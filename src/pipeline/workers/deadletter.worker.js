/**
 * pipeline/workers/deadletter.worker.js
 *
 * Dead-letter queue handler — records permanently failed jobs in the audit log
 * and ensures their upload status is marked 'failed'.
 * Calls orchestrator directly — no HTTP.
 */

const pino = require('pino');
const config = require('../../config');
const db = require('../../db');
const { deadLetterQueue } = require('../queues');

const logger = pino({ level: config.logLevel });

const getOrchestrator = () => require('../orchestrator');

deadLetterQueue.process(async (job) => {
  const { uploadId, candidateId } = job.data;
  const errorMsg = job.data.error || 'Unknown DLQ failure';
  const attemptsMade = job.attemptsMade || 0;

  logger.info({ uploadId, candidateId }, 'Processing dead-letter queue job');

  const { patchUploadStatus } = getOrchestrator();

  try {
    // 1. Write audit entry
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'dead_letter', 'DLQArrival', JSON.stringify(job.data), errorMsg]
    );

    // 2. Ensure status is 'failed'
    try {
      await patchUploadStatus(uploadId, {
        status: 'failed',
        current_stage: 'failed',
        error_message: errorMsg,
      });
    } catch (patchErr) {
      // Status may already be 'failed' — log and continue
      logger.warn({ uploadId, err: patchErr.message }, 'DLQ: status patch skipped (may already be failed)');
    }

    // 3. Log failure details
    logger.error(
      { uploadId, candidateId, error: errorMsg, attemptsMade, jobPayload: job.data },
      `Permanently failed upload in DLQ: ${errorMsg}`
    );

    return { success: true };
  } catch (err) {
    logger.error({ uploadId, candidateId, err: err.message }, 'Failed to process DLQ job');
    throw err;
  }
});
