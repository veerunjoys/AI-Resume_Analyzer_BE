/**
 * pipeline/processor.js
 *
 * Bootstrap module for the processor pipeline.
 * - Loads all queue workers (registers their process() handlers)
 * - Subscribes to ResumeUploaded events from the in-process event system
 *   and enqueues them into the validationQueue
 */

const pino = require('pino');
const jwt = require('jsonwebtoken');
const config = require('../config');

const logger = pino({ level: config.logLevel });

// Load workers — each file registers its queue.process() handler
require('./workers/validation.worker');
require('./workers/processing.worker');
require('./workers/indexing.worker');
require('./workers/deadletter.worker');
require('./workers/matching.worker');

/**
 * Subscribes to the in-process event system's SSE subscriber registry.
 * When a ResumeUploaded event is emitted (in-process), this handler
 * directly enqueues the job — no network call needed.
 */
function bootstrapProcessorSubscription() {
  const { activeSubscribers } = require('./eventSystem');
  const { validationQueue } = require('./queues');

  // Create a synthetic SSE-like subscriber object that receives events
  // pushed by emitEventDirect() in eventSystem.js
  const subscriber = {
    eventTypes: ['ResumeUploaded'],
    aggregateId: null,
    res: {
      // The event system calls res.write(data) for each matched event.
      // We intercept it here and parse the SSE data line.
      write(chunk) {
        try {
          // chunk format: "data: {...}\n\n"
          const trimmed = chunk.toString().trim();
          if (!trimmed.startsWith('data: ')) return;
          const event = JSON.parse(trimmed.slice(6).trim());
          if (event.event_type === 'ResumeUploaded') {
            const { uploadId, candidateId, fileName, checksum, resumeS3Key } = event.payload;
            logger.info({ uploadId, candidateId, fileName }, 'Processor received ResumeUploaded — enqueueing validation');
            validationQueue.add({ uploadId, candidateId, fileName, checksum, resumeS3Key })
              .catch(err => logger.error({ uploadId, err: err.message }, 'Failed to enqueue validation job'));
          }
        } catch (err) {
          logger.error({ err: err.message }, 'Processor: error handling in-process SSE event');
        }
      },
      // Required by the subscriber loop — flushHeaders is a no-op for us
      flushHeaders() {},
    },
  };

  activeSubscribers.add(subscriber);
  logger.info('Processor pipeline bootstrapped — listening for ResumeUploaded events in-process');
}

module.exports = { bootstrapProcessorSubscription };
