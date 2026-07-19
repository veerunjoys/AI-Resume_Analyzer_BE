-- Migration: Update candidates search vector trigger to preserve explicit updates and query resume_content
CREATE OR REPLACE FUNCTION candidates_search_vector_trigger()
RETURNS trigger AS $$
DECLARE
    resume_text TEXT := '';
BEGIN
    -- If the update is explicitly changing the search_vector (e.g. from the indexing worker), preserve it
    IF TG_OP = 'UPDATE' AND NEW.search_vector IS DISTINCT FROM OLD.search_vector THEN
        RETURN NEW;
    END IF;

    -- Otherwise, query the resume_content table to get all text extracted from resumes
    SELECT string_agg(raw_text, ' ') INTO resume_text
    FROM resume_content
    WHERE candidate_id = NEW.id;

    NEW.search_vector :=
        to_tsvector('simple', coalesce(NEW.name, '')) ||
        to_tsvector('simple', coalesce(NEW.email, '')) ||
        to_tsvector('simple', coalesce(array_to_string(NEW.skills, ' '), '')) ||
        to_tsvector('english', coalesce(resume_text, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
