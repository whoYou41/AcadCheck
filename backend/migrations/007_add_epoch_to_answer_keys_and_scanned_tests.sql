ALTER TABLE answer_keys ADD COLUMN epoch VARCHAR(50) NULL AFTER exam_title;
ALTER TABLE scanned_tests ADD COLUMN epoch_detected VARCHAR(50) NULL AFTER answer_key_date_detected;
CREATE INDEX idx_answer_keys_epoch ON answer_keys(epoch);
CREATE INDEX idx_scanned_tests_epoch ON scanned_tests(epoch_detected);
