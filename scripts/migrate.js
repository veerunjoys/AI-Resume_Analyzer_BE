const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('../src/config');

async function runMigration() {
  if (!config.databaseUrl) {
    console.error('Error: DATABASE_URL environment variable is not defined.');
    process.exit(1);
  }

  console.log('Starting migration...');
  const pool = new Pool({
    connectionString: config.databaseUrl,
  });

  pool.on('connect', (client) => {
    client.query('SET search_path TO resume, public');
  });

  try {
    const migrationsDir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const migrationPath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(migrationPath, 'utf8');
      console.log(`Running ${file} migration query...`);
      await pool.query(sql);
    }

    console.log('✅ Migration completed successfully!');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
