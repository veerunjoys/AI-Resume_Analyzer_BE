const jwt = require('jsonwebtoken');
const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
});

/**
 * Durably emits a domain event to the event system.
 * Passes correlationId so all events from one upload share the same correlationId.
 * If the event system is unreachable/fails, logs the error but does NOT throw.
 */
async function emitEvent(eventType, aggregateId, payload, correlationId, causationId = null) {
  try {
    const token = jwt.sign(
      { id: 'system-processor', name: 'Processor Service' },
      config.jwtSecret,
      { expiresIn: '5m' }
    );

    const url = `${config.eventSystemUrl}/events/emit`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        event_type: eventType,
        aggregate_id: aggregateId,
        payload,
        correlation_id: correlationId,
        causation_id: causationId || null,
        metadata: { source: 'processor', version: '1.0.0' }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error({
        eventType,
        aggregateId,
        status: response.status,
        error: errorText,
      }, 'Failed to emit domain event (unsuccessful response)');
      return null;
    }

    const event = await response.json();
    logger.info({
      eventType,
      aggregateId,
      eventId: event.id,
      correlationId,
      causationId,
    }, 'Domain event emitted and persisted successfully');
    return event;
  } catch (err) {
    // Log failure but do NOT throw to avoid blocking the pipeline
    logger.error({
      eventType,
      aggregateId,
      err: err.message,
      stack: err.stack,
    }, 'Event system is unreachable; logging event failure but continuing execution (best-effort)');
    return null;
  }
}

module.exports = {
  emitEvent,
};
