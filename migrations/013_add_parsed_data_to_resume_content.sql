-- Migration: Add parsed_data JSONB column to resume_content table
ALTER TABLE resume_content 
ADD COLUMN IF NOT EXISTS parsed_data JSONB;

-- Create skills table
CREATE TABLE IF NOT EXISTS skills (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL
);

-- Create candidate_skills join table
CREATE TABLE IF NOT EXISTS candidate_skills (
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (candidate_id, skill_id)
);
