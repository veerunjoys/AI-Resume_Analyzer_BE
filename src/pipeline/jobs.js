/**
 * pipeline/jobs.js
 *
 * Job Management — CRUD for job postings, plus resume-to-job matching
 * triggers and the ranked-applicant list. Matching itself runs async via
 * matchingQueue/matching.worker.js, following the same pattern as the
 * resume-processing pipeline.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('../config');
const db = require('../db');
const { matchingQueue } = require('./queues');

const logger = pino({ level: config.logLevel });
const router = express.Router();

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_JOB_STATUSES = ['draft', 'open', 'closed'];
const ALLOWED_APPLICATION_STATUSES = ['applied', 'screening', 'interview', 'offer', 'rejected'];

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

// ─── Job CRUD ──────────────────────────────────────────────────────────────

// POST /api/jobs — create a job posting
router.post('/api/jobs', requireAuth, async (req, res) => {
  try {
    const { title, description, department, location, employmentType, minExperience, requiredSkills, status } = req.body;

    if (!title || !description) {
      return res.status(400).json({ error: 'title and description are required.' });
    }
    if (status && !ALLOWED_JOB_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ALLOWED_JOB_STATUSES.join(', ')}` });
    }

    const result = await db.query(
      `INSERT INTO jobs (recruiter_id, title, description, department, location, employment_type, min_experience, required_skills, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, recruiter_id, title, description, department, location, employment_type, min_experience, required_skills, status, created_at, updated_at`,
      [
        req.recruiter.id, title, description, department || null, location || null,
        employmentType || null, minExperience ?? null, requiredSkills || [], status || 'draft'
      ]
    );
    const job = result.rows[0];

    try {
      const { emitEventDirect } = require('./eventSystem');
      await emitEventDirect('JobCreated', job.id, job, req.correlationId || job.id, null, { source: 'jobs', version: '1.0.0' });
    } catch (emitErr) {
      logger.error({ err: emitErr.message }, 'Failed to emit JobCreated event');
    }

    res.status(201).json(job);
  } catch (error) {
    logger.error({ err: error.message }, 'Error creating job');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/jobs — list jobs, most recent first
router.get('/api/jobs', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const clauses = [];
    const params = [];

    if (status) {
      if (!ALLOWED_JOB_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${ALLOWED_JOB_STATUSES.join(', ')}` });
      }
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await db.query(
      `SELECT j.id, j.title, j.department, j.location, j.employment_type, j.min_experience, j.required_skills, j.status, j.created_at, j.updated_at,
              (SELECT COUNT(*) FROM applications a WHERE a.job_id = j.id) AS application_count
       FROM jobs j ${whereClause} ORDER BY j.created_at DESC LIMIT 200`,
      params
    );
    res.json({ jobs: result.rows });
  } catch (error) {
    logger.error({ err: error.message }, 'Error listing jobs');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/jobs/:id — job detail
router.get('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });

    const result = await db.query('SELECT * FROM jobs WHERE id = $1', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json(result.rows[0]);
  } catch (error) {
    logger.error({ err: error.message }, 'Error fetching job');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUT /api/jobs/:id — update a job posting
router.put('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });

    const { title, description, department, location, employmentType, minExperience, requiredSkills, status } = req.body;
    if (status && !ALLOWED_JOB_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ALLOWED_JOB_STATUSES.join(', ')}` });
    }

    const existing = await db.query('SELECT id FROM jobs WHERE id = $1', [id]);
    if (existing.rows.length === 0) return res.status(404).json({ error: 'Job not found' });

    const result = await db.query(
      `UPDATE jobs SET
         title = COALESCE($1, title), description = COALESCE($2, description),
         department = COALESCE($3, department), location = COALESCE($4, location),
         employment_type = COALESCE($5, employment_type), min_experience = COALESCE($6, min_experience),
         required_skills = COALESCE($7, required_skills), status = COALESCE($8, status),
         updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [title, description, department, location, employmentType, minExperience, requiredSkills, status, id]
    );
    const job = result.rows[0];

    try {
      const { emitEventDirect } = require('./eventSystem');
      await emitEventDirect('JobUpdated', job.id, job, req.correlationId || job.id, null, { source: 'jobs', version: '1.0.0' });
    } catch (emitErr) {
      logger.error({ err: emitErr.message }, 'Failed to emit JobUpdated event');
    }

    res.json(job);
  } catch (error) {
    logger.error({ err: error.message }, 'Error updating job');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /api/jobs/:id
router.delete('/api/jobs/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });

    const result = await db.query('DELETE FROM jobs WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Job not found' });
    res.json({ success: true });
  } catch (error) {
    logger.error({ err: error.message }, 'Error deleting job');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─── Matching + Ranking ──────────────────────────────────────────────────────

// POST /api/jobs/:id/match — enqueue matching for every non-Draft candidate against this job
router.post('/api/jobs/:id/match', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });

    const jobRes = await db.query('SELECT id FROM jobs WHERE id = $1', [id]);
    if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Job not found' });

    const candidatesRes = await db.query(`SELECT id FROM candidates WHERE status != 'Draft'`);

    let enqueued = 0;
    for (const candidate of candidatesRes.rows) {
      const appRes = await db.query(
        `INSERT INTO applications (job_id, candidate_id) VALUES ($1, $2)
         ON CONFLICT (job_id, candidate_id) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [id, candidate.id]
      );
      await matchingQueue.add({ jobId: id, candidateId: candidate.id, applicationId: appRes.rows[0].id });
      enqueued++;
    }

    res.json({ enqueued });
  } catch (error) {
    logger.error({ err: error.message }, 'Error triggering job matching');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/jobs/:id/applications — link a single candidate to a job (and enqueue their match)
router.post('/api/jobs/:id/applications', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { candidateId } = req.body;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });
    if (!candidateId || !uuidRegex.test(candidateId)) return res.status(400).json({ error: 'Invalid candidateId format' });

    const jobRes = await db.query('SELECT id FROM jobs WHERE id = $1', [id]);
    if (jobRes.rows.length === 0) return res.status(404).json({ error: 'Job not found' });

    const appRes = await db.query(
      `INSERT INTO applications (job_id, candidate_id) VALUES ($1, $2)
       ON CONFLICT (job_id, candidate_id) DO UPDATE SET updated_at = NOW()
       RETURNING *`,
      [id, candidateId]
    );
    const application = appRes.rows[0];
    await matchingQueue.add({ jobId: id, candidateId, applicationId: application.id });

    res.status(201).json(application);
  } catch (error) {
    if (error.code === '23503') return res.status(404).json({ error: 'Candidate not found.' });
    logger.error({ err: error.message }, 'Error creating application');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PATCH /api/applications/:id — update an application's pipeline status (applied/screening/interview/offer/rejected)
router.patch('/api/applications/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid application ID format' });
    if (!status || !ALLOWED_APPLICATION_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${ALLOWED_APPLICATION_STATUSES.join(', ')}` });
    }

    const result = await db.query(
      `UPDATE applications SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
    const application = result.rows[0];

    try {
      const { emitEventDirect } = require('./eventSystem');
      await emitEventDirect('ApplicationStatusChanged', application.candidate_id, application, req.correlationId || application.id, null, { source: 'jobs', version: '1.0.0' });
    } catch (emitErr) {
      logger.error({ err: emitErr.message }, 'Failed to emit ApplicationStatusChanged event');
    }

    res.json(application);
  } catch (error) {
    logger.error({ err: error.message }, 'Error updating application status');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/jobs/:id/candidates — ranked applicant list for a job (highest match_score first)
router.get('/api/jobs/:id/candidates', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!uuidRegex.test(id)) return res.status(400).json({ error: 'Invalid job ID format' });

    const result = await db.query(
      `SELECT a.id AS application_id, a.status AS application_status, a.match_score, a.matched_skills,
              a.missing_skills, a.experience_match, a.ai_recommendation, a.created_at AS applied_at,
              c.id AS candidate_id, c.name, c.email, c.phone, c.location, c.skills, c.experience, c.resume_s3_key
       FROM applications a
       JOIN candidates c ON c.id = a.candidate_id
       WHERE a.job_id = $1
       ORDER BY a.match_score DESC NULLS LAST, a.created_at ASC`,
      [id]
    );
    res.json({ candidates: result.rows });
  } catch (error) {
    logger.error({ err: error.message }, 'Error fetching ranked candidates');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = { router };
