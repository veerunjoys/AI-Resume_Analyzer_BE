const express = require('express');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('./config');
const db = require('./db');

const logger = pino({
  level: config.logLevel,
});

const app = express();

// CORS Middleware - Allow cross-origin requests from the client (including SSE)
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
  const correlationId = req.headers['x-correlation-id'] || require('crypto').randomUUID();
  req.correlationId = correlationId;
  req.log = logger.child({ correlationId });
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// Helper to authenticate JWT tokens
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader && req.query.token) {
    // Also accept token from query parameter for SSE clients if needed
    try {
      const decoded = jwt.verify(req.query.token, config.jwtSecret);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Unauthorized', reason: 'Invalid token in query.' });
    }
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', reason: 'Authorization header is missing or malformed.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', reason: 'Invalid or expired token.' });
  }
}

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_EVENT_TYPES = [
  'CandidateCreated',
  'CandidateUpdated',
  'ResumeUploaded',
  'ResumeProcessed',
  'ResumeIndexed',
  'ResumeFailed',
];

// Active SSE Connections and Event Stats
const activeSubscribers = new Set();
const emitTimestamps = [];

function recordEventEmission() {
  emitTimestamps.push(Date.now());
}

function getEmittedPerMinute() {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;
  // Clean timestamps older than 60s
  while (emitTimestamps.length > 0 && emitTimestamps[0] < oneMinuteAgo) {
    emitTimestamps.shift();
  }
  return emitTimestamps.length;
}

// GET /events/stream/stats - Expose active subscribers and emission rate
app.get('/events/stream/stats', requireAuth, (req, res) => {
  res.json({
    active_subscriber_count: activeSubscribers.size,
    events_emitted_per_minute: getEmittedPerMinute(),
  });
});

// GET /events/stream - Server-Sent Events stream for real-time subscribers
app.get('/events/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Parse filters from query
  const eventTypes = req.query.event_type ? req.query.event_type.split(',').map(t => t.trim()) : null;
  const aggregateId = req.query.aggregate_id || null;

  const subscriber = {
    res,
    eventTypes,
    aggregateId,
  };

  activeSubscribers.add(subscriber);

  logger.info({
    eventTypes,
    aggregateId,
    activeSubscriberCount: activeSubscribers.size,
  }, 'New SSE subscriber registered');

  // Send connected block
  res.write(': connected\n\n');

  // Keep-alive heartbeats every 15 seconds
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    activeSubscribers.delete(subscriber);
    logger.info({
      activeSubscriberCount: activeSubscribers.size,
    }, 'SSE subscriber disconnected');
  });
});

// POST /events/emit - Emit and persist a new domain event
app.post('/events/emit', requireAuth, async (req, res) => {
  const { event_type, aggregate_id, payload, correlation_id, causation_id, metadata } = req.body;

  // Basic validations
  if (!event_type || !aggregate_id || !payload || !correlation_id) {
    return res.status(400).json({
      error: 'Validation failed',
      reason: 'event_type, aggregate_id, payload, and correlation_id are required fields.',
    });
  }

  if (!ALLOWED_EVENT_TYPES.includes(event_type)) {
    return res.status(400).json({
      error: 'Validation failed',
      reason: `event_type must be one of: ${ALLOWED_EVENT_TYPES.join(', ')}`,
    });
  }

  if (!uuidRegex.test(aggregate_id) || !uuidRegex.test(correlation_id)) {
    return res.status(400).json({
      error: 'Validation failed',
      reason: 'aggregate_id and correlation_id must be valid UUIDs.',
    });
  }

  if (causation_id && !uuidRegex.test(causation_id)) {
    return res.status(400).json({
      error: 'Validation failed',
      reason: 'causation_id must be a valid UUID.',
    });
  }

  try {
    const insertQuery = `
      INSERT INTO domain_events (event_type, aggregate_id, payload, correlation_id, causation_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
    `;
    const result = await db.query(insertQuery, [
      event_type,
      aggregate_id,
      JSON.stringify(payload),
      correlation_id,
      causation_id || null,
      metadata ? JSON.stringify(metadata) : null,
    ]);

    const createdEvent = result.rows[0];

    // Track metrics
    recordEventEmission();

    // Push event to matching active SSE subscribers
    for (const sub of activeSubscribers) {
      let isMatched = true;

      if (sub.eventTypes && !sub.eventTypes.includes(createdEvent.event_type)) {
        isMatched = false;
      }
      if (sub.aggregateId && sub.aggregateId !== createdEvent.aggregate_id) {
        isMatched = false;
      }

      if (isMatched) {
        sub.res.write(`data: ${JSON.stringify(createdEvent)}\n\n`);
      }
    }

    // Pino emission logging requirement
    logger.info({
      eventType: event_type,
      aggregateId: aggregate_id,
      correlationId: correlation_id,
      causationId: causation_id || null,
      eventId: createdEvent.id,
    }, 'Domain event persisted successfully');

    res.status(201).json(createdEvent);

  } catch (err) {
    logger.error({
      err: err.message,
      stack: err.stack,
      eventType: event_type,
      aggregateId: aggregate_id,
    }, 'Failed to emit domain event');
    res.status(500).json({ error: 'Internal Server Error', reason: err.message });
  }
});

// GET /events/candidate/:candidateId - Retrieve chronological events lineage for a candidate
app.get('/events/candidate/:candidateId', requireAuth, async (req, res) => {
  const { candidateId } = req.params;

  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }

  try {
    const query = `
      SELECT id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
      FROM domain_events
      WHERE aggregate_id = $1
      ORDER BY created_at ASC
    `;
    const result = await db.query(query, [candidateId]);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message, candidateId }, 'Error retrieving candidate event lineage');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /events/correlation/:correlationId - Retrieve all events sharing a correlationId
app.get('/events/correlation/:correlationId', requireAuth, async (req, res) => {
  const { correlationId } = req.params;

  if (!uuidRegex.test(correlationId)) {
    return res.status(400).json({ error: 'Invalid correlationId format. Must be a valid UUID.' });
  }

  try {
    const query = `
      SELECT id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
      FROM domain_events
      WHERE correlation_id = $1
      ORDER BY created_at ASC
    `;
    const result = await db.query(query, [correlationId]);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message, correlationId }, 'Error retrieving correlated events');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Event System service running on port ${PORT}`);
});
