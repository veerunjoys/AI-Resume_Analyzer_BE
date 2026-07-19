const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 4002,
  databaseUrl: process.env.DATABASE_URL || '',
  uploadOrchestratorUrl: process.env.UPLOAD_ORCHESTRATOR_URL || 'http://localhost:4000',
  eventSystemUrl: process.env.EVENT_SYSTEM_URL || 'http://localhost:4000',
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  jwtSecret: process.env.JWT_SECRET || 'recruiter_secret_key_default_123',
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
