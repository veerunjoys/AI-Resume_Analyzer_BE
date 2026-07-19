const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const config = require('./config');
const db = require('./db');
const storage = require('./storage');
const { initWebSocketServer, broadcast } = require('./websocket');
const { emitDomainEvent } = require('./events');

// Pipeline modules (all merged into this server process)
const { router: eventSystemRouter, emitEventDirect } = require('./pipeline/eventSystem');
const { router: orchestratorRouter } = require('./pipeline/orchestrator');
const { router: searchRouter } = require('./pipeline/search');
const { router: jobsRouter } = require('./pipeline/jobs');
const { bootstrapProcessorSubscription } = require('./pipeline/processor');

// Initialize local uploads folder structure
storage.initStorage();

const app = express();

// ─── Middleware ───────────────────────────────────────────────────────────────
// Correlation ID — applied first
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = correlationId;
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser requests (curl, server-to-server, health checks) with no Origin header
    if (!origin || config.corsOrigins.includes(origin) || config.corsOriginPattern.test(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`Not allowed by CORS: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

// ─── Pipeline Routers (mounted on the same port as the main API) ──────────────
app.use('/', eventSystemRouter);   // /events/stream, /events/emit, /events/candidate/:id …
app.use('/', orchestratorRouter);  // /orchestrator/credentials, /orchestrator/status/:id …
app.use('/', searchRouter);        // /search/candidates, /search/health, /search/metrics …
app.use('/', jobsRouter);          // /api/jobs, /api/jobs/:id/match, /api/jobs/:id/candidates …

// Email format validation helper
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

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

// Public Auth Endpoints
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long.' });
    }

    // Check if email already exists
    const existing = await db.query('SELECT id FROM recruiters WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email is already registered.' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Insert recruiter
    const result = await db.query(
      `INSERT INTO recruiters (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id, name, email`,
      [name, email, passwordHash]
    );

    const recruiter = result.rows[0];

    // Sign JWT
    const token = jwt.sign(
      { id: recruiter.id, name: recruiter.name, email: recruiter.email },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.status(201).json({ token });
  } catch (error) {
    console.error('Error during registration:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const result = await db.query(
      'SELECT id, name, email, password_hash FROM recruiters WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const recruiter = result.rows[0];
    const isMatch = await bcrypt.compare(password, recruiter.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign(
      { id: recruiter.id, name: recruiter.name, email: recruiter.email },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.json({ token });
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// Helper to convert search query into tsquery string for prefix search
function convertToTsQuery(searchString) {
  if (!searchString) return '';
  const terms = searchString
    .trim()
    .split(/\s+/)
    .map(t => t.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(t => t.length > 0)
    .map(t => `${t}:*`);
  
  return terms.length > 0 ? terms.join(' & ') : '';
}

// Helpers for encoding/decoding cursor
function encodeCursor(cursorObj) {
  return Buffer.from(JSON.stringify(cursorObj)).toString('base64');
}

function decodeCursor(cursorStr) {
  try {
    return JSON.parse(Buffer.from(cursorStr, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

// GET /api/candidates - Keyset pagination, status/skill filter, search
app.get('/api/candidates', requireAuth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const { status, skill, skills, location, search, cursor, hasResume } = req.query;

    const tsQueryStr = convertToTsQuery(search);
    const skillsQuery = skills || skill;
    const skillList = skillsQuery ? skillsQuery.split(',').filter(Boolean) : [];

    let queryText = '';
    const values = [];

    if (tsQueryStr) {
      // Search-based query
      let paramCount = 1;
      values.push(tsQueryStr); // $1

      const conditions = [`search_vector @@ to_tsquery('simple', $1)`];

      if (status) {
        paramCount++;
        conditions.push(`status = $${paramCount}`);
        values.push(status);
      }

      if (skillList.length > 0) {
        paramCount++;
        conditions.push(`skills @> $${paramCount}::text[]`);
        values.push(skillList);
      }

      if (location) {
        paramCount++;
        conditions.push(`location = $${paramCount}`);
        values.push(location);
      }

      if (hasResume === 'true') {
        conditions.push('resume_s3_key IS NOT NULL');
      }

      if (cursor) {
        const cursorObj = decodeCursor(cursor);
        if (cursorObj && cursorObj.id && cursorObj.search_rank !== undefined) {
          const rankParam = ++paramCount;
          values.push(parseFloat(cursorObj.search_rank));

          const idParam = ++paramCount;
          values.push(cursorObj.id);

          conditions.push(`(
            ts_rank(c.search_vector, to_tsquery('simple', $1)) < $${rankParam} OR 
            (ts_rank(c.search_vector, to_tsquery('simple', $1)) = $${rankParam} AND c.id > $${idParam})
          )`);
        }
      }

      const limitParam = ++paramCount;
      values.push(limit);

      queryText = `
        SELECT
          c.id,
          c.name,
          c.email,
          c.phone,
          c.status,
          c.skills,
          c.updated_at,
          c.resume_s3_key,
          c.experience,
          c.location,
          ts_rank(c.search_vector, to_tsquery('simple', $1)) AS search_rank,
          COALESCE(
            ts_headline(
              'english',
              r.raw_text,
              to_tsquery('simple', $1),
              'MaxWords=30, MinWords=10, MaxFragments=1'
            ),
            ''
          ) AS resume_snippet
        FROM candidates c
        LEFT JOIN resume_content r ON c.id = r.candidate_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY search_rank DESC, c.id ASC
        LIMIT $${limitParam}
      `;
    } else {
      // Standard non-search query
      let paramCount = 0;
      const conditions = [];

      if (status) {
        paramCount++;
        conditions.push(`status = $${paramCount}`);
        values.push(status);
      }

      if (skillList.length > 0) {
        paramCount++;
        conditions.push(`skills @> $${paramCount}::text[]`);
        values.push(skillList);
      }

      if (location) {
        paramCount++;
        conditions.push(`location = $${paramCount}`);
        values.push(location);
      }

      if (hasResume === 'true') {
        conditions.push('resume_s3_key IS NOT NULL');
      }

      if (cursor) {
        // Cursor is a composite base64 encoded object containing { name, id }
        const cursorObj = decodeCursor(cursor);
        if (cursorObj && cursorObj.id && cursorObj.name !== undefined) {
          paramCount++;
          values.push(cursorObj.name);
          const nameParam = paramCount;

          paramCount++;
          values.push(cursorObj.id);
          const idParam = paramCount;

          conditions.push(`(
            name > $${nameParam} OR
            (name = $${nameParam} AND id > $${idParam})
          )`);
        }
      }

      paramCount++;
      const limitParam = paramCount;
      values.push(limit);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      queryText = `
        SELECT id, name, email, phone, status, skills, updated_at, resume_s3_key, experience
        FROM candidates
        ${whereClause}
        ORDER BY name ASC, id ASC
        LIMIT $${limitParam}
      `;
    }

    const result = await db.query(queryText, values);
    const candidates = result.rows;

    let totalCount = 10000;
    // Only fetch total count if cursor is not provided (initial fetch) to avoid DB overhead on paging
    if (!cursor) {
      let countQuery = 'SELECT COUNT(*) FROM candidates';
      let countValues = [];
      
      if (tsQueryStr) {
        // Build search conditions for count
        const countConditions = [`search_vector @@ to_tsquery('simple', $1)`];
        countValues.push(tsQueryStr);
        let countParam = 1;
        
        if (status) {
          countParam++;
          countConditions.push(`status = $${countParam}`);
          countValues.push(status);
        }
        if (skillList.length > 0) {
          countParam++;
          countConditions.push(`skills @> $${countParam}::text[]`);
          countValues.push(skillList);
        }
        if (location) {
          countParam++;
          countConditions.push(`location = $${countParam}`);
          countValues.push(location);
        }
        if (hasResume === 'true') {
          countConditions.push('resume_s3_key IS NOT NULL');
        }
        countQuery = `SELECT COUNT(*) FROM candidates WHERE ${countConditions.join(' AND ')}`;
      } else {
        const countConditions = [];
        let countParam = 0;
        if (status) {
          countParam++;
          countConditions.push(`status = $${countParam}`);
          countValues.push(status);
        }
        if (skillList.length > 0) {
          countParam++;
          countConditions.push(`skills @> $${countParam}::text[]`);
          countValues.push(skillList);
        }
        if (location) {
          countParam++;
          countConditions.push(`location = $${countParam}`);
          countValues.push(location);
        }
        if (hasResume === 'true') {
          countConditions.push('resume_s3_key IS NOT NULL');
        }
        if (countConditions.length > 0) {
          countQuery = `SELECT COUNT(*) FROM candidates WHERE ${countConditions.join(' AND ')}`;
        }
      }
      const countRes = await db.query(countQuery, countValues);
      totalCount = parseInt(countRes.rows[0].count, 10);
    }

    let nextCursor = null;
    if (candidates.length === limit) {
      const lastItem = candidates[candidates.length - 1];
      if (tsQueryStr) {
        nextCursor = encodeCursor({ id: lastItem.id, search_rank: parseFloat(lastItem.search_rank) });
      } else {
        nextCursor = encodeCursor({ id: lastItem.id, name: lastItem.name });
      }
    }

    res.json({
      candidates,
      nextCursor,
      totalCount,
    });
  } catch (error) {
    console.error('Error fetching candidates:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/locations - Fetch unique candidate locations
app.get('/api/locations', requireAuth, async (req, res) => {
  try {
    const result = await db.query(`
      SELECT DISTINCT location 
      FROM candidates 
      WHERE location IS NOT NULL AND location != ''
      ORDER BY location ASC
    `);
    const locations = result.rows.map(r => r.location);
    res.json(locations);
  } catch (error) {
    console.error('Error fetching locations:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/candidates/:id - Get full record
app.get('/api/candidates/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid candidate ID format' });
    }

    const queryText = `
      SELECT id, name, email, phone, location, skills, status, source, notes, resume_s3_key, version, experience, created_at, updated_at
      FROM candidates
      WHERE id = $1
    `;
    const result = await db.query(queryText, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Candidate not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching candidate details:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/candidates/:id/parsed-resume - Get parsed resume JSONB and metadata
app.get('/api/candidates/:id/parsed-resume', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid candidate ID format' });
    }

    const queryText = `
      SELECT 
        c.id AS candidate_id,
        c.extraction_metadata,
        r.parsed_data
      FROM candidates c
      INNER JOIN resume_content r ON c.id = r.candidate_id
      WHERE c.id = $1
    `;
    const result = await db.query(queryText, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No parsed resume data found for this candidate.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching parsed resume data:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/candidates/:id/ai-analysis - Get the latest AI resume-quality analysis
app.get('/api/candidates/:id/ai-analysis', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(id)) {
      return res.status(400).json({ error: 'Invalid candidate ID format' });
    }

    const result = await db.query(
      `SELECT candidate_id, overall_score, category_scores, strengths, weaknesses, missing_skills, summary, recommendation, model, created_at
       FROM ai_analysis WHERE candidate_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No AI analysis found for this candidate.' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching AI analysis:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/sync/replay - Replay queued offline actions
app.post('/api/sync/replay', requireAuth, async (req, res) => {
  try {
    const actions = req.body;
    if (!Array.isArray(actions)) {
      return res.status(400).json({ error: 'Body must be an array of actions.' });
    }

    const results = [];

    for (const action of actions) {
      const { client_action_id, candidate_id, base_version, changes } = action;
      if (!client_action_id || !candidate_id || base_version === undefined || !changes) {
        results.push({
          client_action_id,
          status: 'error',
          error: 'Missing required action parameters.'
        });
        continue;
      }

      try {
        // 1. Get current candidate row
        const currentRes = await db.query(
          'SELECT version, status, notes FROM candidates WHERE id = $1',
          [candidate_id]
        );
        if (currentRes.rows.length === 0) {
          results.push({
            client_action_id,
            status: 'error',
            error: 'Candidate not found.'
          });
          continue;
        }
        const currentVal = currentRes.rows[0];

        // 2. If version matches, apply directly
        if (currentVal.version === base_version) {
          const updatedStatus = changes.status !== undefined ? changes.status : currentVal.status;
          const updatedNotes = changes.notes !== undefined ? changes.notes : currentVal.notes;

          const updateRes = await db.query(
            `UPDATE candidates 
             SET status = $1, notes = $2, version = version + 1, updated_at = now() 
             WHERE id = $3 
             RETURNING id, name, email, phone, status, skills, notes, version, created_at, updated_at`,
            [updatedStatus, updatedNotes, candidate_id]
          );
          const updatedCand = updateRes.rows[0];

          // Insert offline_action_log with conflict=false
          await db.query(
            `INSERT INTO offline_action_log (client_action_id, candidate_id, base_version, action_payload, applied_at, conflict)
             VALUES ($1, $2, $3, $4, now(), false)`,
            [client_action_id, candidate_id, base_version, JSON.stringify(changes)]
          );

          // Broadcast update over WebSocket gateway
          await broadcast('candidate_updated', candidate_id, updatedCand, req.headers['x-client-id']);

          results.push({
            client_action_id,
            status: 'applied'
          });
        } else {
          // Version mismatch! Check conflicts
          // 3. Find prior state from candidate_events (closest event at or before base_version)
          const eventRes = await db.query(
            `SELECT payload 
             FROM candidate_events 
             WHERE candidate_id = $1 
               AND (payload->>'version')::int <= $2 
               AND event_type IN ('candidate_created', 'candidate_updated')
             ORDER BY sequence_id DESC
             LIMIT 1`,
            [candidate_id, base_version]
          );

          let priorVal = null;
          if (eventRes.rows.length > 0) {
            priorVal = eventRes.rows[0].payload;
          } else {
            priorVal = currentVal;
          }

          const appliedChanges = {};
          const conflictedFields = {};
          let hasConflict = false;

          // Fields to check: status, notes
          const fields = ['status', 'notes'];
          for (const field of fields) {
            if (changes[field] !== undefined) {
              const dbVal = currentVal[field] !== undefined && currentVal[field] !== null ? currentVal[field] : null;
              const prVal = priorVal[field] !== undefined && priorVal[field] !== null ? priorVal[field] : null;

              if (dbVal !== prVal) {
                // Field changed on server since base_version -> Conflict!
                conflictedFields[field] = dbVal;
                hasConflict = true;
              } else {
                // Field did not change on server since base_version -> Safe to apply!
                appliedChanges[field] = changes[field];
              }
            }
          }

          if (hasConflict) {
            // Apply non-conflicting changes if any
            const finalStatus = appliedChanges.status !== undefined ? appliedChanges.status : currentVal.status;
            const finalNotes = appliedChanges.notes !== undefined ? appliedChanges.notes : currentVal.notes;

            let updatedCand = currentVal;
            const fieldsToUpdate = Object.keys(appliedChanges);
            if (fieldsToUpdate.length > 0) {
              const updateRes = await db.query(
                `UPDATE candidates 
                 SET status = $1, notes = $2, version = version + 1, updated_at = now() 
                 WHERE id = $3 
                 RETURNING id, name, email, phone, status, skills, notes, version, created_at, updated_at`,
                [finalStatus, finalNotes, candidate_id]
              );
              updatedCand = updateRes.rows[0];
              await emitDomainEvent('CandidateUpdated', candidate_id, updatedCand, req.correlationId);
            }

            // Insert offline_action_log with conflict=true
            await db.query(
              `INSERT INTO offline_action_log (client_action_id, candidate_id, base_version, action_payload, applied_at, conflict)
               VALUES ($1, $2, $3, $4, now(), true)`,
              [client_action_id, candidate_id, base_version, JSON.stringify(changes)]
            );

            results.push({
              client_action_id,
              status: 'conflict',
              conflicts: conflictedFields,
              currentServerValues: {
                status: updatedCand.status,
                notes: updatedCand.notes,
                version: updatedCand.version
              }
            });
          } else {
            // No conflict! Apply all changed fields
            const finalStatus = changes.status !== undefined ? changes.status : currentVal.status;
            const finalNotes = changes.notes !== undefined ? changes.notes : currentVal.notes;

            const updateRes = await db.query(
              `UPDATE candidates 
               SET status = $1, notes = $2, version = version + 1, updated_at = now() 
               WHERE id = $3 
               RETURNING id, name, email, phone, status, skills, notes, version, created_at, updated_at`,
              [finalStatus, finalNotes, candidate_id]
            );
            const updatedCand = updateRes.rows[0];

            // Insert offline_action_log with conflict=false
            await db.query(
              `INSERT INTO offline_action_log (client_action_id, candidate_id, base_version, action_payload, applied_at, conflict)
               VALUES ($1, $2, $3, $4, now(), false)`,
              [client_action_id, candidate_id, base_version, JSON.stringify(changes)]
            );

             // Broadcast update via event system
             await emitDomainEvent('CandidateUpdated', candidate_id, updatedCand, req.correlationId);

            results.push({
              client_action_id,
              status: 'merged'
            });
          }
        }
      } catch (err) {
        console.error(`[Sync Replay] Error processing action ${client_action_id}:`, err);
        results.push({
          client_action_id,
          status: 'error',
          error: err.message || 'Error processing action.'
        });
      }
    }

    res.json(results);
  } catch (error) {
    console.error('Error replaying sync actions:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/candidates - Create new candidate
app.post('/api/candidates', requireAuth, async (req, res) => {
  const { name, email, phone, location, skills, status, source, notes, experience } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required fields.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Check for duplicate email
    const emailCheck = await client.query('SELECT id FROM candidates WHERE email = $1 FOR UPDATE', [email]);
    if (emailCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A candidate with this email address already exists.' });
    }

    // Check for duplicate phone (if provided)
    if (phone) {
      const phoneCheck = await client.query('SELECT id FROM candidates WHERE phone = $1 FOR UPDATE', [phone]);
      if (phoneCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A candidate with this phone number already exists.' });
      }
    }

    const insertCandidateQuery = `
      INSERT INTO candidates (name, email, phone, location, skills, status, source, notes, experience, version)
      VALUES ($1, $2, $3, $4, $5::text[], $6, $7, $8, $9, 1)
      RETURNING id, name, email, phone, location, skills, status, source, notes, resume_s3_key, version, experience, created_at, updated_at
    `;
    const candidateRes = await client.query(insertCandidateQuery, [
      name,
      email,
      phone || null,
      location || null,
      skills || [],
      status || 'Applied',
      source || null,
      notes || null,
      experience || null
    ]);
    const newCandidate = candidateRes.rows[0];

    await client.query('COMMIT');

     // Broadcast candidate_created event via event system
     await emitDomainEvent('CandidateCreated', newCandidate.id, newCandidate, req.correlationId);

    res.status(201).json(newCandidate);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating candidate:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// PUT /api/candidates/:id - Update candidate with optimistic concurrency check
app.put('/api/candidates/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { expectedVersion, name, email, phone, location, skills, status, source, notes, resume_s3_key, experience } = req.body;

  // Validate UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid candidate ID format' });
  }

  if (expectedVersion === undefined || expectedVersion === null) {
    return res.status(400).json({ error: 'expectedVersion is a required field for updating a candidate.' });
  }

  const parsedExpectedVersion = parseInt(expectedVersion, 10);
  if (isNaN(parsedExpectedVersion)) {
    return res.status(400).json({ error: 'expectedVersion must be a valid integer.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Select candidate and lock row for update to prevent concurrent updates
    const selectQuery = `
      SELECT id, name, email, phone, location, skills, status, source, notes, resume_s3_key, version, experience
      FROM candidates
      WHERE id = $1
      FOR UPDATE
    `;
    const selectRes = await client.query(selectQuery, [id]);

    if (selectRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found' });
    }

    const currentCandidate = selectRes.rows[0];

    // Check version
    if (currentCandidate.version !== parsedExpectedVersion) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Conflict: The record has been modified by another process.',
        currentVersion: currentCandidate.version
      });
    }

    // Merge updates
    const updatedName = name !== undefined ? name : currentCandidate.name;
    const updatedEmail = email !== undefined ? email : currentCandidate.email;
    
    if (!updatedName || !updatedEmail) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Name and email cannot be empty or null.' });
    }

    // Check if new email is taken by another candidate
    if (email !== undefined && email !== currentCandidate.email) {
      const emailCheck = await client.query('SELECT id FROM candidates WHERE email = $1 AND id != $2', [email, id]);
      if (emailCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A candidate with this email address already exists.' });
      }
    }

    // Check if new phone is taken by another candidate
    if (phone !== undefined && phone !== currentCandidate.phone && phone) {
      const phoneCheck = await client.query('SELECT id FROM candidates WHERE phone = $1 AND id != $2', [phone, id]);
      if (phoneCheck.rows.length > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'A candidate with this phone number already exists.' });
      }
    }

    const updatedPhone = phone !== undefined ? phone : currentCandidate.phone;
    const updatedLocation = location !== undefined ? location : currentCandidate.location;
    const updatedSkills = skills !== undefined ? skills : currentCandidate.skills;
    const updatedStatus = status !== undefined ? status : currentCandidate.status;
    const updatedSource = source !== undefined ? source : currentCandidate.source;
    const updatedNotes = notes !== undefined ? notes : currentCandidate.notes;
    const updatedResumeS3Key = resume_s3_key !== undefined ? resume_s3_key : currentCandidate.resume_s3_key;
    const updatedExperience = experience !== undefined ? experience : currentCandidate.experience;
    const newVersion = currentCandidate.version + 1;

    // Apply update
    const updateQuery = `
      UPDATE candidates
      SET name = $1, email = $2, phone = $3, location = $4, skills = $5::text[], status = $6, source = $7, notes = $8, resume_s3_key = $9, version = $10, experience = $11, updated_at = NOW()
      WHERE id = $12
      RETURNING id, name, email, phone, location, skills, status, source, notes, resume_s3_key, version, experience, created_at, updated_at
    `;
    const updateRes = await client.query(updateQuery, [
      updatedName,
      updatedEmail,
      updatedPhone || null,
      updatedLocation || null,
      updatedSkills || [],
      updatedStatus,
      updatedSource || null,
      updatedNotes || null,
      updatedResumeS3Key || null,
      newVersion,
      updatedExperience === '' ? null : updatedExperience,
      id
    ]);
    const updatedCandidate = updateRes.rows[0];

    await client.query('COMMIT');

     // Broadcast candidate_updated event via event system
     await emitDomainEvent('CandidateUpdated', id, updatedCandidate, req.correlationId);

    res.json(updatedCandidate);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating candidate:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// GET /api/files/resume/:candidateId - Preview or download a candidate's resume
app.get('/api/files/resume/:candidateId', requireAuth, async (req, res) => {
  const { candidateId } = req.params;

  // Validate candidateId format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidate ID format' });
  }

  try {
    const query = 'SELECT resume_s3_key FROM candidates WHERE id = $1';
    const result = await db.query(query, [candidateId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Candidate not found.' });
    }

    const resumePath = result.rows[0].resume_s3_key;
    if (!resumePath) {
      return res.status(404).json({ error: 'Candidate does not have a resume uploaded.' });
    }

    // Set correct Content-Type based on extension
    const ext = path.extname(resumePath).toLowerCase();
    let contentType = 'application/octet-stream';
    if (ext === '.pdf') {
      contentType = 'application/pdf';
    } else if (ext === '.docx') {
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (ext === '.doc') {
      contentType = 'application/msword';
    }
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');

    if (storage.isSupabaseKey(resumePath)) {
      const buffer = await storage.resolveResumeBuffer(resumePath);
      return res.send(buffer);
    }

    // Safe local-disk path resolution
    let absolutePath = path.isAbsolute(resumePath) ? resumePath : path.resolve(__dirname, '..', resumePath);

    // Also handle if path is stored relative to the project root instead of server
    if (!fs.existsSync(absolutePath)) {
      absolutePath = path.resolve(__dirname, '..', '..', resumePath);
    }

    if (!fs.existsSync(absolutePath)) {
      console.error(`[Download Endpoint] Resume file not found on disk: ${absolutePath}`);
      return res.status(404).json({ error: 'Resume file not found on disk.' });
    }

    // Stream the file using res.sendFile()
    res.sendFile(absolutePath);
  } catch (err) {
    console.error('Error fetching resume file:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /api/candidates/:id - Delete candidate profile and all related items
app.delete('/api/candidates/:id', requireAuth, async (req, res) => {
  const { id } = req.params;

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return res.status(400).json({ error: 'Invalid candidate ID format.' });
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Delete dependent details first
    await client.query('DELETE FROM upload_status WHERE candidate_id = $1', [id]);
    await client.query('DELETE FROM upload_sessions WHERE candidate_id = $1', [id]);
    await client.query('DELETE FROM resume_content WHERE candidate_id = $1', [id]);
    await client.query('DELETE FROM candidate_events WHERE candidate_id = $1', [id]);

    // 2. Delete candidate
    const result = await client.query('DELETE FROM candidates WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Candidate not found.' });
    }

    await client.query('COMMIT');
    res.json({ success: true, message: 'Candidate deleted successfully.' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting candidate:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  } finally {
    client.release();
  }
});

// POST /api/uploads/start - Initiate resumable upload session
app.post('/api/uploads/start', requireAuth, async (req, res) => {
  try {
    const { candidateId, fileName, totalChunks } = req.body;

    if (!candidateId || !fileName) {
      return res.status(400).json({ error: 'candidateId and fileName are required fields.' });
    }

    const sessionId = crypto.randomUUID();
    
    // Create physical storage directory
    storage.startUpload(sessionId);

    // Save session to database
    const insertQuery = `
      INSERT INTO upload_sessions (id, candidate_id, s3_upload_id, status, total_chunks, chunks_received)
      VALUES ($1, $2, $3, 'in_progress', $4, '{}')
      RETURNING id
    `;
    await db.query(insertQuery, [sessionId, candidateId, fileName, parseInt(totalChunks, 10) || null]);

    res.json({ sessionId });
  } catch (error) {
    console.error('Error starting upload session:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUT /api/uploads/:sessionId/chunk/:chunkIndex - Write binary chunk
app.put(
  '/api/uploads/:sessionId/chunk/:chunkIndex',
  requireAuth,
  express.raw({ type: '*/*', limit: '20mb' }),
  async (req, res) => {
    try {
      const { sessionId, chunkIndex } = req.params;
      const parsedChunkIndex = parseInt(chunkIndex, 10);

      if (isNaN(parsedChunkIndex)) {
        return res.status(400).json({ error: 'chunkIndex must be a valid integer.' });
      }

      // Check if session exists
      const selectQuery = 'SELECT id, status FROM upload_sessions WHERE id = $1';
      const selectRes = await db.query(selectQuery, [sessionId]);
      if (selectRes.rows.length === 0) {
        return res.status(404).json({ error: 'Upload session not found.' });
      }

      if (selectRes.rows[0].status === 'completed') {
        return res.status(400).json({ error: 'Upload session has already been completed.' });
      }

      // req.body is populated as Buffer by express.raw()
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'Empty or invalid binary body.' });
      }

      // Write chunk to local file
      storage.writeChunk(sessionId, parsedChunkIndex, req.body);

      // Append and deduplicate chunk index in DB
      const updateQuery = `
        UPDATE upload_sessions
        SET chunks_received = (
          SELECT array_agg(DISTINCT x ORDER BY x)
          FROM unnest(array_append(chunks_received, $1)) AS x
        )
        WHERE id = $2
        RETURNING chunks_received
      `;
      const updateRes = await db.query(updateQuery, [parsedChunkIndex, sessionId]);
      const chunksReceived = updateRes.rows[0]?.chunks_received || [];

      res.json({ chunksReceived });
    } catch (error) {
      console.error('Error uploading chunk:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// GET /api/uploads/:sessionId/status - Fetch upload progress details
app.get('/api/uploads/:sessionId/status', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const selectQuery = 'SELECT chunks_received, total_chunks, status FROM upload_sessions WHERE id = $1';
    const selectRes = await db.query(selectQuery, [sessionId]);

    if (selectRes.rows.length === 0) {
      return res.status(404).json({ error: 'Upload session not found.' });
    }

    const session = selectRes.rows[0];
    res.json({
      chunksReceived: session.chunks_received || [],
      totalChunks: session.total_chunks,
      status: session.status,
    });
  } catch (error) {
    console.error('Error fetching session status:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST /api/uploads/:sessionId/complete - Assemble final file and link to candidate
app.post('/api/uploads/:sessionId/complete', requireAuth, async (req, res) => {
  try {
    const { sessionId } = req.params;

    const selectQuery = 'SELECT candidate_id, s3_upload_id, total_chunks, status FROM upload_sessions WHERE id = $1';
    const selectRes = await db.query(selectQuery, [sessionId]);

    if (selectRes.rows.length === 0) {
      return res.status(404).json({ error: 'Upload session not found.' });
    }

    const session = selectRes.rows[0];

    if (session.status === 'completed') {
      return res.status(400).json({ error: 'Upload session is already completed.' });
    }

    const totalChunks = session.total_chunks;
    if (!totalChunks) {
      return res.status(400).json({ error: 'total_chunks count was not defined on this upload session.' });
    }

    const candidateId = session.candidate_id;
    const fileName = session.s3_upload_id;

    // Concatenate chunks and clean up session directory (uploads to Supabase
    // Storage if configured, otherwise stays on local disk — either way
    // finalFilePath is the resume_s3_key value going forward).
    const finalFilePath = await storage.completeUpload(sessionId, totalChunks, candidateId, fileName);

    const client = await db.pool.connect();
    let alreadyTrackedByOrchestrator = false;
    try {
      await client.query('BEGIN');

      // Update upload session status
      await client.query('UPDATE upload_sessions SET status = $1 WHERE id = $2', ['completed', sessionId]);

      // Update related candidate's resume_s3_key
      await client.query(
        'UPDATE candidates SET resume_s3_key = $1, version = version + 1, updated_at = NOW() WHERE id = $2',
        [finalFilePath, candidateId]
      );

      // Create an event for the resume upload
      await client.query(
        'INSERT INTO candidate_events (candidate_id, event_type, payload) VALUES ($1, $2, $3)',
        [candidateId, 'candidate_resume_uploaded', { resume_s3_key: finalFilePath }]
      );

      // The "Upload resume" tab flow already registered this candidate with the
      // orchestrator (POST /orchestrator/validate) before starting the chunked
      // upload, and will emit its own ResumeUploaded via /orchestrator/dedup-check
      // once this call returns. If we also emit one here, the resume gets
      // processed twice concurrently for the same candidate, which corrupts the
      // dedup-by-email logic (a candidate can look like a "duplicate" of itself
      // mid-transaction) — so skip our own tracking/emit when that's the case.
      const existingTracking = await client.query(
        'SELECT 1 FROM upload_status WHERE candidate_id = $1 LIMIT 1',
        [candidateId]
      );
      alreadyTrackedByOrchestrator = existingTracking.rows.length > 0;

      if (!alreadyTrackedByOrchestrator) {
        // Register the upload with the processing pipeline (received -> validated -> ... -> indexed)
        await client.query(
          `INSERT INTO upload_status (upload_id, candidate_id, file_name, status, current_stage)
           VALUES ($1, $2, $3, 'received', 'received')
           ON CONFLICT (upload_id) DO NOTHING`,
          [sessionId, candidateId, fileName]
        );
      }

      await client.query('COMMIT');
      res.json({ filePath: finalFilePath });
    } catch (innerError) {
      await client.query('ROLLBACK');
      throw innerError;
    } finally {
      client.release();
    }

    if (alreadyTrackedByOrchestrator) {
      console.log(`[uploads/complete] Skipping auto-emit for candidate ${candidateId} — already tracked by the orchestrator flow.`);
    } else {
      // Kick off resume parsing/indexing in-process (outside the DB transaction —
      // this reads the file back (from Supabase or local disk, whichever
      // completeUpload used) and enqueues a background job).
      try {
        const fileBuffer = await storage.resolveResumeBuffer(finalFilePath);
        const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

        await emitEventDirect(
          'ResumeUploaded',
          candidateId,
          { uploadId: sessionId, candidateId, fileName, checksum, resumeS3Key: finalFilePath },
          sessionId,
          null,
          { source: 'chunked-upload', version: '1.0.0' }
        );
      } catch (pipelineError) {
        console.error('Failed to kick off resume processing pipeline:', pipelineError);
      }
    }
  } catch (error) {
    console.error('Error completing upload:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/events/since/:sequenceId - Retrieve all events with sequence_id > sequenceId
app.get('/api/events/since/:sequenceId', requireAuth, async (req, res) => {
  try {
    const { sequenceId } = req.params;
    const parsedSeqId = parseInt(sequenceId, 10);
    
    if (isNaN(parsedSeqId)) {
      return res.status(400).json({ error: 'sequenceId must be a valid integer.' });
    }

    const queryText = `
      SELECT id, candidate_id, event_type, payload, sequence_id, created_at
      FROM candidate_events
      WHERE sequence_id > $1
      ORDER BY sequence_id ASC
    `;
    const result = await db.query(queryText, [parsedSeqId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching events since sequenceId:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/dashboard/stats - Retrieve aggregated statistics for metrics dashboard
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  const fs = require('fs');
  const client = await db.pool.connect();
  try {
    // 1. Total Candidates count
    const candCountRes = await client.query('SELECT COUNT(*) FROM candidates');
    const totalCandidates = parseInt(candCountRes.rows[0].count, 10);

    // 2. Uploads in the last 24 hours
    const todayCountRes = await client.query(
      "SELECT COUNT(*) FROM upload_status WHERE created_at >= NOW() - INTERVAL '1 day'"
    );
    const uploadedToday = parseInt(todayCountRes.rows[0].count, 10);

    // 3. Status aggregates
    const statusCountsRes = await client.query(
      'SELECT status, COUNT(*) FROM upload_status GROUP BY status'
    );
    
    const counts = { completed: 0, processing: 0, failed: 0, queued: 0, received: 0 };
    for (const row of statusCountsRes.rows) {
      if (counts[row.status] !== undefined) {
        counts[row.status] = parseInt(row.count, 10);
      }
    }

    // 4. Calculate actual success rate
    const successRate = (counts.completed + counts.failed) > 0 
      ? Math.round((counts.completed / (counts.completed + counts.failed)) * 1000) / 10 
      : 100;

    // 5. Calculate real average processing time (seconds) for completed uploads
    const avgTimeRes = await client.query(`
      SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) AS avg_time
      FROM upload_status 
      WHERE status = 'completed' AND updated_at IS NOT NULL
    `);
    const avgProcessingTime = avgTimeRes.rows[0].avg_time 
      ? Math.round(parseFloat(avgTimeRes.rows[0].avg_time) * 10) / 10 
      : 0.0;

    // 6. Calculate real file storage used on disk in resumes/ folder (in Megabytes)
    const localRootUploads = path.resolve(__dirname, '..', '..', 'uploads');
    const dockerUploads = path.resolve(__dirname, '..', 'uploads');
    const UPLOADS_DIR = process.env.UPLOADS_DIR || (
      fs.existsSync(localRootUploads) ? localRootUploads : dockerUploads
    );
    const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');
    
    let storageBytes = 0;
    try {
      if (fs.existsSync(RESUMES_DIR)) {
        const files = fs.readdirSync(RESUMES_DIR);
        for (const file of files) {
          const stat = fs.statSync(path.join(RESUMES_DIR, file));
          if (stat.isFile()) {
            storageBytes += stat.size;
          }
        }
      }
    } catch (err) {
      console.error('Failed to read storage size:', err);
    }
    const storageUsedMB = Math.round((storageBytes / (1024 * 1024)) * 10) / 10;

    // 7. Calculate last 7 days uploads trend (using series generation)
    const trendRes = await client.query(`
      SELECT 
        TO_CHAR(d, 'DD Mon') AS day_label,
        COALESCE(COUNT(u.upload_id), 0) AS upload_count
      FROM GENERATE_SERIES(NOW() - INTERVAL '6 days', NOW(), '1 day'::interval) d
      LEFT JOIN upload_status u ON DATE_TRUNC('day', u.created_at) = DATE_TRUNC('day', d)
      GROUP BY d
      ORDER BY d ASC
    `);

    const uploadsTrend = trendRes.rows.map(row => ({
      date: row.day_label,
      count: parseInt(row.upload_count, 10)
    }));

    res.json({
      totalCandidates,
      uploadedToday,
      processing: counts.processing + counts.received,
      queued: counts.queued,
      completed: counts.completed,
      failed: counts.failed,
      successRate,
      avgProcessingTime,
      storageUsedMB,
      uploadsTrend
    });
  } catch (err) {
    console.error('Error fetching dashboard stats:', err);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  } finally {
    client.release();
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

if (process.env.NODE_ENV !== 'test') {
  const httpServer = app.listen(config.port, () => {
    console.log(`Server running on http://localhost:${config.port}`);
    console.log(`  API:         http://localhost:${config.port}/api/`);
    console.log(`  Events SSE:  http://localhost:${config.port}/events/stream`);
    console.log(`  Orchestrator:http://localhost:${config.port}/orchestrator/`);
    console.log(`  Search:      http://localhost:${config.port}/search/candidates`);
    console.log(`  WebSocket:   ws://localhost:${config.port}`);

    // Attach WebSocket to the same HTTP server (no extra port)
    initWebSocketServer(httpServer);

    // Bootstrap processor pipeline — registers queue workers and in-process event subscription
    bootstrapProcessorSubscription();
  });
}

module.exports = app;

// Trigger watch reload to clear EADDRINUSE conflict
