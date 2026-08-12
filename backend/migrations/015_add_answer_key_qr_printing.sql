-- QR identity replaces date/epoch matching for newly created answer sheets.
-- Every schema change is guarded so this migration is safe after importing a
-- dump that already contains one or more of these fields.
SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'classroom_id'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN classroom_id INT NULL AFTER user_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'qr_token'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN qr_token VARCHAR(64) NULL AFTER epoch',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'print_status'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN print_status ENUM(''pending'', ''printed'') NOT NULL DEFAULT ''pending'' AFTER qr_token',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'printed_at'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN printed_at TIMESTAMP NULL AFTER print_status',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND INDEX_NAME = 'unique_answer_key_qr_token'
);
SET @sql = IF(
  @index_exists = 0,
  'ALTER TABLE answer_keys ADD UNIQUE KEY unique_answer_key_qr_token (qr_token)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @constraint_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND CONSTRAINT_NAME = 'fk_answer_keys_classroom'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql = IF(
  @constraint_exists = 0,
  'ALTER TABLE answer_keys ADD CONSTRAINT fk_answer_keys_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE answer_keys
SET classroom_id = CAST(subject AS UNSIGNED)
WHERE classroom_id IS NULL AND subject REGEXP '^[0-9]+$';
