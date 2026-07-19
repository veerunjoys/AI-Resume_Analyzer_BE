const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const logger = require('pino')();
const config = require('../src/config');

async function runMigration() {
  if (!config.databaseUrl) {
    logger.error('Error: DATABASE_URL environment variable is not defined.');
    process.exit(1);
  }

  logger.info({ databaseUrl: config.databaseUrl.replace(/:[^:@/]+@/, ':****@') }, 'Starting database migrations for processor...');
  
  const pool = new Pool({
    connectionString: config.databaseUrl,
  });

  try {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      logger.info('No migrations directory found.');
      return;
    }
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      logger.info({ migrationFile: file }, `Running migration query...`);
      await pool.query(sql);
    }

    logger.info('Migration completed successfully!');
  } catch (error) {
    logger.error({ err: error.message, stack: error.stack }, 'Migration failed!');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
