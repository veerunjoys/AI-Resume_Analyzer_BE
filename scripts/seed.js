const { Pool } = require('pg');
const config = require('../src/config');

const FIRST_NAMES = [
  'James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda',
  'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph',
  'Jessica', 'Thomas', 'Sarah', 'Charles', 'Karen', 'Christopher', 'Nancy',
  'Daniel', 'Lisa', 'Matthew', 'Betty', 'Anthony', 'Margaret', 'Mark', 'Sandra'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'
];

const SKILLS = [
  'JavaScript', 'TypeScript', 'React', 'Node.js', 'Python',
  'Go', 'Java', 'C++', 'Ruby', 'PostgreSQL',
  'Docker', 'Kubernetes', 'AWS', 'GraphQL', 'TailwindCSS'
];

const STATUSES = ['Applied', 'Screening', 'Interview', 'Offer', 'Rejected'];

const CITIES = [
  'New York', 'San Francisco', 'Seattle', 'Austin', 'Boston',
  'Chicago', 'Denver', 'Los Angeles', 'Miami', 'Atlanta'
];

const SOURCES = ['LinkedIn', 'Referral', 'Indeed', 'GitHub', 'Direct Application', 'Recruiter Outreach'];

function getRandomElement(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateSkills() {
  const numSkills = Math.floor(Math.random() * 3) + 2; // 2 to 4 skills
  const shuffled = [...SKILLS].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, numSkills);
}

const seenEmails = new Set();
const seenPhones = new Set();

function generateCandidate() {
  let name, email, phone;
  let attempts = 0;
  
  while (attempts < 1000) {
    const firstName = getRandomElement(FIRST_NAMES);
    const lastName = getRandomElement(LAST_NAMES);
    name = `${firstName} ${lastName}`;
    
    // Use a larger suffix range to minimize collisions
    const emailSuffix = Math.floor(Math.random() * 10000000);
    email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${emailSuffix}@example.com`;
    
    const areaCode = Math.floor(Math.random() * 800) + 200; // 200-999
    const prefix = Math.floor(Math.random() * 800) + 200;    // 200-999
    const lineNum = Math.floor(Math.random() * 9000) + 1000;  // 1000-9999
    phone = `+1 (${areaCode}) ${prefix}-${lineNum}`;
    
    if (!seenEmails.has(email) && !seenPhones.has(phone)) {
      seenEmails.add(email);
      seenPhones.add(phone);
      break;
    }
    attempts++;
  }

  const location = getRandomElement(CITIES);
  const skills = generateSkills();
  const status = getRandomElement(STATUSES);
  const source = getRandomElement(SOURCES);
  const notes = `Candidate is interested in full-stack opportunities. Strong experience with ${skills.join(', ')}.`;
  const version = 1;

  return { name, email, phone, location, skills, status, source, notes, version };
}

async function seed() {
  if (!config.databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  pool.on('connect', (client) => {
    client.query('SET search_path TO resume, public');
  });
  const totalRows = 100000;
  const batchSize = 1000;

  console.log(`Starting seed: Inserting ${totalRows} candidates in batches of ${batchSize}...`);

  try {
    console.log('Clearing existing candidate records for a clean profiling dataset...');
    await pool.query('TRUNCATE TABLE candidates CASCADE');
    let insertedRows = 0;

    for (let i = 0; i < totalRows; i += batchSize) {
      const candidates = [];
      for (let j = 0; j < batchSize; j++) {
        candidates.push(generateCandidate());
      }

      // Build batched insert query
      const placeholders = [];
      const queryValues = [];
      let paramIndex = 1;

      for (const c of candidates) {
        placeholders.push(`(
          $${paramIndex}, 
          $${paramIndex + 1}, 
          $${paramIndex + 2}, 
          $${paramIndex + 3}, 
          $${paramIndex + 4}::text[], 
          $${paramIndex + 5}, 
          $${paramIndex + 6}, 
          $${paramIndex + 7}, 
          $${paramIndex + 8}
        )`);
        
        queryValues.push(
          c.name,
          c.email,
          c.phone,
          c.location,
          c.skills,
          c.status,
          c.source,
          c.notes,
          c.version
        );

        paramIndex += 9;
      }

      const queryText = `
        INSERT INTO candidates (name, email, phone, location, skills, status, source, notes, version)
        VALUES ${placeholders.join(', ')}
      `;

      await pool.query(queryText, queryValues);
      insertedRows += batchSize;
      
      console.log(`Inserted batch: ${insertedRows} / ${totalRows} rows`);
    }

    console.log(`🎉 Seeding complete! Successfully inserted ${insertedRows} rows.`);
  } catch (err) {
    console.error('❌ Seeding failed:', err);
  } finally {
    await pool.end();
  }
}

seed();
