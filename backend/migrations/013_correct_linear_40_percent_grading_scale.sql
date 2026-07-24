-- Migration 012 may already have been applied using the earlier non-linear
-- interpretation. Recalculate every stored 50-question result linearly so
-- 0 correct is 0% and 50 correct is 40%.
UPDATE exam_responses
SET percentage = GREATEST(0, LEAST(40, (total_score / 50) * 40))
WHERE total_score IS NOT NULL;
