const { Client } = require('pg');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL not set in server/.env");
  process.exit(1);
}

const client = new Client({ connectionString });

async function run() {
  await client.connect();
  await client.query('SET search_path TO resume, public');
  console.log("Connected to database. Checking experience column...");

  // 1. Add experience column
  try {
    await client.query(`
      ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience NUMERIC(3,1);
    `);
    console.log("experience column verified/added successfully!");
  } catch (err) {
    console.error("Error adding column:", err.message);
  }
  
  await client.end();
}

run().catch(console.error);
