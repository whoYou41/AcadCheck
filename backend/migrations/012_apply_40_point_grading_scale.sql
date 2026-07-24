-- Convert existing 50-question exam results from a 0-100 percentage to the
-- AcadCheck 40-point grading contribution:
-- Linear scale: percentage = (score / 50) * 40.
UPDATE exam_responses
SET percentage = GREATEST(0, LEAST(40, (total_score / 50) * 40))
WHERE total_score IS NOT NULL;
