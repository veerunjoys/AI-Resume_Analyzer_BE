const Queue = require('bull');
const Redis = require('ioredis');
const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logLevel,
});

const isMock = process.env.NODE_ENV === 'test' || config.redisUrl === 'mock';

// Bull requires separate connection instances for client, subscriber, and bclient.
let createClient;
let redisClientMock;

if (isMock) {
  const RedisMock = require('ioredis-mock');
  logger.info('Initializing Bull queues using in-memory mock Redis (ioredis-mock)');
  // We initialize the mock client to comply with the ioredis-mock installation requirements
  redisClientMock = new RedisMock();
  createClient = (type) => {
    logger.debug({ connectionType: type }, 'Creating mock Redis client');
    return redisClientMock;
  };
} else {
  logger.info({ redisUrl: config.redisUrl.replace(/:[^:@/]+@/, ':****@') }, 'Initializing Bull queues using live Redis connection');
  createClient = (type) => {
    logger.debug({ connectionType: type }, 'Creating real Redis client');
    if (type === 'bclient') {
      return new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    }
    return new Redis(config.redisUrl);
  };
}

const defaultOptions = {
  createClient,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: false,
    removeOnFail: false,
  },
};

// Helper to log queue events
function registerQueueListeners(queue, queueName) {
  queue.on('completed', (job, result) => {
    logger.info({
      jobId: job.id,
      queueName,
      attemptNumber: job.attemptsMade,
      status: 'completed',
    }, `Job completed in queue ${queueName}`);
  });

  queue.on('failed', (job, err) => {
    logger.error({
      jobId: job.id,
      queueName,
      attemptNumber: job.attemptsMade,
      error: err.message,
      stack: err.stack,
      status: 'failed',
    }, `Job failed in queue ${queueName}: ${err.message}`);
  });

  queue.on('stalled', (job) => {
    const jobId = job ? job.id : 'unknown';
    const attemptNumber = job ? job.attemptsMade : null;
    logger.warn({
      jobId,
      queueName,
      attemptNumber,
      status: 'stalled',
    }, `Job stalled in queue ${queueName}`);
  });
}

/**
 * MockQueue Class
 * Since ioredis-mock does not support the Lua scripts containing cmsgpack that Bull relies on,
 * this MockQueue runs job processing inside Node memory when in mock mode.
 */
class MockQueue {
  constructor(name) {
    this.name = name;
    this.jobs = [];
    this.processCallback = null;
    this.listeners = { completed: [], failed: [], stalled: [] };
    this.jobCounter = 0;
  }

  async add(data, options = {}) {
    this.jobCounter++;
    const job = {
      id: String(this.jobCounter),
      data,
      attemptsMade: 0,
      discard: async () => {
        job.discarded = true;
      },
    };
    this.jobs.push(job);

    setImmediate(async () => {
      if (this.processCallback) {
        try {
          const result = await this.processCallback(job);
          this.emit('completed', job, result);
        } catch (err) {
          job.attemptsMade++;
          this.emit('failed', job, err);
        }
      }
    });
    return job;
  }

  process(callback) {
    this.processCallback = callback;
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback);
    }
  }

  emit(event, ...args) {
    if (this.listeners[event]) {
      for (const listener of this.listeners[event]) {
        listener(...args);
      }
    }
  }

  async getJobs() {
    return this.jobs;
  }
}

let validationQueue;
let workerQueue;
let processingQueue;
let indexingQueue;
let deadLetterQueue;

if (isMock) {
  validationQueue = new MockQueue('validation-stage');
  workerQueue = new MockQueue('worker-stage');
  processingQueue = new MockQueue('processing-stage');
  indexingQueue = new MockQueue('indexing-stage');
  deadLetterQueue = new MockQueue('dead-letter-stage');

  registerQueueListeners(validationQueue, 'validationQueue');
  registerQueueListeners(workerQueue, 'workerQueue');
  registerQueueListeners(processingQueue, 'processingQueue');
  registerQueueListeners(indexingQueue, 'indexingQueue');
  registerQueueListeners(deadLetterQueue, 'deadLetterQueue');
} else {
  /**
   * 1. validationQueue:
   * Responsible for verifying that the uploaded file exists on disk,
   * re-computing and validating the file checksum, checking file size bounds,
   * and calling the orchestrator status validation endpoint.
   */
  validationQueue = new Queue('validation-stage', defaultOptions);
  registerQueueListeners(validationQueue, 'validationQueue');

  /**
   * 2. workerQueue:
   * Responsible for orchestrating and dispatching approved files to available
   * processing slots and background worker threads.
   */
  workerQueue = new Queue('worker-stage', defaultOptions);
  registerQueueListeners(workerQueue, 'workerQueue');

  /**
   * 3. processingQueue:
   * Responsible for running the heavy extraction algorithms, extracting text from PDF/Word documents,
   * extracting metadata (name, skills, contact info), and updating candidate profile structures.
   */
  processingQueue = new Queue('processing-stage', defaultOptions);
  registerQueueListeners(processingQueue, 'processingQueue');

  /**
   * 4. indexingQueue:
   * Responsible for feeding processed candidate data and text contents into
   * full-text search indexing engines.
   */
  indexingQueue = new Queue('indexing-stage', defaultOptions);
  registerQueueListeners(indexingQueue, 'indexingQueue');

  /**
   * 5. deadLetterQueue:
   * Stores jobs that have permanently failed validation, indexing, or processing stages,
   * enabling developers to inspect failure payloads and manually trigger retries.
   */
  deadLetterQueue = new Queue('dead-letter-stage', defaultOptions);
  registerQueueListeners(deadLetterQueue, 'deadLetterQueue');
}

module.exports = {
  validationQueue,
  workerQueue,
  processingQueue,
  indexingQueue,
  deadLetterQueue,
};
