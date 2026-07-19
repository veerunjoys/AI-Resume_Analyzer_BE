const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');
const db = require('./db');

// Map of identified clients: clientId -> { ws, identifiedAt, recruiter }
const clients = new Map();

let wss = null;

/**
 * Initializes the WebSocket server attached to the existing HTTP server.
 * No separate port — shares port 4000 with Express via upgrade events.
 *
 * @param {http.Server} httpServer  The server returned by app.listen()
 */
function initWebSocketServer(httpServer) {
  wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws, req) => {
    const clientId = crypto.randomUUID();
    let isIdentified = false;

    console.log(`[WebSocket] New connection. Temp ID: ${clientId}`);

    // Force identification within 5 seconds
    const authTimeout = setTimeout(() => {
      if (!isIdentified) {
        console.log(`[WebSocket] Client ${clientId} timed out without auth — disconnecting`);
        ws.close(4001, 'Authentication timeout');
      }
    }, 5000);

    ws.on('message', (messageBuffer) => {
      try {
        const data = JSON.parse(messageBuffer.toString());

        if (!isIdentified) {
          if ((data.type === 'auth' || data.type === 'identify') && data.token) {
            try {
              const decoded = jwt.verify(data.token, config.jwtSecret);
              isIdentified = true;
              clearTimeout(authTimeout);
              ws.recruiter = decoded;
              clients.set(clientId, { ws, identifiedAt: new Date(), recruiter: decoded });
              console.log(`[WebSocket] Client ${clientId} authenticated as ${decoded.email}`);
              ws.send(JSON.stringify({ type: 'authenticated', clientId }));
            } catch (err) {
              console.log(`[WebSocket] Client ${clientId} auth failed: ${err.message}`);
              ws.close(4001, 'Unauthorized');
            }
          } else {
            ws.close(4001, 'Unauthorized');
          }
          return;
        }

        if (data.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch (err) {
        console.error(`[WebSocket] Parse error for client ${clientId}:`, err);
        ws.close(4002, 'Invalid message format');
      }
    });

    ws.on('close', (code, reason) => {
      clearTimeout(authTimeout);
      clients.delete(clientId);
      console.log(`[WebSocket] Client ${clientId} disconnected. Code: ${code}`);
    });

    ws.on('error', (err) => {
      console.error(`[WebSocket] Error on client ${clientId}:`, err);
      ws.close();
    });
  });

  console.log(`[WebSocket] Server attached to HTTP server (port ${config.port})`);

  // Subscribe to in-process domain events
  subscribeToInProcessEvents();

  return wss;
}

/**
 * Registers an in-process subscriber to the event system.
 * Receives CandidateCreated and CandidateUpdated events and broadcasts via WebSocket.
 * No HTTP SSE connection — same process, zero latency.
 */
const UPLOAD_PIPELINE_EVENT_TYPES = ['ResumeUploaded', 'ResumeProcessed', 'ResumeIndexed', 'ResumeFailed', 'ResumeAnalyzed'];

function subscribeToInProcessEvents() {
  try {
    const { activeSubscribers } = require('./pipeline/eventSystem');

    const subscriber = {
      eventTypes: ['CandidateCreated', 'CandidateUpdated', 'CandidateDeleted', ...UPLOAD_PIPELINE_EVENT_TYPES],
      aggregateId: null,
      res: {
        write(chunk) {
          try {
            const trimmed = chunk.toString().trim();
            if (!trimmed.startsWith('data: ')) return;
            const event = JSON.parse(trimmed.slice(6).trim());
            if (event.event_type === 'CandidateCreated') {
              broadcast('candidate_created', event.aggregate_id, event.payload);
            } else if (event.event_type === 'CandidateUpdated') {
              broadcast('candidate_updated', event.aggregate_id, event.payload);
            } else if (event.event_type === 'CandidateDeleted') {
              broadcast('candidate_deleted', event.aggregate_id, event.payload);
            } else if (UPLOAD_PIPELINE_EVENT_TYPES.includes(event.event_type)) {
              // Pipeline stage transitions aren't candidate-level history (that's
              // what candidate_events/pipeline_audit_log are for) — just a live
              // "something changed, go refetch" ping for the Upload Queue page.
              broadcastRaw({
                type: 'upload_status_ping',
                eventType: event.event_type,
                uploadId: event.payload?.uploadId || null,
                candidateId: event.aggregate_id,
              });
            }
          } catch (err) {
            console.error('[WebSocket] Error handling in-process event:', err.message);
          }
        },
        flushHeaders() {},
      },
    };

    activeSubscribers.add(subscriber);
    console.log('[WebSocket] Subscribed to in-process Candidate + upload-pipeline events');
  } catch (err) {
    console.error('[WebSocket] Failed to subscribe to event system:', err.message);
  }
}

/**
 * Persists a WebSocket event to candidate_events and broadcasts to all identified clients.
 */
async function broadcast(eventType, candidateId, payload, originClientId = null) {
  try {
    let finalPayload = payload;
    if (originClientId && typeof payload === 'object' && payload !== null) {
      finalPayload = { ...payload, _originClientId: originClientId };
    }

    const result = await db.query(
      `INSERT INTO candidate_events (candidate_id, event_type, payload)
       VALUES ($1, $2, $3)
       RETURNING id, sequence_id, candidate_id, event_type, payload, created_at`,
      [candidateId, eventType, finalPayload]
    );
    const event = result.rows[0];

    const messageStr = JSON.stringify({
      type: 'event',
      event: {
        id: event.id,
        sequenceId: parseInt(event.sequence_id, 10),
        candidateId: event.candidate_id,
        eventType: event.event_type,
        payload: event.payload,
        createdAt: event.created_at,
      },
    });

    let broadcastCount = 0;
    for (const [, client] of clients.entries()) {
      if (client.ws.readyState === 1) {
        client.ws.send(messageStr);
        broadcastCount++;
      }
    }
    console.log(`[WebSocket] Broadcasted '${eventType}' for candidate ${candidateId} to ${broadcastCount} clients`);
  } catch (err) {
    console.error(`[WebSocket] Broadcast error for '${eventType}':`, err);
  }
}

/**
 * Sends a message to all identified WebSocket clients without persisting it
 * anywhere — for lightweight "something changed, go refetch" signals that
 * don't need replay-on-reconnect (the receiver just re-fetches current state).
 */
function broadcastRaw(messageObj) {
  const messageStr = JSON.stringify(messageObj);
  for (const [, client] of clients.entries()) {
    if (client.ws.readyState === 1) {
      client.ws.send(messageStr);
    }
  }
}

function closeWebSocketServer() {
  if (wss) {
    for (const [, client] of clients.entries()) {
      if (client.ws.readyState === 1 || client.ws.readyState === 0) client.ws.close();
    }
    clients.clear();
    wss.close();
    wss = null;
    console.log('[WebSocket] Server stopped.');
  }
}

module.exports = { initWebSocketServer, closeWebSocketServer, broadcast, broadcastRaw, clients };
