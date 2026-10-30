-- Run once on a database that already includes migration 0001.
-- Only nullable columns are added. All accounts and manual baselines are preserved.
ALTER TABLE accounts ADD COLUMN rank_tier TEXT CHECK (rank_tier IN ('IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER', 'UNRANKED'));
ALTER TABLE accounts ADD COLUMN rank_division TEXT CHECK (rank_division IN ('I', 'II', 'III', 'IV'));
ALTER TABLE accounts ADD COLUMN rank_lp INTEGER CHECK (rank_lp >= 0);
ALTER TABLE accounts ADD COLUMN profile_observed_at TEXT;
