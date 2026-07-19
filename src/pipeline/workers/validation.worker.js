/**
 * pipeline/workers/validation.worker.js
 *
 * Processes validation-stage and worker-stage Bull jobs.
 * Calls orchestrator functions directly (no HTTP).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pino = require('pino');
const config = require('../../config');
const db = require('../../db');
const storage = require('../../storage');
const { validationQueue, workerQueue, processingQueue, deadLetterQueue } = require('../queues');

// Lazy-require orchestrator to avoid circular deps at module load
const getOrchestrator = () => require('../orchestrator');

const logger = pino({ level: config.logLevel });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', d => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ─── Validation Queue Worker ─────────────────────────────────────────────────
validationQueue.process(async (job) => {
  const startTime = Date.now();
  const { uploadId, candidateId, fileName, filePath, checksum, resumeS3Key } = job.data;
  logger.info({ uploadId, fileName }, 'Starting validation');

  try {
    // 1. Idempotency check
    const { getUploadStatus, patchUploadStatus } = getOrchestrator();
    const statusRecord = await getUploadStatus(uploadId);
    if (statusRecord.status !== 'received') {
      logger.warn({ uploadId, status: statusRecord.status }, 'Already past received stage — skipping');
      return { skipped: true, reason: `Status is ${statusRecord.status}` };
    }

    const isSupabase = storage.isSupabaseKey(resumeS3Key);
    let resolvedFilePath = filePath;
    let fileBuffer = null;

    if (isSupabase) {
      // 2. Fetch from Supabase Storage — existence/size/checksum all come from one download.
      try {
        fileBuffer = await storage.resolveResumeBuffer(resumeS3Key);
      } catch (e) {
        logger.info({ uploadId, fileName, resumeS3Key, result: 'fail' }, 'File existence check');
        throw new Error('FILE_NOT_FOUND');
      }
      logger.info({ uploadId, fileName, resumeS3Key, result: 'pass' }, 'File existence check');

      const computed = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const checksumMatch = computed === checksum;
      logger.info({ uploadId, result: checksumMatch ? 'pass' : 'fail' }, 'Checksum check');
      if (!checksumMatch) throw new Error('CHECKSUM_MISMATCH');

      const sizeValid = fileBuffer.length < 20 * 1024 * 1024;
      logger.info({ uploadId, result: sizeValid ? 'pass' : 'fail' }, 'File size check');
      if (!sizeValid) throw new Error('FILE_TOO_LARGE');
    } else {
      // 2. Resolve local file path
      if (!resolvedFilePath) {
        const localRootUploads = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
        const dockerUploads = path.resolve(__dirname, '..', '..', '..', 'uploads');
        const UPLOADS_DIR = process.env.UPLOADS_DIR || (
          fs.existsSync(localRootUploads) ? localRootUploads : dockerUploads
        );
        const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');
        resolvedFilePath = path.join(RESUMES_DIR, `${candidateId}_${fileName}`);
        if (!fs.existsSync(resolvedFilePath)) resolvedFilePath = path.join(RESUMES_DIR, fileName);
      }

      // 3. File exists check
      let fileExists = false;
      try { await fs.promises.access(resolvedFilePath, fs.constants.F_OK); fileExists = true; }
      catch (e) { fileExists = false; }

      logger.info({ uploadId, fileName, resolvedFilePath, result: fileExists ? 'pass' : 'fail' }, 'File existence check');
      if (!fileExists) throw new Error('FILE_NOT_FOUND');

      // 4. Checksum validation
      const computed = await computeChecksum(resolvedFilePath);
      const checksumMatch = computed === checksum;
      logger.info({ uploadId, result: checksumMatch ? 'pass' : 'fail' }, 'Checksum check');
      if (!checksumMatch) throw new Error('CHECKSUM_MISMATCH');

      // 5. File size check
      const stats = await fs.promises.stat(resolvedFilePath);
      const sizeValid = stats.size < 20 * 1024 * 1024;
      logger.info({ uploadId, result: sizeValid ? 'pass' : 'fail' }, 'File size check');
      if (!sizeValid) throw new Error('FILE_TOO_LARGE');
    }

    // 6. Update status → validated
    await patchUploadStatus(uploadId, { status: 'validated', current_stage: 'validated' });

    const jobPayload = { ...job.data, filePath: resolvedFilePath };

    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'validation', 'ValidationPassed', JSON.stringify(jobPayload), null]
    );

    await workerQueue.add(jobPayload);
    logger.info({ uploadId, durationMs: Date.now() - startTime }, 'Validation passed');
    return { success: true };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err.message;
    const permanent = ['FILE_NOT_FOUND', 'CHECKSUM_MISMATCH', 'FILE_TOO_LARGE'];

    if (permanent.includes(errorMsg)) {
      logger.info({ uploadId, failureReason: errorMsg, durationMs }, `Permanent validation failure: ${errorMsg}`);
      try {
        await db.query(
          `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uploadId, candidateId, 'validation', 'ValidationFailed', JSON.stringify(job.data), errorMsg]
        );
      } catch (e) { logger.error({ err: e.message }, 'Audit insert failed'); }
      try {
        const { patchUploadStatus } = getOrchestrator();
        await patchUploadStatus(uploadId, { status: 'failed', current_stage: 'validation_failed', error_message: errorMsg });
      } catch (e) { logger.error({ err: e.message }, 'Status patch failed'); }
      try { await deadLetterQueue.add({ ...job.data, failedAt: new Date().toISOString(), error: errorMsg }); }
      catch (e) { logger.error({ err: e.message }, 'DLQ enqueue failed'); }
      await job.discard();
      throw new Error(`Validation failed permanently: ${errorMsg}`);
    }
    logger.error({ uploadId, err: errorMsg, durationMs }, 'Temporary validation error');
    throw err;
  }
});

// ─── Worker Queue Process Handler ─────────────────────────────────────────────
workerQueue.process(async (job) => {
  const { uploadId, candidateId, fileName, filePath, checksum } = job.data;
  const startTime = Date.now();
  logger.info({ uploadId, candidateId }, 'Worker queue: orchestrating');

  const { getUploadStatus, patchUploadStatus } = getOrchestrator();

  const statusRecord = await getUploadStatus(uploadId);
  if (['queued', 'processing', 'completed', 'failed'].includes(statusRecord.status)) {
    logger.warn({ uploadId, status: statusRecord.status }, 'Already orchestrated — skipping');
    return { skipped: true, reason: `Status is ${statusRecord.status}` };
  }

  try {
    await patchUploadStatus(uploadId, { status: 'queued', current_stage: 'queued' });
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'orchestrator', 'OrchestrationPassed', JSON.stringify(job.data), null]
    );
    await processingQueue.add({ uploadId, candidateId, fileName, filePath, checksum });
    logger.info({ uploadId, durationMs: Date.now() - startTime }, 'Dispatched to processingQueue');
    return { success: true };
  } catch (err) {
    logger.error({ uploadId, err: err.message }, 'Orchestration failed');
    try {
      await db.query(
        `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uploadId, candidateId, 'orchestrator', 'OrchestrationFailed', JSON.stringify(job.data), err.message]
      );
    } catch (e) {}
    try { await patchUploadStatus(uploadId, { status: 'failed', current_stage: 'orchestration_failed', error_message: err.message }); } catch (e) {}
    try { await deadLetterQueue.add({ ...job.data, failedAt: new Date().toISOString(), error: err.message }); } catch (e) {}
    await job.discard();
    throw err;
  }
});
