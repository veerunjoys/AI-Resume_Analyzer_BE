-- Migration: Add search indexes for scale queries (200M+ candidates)

-- 1. A partial index on candidates(status) excluding Rejected candidates
CREATE INDEX IF NOT EXISTS idx_candidates_status_partial 
ON candidates(status) 
WHERE status != 'Rejected';

-- 2. A GIN index on candidates(skills) for array containment (@> operator)
CREATE INDEX IF NOT EXISTS idx_candidates_skills_gin 
ON candidates USING gin(skills);

-- 3. A composite index on candidates(location, status) for location + status filters
CREATE INDEX IF NOT EXISTS idx_candidates_location_status 
ON candidates(location, status);

-- 4. An index on resume_content(candidate_id) for the JOIN lookup
CREATE INDEX IF NOT EXISTS idx_resume_content_candidate_id 
ON resume_content(candidate_id);
