const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 4001,
  databaseUrl: process.env.DATABASE_URL || '',
  eventSystemUrl: process.env.EVENT_SYSTEM_URL || 'http://localhost:4004',
  jwtSecret: process.env.JWT_SECRET || 'recruiter_secret_key_default_123',
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
