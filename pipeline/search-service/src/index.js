const express = require('express');
const jwt = require('jsonwebtoken');
const pino = require('pino');
const crypto = require('crypto');
const config = require('./config');
const db = require('./db');

const logger = pino({
  level: config.logLevel,
});

// LRU Query Result Cache
class QueryCache {
  constructor(maxSize = 500, ttlMs = 30000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map(); // key -> { results, expiresAt }
    this.hits = 0;
    this.misses = 0;
  }

  generateKey(queryParams) {
    // Sort query keys to ensure stable cache signature hashes
    const sortedKeys = Object.keys(queryParams).sort();
    const sortedObj = {};
    for (const key of sortedKeys) {
      sortedObj[key] = queryParams[key];
    }
    const str = JSON.stringify(sortedObj);
    return crypto.createHash('sha256').update(str).digest('hex');
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    // Move to end to maintain LRU order
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.results;
  }

  set(key, results) {
    // Evict oldest entry if size limit reached
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      results,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  getStats() {
    const total = this.hits + this.misses;
    const ratio = total > 0 ? (this.hits / total) : 0;
    return {
      cacheSize: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      hitRatio: parseFloat(ratio.toFixed(4)),
    };
  }
}

const queryCache = new QueryCache(500, 30000);

// Helper to extract percentile values
function getPercentile(arr, percentile) {
  if (arr.length === 0) return 0.0;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

// Metrics Tracker
class MetricsTracker {
  constructor() {
    this.totalQueries = 0;
    this.durations = []; // stores last 1000 durations
    this.queryTimestamps = []; // stores timestamps for QPM
    this.slowQueries = 0;
  }

  recordQuery(durationMs) {
    this.totalQueries++;
    this.durations.push(durationMs);
    if (this.durations.length > 1000) {
      this.durations.shift();
    }
    this.queryTimestamps.push(Date.now());
    if (durationMs > 500) {
      this.slowQueries++;
    }
  }

  getQueriesPerMinute() {
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    // Evict old timestamps outside the 60s sliding window
    while (this.queryTimestamps.length > 0 && this.queryTimestamps[0] < oneMinuteAgo) {
      this.queryTimestamps.shift();
    }
    return this.queryTimestamps.length;
  }

  getMetricsSummary(cache) {
    const cacheStats = cache.getStats();
    const totalCache = cacheStats.hits + cacheStats.misses;
    const cacheHitRate = totalCache > 0 ? parseFloat(((cacheStats.hits / totalCache) * 100).toFixed(2)) : 0.0;

    const avg = this.durations.length > 0
      ? parseFloat((this.durations.reduce((a, b) => a + b, 0) / this.durations.length).toFixed(2))
      : 0.0;

    return {
      total_queries: this.totalQueries,
      avg_query_duration_ms: avg,
      p95_query_duration_ms: getPercentile(this.durations, 95),
      p99_query_duration_ms: getPercentile(this.durations, 99),
      cache_hit_rate: cacheHitRate,
      queries_per_minute: this.getQueriesPerMinute(),
      slow_queries: this.slowQueries,
    };
  }
}

const metricsTracker = new MetricsTracker();

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

// Helper to authenticate JWT tokens
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
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

// Cursor Encoding/Decoding Helpers
function decodeCursor(cursorStr) {
  if (!cursorStr) return null;
  try {
    const decoded = Buffer.from(cursorStr, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (err) {
    logger.warn({ cursorStr, err: err.message }, 'Failed to decode cursor');
    return null;
  }
}

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

// GET /search/health - Checks database connectivity and records latency
app.get('/search/health', async (req, res) => {
  const checkStart = Date.now();
  try {
    await db.query('SELECT 1');
    const dbLatencyMs = Date.now() - checkStart;
    res.json({
      status: 'ok',
      dbLatencyMs,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'Database health check failed');
    res.status(500).json({
      status: 'degraded',
      error: err.message,
    });
  }
});

// GET /search/metrics - Retrieve performance metrics
app.get('/search/metrics', (req, res) => {
  res.json(metricsTracker.getMetricsSummary(queryCache));
});

// GET /search/cache/stats - Expose cache performance metrics
app.get('/search/cache/stats', requireAuth, (req, res) => {
  res.json(queryCache.getStats());
});

// GET /search/candidates - Full-text search with keyset pagination, filters, and caching
app.get('/search/candidates', requireAuth, async (req, res) => {
  const startTime = Date.now();
  let { q, skills, status, location, experience, cursor, limit } = req.query;

  // 1. Check Query Cache
  const cacheKey = queryCache.generateKey(req.query);
  const cachedVal = queryCache.get(cacheKey);

  if (cachedVal) {
    const durationMs = Date.now() - startTime;
    // Record cached query metrics (cache latency is usually 0-1ms)
    metricsTracker.recordQuery(durationMs);

    req.log.info({
      queryParams: req.query,
      resultCount: cachedVal.candidates.length,
      durationMs,
      usedFullTextIndex: !!q,
      cacheStatus: 'hit',
    }, 'Search queries served from cache');
    return res.json(cachedVal);
  }

  req.log.info({ queryParams: req.query }, 'Received candidate search request (Cache Miss)');

  // Keyset parameters setup
  const params = [];
  const whereClauses = [];

  let queryTerms = '';
  if (q) {
    const cleanQ = q.replace(/[^\w\s-]/g, ' ').trim();
    const terms = cleanQ.split(/\s+/).filter(Boolean);
    if (terms.length > 0) {
      queryTerms = terms.map(t => `${t}:*`).join(' & ');
    } else {
      q = null; // Ignore query if no search tokens remain
    }
  }

  let selectFields = `
    c.id,
    c.name,
    c.email,
    c.skills,
    c.status,
    c.location,
    c.updated_at,
    c.resume_s3_key
  `;

  const fromClause = `candidates c LEFT JOIN resume_content r ON c.id = r.candidate_id`;
  let orderBy = '';
  let queryTermsParamIndex = null;

  if (q) {
    params.push(queryTerms);
    queryTermsParamIndex = params.length;

    selectFields += `, ts_rank(c.search_vector, to_tsquery('simple', $queryTermsParamIndex)) AS search_rank`;
    // Explicit placeholder matching target parameters count
    selectFields = selectFields.replace('$queryTermsParamIndex', `$${queryTermsParamIndex}`);
    
    selectFields += `, coalesce(ts_headline('english', r.raw_text, to_tsquery('simple', $${queryTermsParamIndex}), 'MaxWords=30, MaxFragments=1'), '') AS resume_snippet`;

    whereClauses.push(`c.search_vector @@ to_tsquery('simple', $${queryTermsParamIndex})`);
    orderBy = `ts_rank(c.search_vector, to_tsquery('simple', $${queryTermsParamIndex})) DESC, c.updated_at DESC, c.id DESC`;
  } else {
    selectFields += `, 0.0 AS search_rank`;
    selectFields += `, coalesce(substring(r.raw_text from 1 for 200), '') AS resume_snippet`;
    orderBy = `c.updated_at DESC, c.id DESC`;
  }

  // Comma-separated skills filter (Must have ALL skills)
  if (skills) {
    const skillsArray = skills.split(',').map(s => s.trim()).filter(Boolean);
    if (skillsArray.length > 0) {
      params.push(skillsArray);
      whereClauses.push(`c.skills @> $${params.length}::text[]`);
    }
  }

  // Candidate status filter
  if (status) {
    params.push(status);
    whereClauses.push(`c.status = $${params.length}`);
  }

  // Location filter (case-insensitive substring)
  if (location) {
    params.push(`%${location.trim()}%`);
    whereClauses.push(`c.location ILIKE $${params.length}`);
  }

  // Experience search inside resume text
  if (experience) {
    params.push(`%${experience.trim()}%`);
    whereClauses.push(`r.raw_text ILIKE $${params.length}`);
  }

  // Keyset Pagination cursor evaluation
  const decodedCursor = decodeCursor(cursor);
  if (decodedCursor) {
    if (q) {
      const { searchRank, updatedAt, id } = decodedCursor;
      params.push(searchRank, updatedAt, id);
      const rankIdx = params.length - 2;
      const timeIdx = params.length - 1;
      const idIdx = params.length;

      const rankFunc = `ts_rank(c.search_vector, to_tsquery('simple', $${queryTermsParamIndex}))`;
      whereClauses.push(`(
        (${rankFunc} < $${rankIdx})
        OR (${rankFunc} = $${rankIdx} AND c.updated_at < $${timeIdx})
        OR (${rankFunc} = $${rankIdx} AND c.updated_at = $${timeIdx} AND c.id < $${idIdx})
      )`);
    } else {
      const { updatedAt, id } = decodedCursor;
      params.push(updatedAt, id);
      const timeIdx = params.length - 1;
      const idIdx = params.length;

      whereClauses.push(`(
        (c.updated_at < $${timeIdx})
        OR (c.updated_at = $${timeIdx} AND c.id < $${idIdx})
      )`);
    }
  }

  // Parse limits
  let finalLimit = parseInt(limit, 10) || 20;
  if (finalLimit <= 0) finalLimit = 20;
  if (finalLimit > 100) finalLimit = 100;

  // Build final SQL
  let sql = `SELECT ${selectFields} FROM ${fromClause}`;
  if (whereClauses.length > 0) {
    sql += ` WHERE ` + whereClauses.join(' AND ');
  }
  sql += ` ORDER BY ${orderBy}`;

  // Limit query to finalLimit + 1 to inspect nextPage existence
  params.push(finalLimit + 1);
  sql += ` LIMIT $${params.length}`;

  try {
    const result = await db.query(sql, params);
    const results = result.rows;

    const hasNextPage = results.length > finalLimit;
    const slicedResults = hasNextPage ? results.slice(0, finalLimit) : results;

    // Encode cursor for next page if present
    let nextCursor = null;
    if (hasNextPage && slicedResults.length > 0) {
      const lastItem = slicedResults[slicedResults.length - 1];
      if (q) {
        nextCursor = encodeCursor({
          searchRank: parseFloat(lastItem.search_rank),
          updatedAt: lastItem.updated_at,
          id: lastItem.id,
        });
      } else {
        nextCursor = encodeCursor({
          updatedAt: lastItem.updated_at,
          id: lastItem.id,
        });
      }
    }

    const durationMs = Date.now() - startTime;
    
    // Record metrics
    metricsTracker.recordQuery(durationMs);

    req.log.info({
      queryParams: req.query,
      resultCount: slicedResults.length,
      durationMs,
      usedFullTextIndex: !!q,
      cacheStatus: 'miss',
    }, 'Search queries executed successfully');

    // Slow Query Diagnostics: log a pino warning and fetch EXPLAIN ANALYZE if exceeds 500ms
    if (durationMs > 500) {
      req.log.warn({
        queryParams: req.query,
        durationMs,
      }, `Slow search query detected (>500ms)`);

      try {
        const explainSql = `EXPLAIN ANALYZE ${sql}`;
        const explainResult = await db.query(explainSql, params);
        const explainPlanStr = explainResult.rows.map(r => r['QUERY PLAN']).join('\n');
        req.log.warn({
          queryParams: req.query,
          durationMs,
          explainPlan: explainPlanStr,
        }, 'Slow search query database execution plan (EXPLAIN ANALYZE)');
      } catch (explainErr) {
        req.log.error({ err: explainErr.message }, 'Failed to run EXPLAIN ANALYZE for slow search query');
      }
    }

    const responseData = {
      candidates: slicedResults,
      nextCursor,
    };

    // Store response in cache
    queryCache.set(cacheKey, responseData);

    res.json(responseData);

  } catch (err) {
    const durationMs = Date.now() - startTime;
    logger.error({
      err: err.message,
      stack: err.stack,
      durationMs,
    }, 'Error executing candidate search');
    res.status(500).json({ error: 'Internal Server Error', reason: err.message });
  }
});

const PORT = config.port;
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Search Service running on port ${PORT}`);
});
