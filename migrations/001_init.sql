-- Enable UUID extension just in case
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Candidates Table
CREATE TABLE IF NOT EXISTS candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    location TEXT,
    skills TEXT[] DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'Applied',
    source TEXT,
    notes TEXT,
    resume_s3_key TEXT,
    search_vector TSVECTOR,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Candidate Events Table
CREATE TABLE IF NOT EXISTS candidate_events (
    id BIGSERIAL PRIMARY KEY,
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload JSONB,
    sequence_id BIGSERIAL,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Upload Sessions Table
CREATE TABLE IF NOT EXISTS upload_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID REFERENCES candidates(id) ON DELETE SET NULL,
    s3_upload_id TEXT,
    status TEXT DEFAULT 'in_progress',
    total_chunks INTEGER,
    chunks_received INTEGER[] DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT now()
);

-- 4. Offline Action Log Table
CREATE TABLE IF NOT EXISTS offline_action_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_action_id UUID NOT NULL,
    candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
    base_version INTEGER NOT NULL,
    action_payload JSONB NOT NULL,
    applied_at TIMESTAMPTZ,
    conflict BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- GIN index on candidates.search_vector for full-text search
CREATE INDEX IF NOT EXISTS idx_candidates_search_vector ON candidates USING gin(search_vector);

-- Composite index on candidates (status, updated_at) for efficient filtered queries
CREATE INDEX IF NOT EXISTS idx_candidates_status_updated_at ON candidates(status, updated_at);

-- Index on candidate_events (sequence_id)
CREATE INDEX IF NOT EXISTS idx_candidate_events_sequence_id ON candidate_events(sequence_id);

-- Trigger function to update candidates.search_vector automatically
CREATE OR REPLACE FUNCTION candidates_search_vector_trigger()
RETURNS trigger AS $$
BEGIN
    NEW.search_vector :=
        to_tsvector('simple', coalesce(NEW.name, '')) ||
        to_tsvector('simple', coalesce(NEW.email, '')) ||
        to_tsvector('simple', coalesce(array_to_string(NEW.skills, ' '), ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create Trigger (drops if exists to be idempotent)
DROP TRIGGER IF EXISTS trg_candidates_search_vector ON candidates;
CREATE TRIGGER trg_candidates_search_vector
    BEFORE INSERT OR UPDATE ON candidates
    FOR EACH ROW
    EXECUTE FUNCTION candidates_search_vector_trigger();

-- Update all existing candidate search vectors to use simple configuration
UPDATE candidates SET search_vector = 
    to_tsvector('simple', coalesce(name, '')) ||
    to_tsvector('simple', coalesce(email, '')) ||
    to_tsvector('simple', coalesce(array_to_string(skills, ' '), ''));

