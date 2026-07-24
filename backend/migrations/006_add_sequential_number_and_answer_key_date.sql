ALTER TABLE answer_keys ADD COLUMN answer_key_date DATE AFTER num_questions;
UPDATE answer_keys SET answer_key_date = DATE(created_at);
ALTER TABLE answer_keys ALTER COLUMN answer_key_date SET DEFAULT CURRENT_DATE;
CREATE INDEX idx_answer_keys_answer_key_date ON answer_keys(answer_key_date);

ALTER TABLE students ADD COLUMN sequential_number INT DEFAULT 1 AFTER classroom_id;
UPDATE students SET sequential_number = 1 WHERE sequential_number IS NULL;
ALTER TABLE students ADD UNIQUE KEY unique_user_classroom_sequential (user_id, classroom_id, sequential_number);
CREATE INDEX idx_students_sequential_number ON students(sequential_number);

ALTER TABLE scanned_tests ADD COLUMN sequential_number_detected INT NULL AFTER student_number_detected;
ALTER TABLE scanned_tests ADD COLUMN answer_key_date_detected DATE NULL AFTER sequential_number_detected;
