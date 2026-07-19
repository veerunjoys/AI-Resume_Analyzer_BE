-- 003_unique_candidates.sql
-- 1. Remove duplicate emails, keeping the oldest record
DELETE FROM candidates a USING candidates b
WHERE a.id > b.id AND a.email = b.email;

-- 2. Remove duplicate phones (ignoring nulls), keeping the oldest record
DELETE FROM candidates a USING candidates b
WHERE a.id > b.id AND a.phone = b.phone AND a.phone IS NOT NULL;

-- 3. Add unique constraints
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS uq_candidate_email;
ALTER TABLE candidates ADD CONSTRAINT uq_candidate_email UNIQUE (email);
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS uq_candidate_phone;
ALTER TABLE candidates ADD CONSTRAINT uq_candidate_phone UNIQUE (phone);
