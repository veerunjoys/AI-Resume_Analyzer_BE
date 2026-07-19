const { Pool } = require('pg');
const config = require('./config');
const logger = require('pino')();

if (!config.databaseUrl) {
  logger.error('DATABASE_URL is not configured for upload-orchestrator.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: config.databaseUrl,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
