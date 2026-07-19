/**
 * pipeline/workers/matching.worker.js
 *
 * Processes matchingQueue jobs — computes a resume-to-job match via Gemini
 * (jobMatcher.js) and writes the result onto the applications row.
 */

const pino = require('pino');
const config = require('../../config');
const db = require('../../db');
const { matchingQueue } = require('../queues');
const { matchResumeToJob } = require('../jobMatcher');

const logger = pino({ level: config.logLevel });

const getEventSystem = () => require('../eventSystem');

matchingQueue.process(async (job) => {
  const startTime = Date.now();
  const { jobId, candidateId, applicationId } = job.data;
  logger.info({ jobId, candidateId, applicationId }, 'Starting resume-to-job match');

  try {
    const jobRes = await db.query(
      'SELECT title, description, required_skills, min_experience FROM jobs WHERE id = $1',
      [jobId]
    );
    if (jobRes.rows.length === 0) throw new Error(`Job not found: ${jobId}`);
    const jobRow = jobRes.rows[0];

    const resumeRes = await db.query(
      'SELECT raw_text FROM resume_content WHERE candidate_id = $1 ORDER BY extracted_at DESC LIMIT 1',
      [candidateId]
    );
    if (resumeRes.rows.length === 0) throw new Error(`No resume text available for candidate: ${candidateId}`);
    const rawText = resumeRes.rows[0].raw_text;

    const match = await matchResumeToJob(rawText, {
      title: jobRow.title,
      description: jobRow.description,
      requiredSkills: jobRow.required_skills || [],
      minExperience: jobRow.min_experience,
    });

    const updateRes = await db.query(
      `UPDATE applications SET
         match_score = $1, matched_skills = $2, missing_skills = $3,
         experience_match = $4, ai_recommendation = $5, updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [match.matchScore, match.matchedSkills, match.missingSkills, match.experienceMatch, match.recommendation, applicationId]
    );

    const { emitEventDirect } = getEventSystem();
    if (updateRes.rows.length > 0) {
      await emitEventDirect('JobMatchCompleted', candidateId,
        updateRes.rows[0], job.data.correlationId || applicationId,
        null, { source: 'matching-worker', version: '1.0.0' }
      );
    }

    logger.info({ jobId, candidateId, matchScore: match.matchScore, durationMs: Date.now() - startTime }, 'Resume-to-job match completed');
    return { success: true, matchScore: match.matchScore };
  } catch (err) {
    logger.error({ jobId, candidateId, err: err.message, durationMs: Date.now() - startTime }, 'Resume-to-job match failed');
    throw err;
  }
});
