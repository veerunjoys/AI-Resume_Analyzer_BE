const request = require('supertest');
const app = require('../index');
const db = require('../db');
const jwt = require('jsonwebtoken');
const config = require('../config');

const testToken = jwt.sign(
  { id: 'test-recruiter-uuid', name: 'Test Recruiter', email: 'test@company.com' },
  config.jwtSecret,
  { expiresIn: '24h' }
);

jest.mock('../db', () => ({
  query: jest.fn(),
  pool: {
    connect: jest.fn(),
    query: jest.fn(),
  }
}));

jest.mock('../websocket', () => ({
  initWebSocketServer: jest.fn(),
  broadcast: jest.fn(() => Promise.resolve()),
}));

describe('Candidates Query & Pagination Integration Tests', () => {
  let mockCandidates = [];
  let dbQueries = [];

  beforeEach(() => {
    jest.clearAllMocks();
    dbQueries = [];
    mockCandidates = Array.from({ length: 50 }, (_, i) => ({
      id: `uuid-${i}`,
      name: `Candidate ${i}`,
      email: `candidate.${i}@example.com`,
      phone: `555-01${i}`,
      status: i % 2 === 0 ? 'Applied' : 'Interviewing',
      skills: ['React', 'Node'],
      location: 'New York',
      version: 1
    }));

    db.query.mockImplementation((text, params) => {
      dbQueries.push({ text: text.replace(/\s+/g, ' '), params });
      
      if (text.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ count: '100' }] });
      }
      
      // Return candidates list (slice depending on requested limit)
      const limit = params && params[params.length - 1];
      const sliceSize = typeof limit === 'number' ? limit : 50;
      const returnedList = mockCandidates.slice(0, sliceSize);
      return Promise.resolve({ rows: returnedList });
    });
  });

  test('should return default candidate list (limit 50) and nextCursor when length matches limit', async () => {
    const res = await request(app)
      .get('/api/candidates')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(50);
    expect(res.body.totalCount).toBe(100);
    expect(res.body.nextCursor).toBeDefined();

    // Verify nextCursor contains encoded { name: 'Candidate 49', id: 'uuid-49' }
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded).toEqual({
      name: 'Candidate 49',
      id: 'uuid-49'
    });

    // Check queries executed
    const listQuery = dbQueries.find(q => q.text.includes('SELECT id, name'));
    const countQuery = dbQueries.find(q => q.text.includes('COUNT(*)'));

    expect(listQuery).toBeDefined();
    expect(listQuery.text).toContain('LIMIT $1');
    expect(listQuery.params).toEqual([50]);
    expect(countQuery).toBeDefined();
  });

  test('should apply filters for status, skills, and location correctly', async () => {
    const res = await request(app)
      .get('/api/candidates?status=Applied&skills=React,Jest&location=New York&limit=10')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates.length).toBeLessThanOrEqual(10);

    // Verify filter parameters in the DB query
    const listQuery = dbQueries.find(q => q.text.includes('SELECT id, name'));
    expect(listQuery).toBeDefined();
    expect(listQuery.text).toContain('status = $1');
    expect(listQuery.text).toContain('skills @> $2::text[]');
    expect(listQuery.text).toContain('location = $3');
    expect(listQuery.text).toContain('LIMIT $4');
    
    // params order: status, skillList, location, limit
    expect(listQuery.params).toEqual(['Applied', ['React', 'Jest'], 'New York', 10]);

    // Check count query includes identical filters
    const countQuery = dbQueries.find(q => q.text.includes('COUNT(*)'));
    expect(countQuery).toBeDefined();
    expect(countQuery.text).toContain('status = $1');
    expect(countQuery.text).toContain('skills @> $2::text[]');
    expect(countQuery.text).toContain('location = $3');
    expect(countQuery.params).toEqual(['Applied', ['React', 'Jest'], 'New York']);
  });

  test('should support keyset pagination via a cursor parameter', async () => {
    // Generate cursor for name: "John Doe", id: "uuid-middle"
    const cursorStr = Buffer.from(JSON.stringify({ name: 'John Doe', id: 'uuid-middle' })).toString('base64');

    const res = await request(app)
      .get(`/api/candidates?cursor=${cursorStr}&limit=20`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);

    const listQuery = dbQueries.find(q => q.text.includes('SELECT id, name'));
    expect(listQuery).toBeDefined();
    
    // Keyset pagination condition: name > $1 OR (name = $1 AND id > $2)
    expect(listQuery.text).toContain('name > $1');
    expect(listQuery.text).toContain('id > $2');
    expect(listQuery.params).toEqual(['John Doe', 'uuid-middle', 20]);

    // When cursor is provided, it should NOT fetch totalCount
    const countQuery = dbQueries.find(q => q.text.includes('COUNT(*)'));
    expect(countQuery).toBeUndefined();
  });

  test('should execute full-text search query and sort by rank when search term is provided', async () => {
    // Mock candidates returned from search contains a rank field
    mockCandidates = [
      { id: 'uuid-1', name: 'Software Engineer', rank: 0.95, status: 'Applied', skills: [], version: 1 },
      { id: 'uuid-2', name: 'Software Architect', rank: 0.85, status: 'Applied', skills: [], version: 1 }
    ];

    const res = await request(app)
      .get('/api/candidates?search=Software&limit=2')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);

    const listQuery = dbQueries.find(q => q.text.includes('SELECT id, name'));
    expect(listQuery).toBeDefined();
    expect(listQuery.text).toContain("search_vector @@ to_tsquery('simple', $1)");
    expect(listQuery.text).toContain('ORDER BY rank DESC, id ASC');
    expect(listQuery.params).toEqual(['Software:*', 2]);

    // Check pagination cursor has rank details
    const decoded = JSON.parse(Buffer.from(res.body.nextCursor, 'base64').toString('utf8'));
    expect(decoded).toEqual({
      id: 'uuid-2',
      rank: 0.85
    });
  });

  test('should support search keyset pagination with rank and id cursors', async () => {
    const cursorStr = Buffer.from(JSON.stringify({ rank: 0.85, id: 'uuid-2' })).toString('base64');

    const res = await request(app)
      .get(`/api/candidates?search=Software&cursor=${cursorStr}&limit=5`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);

    const listQuery = dbQueries.find(q => q.text.includes('SELECT id, name'));
    expect(listQuery).toBeDefined();
    expect(listQuery.text).toContain("ts_rank(search_vector, to_tsquery('simple', $1)) < $2");
    expect(listQuery.text).toContain('id > $3');
    expect(listQuery.params).toEqual(['Software:*', 0.85, 'uuid-2', 5]);
  });
});
