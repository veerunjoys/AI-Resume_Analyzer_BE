/**
 * pipeline/orchestrator.js
 *
 * In-process Upload Orchestrator — replaces the standalone rw-upload-orchestrator microservice.
 * - Provides Express routes for /orchestrator/* endpoints
 * - Exposes getUploadStatus() and patchUploadStatus() for direct use by workers
 *   (replacing HTTP calls to localhost:4005)
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('../config');
const db = require('../db');

const logger = pino({ level: config.logLevel });
const router = express.Router();

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    req.recruiter = jwt.verify(authHeader.split(' ')[1], config.jwtSecret);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

// ─── Request Logging Middleware ──────────────────────────────────────────────
// Note: mounted at app root in index.js, so this actually logs every request
// the server handles (not just /orchestrator/* routes) — labeled "API" accordingly.
router.use((req, res, next) => {
  const start = process.hrtime();
  req.requestId = crypto.randomUUID();
  req.candidateId = null;
  res.on('finish', () => {
    const diff = process.hrtime(start);
    const durationMs = Math.round((diff[0] * 1e9 + diff[1]) / 1e6);
    const candidateId = req.candidateId || req.body?.candidateId || req.query?.candidateId || null;
    logger.info({ requestId: req.requestId, candidateId, durationMs, statusCode: res.statusCode },
      `API: ${req.method} ${req.path}`);
  });
  next();
});

// ─── Validation Helpers ──────────────────────────────────────────────────────
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Valid lifecycle status transitions
const ALLOWED_TRANSITIONS = {
  received: ['validated', 'failed'],
  validated: ['queued', 'failed'],
  queued: ['processing', 'failed'],
  processing: ['indexed', 'failed'],
  indexed: ['completed', 'failed'],
  completed: [],
  failed: [],
};

// ─── Internal Functions (used by workers directly) ───────────────────────────

/**
 * Fetch upload status directly from DB (replaces HTTP GET /orchestrator/status/:id).
 * @param {string} uploadId
 * @returns {object} Status row
 */
async function getUploadStatus(uploadId) {
  const result = await db.query(
    `SELECT upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at
     FROM upload_status WHERE upload_id = $1`,
    [uploadId]
  );
  if (result.rows.length === 0) {
    throw new Error(`Upload status not found: ${uploadId}`);
  }
  return result.rows[0];
}

/**
 * Update upload status directly in DB (replaces HTTP PATCH /orchestrator/status/:id).
 * Enforces ALLOWED_TRANSITIONS.
 * @param {string} uploadId
 * @param {object} data — { status, current_stage, error_message?, metadata? }
 * @returns {object} Updated row
 */
async function patchUploadStatus(uploadId, data) {
  const { status, current_stage, error_message, metadata } = data;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const selectRes = await client.query(
      'SELECT status, metadata FROM upload_status WHERE upload_id = $1 FOR UPDATE',
      [uploadId]
    );
    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      throw new Error(`Upload status not found: ${uploadId}`);
    }
    const row = selectRes.rows[0];
    const currentStatus = row.status;

    if (status !== currentStatus) {
      const allowed = ALLOWED_TRANSITIONS[currentStatus] || [];
      if (!allowed.includes(status)) {
        await client.query('ROLLBACK');
        throw new Error(`Invalid transition from '${currentStatus}' to '${status}'`);
      }
    }

    const mergedMetadata = metadata ? { ...row.metadata, ...metadata } : row.metadata;
    const updateRes = await client.query(
      `UPDATE upload_status
       SET status = $1, current_stage = $2, error_message = $3, metadata = $4, updated_at = NOW()
       WHERE upload_id = $5
       RETURNING upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at`,
      [status, current_stage, error_message || null, JSON.stringify(mergedMetadata), uploadId]
    );
    await client.query('COMMIT');
    logger.info({ uploadId, fromStatus: currentStatus, toStatus: status }, 'Status transition recorded');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// POST /orchestrator/credentials — Request secure upload token
