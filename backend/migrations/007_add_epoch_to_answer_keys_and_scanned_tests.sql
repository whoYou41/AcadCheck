SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'epoch'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN epoch VARCHAR(50) NULL AFTER exam_title',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'scanned_tests'
    AND COLUMN_NAME = 'epoch_detected'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE scanned_tests ADD COLUMN epoch_detected VARCHAR(50) NULL AFTER answer_key_date_detected',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND INDEX_NAME = 'idx_answer_keys_epoch'
);
SET @sql = IF(
  @index_exists = 0,
  'CREATE INDEX idx_answer_keys_epoch ON answer_keys(epoch)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'scanned_tests'
    AND INDEX_NAME = 'idx_scanned_tests_epoch'
);
SET @sql = IF(
  @index_exists = 0,
  'CREATE INDEX idx_scanned_tests_epoch ON scanned_tests(epoch_detected)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
