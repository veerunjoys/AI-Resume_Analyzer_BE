-- Migration: Add extraction_quality column to resume_content
ALTER TABLE resume_content 
ADD COLUMN IF NOT EXISTS extraction_quality TEXT;
