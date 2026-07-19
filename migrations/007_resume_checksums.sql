-- Migration: Create resume_checksums table for deduplication
CREATE TABLE IF NOT EXISTS resume_checksums (
  checksum TEXT PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  upload_id UUID NOT NULL
);
