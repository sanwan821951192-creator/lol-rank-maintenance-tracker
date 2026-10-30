-- Run exactly once against a database created with the original schema.
-- Existing records remain unchanged; their unknown precise times stay NULL.
ALTER TABLE accounts ADD COLUMN baseline_at TEXT;
ALTER TABLE accounts ADD COLUMN candidate_days INTEGER CHECK (candidate_days BETWEEN 0 AND 365);
ALTER TABLE accounts ADD COLUMN candidate_at TEXT;
ALTER TABLE accounts ADD COLUMN candidate_status TEXT CHECK (candidate_status IN ('estimate'));
ALTER TABLE accounts ADD COLUMN candidate_summary TEXT CHECK (length(candidate_summary) <= 2000);
ALTER TABLE accounts ADD COLUMN candidate_reviews TEXT;
