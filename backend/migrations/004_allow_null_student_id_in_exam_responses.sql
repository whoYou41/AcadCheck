-- Allow exam_responses to be saved even when no student is matched yet
ALTER TABLE exam_responses MODIFY COLUMN student_id INT NULL;
ALTER TABLE exam_responses DROP INDEX unique_user_student_scan;
ALTER TABLE exam_responses ADD UNIQUE KEY unique_user_scan (user_id, scanned_test_id);
