const jwt = require('jsonwebtoken');
const pino = require('pino');

const config = require('../config');
const db = require('../db');
const { indexingQueue, deadLetterQueue } = require('../queues');
const { emitEvent } = require('../events');

const logger = pino({
  level: config.logLevel,
});

/**
 * Helper to perform authenticated calls to the upload-orchestrator
 */
async function sendOrchestratorRequest(endpoint, method, body = null) {
  const token = jwt.sign(
    { id: 'system-processor', name: 'Processor Service' },
    config.jwtSecret,
    { expiresIn: '5m' }
  );

  const url = `${config.uploadOrchestratorUrl}${endpoint}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Orchestrator request failed: ${response.status} - ${text}`);
  }
  return response.json();
}

// Indexing Queue Worker
indexingQueue.process(async (job) => {
  const startTime = Date.now();
  const { uploadId, candidateId, rawText, raw_text } = job.data;
  const contentToIndex = rawText || raw_text;

  logger.info({ uploadId, candidateId }, 'Starting job indexing processing');

  try {
    // Record audit entry for start
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'indexing', 'IndexingStarted', JSON.stringify(job.data), null]
    );
    // 1. Idempotency Check: Get status of upload
    let statusRecord;
    try {
      statusRecord = await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'GET');
    } catch (err) {
      logger.error({ uploadId, err: err.message }, 'Failed to fetch status from orchestrator');
      throw err; // Trigger Bull retry
    }

    if (statusRecord.status === 'completed') {
      logger.warn(
        { uploadId, candidateId },
        'Upload is already completed. Skipping indexing.'
      );
      return { skipped: true, reason: 'Already completed' };
    }

    // 2. Call PATCH status to update status to 'indexed'
    await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
      status: 'indexed',
      current_stage: 'indexing',
    });

    // 3. Update candidates table's search_vector
    if (contentToIndex) {
      const updateCandidateQuery = `
        UPDATE candidates
        SET search_vector = COALESCE(search_vector, ''::tsvector) || to_tsvector('english', $1),
            updated_at = NOW()
        WHERE id = $2
      `;
      await db.query(updateCandidateQuery, [contentToIndex, candidateId]);
    } else {
      logger.warn({ uploadId, candidateId }, 'No raw text content available to index');
    }

    // 4. Update resume_content row to record indexing completion
    const updateResumeContentQuery = `
      UPDATE resume_content
      SET indexed_at = NOW()
      WHERE upload_id = $1
    `;
    await db.query(updateResumeContentQuery, [uploadId]);

    // 5. Call PATCH status to update status to 'completed'
    await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
      status: 'completed',
      current_stage: 'completed',
    });

    // Record audit entry for pass
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'indexing', 'IndexingPassed', JSON.stringify(job.data), null]
    );

    // 6. Emit ResumeIndexed domain event
    await emitEvent('ResumeIndexed', candidateId, { uploadId, candidateId }, job.data.correlationId || uploadId);

    // Pino logging requirement: uploadId, candidateId, indexingDurationMs
    const indexingDurationMs = Date.now() - startTime;
    logger.info({
      uploadId,
      candidateId,
      indexingDurationMs,
    }, 'Job indexing completed successfully');

    return { success: true, indexingDurationMs };

  } catch (err) {
    const indexingDurationMs = Date.now() - startTime;
    logger.error({
      uploadId,
      candidateId,
      indexingDurationMs,
      err: err.message,
      stack: err.stack,
    }, 'Error during indexing worker processing');

    // On unrecoverable error, update status to failed and push to DLQ
    const isUnrecoverable = err.code === '22P02' || err.code === '23503'; // bad UUID format or missing candidate ref
    if (isUnrecoverable) {
      // Record audit entry for failure
      try {
        await db.query(
          `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uploadId, candidateId, 'indexing', 'IndexingFailed', JSON.stringify(job.data), err.message]
        );
      } catch (auditErr) {
        logger.error({ uploadId, err: auditErr.message }, 'Failed to insert indexing failed audit entry');
      }
      try {
        await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
          status: 'failed',
          current_stage: 'indexing_failed',
          error_message: err.message,
        });
      } catch (patchErr) {
        logger.error({ uploadId, err: patchErr.message }, 'Failed to set status to failed on orchestrator');
      }

      emitEvent('ResumeFailed', { uploadId, candidateId, reason: err.message });

      try {
        await deadLetterQueue.add({
          ...job.data,
          failedAt: new Date().toISOString(),
          error: err.message,
        });
      } catch (dlqErr) {
        logger.error({ uploadId, err: dlqErr.message }, 'Failed to enqueue to dead letter queue');
      }

      await job.discard();
      throw new Error(`Indexing failed permanently: ${err.message}`);
    } else {
      throw err; // Bull retry
    }
  }
});
