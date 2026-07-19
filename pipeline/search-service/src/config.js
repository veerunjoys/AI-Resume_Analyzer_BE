const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const config = {
  port: parseInt(process.env.PORT, 10) || 4003,
  databaseUrl: process.env.DATABASE_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'recruiter_secret_key_default_123',
  logLevel: process.env.LOG_LEVEL || 'info',
};

module.exports = config;
