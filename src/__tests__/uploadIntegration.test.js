const request = require('supertest');
const app = require('../index');
const db = require('../db');
const storage = require('../storage');
const jwt = require('jsonwebtoken');
const config = require('../config');

const testToken = jwt.sign(
  { id: 'test-recruiter-uuid', name: 'Test Recruiter', email: 'test@company.com' },
  config.jwtSecret,
  { expiresIn: '24h' }
);

jest.mock('../db', () => {
  const mockQuery = jest.fn();
  const mockClient = {
    query: jest.fn(),
    release: jest.fn(),
  };
  return {
    query: mockQuery,
    pool: {
      connect: jest.fn(() => Promise.resolve(mockClient)),
      query: mockQuery,
    },
    mockClient // Expose client mock for assertions
  };
});

jest.mock('../storage', () => ({
  initStorage: jest.fn(),
  startUpload: jest.fn(),
  writeChunk: jest.fn(),
  completeUpload: jest.fn(() => 'uploads/resumes/cand-123_resume.pdf'),
}));

jest.mock('../websocket', () => ({
  initWebSocketServer: jest.fn(),
  broadcast: jest.fn(() => Promise.resolve()),
}));

describe('Upload Session Lifecycle Integration Tests', () => {
  let sessions = {};
  let candidates = {};

  beforeEach(() => {
    jest.clearAllMocks();
    sessions = {};
    candidates = {
      'cand-123': {
        id: 'cand-123',
        name: 'John Doe',
        version: 1,
        resume_s3_key: null
      }
    };

    const handleQuery = (text, params) => {
      const normalized = text.replace(/\s+/g, ' ');

      if (normalized.includes('INSERT INTO upload_sessions')) {
        const [id, candidate_id, fileName, total_chunks] = params;
        sessions[id] = {
          id,
          candidate_id,
          s3_upload_id: fileName,
          status: 'in_progress',
          total_chunks: parseInt(total_chunks, 10),
          chunks_received: []
        };
        return Promise.resolve({ rows: [{ id }] });
      }

      if (normalized.includes('SELECT id, status FROM upload_sessions')) {
        const [id] = params;
        const session = sessions[id];
        return Promise.resolve({ rows: session ? [{ id: session.id, status: session.status }] : [] });
      }

      if (normalized.includes('UPDATE upload_sessions SET chunks_received')) {
        const [chunkIndex, id] = params;
        const session = sessions[id];
        if (session) {
          if (!session.chunks_received.includes(chunkIndex)) {
            session.chunks_received.push(chunkIndex);
            session.chunks_received.sort((a, b) => a - b);
          }
          return Promise.resolve({ rows: [{ chunks_received: session.chunks_received }] });
        }
        return Promise.resolve({ rows: [] });
      }

      if (normalized.includes('SELECT chunks_received, total_chunks, status FROM upload_sessions')) {
        const [id] = params;
        const session = sessions[id];
        return Promise.resolve({ rows: session ? [session] : [] });
      }

      if (normalized.includes('SELECT candidate_id, s3_upload_id, total_chunks, status FROM upload_sessions')) {
        const [id] = params;
        const session = sessions[id];
        return Promise.resolve({ rows: session ? [session] : [] });
      }

      if (normalized.includes('UPDATE upload_sessions SET status = $1')) {
        const [status, id] = params;
        if (sessions[id]) {
          sessions[id].status = status;
        }
        return Promise.resolve({ rows: [] });
      }

      if (normalized.includes('UPDATE candidates SET resume_s3_key')) {
        const [filePath, candidateId] = params;
        if (candidates[candidateId]) {
          candidates[candidateId].resume_s3_key = filePath;
          candidates[candidateId].version++;
        }
        return Promise.resolve({ rows: [] });
      }

      if (normalized.includes('INSERT INTO candidate_events')) {
        return Promise.resolve({ rows: [] });
      }

      if (normalized.includes('BEGIN') || normalized.includes('COMMIT') || normalized.includes('ROLLBACK')) {
        return Promise.resolve({ rows: [] });
      }

      return Promise.reject(new Error('Unexpected query: ' + text));
    };

    db.query.mockImplementation(handleQuery);
    db.mockClient.query.mockImplementation(handleQuery);
  });

  test('should execute full resumable upload workflow (start -> chunk upload -> status -> complete)', async () => {
    // 1. Start Session
    const startRes = await request(app)
      .post('/api/uploads/start')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        candidateId: 'cand-123',
        fileName: 'resume.pdf',
        totalChunks: 3
      });

    expect(startRes.status).toBe(200);
    const sessionId = startRes.body.sessionId;
    expect(sessionId).toBeDefined();
    expect(storage.startUpload).toHaveBeenCalledWith(sessionId);

    // 2. Upload Chunk 0
    const chunk0Res = await request(app)
      .put(`/api/uploads/${sessionId}/chunk/0`)
      .set('Authorization', `Bearer ${testToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('chunk0-binary-data'));

    expect(chunk0Res.status).toBe(200);
    expect(chunk0Res.body.chunksReceived).toEqual([0]);
    expect(storage.writeChunk).toHaveBeenCalledWith(sessionId, 0, expect.any(Buffer));

    // 3. Upload Chunk 1
    const chunk1Res = await request(app)
      .put(`/api/uploads/${sessionId}/chunk/1`)
      .set('Authorization', `Bearer ${testToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('chunk1-binary-data'));

    expect(chunk1Res.status).toBe(200);
    expect(chunk1Res.body.chunksReceived).toEqual([0, 1]);

    // 4. Fetch Progress Status
    const statusRes = await request(app)
      .get(`/api/uploads/${sessionId}/status`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(statusRes.status).toBe(200);
    expect(statusRes.body).toEqual({
      chunksReceived: [0, 1],
      totalChunks: 3,
      status: 'in_progress'
    });

    // 5. Upload Chunk 2 (Final Chunk)
    const chunk2Res = await request(app)
      .put(`/api/uploads/${sessionId}/chunk/2`)
      .set('Authorization', `Bearer ${testToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('chunk2-binary-data'));

    expect(chunk2Res.status).toBe(200);
    expect(chunk2Res.body.chunksReceived).toEqual([0, 1, 2]);

    // 6. Complete Session
    const completeRes = await request(app)
      .post(`/api/uploads/${sessionId}/complete`)
      .set('Authorization', `Bearer ${testToken}`);

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.filePath).toBe('uploads/resumes/cand-123_resume.pdf');
    expect(storage.completeUpload).toHaveBeenCalledWith(sessionId, 3, 'cand-123', 'resume.pdf');

    // Verify final state in memory
    expect(sessions[sessionId].status).toBe('completed');
    expect(candidates['cand-123'].resume_s3_key).toBe('uploads/resumes/cand-123_resume.pdf');
    expect(candidates['cand-123'].version).toBe(2);
  });

  test('should return 400 for start session with missing candidateId or fileName', async () => {
    const res = await request(app)
      .post('/api/uploads/start')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ fileName: 'resume.pdf' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('candidateId and fileName are required fields.');
  });

  test('should return 404 for chunk upload to non-existent session', async () => {
    const res = await request(app)
      .put('/api/uploads/missing-session-uuid/chunk/0')
      .set('Authorization', `Bearer ${testToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('chunk-data'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Upload session not found.');
  });

  test('should return 400 for chunk upload with empty body', async () => {
    const startRes = await request(app)
      .post('/api/uploads/start')
      .set('Authorization', `Bearer ${testToken}`)
      .send({
        candidateId: 'cand-123',
        fileName: 'resume.pdf',
        totalChunks: 1
      });
    const sessionId = startRes.body.sessionId;

    const res = await request(app)
      .put(`/api/uploads/${sessionId}/chunk/0`)
      .set('Authorization', `Bearer ${testToken}`)
      .set('Content-Type', 'application/octet-stream')
      .send('');

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Empty or invalid binary body.');
  });
});
