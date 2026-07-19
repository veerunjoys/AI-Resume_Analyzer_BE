// Configure custom WebSocket port before loading modules
process.env.WS_PORT = '4501';

const WebSocket = require('ws');
const request = require('supertest');
const app = require('../index');
const db = require('../db');
const { initWebSocketServer, closeWebSocketServer, broadcast, clients } = require('../websocket');
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

describe('WebSocket Lifecycle & Event Replay Integration Tests', () => {
  let wssServer = null;

  beforeAll(() => {
    // Start real WebSocket Server on port 4501
    wssServer = initWebSocketServer();
  });

  afterAll(async () => {
    // Clean up server
    closeWebSocketServer();
    // Allow a brief moment for socket handles to fully close
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('should authenticate client, reply to ping, and receive broadcasted events', (done) => {
    const ws = new WebSocket('ws://localhost:4501');
    let authenticated = false;
    let receivedEvent = false;

    ws.on('open', () => {
      // Send identification message
      ws.send(JSON.stringify({ type: 'identify', token: testToken }));
    });

    ws.on('message', async (dataStr) => {
      const data = JSON.parse(dataStr.toString());

      if (data.type === 'authenticated') {
        authenticated = true;
        
        // Assert that client is registered in map
        expect(clients.size).toBe(1);
        
        // Test heartbeat ping
        ws.send(JSON.stringify({ type: 'ping' }));
        return;
      }

      if (data.type === 'pong') {
        expect(authenticated).toBe(true);

        // Mock DB query for broadasting an event
        db.query.mockResolvedValueOnce({
          rows: [{
            id: 'event-uuid-456',
            sequence_id: '15',
            candidate_id: 'cand-123',
            event_type: 'candidate_updated',
            payload: { status: 'Interviewing', _originClientId: 'some-client-id' },
            created_at: new Date().toISOString()
          }]
        });

        // Trigger broadcast on server
        await broadcast('candidate_updated', 'cand-123', { status: 'Interviewing' }, 'some-client-id');
        return;
      }

      if (data.type === 'event') {
        expect(data.event.sequenceId).toBe(15);
        expect(data.event.eventType).toBe('candidate_updated');
        expect(data.event.payload.status).toBe('Interviewing');
        receivedEvent = true;

        // Clean up client
        ws.close();
      }
    });

    ws.on('close', () => {
      expect(authenticated).toBe(true);
      expect(receivedEvent).toBe(true);
      done();
    });

    ws.on('error', (err) => {
      done(err);
    });
  }, 10000); // 10s timeout

  test('should retrieve missed events since sequenceId via REST API', async () => {
    const mockEvents = [
      { id: 'ev-1', candidate_id: 'cand-1', event_type: 'candidate_created', payload: {}, sequence_id: 11, created_at: new Date().toISOString() },
      { id: 'ev-2', candidate_id: 'cand-2', event_type: 'candidate_updated', payload: {}, sequence_id: 12, created_at: new Date().toISOString() }
    ];

    db.query.mockResolvedValueOnce({ rows: mockEvents });

    const res = await request(app)
      .get('/api/events/since/10')
      .set('Authorization', `Bearer ${testToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].sequence_id).toBe(11);
    expect(res.body[1].sequence_id).toBe(12);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE sequence_id > $1'),
      [10]
    );
  });
});
