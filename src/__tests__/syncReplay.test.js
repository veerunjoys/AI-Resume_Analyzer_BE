const request = require('supertest');
const app = require('../index');
const db = require('../db');
const { broadcast } = require('../websocket');
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

describe('Sync Replay API Conflict Logic Unit Tests', () => {
  let mockCandidateValue = null;
  let mockPriorEventValue = null;
  let mockUpdatedCandidateValue = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCandidateValue = null;
    mockPriorEventValue = null;
    mockUpdatedCandidateValue = null;

    db.query.mockImplementation((text, params) => {
      const normalizedText = text.replace(/\s+/g, ' ');
      if (normalizedText.includes('SELECT version, status, notes FROM candidates')) {
        return Promise.resolve({ rows: mockCandidateValue ? [mockCandidateValue] : [] });
      }
      if (normalizedText.includes('SELECT payload FROM candidate_events')) {
        return Promise.resolve({ rows: mockPriorEventValue ? [{ payload: mockPriorEventValue }] : [] });
      }
      if (normalizedText.includes('UPDATE candidates')) {
        return Promise.resolve({ rows: mockUpdatedCandidateValue ? [mockUpdatedCandidateValue] : [{}] });
      }
      if (normalizedText.includes('INSERT INTO offline_action_log')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.reject(new Error('Unexpected query: ' + text));
    });
  });

  test('should return 400 if body is not an array of actions', async () => {
    const res = await request(app)
      .post('/api/sync/replay')
      .set('Authorization', `Bearer ${testToken}`)
      .send({ client_action_id: '1' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Body must be an array of actions.');
  });

  test('should report error for action if parameters are missing', async () => {
    const res = await request(app)
      .post('/api/sync/replay')
      .set('Authorization', `Bearer ${testToken}`)
      .send([{ client_action_id: 'action-1' }]);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      client_action_id: 'action-1',
      status: 'error',
      error: 'Missing required action parameters.'
    });
  });

  test('should apply changes directly if client version matches server version (applied)', async () => {
    mockCandidateValue = {
      version: 1,
      status: 'Applied',
      notes: 'Initial notes'
    };
    mockUpdatedCandidateValue = {
      id: 'cand-123',
      name: 'John Doe',
      status: 'Interviewing',
      notes: 'Initial notes',
      version: 2
    };

    const actions = [{
      client_action_id: 'action-1',
      candidate_id: 'cand-123',
      base_version: 1,
      changes: { status: 'Interviewing' }
    }];

    const res = await request(app)
      .post('/api/sync/replay')
      .set('Authorization', `Bearer ${testToken}`)
      .send(actions);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      client_action_id: 'action-1',
      status: 'applied'
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE candidates'),
      ['Interviewing', 'Initial notes', 'cand-123']
    );
    expect(broadcast).toHaveBeenCalled();
  });

  test('should merge non-overlapping changes if version mismatch exists but fields do not conflict (merged)', async () => {
    mockCandidateValue = {
      version: 2,
      status: 'Applied',
      notes: 'Server notes'
    };
    mockPriorEventValue = {
      version: 1,
      status: 'Applied',
      notes: 'Initial notes'
    };
    mockUpdatedCandidateValue = {
      id: 'cand-123',
      name: 'John Doe',
      status: 'Interviewing',
      notes: 'Server notes',
      version: 3
    };

    const actions = [{
      client_action_id: 'action-2',
      candidate_id: 'cand-123',
      base_version: 1,
      changes: { status: 'Interviewing' }
    }];

    const res = await request(app)
      .post('/api/sync/replay')
      .set('Authorization', `Bearer ${testToken}`)
      .send(actions);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      client_action_id: 'action-2',
      status: 'merged'
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE candidates'),
      ['Interviewing', 'Server notes', 'cand-123']
    );
  });

  test('should report conflict if client and server modified overlapping fields (conflict)', async () => {
    mockCandidateValue = {
      version: 2,
      status: 'Rejected',
      notes: 'Initial notes'
    };
    mockPriorEventValue = {
      version: 1,
      status: 'Applied',
      notes: 'Initial notes'
    };
    mockUpdatedCandidateValue = {
      id: 'cand-123',
      name: 'John Doe',
      status: 'Rejected',
      notes: 'Client notes',
      version: 3
    };

    const actions = [{
      client_action_id: 'action-3',
      candidate_id: 'cand-123',
      base_version: 1,
      changes: { status: 'Interviewing', notes: 'Client notes' }
    }];

    const res = await request(app)
      .post('/api/sync/replay')
      .set('Authorization', `Bearer ${testToken}`)
      .send(actions);

    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      client_action_id: 'action-3',
      status: 'conflict',
      conflicts: { status: 'Rejected' },
      currentServerValues: {
        status: 'Rejected',
        notes: 'Client notes',
        version: 3
      }
    });

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE candidates'),
      ['Rejected', 'Client notes', 'cand-123']
    );
  });
});
