-- Migration: Add extraction_metadata to candidates table
ALTER TABLE candidates 
ADD COLUMN IF NOT EXISTS extraction_metadata JSONB DEFAULT '{}'::jsonb;
