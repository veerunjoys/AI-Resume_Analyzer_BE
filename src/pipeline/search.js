/**
 * pipeline/search.js
 *
 * In-process Search Service — replaces the standalone rw-search-service microservice.
 * Provides /search/* routes with LRU cache, full-text search via tsvector,
 * resume_snippet via ts_headline, and keyset pagination.
 */

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('../config');
const db = require('../db');

const logger = pino({ level: config.logLevel });
const router = express.Router();

// ─── LRU Query Result Cache ───────────────────────────────────────────────────
class QueryCache {
  constructor(maxSize = 500, ttlMs = 30000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  generateKey(queryParams) {
    const sorted = Object.keys(queryParams).sort().reduce((obj, k) => { obj[k] = queryParams[k]; return obj; }, {});
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() > entry.expiresAt) { this.cache.delete(key); this.misses++; return null; }
    this.hits++;
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.results;
  }

  set(key, results) {
    if (this.cache.size >= this.maxSize) {
      this.cache.delete(this.cache.keys().next().value);
    }
    this.cache.set(key, { results, expiresAt: Date.now() + this.ttlMs });
  }

  getStats() {
    const total = this.hits + this.misses;
    return {
      cacheSize: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: total > 0 ? parseFloat((this.hits / total).toFixed(4)) : 0,
    };
  }
}

const queryCache = new QueryCache(500, 30000);

// ─── Metrics ─────────────────────────────────────────────────────────────────
class MetricsTracker {
  constructor() {
    this.totalQueries = 0;
    this.durations = [];
    this.queryTimestamps = [];
    this.slowQueries = 0;
  }
  recordQuery(ms) {
    this.totalQueries++;
    this.durations.push(ms);
    if (this.durations.length > 1000) this.durations.shift();
    this.queryTimestamps.push(Date.now());
    if (ms > 500) this.slowQueries++;
  }
  getQPM() {
    const cutoff = Date.now() - 60000;
    while (this.queryTimestamps.length > 0 && this.queryTimestamps[0] < cutoff) this.queryTimestamps.shift();
    return this.queryTimestamps.length;
  }
  getSummary() {
    const avg = this.durations.length > 0
      ? parseFloat((this.durations.reduce((a, b) => a + b, 0) / this.durations.length).toFixed(2)) : 0;
    const sorted = [...this.durations].sort((a, b) => a - b);
    const p = (pct) => sorted.length ? sorted[Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1)] : 0;
    const stats = queryCache.getStats();
    const total = stats.hits + stats.misses;
    return {
      total_queries: this.totalQueries,
      avg_query_duration_ms: avg,
      p95_query_duration_ms: p(95),
      p99_query_duration_ms: p(99),
      cache_hit_rate: total > 0 ? parseFloat(((stats.hits / total) * 100).toFixed(2)) : 0,
      queries_per_minute: this.getQPM(),
      slow_queries: this.slowQueries,
    };
  }
}
const metricsTracker = new MetricsTracker();

// ─── Cursor Helpers ───────────────────────────────────────────────────────────
function decodeCursor(str) {
  if (!str) return null;
  try { return JSON.parse(Buffer.from(str, 'base64').toString('utf8')); }
  catch (e) { return null; }
}
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// ─── Auth Middleware ─────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { req.user = jwt.verify(token, config.jwtSecret); next(); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /search/health
router.get('/search/health', async (req, res) => {
  const t = Date.now();
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', dbLatencyMs: Date.now() - t });
  } catch (err) {
    res.status(500).json({ status: 'degraded', error: err.message });
  }
});

// GET /search/metrics
router.get('/search/metrics', (req, res) => {
  res.json(metricsTracker.getSummary());
});

// GET /search/cache/stats
router.get('/search/cache/stats', requireAuth, (req, res) => {
  res.json(queryCache.getStats());
});

