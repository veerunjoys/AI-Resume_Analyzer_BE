const { Pool } = require('pg');
const config = require('./config');

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not configured.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on('connect', (client) => {
  client.query('SET search_path TO resume, public');
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
