/**
 * pipeline/workers/indexing.worker.js
 *
 * Updates the candidates search_vector with resume text and marks indexing complete.
 * Calls orchestrator and event system directly — no HTTP.
 */

const pino = require('pino');
const config = require('../../config');
const db = require('../../db');
const { indexingQueue, deadLetterQueue } = require('../queues');

const logger = pino({ level: config.logLevel });

const getOrchestrator = () => require('../orchestrator');
const getEventSystem  = () => require('../eventSystem');

indexingQueue.process(async (job) => {
  const startTime = Date.now();
  const { uploadId, candidateId, rawText, raw_text } = job.data;
  const contentToIndex = rawText || raw_text;

  logger.info({ uploadId, candidateId }, 'Starting indexing');

  const { getUploadStatus, patchUploadStatus } = getOrchestrator();
  const { emitEventDirect } = getEventSystem();

  try {
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'indexing', 'IndexingStarted', JSON.stringify(job.data), null]
    );

    // Idempotency check
    const statusRecord = await getUploadStatus(uploadId);
    if (statusRecord.status === 'completed') {
      logger.warn({ uploadId }, 'Already completed — skipping indexing');
      return { skipped: true, reason: 'Already completed' };
    }

    // Update status → indexed
    await patchUploadStatus(uploadId, { status: 'indexed', current_stage: 'indexing' });

    // Update candidates search_vector with resume text
    if (contentToIndex) {
      await db.query(
        `UPDATE candidates
         SET search_vector = COALESCE(search_vector, ''::tsvector) || to_tsvector('english', $1),
             updated_at = NOW()
         WHERE id = $2`,
        [contentToIndex, candidateId]
      );
    } else {
      logger.warn({ uploadId, candidateId }, 'No raw text available to index');
    }

    // Mark resume_content indexed
    await db.query(
      `UPDATE resume_content SET indexed_at = NOW() WHERE upload_id = $1`,
      [uploadId]
    );

    // Update status → completed
    await patchUploadStatus(uploadId, { status: 'completed', current_stage: 'completed' });

    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'indexing', 'IndexingPassed', JSON.stringify(job.data), null]
    );

    // Emit ResumeIndexed event
    await emitEventDirect('ResumeIndexed', candidateId,
      { uploadId, candidateId }, job.data.correlationId || uploadId,
      null, { source: 'processor' }
    );

    const indexingDurationMs = Date.now() - startTime;
    logger.info({ uploadId, candidateId, indexingDurationMs }, 'Indexing completed');
    return { success: true, indexingDurationMs };

  } catch (err) {
    const indexingDurationMs = Date.now() - startTime;
    logger.error({ uploadId, candidateId, indexingDurationMs, err: err.message }, 'Indexing error');

    const isUnrecoverable = err.code === '22P02' || err.code === '23503';
    if (isUnrecoverable) {
      try {
        await db.query(
          `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uploadId, candidateId, 'indexing', 'IndexingFailed', JSON.stringify(job.data), err.message]
        );
      } catch (e) {}
      try {
        await patchUploadStatus(uploadId, { status: 'failed', current_stage: 'indexing_failed', error_message: err.message });
      } catch (e) {}
      try {
        await emitEventDirect('ResumeFailed', candidateId,
          { uploadId, candidateId, reason: err.message }, uploadId, null, { source: 'processor' }
        );
      } catch (e) {}
      try { await deadLetterQueue.add({ ...job.data, failedAt: new Date().toISOString(), error: err.message }); } catch (e) {}
      await job.discard();
      throw new Error(`Indexing failed permanently: ${err.message}`);
    }
    throw err;
  }
});