// GET /search/candidates — Full-text search with keyset pagination and resume_snippet
router.get('/search/candidates', requireAuth, async (req, res) => {
  const startTime = Date.now();
  let { q, skills, status, location, experience, cursor, limit } = req.query;

  const cacheKey = queryCache.generateKey(req.query);
  const cached = queryCache.get(cacheKey);
  if (cached) {
    metricsTracker.recordQuery(Date.now() - startTime);
    return res.json(cached);
  }

  const params = [];
  const whereClauses = [];

  let queryTerms = '';
  if (q) {
    const cleanQ = q.replace(/[^\w\s-]/g, ' ').trim();
    const terms = cleanQ.split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
      queryTerms = terms.map(t => `${t}:*`).join(' & ');
    } else {
      q = null;
    }
  }

  let selectFields = `
    c.id, c.name, c.email, c.skills, c.status, c.location, c.updated_at, c.resume_s3_key
  `;
  const fromClause = `candidates c LEFT JOIN resume_content r ON c.id = r.candidate_id`;
  let orderBy = '';
  let queryTermsParamIndex = null;

  if (q) {
    params.push(queryTerms);
    queryTermsParamIndex = params.length;
    selectFields += `, ts_rank(c.search_vector, to_tsquery('simple', $${queryTermsParamIndex})) AS search_rank`;
    selectFields += `, coalesce(ts_headline('english', r.raw_text, to_tsquery('simple', $${queryTermsParamIndex}), 'MaxWords=30, MaxFragments=1'), '') AS resume_snippet`;
    whereClauses.push(`c.search_vector @@ to_tsquery('simple', $${queryTermsParamIndex})`);
    orderBy = `ts_rank(c.search_vector, to_tsquery('simple', $${queryTermsParamIndex})) DESC, c.updated_at DESC, c.id DESC`;
  } else {
    selectFields += `, 0.0 AS search_rank`;
    selectFields += `, coalesce(substring(r.raw_text from 1 for 200), '') AS resume_snippet`;
    orderBy = `c.updated_at DESC, c.id DESC`;
  }

  if (skills) {
    const skillsArray = skills.split(',').map(s => s.trim()).filter(Boolean);
    if (skillsArray.length > 0) {
      params.push(skillsArray);
      whereClauses.push(`c.skills @> $${params.length}::text[]`);
    }
  }
  if (status) { params.push(status); whereClauses.push(`c.status = $${params.length}`); }
  if (location) { params.push(`%${location.trim()}%`); whereClauses.push(`c.location ILIKE $${params.length}`); }
  if (experience) { params.push(`%${experience.trim()}%`); whereClauses.push(`r.raw_text ILIKE $${params.length}`); }

  const decodedCursor = decodeCursor(cursor);
  if (decodedCursor) {
    if (q) {
      const { searchRank, updatedAt, id } = decodedCursor;
      params.push(searchRank, updatedAt, id);
      const rankIdx = params.length - 2;
      const timeIdx = params.length - 1;
      const idIdx = params.length;
      const rankFn = `ts_rank(c.search_vector, to_tsquery('simple', $${queryTermsParamIndex}))`;
      whereClauses.push(`(
        (${rankFn} < $${rankIdx})
        OR (${rankFn} = $${rankIdx} AND c.updated_at < $${timeIdx})
        OR (${rankFn} = $${rankIdx} AND c.updated_at = $${timeIdx} AND c.id < $${idIdx})
      )`);
    } else {
      const { updatedAt, id } = decodedCursor;
      params.push(updatedAt, id);
      const tIdx = params.length - 1;
      const iIdx = params.length;
      whereClauses.push(`((c.updated_at < $${tIdx}) OR (c.updated_at = $${tIdx} AND c.id < $${iIdx}))`);
    }
  }

  let finalLimit = parseInt(limit, 10) || 20;
  if (finalLimit <= 0) finalLimit = 20;
  if (finalLimit > 100) finalLimit = 100;

  let sql = `SELECT ${selectFields} FROM ${fromClause}`;
  if (whereClauses.length > 0) sql += ` WHERE ` + whereClauses.join(' AND ');
  sql += ` ORDER BY ${orderBy}`;
  params.push(finalLimit + 1);
  sql += ` LIMIT $${params.length}`;

  try {
    const result = await db.query(sql, params);
    const rows = result.rows;
    const hasNextPage = rows.length > finalLimit;
    const sliced = hasNextPage ? rows.slice(0, finalLimit) : rows;

    let nextCursor = null;
    if (hasNextPage && sliced.length > 0) {
      const last = sliced[sliced.length - 1];
      nextCursor = q
        ? encodeCursor({ searchRank: parseFloat(last.search_rank), updatedAt: last.updated_at, id: last.id })
        : encodeCursor({ updatedAt: last.updated_at, id: last.id });
    }

    const durationMs = Date.now() - startTime;
    metricsTracker.recordQuery(durationMs);

    const responseData = { candidates: sliced, nextCursor };
    queryCache.set(cacheKey, responseData);
    res.json(responseData);
  } catch (err) {
    logger.error({ err: err.message }, 'Error executing candidate search');
    res.status(500).json({ error: 'Internal Server Error', reason: err.message });
  }
});

module.exports = { router };
