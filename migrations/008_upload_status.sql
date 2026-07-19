-- Migration: Create upload_status table for tracking upload progress lifecycle
CREATE TABLE IF NOT EXISTS upload_status (
  upload_id UUID PRIMARY KEY,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received', 'validated', 'queued', 'processing', 'indexed', 'completed', 'failed')),
  current_stage TEXT,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_upload_status_candidate_id ON upload_status(candidate_id);
CREATE INDEX IF NOT EXISTS idx_upload_status_status ON upload_status(status);
