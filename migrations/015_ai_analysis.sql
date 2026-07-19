-- AI-generated resume quality analysis (score breakdown, strengths/weaknesses, summary)
CREATE TABLE IF NOT EXISTS ai_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    upload_id UUID UNIQUE,
    overall_score NUMERIC(5,2) NOT NULL,
    category_scores JSONB NOT NULL DEFAULT '{}'::jsonb,
    strengths TEXT[] DEFAULT '{}',
    weaknesses TEXT[] DEFAULT '{}',
    missing_skills TEXT[] DEFAULT '{}',
    summary TEXT,
    recommendation TEXT,
    model TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_analysis_candidate_id ON ai_analysis(candidate_id);
