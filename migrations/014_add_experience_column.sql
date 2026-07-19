-- Adds years-of-experience column used by candidate CRUD routes and the resume processing worker
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience NUMERIC(3,1);
