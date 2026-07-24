-- Keep scanner persistence and login auditing consistent on fresh and
-- existing AcadCheck installations.

CREATE TABLE IF NOT EXISTS login_attempts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  username VARCHAR(255) NOT NULL,
  ip_address VARCHAR(45),
  user_agent TEXT,
  success BOOLEAN NOT NULL,
  failure_reason VARCHAR(255),
  attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_username (username),
  INDEX idx_attempted_at (attempted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @suspicious_column_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'scanned_tests'
    AND COLUMN_NAME = 'suspicious_uniform_detection'
);

SET @add_suspicious_column = IF(
  @suspicious_column_exists = 0,
  'ALTER TABLE scanned_tests ADD COLUMN suspicious_uniform_detection BOOLEAN NOT NULL DEFAULT FALSE AFTER ocr_confidence',
  'SELECT 1'
);

PREPARE add_suspicious_column_stmt FROM @add_suspicious_column;
EXECUTE add_suspicious_column_stmt;
DEALLOCATE PREPARE add_suspicious_column_stmt;

SET @omr_unique_index_exists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'omr_results'
    AND INDEX_NAME = 'unique_user_scan_question'
);

SET @add_omr_unique_index = IF(
  @omr_unique_index_exists = 0,
  'ALTER TABLE omr_results ADD UNIQUE KEY unique_user_scan_question (user_id, scanned_test_id, question_number)',
  'SELECT 1'
);

PREPARE add_omr_unique_index_stmt FROM @add_omr_unique_index;
EXECUTE add_omr_unique_index_stmt;
DEALLOCATE PREPARE add_omr_unique_index_stmt;
