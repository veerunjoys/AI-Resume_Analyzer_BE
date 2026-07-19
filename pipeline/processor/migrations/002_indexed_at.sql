-- Migration: Add indexed_at column to resume_content table
ALTER TABLE resume_content ADD COLUMN IF NOT EXISTS indexed_at TIMESTAMPTZ;
