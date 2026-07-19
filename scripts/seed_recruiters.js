const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const config = require('../src/config');

async function seedRecruiters() {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('connect', (client) => {
    client.query('SET search_path TO resume, public');
  });

  try {
    console.log('Starting seed_recruiters...');

    const password = 'password123';
    const hash = await bcrypt.hash(password, 10);

    const recruiters = [
      { name: 'Recruiter One', email: 'recruiter1@company.com', passwordHash: hash },
      { name: 'Recruiter Two', email: 'recruiter2@company.com', passwordHash: hash }
    ];

    for (const r of recruiters) {
      await pool.query(
        `INSERT INTO recruiters (name, email, password_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO UPDATE 
         SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash`,
        [r.name, r.email, r.passwordHash]
      );
      console.log(`Seeded account: ${r.email} / ${password}`);
    }

    console.log('✅ Seed recruiters completed successfully!');
  } catch (err) {
    console.error('❌ Seed recruiters failed:', err);
  } finally {
    await pool.end();
  }
}

seedRecruiters();
