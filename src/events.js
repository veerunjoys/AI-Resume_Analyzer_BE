const crypto = require('crypto');

/**
 * Emits a candidate domain event directly via the in-process event system.
 * No HTTP call — zero network overhead.
 */
async function emitDomainEvent(eventType, aggregateId, payload, correlationId = null, causationId = null) {
  try {
    const { emitEventDirect } = require('./pipeline/eventSystem');
    const actualCorrelationId = correlationId || crypto.randomUUID();
    const event = await emitEventDirect(
      eventType,
      aggregateId,
      payload,
      actualCorrelationId,
      causationId,
      { source: 'server', version: '1.0.0' }
    );
    console.log(`[EventSystem] Emitted ${eventType} (ID: ${event?.id})`);
    return event;
  } catch (err) {
    console.error(`[EventSystem] Error emitting ${eventType}:`, err.message);
    return null;
  }
}

module.exports = { emitDomainEvent };
