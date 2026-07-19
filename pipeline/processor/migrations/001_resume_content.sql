-- Migration: Create resume_content table to store extracted resume text
CREATE TABLE IF NOT EXISTS resume_content (
  upload_id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
