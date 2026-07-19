/**
 * pipeline/queues.js
 *
 * Bull queue definitions shared by all pipeline workers.
 * Set REDIS_URL=mock to use in-memory MockQueue (no Redis needed).
 */

const Queue = require('bull');
const Redis = require('ioredis');
const pino = require('pino');
const config = require('../config');

const logger = pino({ level: config.logLevel });

const isMock = process.env.NODE_ENV === 'test' || config.redisUrl === 'mock';

let createClient;
let redisClientMock;

if (isMock) {
  const RedisMock = require('ioredis-mock');
  logger.info('Initializing Bull queues using in-memory mock Redis (ioredis-mock)');
  redisClientMock = new RedisMock();
  createClient = () => redisClientMock;
} else {
  logger.info({ redisUrl: config.redisUrl.replace(/:[^:@/]+@/, ':****@') }, 'Initializing Bull queues using live Redis');
  createClient = (type) => {
    // Bull requires maxRetriesPerRequest: null on all connection types
    return new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false });
  };
}

const defaultOptions = {
  createClient,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: false,
    removeOnFail: false,
  },
};

function registerQueueListeners(queue, name) {
  queue.on('completed', (job) => {
    logger.info({ jobId: job.id, queue: name }, `Job completed in ${name}`);
  });
  queue.on('failed', (job, err) => {
    logger.error({ jobId: job.id, queue: name, error: err.message }, `Job failed in ${name}`);
  });
  queue.on('stalled', (job) => {
    logger.warn({ jobId: job?.id, queue: name }, `Job stalled in ${name}`);
  });
}

/**
 * In-memory MockQueue for testing without Redis.
 */
class MockQueue {
  constructor(name) {
    this.name = name;
    this.jobs = [];
    this.processCallback = null;
    this.listeners = { completed: [], failed: [], stalled: [] };
    this.jobCounter = 0;
  }
  async add(data) {
    this.jobCounter++;
    const job = {
      id: String(this.jobCounter), data, attemptsMade: 0,
      discard: async () => { job.discarded = true; },
    };
    this.jobs.push(job);
    setImmediate(async () => {
      if (this.processCallback) {
        try { const r = await this.processCallback(job); this.emit('completed', job, r); }
        catch (err) { job.attemptsMade++; this.emit('failed', job, err); }
      }
    });
    return job;
  }
  process(cb) { this.processCallback = cb; }
  on(event, cb) { if (this.listeners[event]) this.listeners[event].push(cb); }
  emit(event, ...args) { (this.listeners[event] || []).forEach(cb => cb(...args)); }
  async getJobs() { return this.jobs; }
}

let validationQueue, workerQueue, processingQueue, indexingQueue, deadLetterQueue, matchingQueue;

if (isMock) {
  validationQueue = new MockQueue('validation-stage');
  workerQueue     = new MockQueue('worker-stage');
  processingQueue = new MockQueue('processing-stage');
  indexingQueue   = new MockQueue('indexing-stage');
  deadLetterQueue = new MockQueue('dead-letter-stage');
  matchingQueue   = new MockQueue('matching-stage');
} else {
  validationQueue = new Queue('validation-stage', defaultOptions);
  workerQueue     = new Queue('worker-stage', defaultOptions);
  processingQueue = new Queue('processing-stage', defaultOptions);
  indexingQueue   = new Queue('indexing-stage', defaultOptions);
  deadLetterQueue = new Queue('dead-letter-stage', defaultOptions);
  matchingQueue   = new Queue('matching-stage', defaultOptions);
}

[
  [validationQueue, 'validationQueue'],
  [workerQueue,     'workerQueue'],
  [processingQueue, 'processingQueue'],
  [indexingQueue,   'indexingQueue'],
  [deadLetterQueue, 'deadLetterQueue'],
  [matchingQueue,   'matchingQueue'],
].forEach(([q, n]) => registerQueueListeners(q, n));

module.exports = { validationQueue, workerQueue, processingQueue, indexingQueue, deadLetterQueue, matchingQueue };
