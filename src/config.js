const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env'), quiet: true });

const config = {
  // HTTP server
  port: parseInt(process.env.PORT, 10) || 4000,

  // WebSocket (shares the same HTTP server — no separate port)
  wsPort: null, // unused; WS is now attached to the main HTTP server

  // PostgreSQL
  databaseUrl: process.env.DATABASE_URL || '',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'recruiter_secret_key_default_123',

  // Redis (for Bull queues); set to 'mock' for in-memory testing
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // AWS (for S3 resume storage)
  aws: {
    region: process.env.AWS_REGION || 'us-east-1',
    s3BucketName: process.env.S3_BUCKET_NAME || '',
  },

  // Gemini (LLM-based resume field extraction)
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
  },

  // Supabase Storage (resume file storage). If unset, storage.js falls back
  // to local disk so uploads keep working without these being configured.
  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    resumesBucket: process.env.SUPABASE_RESUMES_BUCKET || 'resumes',
  },
};

module.exports = config;
