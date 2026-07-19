-- Migration: Create resume_content table to store extracted resume text
CREATE TABLE IF NOT EXISTS resume_content (
  upload_id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  raw_text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  extraction_quality TEXT NOT NULL DEFAULT 'high',
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMPTZ
);

-- Index for fast candidate lookups
CREATE INDEX IF NOT EXISTS idx_resume_content_candidate_id ON resume_content(candidate_id);