router.post('/orchestrator/credentials', requireAuth, async (req, res) => {
  const { candidateId, fileName } = req.body;
  if (!fileName) {
    return res.status(400).json({ error: 'fileName is a required field.' });
  }
  if (candidateId && !uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }
  try {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query(
      `INSERT INTO upload_credentials (token, candidate_id, file_name) VALUES ($1, $2, $3)`,
      [token, candidateId || null, fileName]
    );
    res.status(201).json({
      token,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to generate upload credentials');
    if (err.code === '23503') return res.status(404).json({ error: 'Candidate not found.' });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /orchestrator/validate — Validate upload token
router.post('/orchestrator/validate', requireAuth, async (req, res) => {
  const { uploadToken, candidateId, fileName, fileSizeBytes, mimeType } = req.body;
  if (!uploadToken || !fileName || fileSizeBytes === undefined || !mimeType) {
    return res.status(400).json({ error: 'Validation failed', reason: 'Missing required fields' });
  }
  if (candidateId && !uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Validation failed', reason: 'Invalid candidateId format' });
  }
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  if (!allowedMimeTypes.includes(mimeType)) {
    return res.status(400).json({ error: 'Validation failed', reason: `Unsupported mimeType: ${mimeType}` });
  }
  const MAX_SIZE_BYTES = 20 * 1024 * 1024;
  if (fileSizeBytes >= MAX_SIZE_BYTES) {
    return res.status(400).json({ error: 'Validation failed', reason: 'File size exceeds 20MB limit' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const selectRes = await client.query(
      'SELECT candidate_id, expires_at, used FROM upload_credentials WHERE token = $1 FOR UPDATE',
      [uploadToken]
    );
    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed', reason: 'Upload token not found' });
    }
    const credential = selectRes.rows[0];
    if (credential.candidate_id && candidateId && credential.candidate_id !== candidateId) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed', reason: 'Token does not match candidateId' });
    }
    if (credential.used) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed', reason: 'Token already used' });
    }
    if (new Date(credential.expires_at) <= new Date()) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed', reason: 'Token expired' });
    }

    const uploadId = crypto.randomUUID();
    await client.query('UPDATE upload_credentials SET used = true WHERE token = $1', [uploadToken]);
    await client.query(
      `INSERT INTO upload_status (upload_id, candidate_id, file_name, status, current_stage, metadata)
       VALUES ($1, $2, $3, 'received', 'received', '{}'::jsonb)`,
      [uploadId, candidateId || null, fileName]
    );
    await client.query('COMMIT');
    res.json({ valid: true, uploadId });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ err: err.message }, 'Error during credential validation');
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// POST /orchestrator/dedup-check — Duplicate resume detection
router.post('/orchestrator/dedup-check', requireAuth, async (req, res) => {
  const { checksum, candidateId, uploadId } = req.body;
  if (!checksum) return res.status(400).json({ error: 'checksum is required.' });

  const sha256Regex = /^[0-9a-f]{64}$/i;
  if (!sha256Regex.test(checksum)) {
    return res.status(400).json({ error: 'Invalid checksum format. Must be SHA-256 hex.' });
  }
  if (candidateId && !uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format.' });
  }
  if (uploadId && !uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format.' });
  }

  try {
    const checkRes = await db.query(
      'SELECT candidate_id, upload_id FROM resume_checksums WHERE checksum = $1',
      [checksum]
    );
    if (checkRes.rows.length > 0) {
      return res.json({
        duplicate: true,
        existingCandidateId: checkRes.rows[0].candidate_id,
        existingUploadId: checkRes.rows[0].upload_id,
      });
    }

    if (candidateId && uploadId) {
      await db.query(
        `INSERT INTO resume_checksums (checksum, candidate_id, upload_id, uploaded_at) VALUES ($1, $2, $3, NOW())`,
        [checksum, candidateId, uploadId]
      );

      // Emit ResumeUploaded domain event in-process
      try {
        const statusRes = await db.query('SELECT file_name FROM upload_status WHERE upload_id = $1', [uploadId]);
        const fileName = statusRes.rows[0]?.file_name || 'resume.pdf';
        const candRes = await db.query('SELECT resume_s3_key FROM candidates WHERE id = $1', [candidateId]);
        const resumeS3Key = candRes.rows[0]?.resume_s3_key || null;
        const { emitEventDirect } = require('./eventSystem');
        await emitEventDirect('ResumeUploaded', candidateId,
          { uploadId, candidateId, fileName, checksum, resumeS3Key },
          uploadId, null,
          { source: 'upload-orchestrator', version: '1.0.0' }
        );
      } catch (emitErr) {
        logger.error({ err: emitErr.message }, 'Failed to emit ResumeUploaded event');
      }
    }

    res.json({ duplicate: false });
  } catch (err) {
    logger.error({ err: err.message }, 'Error during duplicate check');
    if (err.code === '23503') return res.status(404).json({ error: 'Candidate not found.' });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /orchestrator/status — Create a new upload status tracker
router.post('/orchestrator/status', requireAuth, async (req, res) => {
  const { candidateId, fileName } = req.body;
  if (!candidateId || !fileName) {
    return res.status(400).json({ error: 'candidateId and fileName are required.' });
  }
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format.' });
  }
  try {
    const uploadId = crypto.randomUUID();
    const result = await db.query(
      `INSERT INTO upload_status (upload_id, candidate_id, file_name, status, current_stage, metadata)
       VALUES ($1, $2, $3, 'received', 'received', '{}'::jsonb) RETURNING upload_id`,
      [uploadId, candidateId, fileName]
    );
    res.status(201).json({ uploadId: result.rows[0].upload_id });
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to create upload status');
    if (err.code === '23503') return res.status(404).json({ error: 'Candidate not found.' });
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /orchestrator/status/:uploadId — Update upload status lifecycle
router.patch('/orchestrator/status/:uploadId', requireAuth, async (req, res) => {
  const { uploadId } = req.params;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format.' });
  }
  const { status, current_stage, error_message, metadata } = req.body;
  if (!status || !current_stage) {
    return res.status(400).json({ error: 'status and current_stage are required.' });
  }
  const validStatuses = Object.keys(ALLOWED_TRANSITIONS);
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
  }
  try {
    const updated = await patchUploadStatus(uploadId, { status, current_stage, error_message, metadata });
    res.json(updated);
  } catch (err) {
    if (err.message.includes('Invalid transition') || err.message.includes('not found')) {
      return res.status(400).json({ error: err.message });
    }
    logger.error({ err: err.message }, 'Error during status update');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/uploads/recent — Recent uploads across all candidates, for the Upload Queue page
router.get('/orchestrator/uploads/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
    const result = await db.query(
      `SELECT u.upload_id, u.candidate_id, u.file_name, u.status, u.current_stage, u.error_message,
              u.created_at, u.updated_at, c.name AS candidate_name
       FROM upload_status u
       LEFT JOIN candidates c ON c.id = u.candidate_id
       ORDER BY u.created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ uploads: result.rows });
  } catch (err) {
    logger.error({ err: err.message }, 'Error retrieving recent uploads');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/status/:uploadId — Get full upload status details
router.get('/orchestrator/status/:uploadId', requireAuth, async (req, res) => {
  const { uploadId } = req.params;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format.' });
  }
  try {
    const row = await getUploadStatus(uploadId);
    res.json(row);
  } catch (err) {
    if (err.message.includes('not found')) return res.status(404).json({ error: err.message });
    logger.error({ err: err.message }, 'Error retrieving status');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/status/candidate/:candidateId — All uploads for a candidate
router.get('/orchestrator/status/candidate/:candidateId', requireAuth, async (req, res) => {
  const { candidateId } = req.params;
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format.' });
  }
  try {
    const result = await db.query(
      `SELECT upload_id, candidate_id, file_name, status, current_stage, error_message, metadata, created_at, updated_at
       FROM upload_status WHERE candidate_id = $1 ORDER BY created_at DESC`,
      [candidateId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message }, 'Error retrieving candidate statuses');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /orchestrator/audit/:uploadId — Full audit log for an upload
router.get('/orchestrator/audit/:uploadId', requireAuth, async (req, res) => {
  const { uploadId } = req.params;
  if (!uuidRegex.test(uploadId)) {
    return res.status(400).json({ error: 'Invalid uploadId format.' });
  }
  try {
    const result = await db.query(
      `SELECT id, upload_id, candidate_id, stage, event_type, payload, error_message, created_at
       FROM pipeline_audit_log WHERE upload_id = $1 ORDER BY created_at ASC`,
      [uploadId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message }, 'Error retrieving audit logs');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = { router, getUploadStatus, patchUploadStatus };
