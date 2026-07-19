/**
 * pipeline/eventSystem.js
 *
 * In-process Event System — replaces the standalone rw-event-system microservice.
 * - Persists domain events to the domain_events table
 * - Delivers events to SSE subscribers in the same process (no HTTP round-trips)
 * - Exposes emitEventDirect() for internal callers (workers, orchestrator, server)
 * - Exposes an Express Router for /events/* HTTP routes
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('../config');
const db = require('../db');

const logger = pino({ level: config.logLevel });
const router = express.Router();

// ─── SSE Subscriber Registry ────────────────────────────────────────────────
const activeSubscribers = new Set();
const emitTimestamps = [];

function recordEmission() {
  emitTimestamps.push(Date.now());
}

function getEmittedPerMinute() {
  const cutoff = Date.now() - 60000;
  while (emitTimestamps.length > 0 && emitTimestamps[0] < cutoff) emitTimestamps.shift();
  return emitTimestamps.length;
}

// ─── Validation Helpers ──────────────────────────────────────────────────────
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_EVENT_TYPES = [
  'CandidateCreated',
  'CandidateUpdated',
  'CandidateDeleted',
  'ResumeUploaded',
  'ResumeProcessed',
  'ResumeIndexed',
  'ResumeFailed',
  'ResumeAnalyzed',
  'JobCreated',
  'JobUpdated',
  'JobMatchCompleted',
  'ApplicationStatusChanged',
];

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  // Also accept token from query parameter for SSE clients
  const queryToken = req.query.token;
  const headerToken = req.headers['authorization']?.split(' ')[1];
  const token = headerToken || queryToken;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized', reason: 'No token provided.' });
  }
  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Unauthorized', reason: 'Invalid or expired token.' });
  }
}

// ─── Core: Persist & Broadcast ──────────────────────────────────────────────
/**
 * Persists a domain event to the DB and pushes it to all matching SSE subscribers.
 * This is the single source of truth for event emission — called both from HTTP
 * routes and directly from internal modules (workers, orchestrator, server).
 *
 * @returns {object} The created event row
 */
async function emitEventDirect(eventType, aggregateId, payload, correlationId, causationId = null, metadata = null) {
  const insertQuery = `
    INSERT INTO domain_events (event_type, aggregate_id, payload, correlation_id, causation_id, metadata)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
  `;
  const result = await db.query(insertQuery, [
    eventType,
    aggregateId,
    JSON.stringify(payload),
    correlationId,
    causationId || null,
    metadata ? JSON.stringify(metadata) : null,
  ]);
  const createdEvent = result.rows[0];

  recordEmission();

  // Push to matching SSE subscribers in-process
  for (const sub of activeSubscribers) {
    let match = true;
    if (sub.eventTypes && !sub.eventTypes.includes(createdEvent.event_type)) match = false;
    if (sub.aggregateId && sub.aggregateId !== createdEvent.aggregate_id) match = false;
    if (match) {
      try {
        sub.res.write(`data: ${JSON.stringify(createdEvent)}\n\n`);
      } catch (e) {
        // Client disconnected
        activeSubscribers.delete(sub);
      }
    }
  }

  logger.info({
    eventType,
    aggregateId,
    correlationId,
    eventId: createdEvent.id,
  }, 'Domain event persisted and broadcast');

  return createdEvent;
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /events/stream/stats
router.get('/events/stream/stats', requireAuth, (req, res) => {
  res.json({
    active_subscriber_count: activeSubscribers.size,
    events_emitted_per_minute: getEmittedPerMinute(),
  });
});

// GET /events/stream — Server-Sent Events
router.get('/events/stream', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const eventTypes = req.query.event_type
    ? req.query.event_type.split(',').map(t => t.trim())
    : null;
  const aggregateId = req.query.aggregate_id || null;

  const subscriber = { res, eventTypes, aggregateId };
  activeSubscribers.add(subscriber);

  logger.info({ eventTypes, aggregateId, count: activeSubscribers.size }, 'New SSE subscriber');

  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    activeSubscribers.delete(subscriber);
    logger.info({ count: activeSubscribers.size }, 'SSE subscriber disconnected');
  });
});

// POST /events/emit — HTTP entrypoint for external callers
router.post('/events/emit', requireAuth, async (req, res) => {
  const { event_type, aggregate_id, payload, correlation_id, causation_id, metadata } = req.body;

  if (!event_type || !aggregate_id || !payload || !correlation_id) {
    return res.status(400).json({
      error: 'Validation failed',
      reason: 'event_type, aggregate_id, payload, and correlation_id are required.',
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
    const createdEvent = await emitEventDirect(
      event_type, aggregate_id, payload, correlation_id, causation_id, metadata
    );
    res.status(201).json(createdEvent);
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to emit domain event');
    res.status(500).json({ error: 'Internal Server Error', reason: err.message });
  }
});

// GET /events/candidate/:candidateId
router.get('/events/candidate/:candidateId', requireAuth, async (req, res) => {
  const { candidateId } = req.params;
  if (!uuidRegex.test(candidateId)) {
    return res.status(400).json({ error: 'Invalid candidateId format. Must be a valid UUID.' });
  }
  try {
    const result = await db.query(
      `SELECT id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
       FROM domain_events WHERE aggregate_id = $1 ORDER BY created_at ASC`,
      [candidateId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message, candidateId }, 'Error retrieving candidate events');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /events/correlation/:correlationId
router.get('/events/correlation/:correlationId', requireAuth, async (req, res) => {
  const { correlationId } = req.params;
  if (!uuidRegex.test(correlationId)) {
    return res.status(400).json({ error: 'Invalid correlationId format. Must be a valid UUID.' });
  }
  try {
    const result = await db.query(
      `SELECT id, event_type, aggregate_id, aggregate_type, payload, correlation_id, causation_id, metadata, created_at
       FROM domain_events WHERE correlation_id = $1 ORDER BY created_at ASC`,
      [correlationId]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err.message, correlationId }, 'Error retrieving correlated events');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = { router, emitEventDirect, activeSubscribers };
