-- Migration: Create pipeline_audit_log table
CREATE TABLE IF NOT EXISTS pipeline_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL,
  candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup of logs for a given uploadId
CREATE INDEX IF NOT EXISTS idx_pipeline_audit_log_upload_id ON pipeline_audit_log(upload_id);
