const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('../config');
const db = require('../db');
const { validationQueue, workerQueue, processingQueue, deadLetterQueue } = require('../queues');

const logger = pino({
  level: config.logLevel,
});

/**
 * Streaming checksum computation utility.
 */
function computeChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

/**
 * Helper to perform authenticated calls to the upload-orchestrator.
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

// Validation Queue Worker
validationQueue.process(async (job) => {
  const startTime = Date.now();
  const { uploadId, candidateId, fileName, filePath, checksum } = job.data;

  logger.info({ uploadId, fileName }, 'Starting job validation processing');

  try {
    // 1. Idempotency Check: Get status of upload
    let statusRecord;
    try {
      statusRecord = await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'GET');
    } catch (err) {
      logger.error({ uploadId, err: err.message }, 'Failed to fetch status from orchestrator');
      throw err; // Trigger retry
    }

    if (statusRecord.status !== 'received') {
      logger.warn(
        { uploadId, status: statusRecord.status },
        'Upload is already validated or in progress. Skipping processing.'
      );
      return { skipped: true, reason: `Status is ${statusRecord.status}` };
    }

    // 2. Step 1: Verify file exists on disk
    let resolvedFilePath = filePath;
    if (!resolvedFilePath) {
      const localRootUploads = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
      const dockerUploads = path.resolve(__dirname, '..', '..', '..', '..', 'uploads');
      const UPLOADS_DIR = process.env.UPLOADS_DIR || (
        fs.existsSync(localRootUploads) ? localRootUploads : dockerUploads
      );
      const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');
      resolvedFilePath = path.join(RESUMES_DIR, `${candidateId}_${fileName}`);
      if (!fs.existsSync(resolvedFilePath)) {
        resolvedFilePath = path.join(RESUMES_DIR, fileName);
      }
    }

    let stepStartTime = Date.now();
    let fileExists = false;
    try {
      await fs.promises.access(resolvedFilePath, fs.constants.F_OK);
      fileExists = true;
    } catch (e) {
      fileExists = false;
    }

    logger.info({
      uploadId,
      fileName,
      resolvedFilePath,
      validationStep: 'file_exists',
      result: fileExists ? 'pass' : 'fail',
      durationMs: Date.now() - stepStartTime,
    }, 'File existence check complete');

    if (!fileExists) {
      throw new Error('FILE_NOT_FOUND');
    }

    // 3. Step 2: Re-compute checksum and compare
    stepStartTime = Date.now();
    const computed = await computeChecksum(resolvedFilePath);
    const checksumMatch = computed === checksum;

    logger.info({
      uploadId,
      fileName,
      validationStep: 'checksum',
      result: checksumMatch ? 'pass' : 'fail',
      durationMs: Date.now() - stepStartTime,
    }, 'Checksum match check complete');

    if (!checksumMatch) {
      throw new Error('CHECKSUM_MISMATCH');
    }

    // 4. Step 3: Check file size is under 20MB
    stepStartTime = Date.now();
    const stats = await fs.promises.stat(resolvedFilePath);
    const MAX_SIZE_BYTES = 20 * 1024 * 1024;
    const sizeValid = stats.size < MAX_SIZE_BYTES;

    logger.info({
      uploadId,
      fileName,
      validationStep: 'file_size',
      result: sizeValid ? 'pass' : 'fail',
      durationMs: Date.now() - stepStartTime,
    }, 'File size check complete');

    if (!sizeValid) {
      throw new Error('FILE_TOO_LARGE');
    }

    // 5. Success Path
    const durationMs = Date.now() - startTime;
    logger.info({
      uploadId,
      fileName,
      validationStep: 'overall',
      result: 'pass',
      durationMs,
    }, 'Overall validation checks passed');

    // Update status to 'validated'
    await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
      status: 'validated',
      current_stage: 'validated',
    });

    const jobPayload = {
      ...job.data,
      filePath: resolvedFilePath,
    };

    // Record audit entry
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'validation', 'ValidationPassed', JSON.stringify(jobPayload), null]
    );

    // Enqueue in workerQueue
    await workerQueue.add(jobPayload);

    return { success: true };

  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err.message;
    const permanentErrors = ['FILE_NOT_FOUND', 'CHECKSUM_MISMATCH', 'FILE_TOO_LARGE'];

    if (permanentErrors.includes(errorMsg)) {
      logger.info({
        uploadId,
        fileName,
        validationStep: 'overall',
        result: 'fail',
        failureReason: errorMsg,
        durationMs,
      }, `Validation failed permanently: ${errorMsg}`);

      // Record audit entry
      try {
        await db.query(
          `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [uploadId, candidateId, 'validation', 'ValidationFailed', JSON.stringify(job.data), errorMsg]
        );
      } catch (auditErr) {
        logger.error({ uploadId, err: auditErr.message }, 'Failed to insert validation failed audit entry');
      }

      // Update status to 'failed' on the orchestrator
      try {
        await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
          status: 'failed',
          current_stage: 'validation_failed',
          error_message: errorMsg,
        });
      } catch (patchErr) {
        logger.error({ uploadId, err: patchErr.message }, 'Failed to set status to failed on orchestrator');
      }

      // Add to deadLetterQueue
      try {
        await deadLetterQueue.add({
          ...job.data,
          failedAt: new Date().toISOString(),
          error: errorMsg,
        });
      } catch (dlqErr) {
        logger.error({ uploadId, err: dlqErr.message }, 'Failed to enqueue to dead letter queue');
      }

      // Discard remaining retries so it doesn't retry in Bull
      await job.discard();
      throw new Error(`Validation failed permanently: ${errorMsg}`);
    } else {
      // Temporary or system errors (e.g. network timeout)
      logger.error({
        uploadId,
        fileName,
        err: err.message,
        stack: err.stack,
        durationMs,
      }, 'Temporary validation error occurred');
      throw err; // Standard Bull retry (up to 5 attempts)
    }
  }
});

// Worker Queue Process Handler
// Orchestrates approved uploads and forwards them to processingQueue.
workerQueue.process(async (job) => {
  const { uploadId, candidateId, fileName, filePath, checksum } = job.data;
  const startTime = Date.now();

  logger.info({ uploadId, candidateId, fileName }, 'Orchestrating worker allocation for upload');

  // 0. Verify current status is allowed to proceed (avoid repeating on retries)
  let statusRecord;
  try {
    statusRecord = await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'GET');
  } catch (err) {
    logger.error({ uploadId, err: err.message }, 'Failed to fetch status from orchestrator');
    throw err;
  }

  if (['queued', 'processing', 'completed', 'failed'].includes(statusRecord.status)) {
    logger.warn({ uploadId, status: statusRecord.status }, 'Upload is already orchestrated or in progress. Skipping worker allocation.');
    return { skipped: true, reason: `Status is ${statusRecord.status}` };
  }

  try {
    // 1. Transition status to 'queued' on orchestrator
    await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
      status: 'queued',
      current_stage: 'queued',
    });

    // 2. Record audit entry
    await db.query(
      `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [uploadId, candidateId, 'orchestrator', 'OrchestrationPassed', JSON.stringify(job.data), null]
    );

    // 3. Add to processingQueue
    await processingQueue.add({
      uploadId,
      candidateId,
      fileName,
      filePath,
      checksum,
    });

    logger.info({ uploadId, durationMs: Date.now() - startTime }, 'Successfully dispatched upload to processing queue');
    return { success: true };

  } catch (err) {
    logger.error({
      uploadId,
      fileName,
      err: err.message,
      stack: err.stack,
    }, 'Failed to orchestrate and queue upload');

    // Record audit entry
    try {
      await db.query(
        `INSERT INTO pipeline_audit_log (upload_id, candidate_id, stage, event_type, payload, error_message)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [uploadId, candidateId, 'orchestrator', 'OrchestrationFailed', JSON.stringify(job.data), err.message]
      );
    } catch (auditErr) {
      logger.error({ uploadId, err: auditErr.message }, 'Failed to insert orchestration failed audit entry');
    }

    // Try to update status to failed on orchestrator
    try {
      await sendOrchestratorRequest(`/orchestrator/status/${uploadId}`, 'PATCH', {
        status: 'failed',
        current_stage: 'orchestration_failed',
        error_message: err.message,
      });
    } catch (patchErr) {
      logger.error({ uploadId, err: patchErr.message }, 'Failed to set status to failed on orchestrator');
    }

    // Add to deadLetterQueue
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
    throw err;
  }
});
