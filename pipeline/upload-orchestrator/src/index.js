const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('./config');
const db = require('./db');

const logger = pino({
  level: config.logLevel,
});

const app = express();

// CORS Middleware - Allow cross-origin requests from the client
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Correlation-ID');
  res.setHeader('Access-Control-Expose-Headers', 'X-Correlation-ID');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());

// Correlation ID Middleware - Applied first
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = correlationId;
  req.log = logger.child({ correlationId });
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// Logger Middleware - ensures every response is logged with durationMs, requestId, candidateId, action
app.use((req, res, next) => {
  const start = process.hrtime();
  req.requestId = crypto.randomUUID();
  req.action = `${req.method} ${req.path}`;
  req.candidateId = null;

  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);
    const candidateId = req.candidateId || req.body?.candidateId || req.query?.candidateId || null;

    req.log.info({
      requestId: req.requestId,
      candidateId,
      action: req.action,
      durationMs,
      statusCode: res.statusCode,
    }, `Response sent for ${req.method} ${req.path}`);
  });

  next();
});

// Authentication Middleware
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.recruiter = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// Health Check Endpoint
app.get('/health', (req, res) => {
  req.action = 'health_check';
  res.json({ status: 'ok' });
});

// POST /orchestrator/credentials - Request secure upload token
app.post('/orchestrator/credentials', requireAuth, async (req, res) => {
  req.action = 'generate_credentials';
  const { candidateId, fileName } = req.body;

  if (!fileName) {
    return res.status(400).json({ error: 'fileName is a required field.' });
  }

  // Validate candidateId is a valid UUID if present
  if (candidateId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(candidateId)) {
      return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
    }
    req.candidateId = candidateId;
  }

  try {
    // Generate secure upload token
    const token = crypto.randomBytes(32).toString('hex');

    // Insert token details into database
    const insertQuery = `
      INSERT INTO upload_credentials (token, candidate_id, file_name)
      VALUES ($1, $2, $3)
      RETURNING token, expires_at
    `;
    await db.query(insertQuery, [token, candidateId || null, fileName]);

    res.status(201).json({
      token,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 mins expiry
    });
  } catch (err) {
    logger.error({
      requestId: req.requestId,
      candidateId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Failed to generate upload credentials');
    
    // Check if it's a foreign key constraint violation (candidate does not exist)
    if (err.code === '23503') {
      return res.status(404).json({ error: 'Candidate not found.' });
    }

    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /orchestrator/validate - Validate upload token, file details, and mimeType
app.post('/orchestrator/validate', requireAuth, async (req, res) => {
  req.action = 'validate_credentials';
  const { uploadToken, candidateId, fileName, fileSizeBytes, mimeType } = req.body;
  const requestId = req.requestId;

  // Set candidateId on request so the middleware logs it
  if (candidateId) {
    req.candidateId = candidateId;
  }

  // Basic payload presence validations
  if (!uploadToken || !fileName || fileSizeBytes === undefined || !mimeType) {
    const failureReason = 'Missing required request body fields';
    logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: missing fields');
    return res.status(400).json({ error: 'Validation failed', reason: failureReason });
  }

  // Validate candidateId format (UUID) if present
  if (candidateId) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(candidateId)) {
      const failureReason = 'Invalid candidateId format';
      logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: invalid candidate UUID');
      return res.status(400).json({ error: 'Validation failed', reason: failureReason });
    }
  }

  // Validate mimeType
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  if (!allowedMimeTypes.includes(mimeType)) {
    const failureReason = `Unsupported mimeType: ${mimeType}`;
    logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: unsupported mimeType');
    return res.status(400).json({ error: 'Validation failed', reason: failureReason });
  }

  // Validate fileSizeBytes under 20MB (20 * 1024 * 1024 bytes)
  const MAX_SIZE_BYTES = 20 * 1024 * 1024;
  if (fileSizeBytes >= MAX_SIZE_BYTES) {
    const failureReason = `File size exceeds 20MB limit: ${fileSizeBytes} bytes`;
    logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: file too large');
    return res.status(400).json({ error: 'Validation failed', reason: failureReason });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Retrieve and lock the credential row
    const selectRes = await client.query(
      'SELECT candidate_id, expires_at, used FROM upload_credentials WHERE token = $1 FOR UPDATE',
      [uploadToken]
    );

    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      const failureReason = 'Upload token not found';
      logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: token not found');
      return res.status(400).json({ error: 'Validation failed', reason: failureReason });
    }

    const credential = selectRes.rows[0];

    // Check candidateId match if present on both sides
    if (credential.candidate_id && candidateId && credential.candidate_id !== candidateId) {
      await client.query('ROLLBACK');
      const failureReason = 'Upload token does not match candidateId';
      logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: candidate mismatch');
      return res.status(400).json({ error: 'Validation failed', reason: failureReason });
    }

    // Check if token is already used
    if (credential.used) {
      await client.query('ROLLBACK');
      const failureReason = 'Upload token has already been used';
      logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: token already used');
      return res.status(400).json({ error: 'Validation failed', reason: failureReason });
    }

    // Check expiration
    if (new Date(credential.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      const failureReason = 'Upload token has expired';
      logger.info({ requestId, candidateId, fileName, validationResult: 'fail', failureReason }, 'Validation failed: token expired');
      return res.status(400).json({ error: 'Validation failed', reason: failureReason });
    }

    // Generate new uploadId
    const uploadId = crypto.randomUUID();

    // All checks pass! Mark token as used
    await client.query(
      'UPDATE upload_credentials SET used = true WHERE token = $1',
      [uploadToken]
    );

    // Create status record in database atomically
    const insertStatusQuery = `
      INSERT INTO upload_status (upload_id, candidate_id, file_name, status, current_stage, metadata)
      VALUES ($1, $2, $3, 'received', 'received', '{}'::jsonb)
    `;
    await client.query(insertStatusQuery, [uploadId, candidateId || null, fileName]);

    await client.query('COMMIT');

    logger.info({ requestId, candidateId, fileName, uploadId, validationResult: 'pass' }, 'Validation succeeded and status tracker initialized');

    res.json({
      valid: true,
      uploadId
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({
      requestId,
      candidateId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error during credential validation');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// POST /orchestrator/dedup-check - Check for duplicate resumes based on checksum
app.post('/orchestrator/dedup-check', requireAuth, async (req, res) => {
  req.action = 'dedup_check';
  const { checksum, candidateId, uploadId } = req.body;
  const requestId = req.requestId;

  if (!checksum) {
    return res.status(400).json({ error: 'checksum is a required field.' });
  }

  // Validate format of candidateId and uploadId if provided
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (candidateId && !uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }
  if (uploadId && !uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format. Must be a valid UUID.' });
  }

  // Validate SHA-256 checksum format (64-character hex string)
  const sha256Regex = /^[0-9a-f]{64}$/i;
  if (!sha256Regex.test(checksum)) {
    return res.status(400).json({ error: 'Invalid checksum format. Must be a valid SHA-256 hex string.' });
  }

  if (candidateId) {
    req.candidateId = candidateId;
  }

  try {
    // Check if checksum exists in database
    const checkRes = await db.query(
      'SELECT candidate_id, upload_id FROM resume_checksums WHERE checksum = $1',
      [checksum]
    );

    if (checkRes.rows.length > 0) {
      const existingCandidateId = checkRes.rows[0].candidate_id;
      const existingUploadId = checkRes.rows[0].upload_id;
      logger.info({ requestId, candidateId, checksum, duplicate: true, existingUploadId, existingCandidateId }, 'Duplicate resume detected');
      return res.json({
        duplicate: true,
        existingCandidateId,
        existingUploadId
      });
    }

    // Only insert new checksum record if candidateId and uploadId are provided
    if (candidateId && uploadId) {
      const insertQuery = `
        INSERT INTO resume_checksums (checksum, candidate_id, upload_id, uploaded_at)
        VALUES ($1, $2, $3, NOW())
      `;
      await db.query(insertQuery, [checksum, candidateId, uploadId]);
      logger.info({ requestId, candidateId, checksum, duplicate: false }, 'New resume registered');

      // Fetch fileName from upload_status and emit ResumeUploaded event to Event System
      try {
        const statusRes = await db.query('SELECT file_name FROM upload_status WHERE upload_id = $1', [uploadId]);
        const fileName = statusRes.rows[0]?.file_name || 'resume.pdf';

        const token = jwt.sign(
          { id: 'upload-orchestrator', name: 'Upload Orchestrator' },
          config.jwtSecret,
          { expiresIn: '5m' }
        );

        const eventUrl = `${config.eventSystemUrl}/events/emit`;
        const sseRes = await fetch(eventUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            event_type: 'ResumeUploaded',
            aggregate_id: candidateId,
            payload: {
              uploadId,
              candidateId,
              fileName,
              checksum,
            },
            correlation_id: uploadId,
            metadata: { source: 'upload-orchestrator', version: '1.0.0' }
          }),
        });

        if (sseRes.ok) {
          logger.info({ uploadId, candidateId }, 'ResumeUploaded event emitted successfully');
        } else {
          const errText = await sseRes.text();
          logger.error({ uploadId, candidateId, status: sseRes.status, errText }, 'Failed to emit ResumeUploaded event');
        }
      } catch (err) {
        logger.error({ uploadId, candidateId, err: err.message }, 'Failed to emit ResumeUploaded event');
      }
    }

    res.json({
      duplicate: false
    });
  } catch (err) {
    logger.error({
      requestId,
      candidateId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error during duplicate check');

    // Handle foreign key constraint violation (candidate does not exist)
    if (err.code === '23503') {
      return res.status(404).json({ error: 'Candidate not found.' });
    }

    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Valid lifecycle status transitions
const ALLOWED_TRANSITIONS = {
  received: ['validated', 'failed'],
  validated: ['queued', 'failed'],
  queued: ['processing', 'failed'],
  processing: ['indexed', 'failed'],
  indexed: ['completed', 'failed'],
  completed: [],
  failed: []
};

// POST /orchestrator/status - Create a new upload status tracker
app.post('/orchestrator/status', requireAuth, async (req, res) => {
  req.action = 'create_status';
  const { candidateId, fileName } = req.body;
  const requestId = req.requestId;

  if (!candidateId || !fileName) {
    return res.status(400).json({ error: 'candidateId and fileName are required fields.' });
  }

  // Validate candidateId format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }

  req.candidateId = candidateId;

  try {
    const uploadId = crypto.randomUUID();

    const insertQuery = `
      INSERT INTO upload_status (upload_id, candidate_id, file_name, status, current_stage, metadata)
      VALUES ($1, $2, $3, 'received', 'received', '{}'::jsonb)
      RETURNING upload_id
    `;
    const result = await db.query(insertQuery, [uploadId, candidateId, fileName]);
    
    res.status(201).json({ uploadId: result.rows[0].upload_id });
  } catch (err) {
    logger.error({
      requestId,
      candidateId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Failed to create upload status');

    if (err.code === '23503') {
      return res.status(404).json({ error: 'Candidate not found.' });
    }

    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /orchestrator/status/:uploadId - Update upload status lifecycle stage
app.patch('/orchestrator/status/:uploadId', requireAuth, async (req, res) => {
  req.action = 'update_status';
  const { uploadId } = req.params;
  const { status, current_stage, error_message, metadata } = req.body;
  const requestId = req.requestId;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format. Must be a valid UUID.' });
  }

  if (!status || !current_stage) {
    return res.status(400).json({ error: 'status and current_stage are required fields.' });
  }

  const validStatuses = Object.keys(ALLOWED_TRANSITIONS);
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status value. Must be one of: ${validStatuses.join(', ')}` });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch and lock current status row
    const selectRes = await client.query(
      'SELECT status, current_stage, metadata, created_at, candidate_id FROM upload_status WHERE upload_id = $1 FOR UPDATE',
      [uploadId]
    );

    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Upload status record not found.' });
    }

    const row = selectRes.rows[0];
    req.candidateId = row.candidate_id;
    const currentStatus = row.status;

    // Validate transition
    if (status !== currentStatus) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Invalid state transition',
          reason: `Cannot transition from '${currentStatus}' to '${status}'`
        });
      }
    }

    // Merge metadata
    const mergedMetadata = metadata ? { ...row.metadata, ...metadata } : row.metadata;

    // Update row
    const updateQuery = `
      UPDATE upload_status
      SET status = $1, current_stage = $2, error_message = $3, metadata = $4, updated_at = NOW()
      WHERE upload_id = $5
      RETURNING upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at
    `;
    const updateRes = await client.query(updateQuery, [
      status,
      current_stage,
      error_message || null,
      JSON.stringify(mergedMetadata),
      uploadId
    ]);

    await client.query('COMMIT');

    // Calculate durationMs since created_at
    const durationMs = Date.now() - new Date(row.created_at).getTime();

    // Pino transition logging requirement
    logger.info({
      uploadId,
      fromStatus: currentStatus,
      toStatus: status,
      currentStage: current_stage,
      durationMs
    }, `Status transition recorded from ${currentStatus} to ${status}`);

    res.json(updateRes.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({
      requestId,
      uploadId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error during status update');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// GET /orchestrator/status/:uploadId - Get full upload status details
app.get('/orchestrator/status/:uploadId', requireAuth, async (req, res) => {
  req.action = 'get_status';
  const { uploadId } = req.params;
  const requestId = req.requestId;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format. Must be a valid UUID.' });
  }

  try {
    const queryText = `
      SELECT upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at
      FROM upload_status
      WHERE upload_id = $1
    `;
    const result = await db.query(queryText, [uploadId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Upload status record not found.' });
    }

    const row = result.rows[0];
    req.candidateId = row.candidate_id;

    res.json(row);
  } catch (err) {
    logger.error({
      requestId,
      uploadId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error retrieving status details');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/status/candidate/:candidateId - Get all upload statuses for a candidate
app.get('/orchestrator/status/candidate/:candidateId', requireAuth, async (req, res) => {
  req.action = 'get_candidate_statuses';
  const { candidateId } = req.params;
  const requestId = req.requestId;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }

  req.candidateId = candidateId;

  try {
    const queryText = `
      SELECT upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at
      FROM upload_status
      WHERE candidate_id = $1
      ORDER BY created_at DESC
    `;
    const result = await db.query(queryText, [candidateId]);

    res.json(result.rows);
  } catch (err) {
    logger.error({
      requestId,
      candidateId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error retrieving candidate statuses');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/audit/:uploadId - Get full audit log for an upload in chronological order
app.get('/orchestrator/audit/:uploadId', requireAuth, async (req, res) => {
  req.action = 'get_audit';
  const { uploadId } = req.params;
  const requestId = req.requestId;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format. Must be a valid UUID.' });
  }

  try {
    const queryText = `
      SELECT id, upload_id, candidate_id, stage, event_type, payload, error_message, created_at
      FROM pipeline_audit_log
      WHERE upload_id = $1
      ORDER BY created_at ASC
    `;
    const result = await db.query(queryText, [uploadId]);
    res.json(result.rows);
  } catch (err) {
    logger.error({
      requestId,
      uploadId,
      action: req.action,
      err: err.message,
      stack: err.stack,
    }, 'Error retrieving audit logs');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Upload Orchestrator service running on port ${PORT}`);
});


