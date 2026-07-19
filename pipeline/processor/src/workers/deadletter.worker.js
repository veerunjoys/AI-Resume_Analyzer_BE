const jwt = require('jsonwebtoken');
const pino = require('pino');

const config = require('../config');
const db = require('../db');
const { deadLetterQueue } = require('../queues');

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

// Dead-letter Queue Worker
deadLetterQueue.process(async (job) => {
  const { uploadId, candidateId } = job.data;
  const errorMsg = job.data.error || 'Unknown DLQ failure';
  const attemptsMade = job.attemptsMade || 0;

  logger.info({ uploadId, candidateId }, 'Processing job in dead letter queue handler');

  try {
    // 1. Insert a row into pipeline_audit_log table
    const auditQuery = `
      INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
      VALUES ($1, $2, $3, $4, $5, $6)
    `;
    await db.query(auditQuery, [
      uploadId,
      candidateId,
      'dead_letter',
      'DLQArrival',
      JSON.stringify(job.data),
      errorMsg,
    ]);

    // 2. Call PATCH status to ensure status is 'failed'
    await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
      status: 'failed',
      current_stage: 'failed',
      error_message: errorMsg,
    });

    // 3. Log the failure using pino at error level with full payload, error message, and attempts made
    logger.error({
      uploadId,
      candidateId,
      error: errorMsg,
      attemptsMade,
      jobPayload: job.data,
    }, `Permanently failed upload moved to DLQ: ${errorMsg}`);

    return { success: true };

  } catch (err) {
    logger.error({
      uploadId,
      candidateId,
      err: err.message,
      stack: err.stack,
    }, 'Failed to process dead letter queue job');
    throw err;
  }
});
