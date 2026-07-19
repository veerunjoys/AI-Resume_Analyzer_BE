const express = require('express');
const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
});

const app = express();
app.use(express.json());

// Correlation ID Middleware - Applied first
app.use((req, res, next) => {
  const correlationId = req.headers['x-correlation-id'] || require('crypto').randomUUID();
  req.correlationId = correlationId;
  req.log = logger.child({ correlationId });
  res.setHeader('X-Correlation-ID', correlationId);
  next();
});

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'rw-processor' });
});

// Load queue workers
require('./workers/validation.worker');
require('./workers/processing.worker');
require('./workers/indexing.worker');
require('./workers/deadletter.worker');

const jwt = require('jsonwebtoken');

async function subscribeToEventStore() {
  const token = jwt.sign(
    { id: 'system-processor', name: 'Processor Service' },
    config.jwtSecret,
    { expiresIn: '24h' }
  );

  const url = `${config.eventSystemUrl}/events/stream?event_type=ResumeUploaded`;
  logger.info({ url }, 'Processor attempting connection to Event System SSE stream');

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!response.ok) {
      throw new Error(`SSE stream returned status ${response.status}`);
    }

    logger.info('Processor connection to Event System stream established');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const { validationQueue } = require('./queues');

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.info('Processor Event System stream closed by remote server');
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          const rawData = trimmed.slice(6).trim();
          if (rawData) {
            try {
              const event = JSON.parse(rawData);
              if (event.event_type === 'ResumeUploaded') {
                const { uploadId, candidateId, fileName, checksum } = event.payload;
                logger.info({ uploadId, candidateId, fileName }, 'Received ResumeUploaded event. Adding to validationQueue...');
                
                await validationQueue.add({
                  uploadId,
                  candidateId,
                  fileName,
                  checksum
                });
              }
            } catch (parseErr) {
              logger.error({ parseErr: parseErr.message, rawData }, 'Error parsing SSE event data');
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'Processor Event System connection failed. Reconnecting in 5 seconds...');
  }

  // Auto reconnect
  setTimeout(subscribeToEventStore, 5000);
}

const PORT = config.port;
app.listen(PORT, () => {
  logger.info({ port: PORT }, `Processor service running on port ${PORT}`);
  subscribeToEventStore();
});
