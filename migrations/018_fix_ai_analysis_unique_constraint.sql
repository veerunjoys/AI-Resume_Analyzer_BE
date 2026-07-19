-- 015 created a partial unique index (WHERE upload_id IS NOT NULL), which
-- Postgres cannot use as an ON CONFLICT (upload_id) arbiter — every resume
-- processing job was failing with "no unique or exclusion constraint matching
-- the ON CONFLICT specification", rolling back the whole candidate-update
-- transaction (parsed name/email/etc. never got saved). Replace it with a
-- plain unique constraint, which Postgres allows multiple NULLs under anyway.
DROP INDEX IF EXISTS idx_ai_analysis_upload_id;
ALTER TABLE ai_analysis ADD CONSTRAINT ai_analysis_upload_id_key UNIQUE (upload_id);
