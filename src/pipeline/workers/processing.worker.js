/**
 * pipeline/workers/processing.worker.js
 *
 * Extracts text from uploaded resumes (PDF/DOCX), runs NLP resumeParser to
 * extract candidate fields, creates/updates the candidate record in a transaction,
 * maps skills relationally, and enqueues to indexingQueue.
 */

const fs = require('fs');
const path = require('path');
const pino = require('pino');
const pdf = require('pdf-parse');
const mammoth = require('mammoth');
const config = require('../../config');
const db = require('../../db');
const storage = require('../../storage');
const { processingQueue, indexingQueue, deadLetterQueue } = require('../queues');
const { parseResume } = require('../resumeParser');
const { extractWithGemini } = require('../geminiExtractor');

const logger = pino({ level: config.logLevel });

const getOrchestrator = () => require('../orchestrator');
const getEventSystem  = () => require('../eventSystem');

processingQueue.process(async (job) => {
  const startTime = Date.now();
  const { uploadId, candidateId, fileName, filePath, resumeS3Key } = job.data;
  const logStep = (stage, wc = null) =>
    logger.info({ uploadId, stage, wordCount: wc, durationMs: Date.now() - startTime }, `Step: ${stage}`);

  logger.info({ uploadId, fileName }, 'Starting text extraction');
  logStep('start_processing');

  const { getUploadStatus, patchUploadStatus } = getOrchestrator();
  const { emitEventDirect } = getEventSystem();

  try {
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'processing', 'ProcessingStarted', JSON.stringify(job.data), null]
    );

    // Idempotency check
    const statusRecord = await getUploadStatus(uploadId);
    const STAGES = ['received','validated','queued','processing','indexed','completed','failed'];
    if (STAGES.indexOf(statusRecord.status) >= STAGES.indexOf('processing')) {
      logger.warn({ uploadId, status: statusRecord.status }, 'Already processing or later — skipping');
      return { skipped: true, reason: `Status is ${statusRecord.status}` };
    }

    await patchUploadStatus(uploadId, { status: 'processing', current_stage: 'extracting_text' });
    logStep('status_updated_processing');

    // Resolve file bytes — Supabase Storage if that's where it lives, else local disk.
    const localRootUploads = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
    const dockerUploads = path.resolve(__dirname, '..', '..', '..', 'uploads');
    const UPLOADS_DIR = process.env.UPLOADS_DIR || (
      fs.existsSync(localRootUploads) ? localRootUploads : dockerUploads
    );
    const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');
    const PROCESSED_DIR = path.join(UPLOADS_DIR, 'processed');

    let fileData;
    if (storage.isSupabaseKey(resumeS3Key)) {
      fileData = await storage.resolveResumeBuffer(resumeS3Key);
    } else {
      let actualFilePath = path.join(RESUMES_DIR, fileName);
      if (!fs.existsSync(actualFilePath)) actualFilePath = path.join(RESUMES_DIR, `${candidateId}_${fileName}`);
      if (!fs.existsSync(actualFilePath)) actualFilePath = filePath;
      fileData = await fs.promises.readFile(actualFilePath);
    }

    let rawText = '';
    const ext = path.extname(fileName).toLowerCase();
    if (ext === '.pdf') {
      const pdfData = await pdf(fileData);
      rawText = pdfData.text;
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ buffer: fileData });
      rawText = result.value;
    } else {
      throw new Error(`UNSUPPORTED_FILE_TYPE: ${ext}`);
    }

    const wordCount = rawText.trim().split(/\s+/).filter(Boolean).length;
    logStep('text_extracted', wordCount);

    // Write processed text to disk
    if (!fs.existsSync(PROCESSED_DIR)) fs.mkdirSync(PROCESSED_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(PROCESSED_DIR, `${uploadId}.txt`), rawText, 'utf8');

    const extractionQuality = wordCount < 50 ? 'low' : 'high';
    if (wordCount < 50) logger.warn({ uploadId, wordCount }, 'Low-quality text extraction');

    // Extract structured fields (and a resume-quality analysis) via Gemini,
    // falling back to the heuristic/NLP parser if the API key is missing, the
    // request fails, or times out — so a transient LLM outage doesn't
    // dead-letter the whole upload. The heuristic fallback has no equivalent
    // for the analysis (score/strengths/weaknesses), so that stays null.
    let parsed;
    let analysis = null;
    try {
      const result = await extractWithGemini(rawText);
      parsed = result.parsed;
      analysis = result.analysis;
      logStep('gemini_extraction_ok', wordCount);
    } catch (geminiErr) {
      logger.warn({ uploadId, err: geminiErr.message }, 'Gemini extraction failed — falling back to heuristic parser');
      parsed = parseResume(rawText);
    }

    // Persist to resume_content, saving parsed_data
    await db.query(
      `INSERT INTO resume_content (upload_id, candidate_id, raw_text, word_count, extraction_quality, parsed_data)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (upload_id) DO UPDATE
       SET raw_text = EXCLUDED.raw_text, word_count = EXCLUDED.word_count,
           extraction_quality = EXCLUDED.extraction_quality, parsed_data = EXCLUDED.parsed_data, extracted_at = NOW()`,
      [uploadId, candidateId, rawText, wordCount, extractionQuality, JSON.stringify(parsed)]
    );
    logStep('stored_in_database', wordCount);

    // DB Transaction for Candidate creation/deduplication
    const client = await db.pool.connect();
    let targetCandidateId = candidateId;
    let isDuplicateLinked = false;

    try {
      await client.query('BEGIN');

      const extractedEmail = parsed.email?.value;
      let existingCandidate = null;

      if (extractedEmail) {
        const findRes = await client.query(
          'SELECT id, name, email, phone, location, skills, notes, experience FROM candidates WHERE email = $1 LIMIT 1',
          [extractedEmail]
        );
        if (findRes.rows.length > 0) {
          existingCandidate = findRes.rows[0];
        }
      }

      const relativeResumePath = `uploads/resumes/${candidateId}_${fileName}`;
      const newNotes = `Auto-created from resume upload on ${new Date().toLocaleDateString()}.\nExtracted: ${parsed.experience?.value || 0} years experience,\n${parsed.skills?.value?.length || 0} skills detected,\nCurrent role: ${parsed.jobTitle?.value || 'N/A'}.\nPlease review and confirm all fields.`;

      // Only treat this as a "duplicate to merge into" if it's a genuinely
      // different candidate row. If the email lookup finds this same job's
      // own candidateId (e.g. because a second ResumeUploaded event fired for
      // the same upload), merging would delete the row out from under itself
      // and then crash inserting candidate_skills against the deleted id.
      if (existingCandidate && existingCandidate.id !== candidateId) {
        // Link resume to existing candidate
        targetCandidateId = existingCandidate.id;
        isDuplicateLinked = true;

        // Update empty/null fields on existing candidate with newly extracted values
        const updates = [];
        const values = [];
        let pCount = 0;

        const addUpdate = (col, val) => {
          pCount++;
          updates.push(`${col} = $${pCount}`);
          values.push(val);
        };

        if (!existingCandidate.name || existingCandidate.name === 'Draft Candidate' || existingCandidate.name === 'Unknown — please review') {
          if (parsed.name?.value) addUpdate('name', parsed.name.value);
        }
        if (!existingCandidate.phone) {
          if (parsed.phone?.value) addUpdate('phone', parsed.phone.value);
        }
        if (!existingCandidate.location) {
          if (parsed.location?.value) addUpdate('location', parsed.location.value);
        }
        if (existingCandidate.experience === null || existingCandidate.experience === undefined) {
          if (parsed.experience?.value !== undefined) addUpdate('experience', parsed.experience.value);
        }
        if (!existingCandidate.skills || existingCandidate.skills.length === 0) {
          if (parsed.skills?.value) addUpdate('skills', parsed.skills.value);
        }

        if (!existingCandidate.notes) {
          addUpdate('notes', newNotes);
        } else {
          addUpdate('notes', existingCandidate.notes + '\n\n' + newNotes);
        }

        // Always link the resume path
        addUpdate('resume_s3_key', relativeResumePath);
        addUpdate('updated_at', new Date());

        if (updates.length > 0) {
          values.push(targetCandidateId);
          await client.query(
            `UPDATE candidates SET ${updates.join(', ')}, version = version + 1 WHERE id = $${values.length}`,
            values
          );
        }

        // Re-point upload_status and resume_content to the surviving candidate
        // BEFORE deleting the draft row — upload_status.candidate_id has
        // ON DELETE CASCADE, so deleting first would wipe these rows out from
        // under the reassignment instead of moving them, permanently losing
        // this upload's tracking row (frontend polling then 404s forever).
        await client.query('UPDATE upload_status SET candidate_id = $1 WHERE upload_id = $2', [targetCandidateId, uploadId]);
        await client.query('UPDATE resume_content SET candidate_id = $1 WHERE upload_id = $2', [targetCandidateId, uploadId]);

        // Delete temporary draft candidate profile to prevent duplicates
        await client.query('DELETE FROM candidates WHERE id = $1', [candidateId]);

        // Emit CandidateDeleted event so client knows this ID has been merged
        await emitEventDirect('CandidateDeleted', candidateId,
          { id: candidateId, mergedInto: targetCandidateId }, job.data.correlationId || uploadId,
          null, { source: 'processor', version: '1.0.0' }
        );

      } else {
        // Update the temporary draft candidate profile with all parsed information
        await client.query(
          `UPDATE candidates
           SET name = $1, email = $2, phone = $3, location = $4, skills = $5, status = 'Draft',
               source = 'resume_upload', notes = $6, experience = $7, resume_s3_key = $8,
               version = version + 1, updated_at = NOW()
           WHERE id = $9`,
          [
            parsed.name?.value || 'Unknown — please review',
            parsed.email?.value || `noreply_${uploadId}@review.local`,
            parsed.phone?.value || null,
            parsed.location?.value || null,
            parsed.skills?.value || [],
            newNotes,
            parsed.experience?.value || null,
            relativeResumePath,
            targetCandidateId
          ]
        );
      }

      // Relationally map skills into skills & candidate_skills tables
      const skillList = parsed.skills?.value || [];
      for (const skillName of skillList) {
        const skillRes = await client.query(
          `INSERT INTO skills (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [skillName]
        );
        const skillId = skillRes.rows[0].id;
        await client.query(
          `INSERT INTO candidate_skills (candidate_id, skill_id)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [targetCandidateId, skillId]
        );
      }

      // Store extraction metadata on candidates table
      const fields = ['name', 'email', 'phone', 'location', 'experience', 'jobTitle', 'skills', 'education', 'linkedin', 'github', 'summary'];
      let highConfCount = 0;
      fields.forEach(f => {
        if (parsed[f]?.confidence === 'high') highConfCount++;
      });
      const finalQuality = highConfCount > 5 ? 'high' : (highConfCount >= 3 ? 'medium' : 'low');

      const extractionMetadata = {
        parsedAt: new Date().toISOString(),
        parserVersion: "1.0",
        fields: {
          name:       parsed.name       ? { value: parsed.name.value, confidence: parsed.name.confidence, method: parsed.name.method } : null,
          email:      parsed.email      ? { value: parsed.email.value, confidence: parsed.email.confidence } : null,
          phone:      parsed.phone      ? { value: parsed.phone.value, confidence: parsed.phone.confidence } : null,
          location:   parsed.location   ? { value: parsed.location.value, confidence: parsed.location.confidence } : null,
          experience: parsed.experience ? { value: parsed.experience.value, unit: parsed.experience.unit, confidence: parsed.experience.confidence, method: parsed.experience.method } : null,
          jobTitle:   parsed.jobTitle   ? { value: parsed.jobTitle.value, confidence: parsed.jobTitle.confidence } : null,
          skills:     parsed.skills     ? { value: parsed.skills.value, confidence: parsed.skills.confidence } : null,
          education:  parsed.education  ? { value: parsed.education.value, institution: parsed.education.institution, confidence: parsed.education.confidence } : null,
          linkedin:   parsed.linkedin   ? { value: parsed.linkedin.value, confidence: parsed.linkedin.confidence } : null,
          github:     parsed.github     ? { value: parsed.github.value, confidence: parsed.github.confidence } : null,
          summary:    parsed.summary    ? { value: parsed.summary.value, confidence: parsed.summary.confidence } : null,
        },
        wordCount,
        extractionQuality: finalQuality
      };

      await client.query(
        `UPDATE candidates SET extraction_metadata = $1 WHERE id = $2`,
        [JSON.stringify(extractionMetadata), targetCandidateId]
      );

      // Store the AI resume-quality analysis (score breakdown, strengths/weaknesses)
      if (analysis) {
        await client.query(
          `INSERT INTO ai_analysis (candidate_id, upload_id, overall_score, category_scores, strengths, weaknesses, missing_skills, summary, recommendation, model)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (upload_id) DO UPDATE
           SET candidate_id = EXCLUDED.candidate_id, overall_score = EXCLUDED.overall_score,
               category_scores = EXCLUDED.category_scores, strengths = EXCLUDED.strengths,
               weaknesses = EXCLUDED.weaknesses, missing_skills = EXCLUDED.missing_skills,
               summary = EXCLUDED.summary, recommendation = EXCLUDED.recommendation, model = EXCLUDED.model`,
          [
            targetCandidateId, uploadId, analysis.overallScore, JSON.stringify(analysis.categoryScores),
            analysis.strengths, analysis.weaknesses, analysis.missingSkills, analysis.summary,
            analysis.recommendation, analysis.model
          ]
        );
      }

      await client.query('COMMIT');

      // Fetch finalized candidate to emit CandidateUpdated
      const finalCandRes = await client.query(
        `SELECT id, name, email, phone, location, skills, status, source, notes, resume_s3_key, version, experience, created_at, updated_at
         FROM candidates WHERE id = $1`,
        [targetCandidateId]
      );
      if (finalCandRes.rows.length > 0) {
        const updatedCandidate = finalCandRes.rows[0];
        await emitEventDirect('CandidateUpdated', targetCandidateId,
          updatedCandidate, job.data.correlationId || uploadId,
          null, { source: 'processor', version: '1.0.0' }
        );
      }

      if (analysis) {
        await emitEventDirect('ResumeAnalyzed', targetCandidateId,
          { uploadId, candidateId: targetCandidateId, overallScore: analysis.overallScore }, job.data.correlationId || uploadId,
          null, { source: 'processor', version: '1.0.0' }
        );
      }

      // Log parser outcome
      const fieldsExtracted = fields.filter(f => parsed[f] !== null).length;
      logger.info({
        uploadId,
        candidateId: targetCandidateId,
        fieldsExtracted,
        extractionQuality: finalQuality,
        skillsFound: parsed.skills?.value || [],
        yearsExperience: parsed.experience?.value || null,
        wordCount,
        durationMs: Date.now() - startTime
      }, 'Resume extraction completed');

    } catch (txErr) {
      await client.query('ROLLBACK');
      throw txErr;
    } finally {
      client.release();
    }

    // Emit ResumeProcessed event
    await emitEventDirect('ResumeProcessed', targetCandidateId,
      { uploadId, candidateId: targetCandidateId }, job.data.correlationId || uploadId,
      null, { source: 'processor', version: '1.0.0' }
    );
    logStep('event_emitted', wordCount);

    // Enqueue indexing
    await indexingQueue.add({ uploadId, candidateId: targetCandidateId, rawText, raw_text: rawText });
    logStep('indexing_queued', wordCount);

    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, targetCandidateId, 'processing', 'ProcessingPassed', JSON.stringify(job.data), null]
    );
    logStep('overall', wordCount);
    return { success: true, wordCount };

  } catch (err) {
    const errorMsg = err.message;
    const isUnrecoverable =
      errorMsg.startsWith('UNSUPPORTED_FILE_TYPE') ||
      errorMsg.includes('corrupt') || errorMsg.includes('invalid') ||
      err.name === 'PDFJS' || err.code === 'ENOENT';

    if (isUnrecoverable) {
      logger.info({ uploadId, errorMsg }, `Permanent processing error: ${errorMsg}`);
      try {
        await db.query(
          `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uploadId, candidateId, 'processing', 'ProcessingFailed', JSON.stringify(job.data), errorMsg]
        );
      } catch (e) {}
      try {
        const { patchUploadStatus } = getOrchestrator();
        await patchUploadStatus(uploadId, { status: 'failed', current_stage: 'processing_failed', error_message: errorMsg });
      } catch (e) {}
      try {
        await emitEventDirect('ResumeFailed', candidateId,
          { uploadId, candidateId, reason: errorMsg }, job.data.correlationId || uploadId,
          null, { source: 'processor' }
        );
      } catch (e) {}
      try { await deadLetterQueue.add({ ...job.data, failedAt: new Date().toISOString(), error: errorMsg }); } catch (e) {}
      await job.discard();
      throw new Error(`Processing failed permanently: ${errorMsg}`);
    }
    logger.error({ uploadId, err: err.message }, 'Temporary processing error');
    throw err;
  }
});
