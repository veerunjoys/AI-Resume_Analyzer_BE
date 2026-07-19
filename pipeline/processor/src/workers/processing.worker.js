const fs = require('fs');
const path = require('path');
const { processingQueue } = require('../queues');
const serverWorkerPath = path.resolve(__dirname, '../../../../server/src/pipeline/workers/processing.worker');

// Load implementation directly from server/src/pipeline/workers/processing.worker.js
require(serverWorkerPath);
