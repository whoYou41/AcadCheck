-- Make scanner retries traceable, stale-safe, and measurable.

CREATE TABLE IF NOT EXISTS scan_processing_attempts (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  scanned_test_id INT NOT NULL,
  image_sha256 CHAR(64) NOT NULL,
  scanner_version VARCHAR(80) NOT NULL,
  status ENUM('processing', 'completed', 'failed') NOT NULL DEFAULT 'processing',
  timings_json JSON NULL,
  error_message TEXT NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP NULL,
  INDEX idx_scan_attempt_scan (scanned_test_id, id),
  INDEX idx_scan_attempt_user_status (user_id, status),
  CONSTRAINT fk_scan_attempt_scan FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
  CONSTRAINT fk_scan_attempt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @add_scan_hash = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests' AND COLUMN_NAME = 'image_sha256') = 0,
  'ALTER TABLE scanned_tests ADD COLUMN image_sha256 CHAR(64) NULL AFTER file_path',
  'SELECT 1'
);
PREPARE stmt FROM @add_scan_hash; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_processing_started = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests' AND COLUMN_NAME = 'processing_started_at') = 0,
  'ALTER TABLE scanned_tests ADD COLUMN processing_started_at TIMESTAMP NULL AFTER processed_at',
  'SELECT 1'
);
PREPARE stmt FROM @add_processing_started; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_processing_duration = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests' AND COLUMN_NAME = 'processing_duration_ms') = 0,
  'ALTER TABLE scanned_tests ADD COLUMN processing_duration_ms INT NULL AFTER processing_started_at',
  'SELECT 1'
);
PREPARE stmt FROM @add_processing_duration; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_scanner_version = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests' AND COLUMN_NAME = 'scanner_version') = 0,
  'ALTER TABLE scanned_tests ADD COLUMN scanner_version VARCHAR(80) NULL AFTER processing_duration_ms',
  'SELECT 1'
);
PREPARE stmt FROM @add_scanner_version; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_current_attempt = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests' AND COLUMN_NAME = 'current_processing_attempt_id') = 0,
  'ALTER TABLE scanned_tests ADD COLUMN current_processing_attempt_id BIGINT NULL AFTER scanner_version',
  'SELECT 1'
);
PREPARE stmt FROM @add_current_attempt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_omr_attempt = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'omr_results' AND COLUMN_NAME = 'processing_attempt_id') = 0,
  'ALTER TABLE omr_results ADD COLUMN processing_attempt_id BIGINT NULL AFTER scanned_test_id',
  'SELECT 1'
);
PREPARE stmt FROM @add_omr_attempt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_ocr_attempt = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ocr_extractions' AND COLUMN_NAME = 'processing_attempt_id') = 0,
  'ALTER TABLE ocr_extractions ADD COLUMN processing_attempt_id BIGINT NULL AFTER scanned_test_id',
  'SELECT 1'
);
PREPARE stmt FROM @add_ocr_attempt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_response_attempt = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'exam_responses' AND COLUMN_NAME = 'processing_attempt_id') = 0,
  'ALTER TABLE exam_responses ADD COLUMN processing_attempt_id BIGINT NULL AFTER scanned_test_id',
  'SELECT 1'
);
PREPARE stmt FROM @add_response_attempt; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Existing installations may contain repeated OCR fields from reprocessing.
-- Keep the newest row before enforcing one current value per field.
DELETE older
FROM ocr_extractions older
JOIN ocr_extractions newer
  ON newer.user_id = older.user_id
 AND newer.scanned_test_id = older.scanned_test_id
 AND newer.field_name = older.field_name
 AND newer.id > older.id;

SET @add_ocr_unique = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ocr_extractions'
     AND INDEX_NAME = 'unique_user_scan_field') = 0,
  'ALTER TABLE ocr_extractions ADD UNIQUE KEY unique_user_scan_field (user_id, scanned_test_id, field_name)',
  'SELECT 1'
);
PREPARE stmt FROM @add_ocr_unique; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @add_scan_hash_index = IF(
  (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'scanned_tests'
     AND INDEX_NAME = 'idx_scanned_tests_image_hash') = 0,
  'ALTER TABLE scanned_tests ADD INDEX idx_scanned_tests_image_hash (user_id, image_sha256)',
  'SELECT 1'
);
PREPARE stmt FROM @add_scan_hash_index; EXECUTE stmt; DEALLOCATE PREPARE stmt;
