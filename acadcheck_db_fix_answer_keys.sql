-- AcadCheck answer_keys schema repair
-- Safe to import through phpMyAdmin on an existing acadcheck_db database.
USE acadcheck_db;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  filename VARCHAR(255) UNIQUE NOT NULL,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Complete migration 006. The deployed copy can attempt to update
-- answer_key_date before creating it, which prevents the server from starting.
SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND COLUMN_NAME = 'answer_key_date'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE answer_keys ADD COLUMN answer_key_date DATE NULL AFTER num_questions',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE answer_keys
SET answer_key_date = DATE(created_at)
WHERE answer_key_date IS NULL;

-- The application supplies answer_key_date explicitly. Avoid
-- DEFAULT CURRENT_DATE syntax, which older MySQL/MariaDB versions reject.

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'answer_keys'
    AND INDEX_NAME = 'idx_answer_keys_answer_key_date'
);
SET @sql = IF(
  @index_exists = 0,
  'CREATE INDEX idx_answer_keys_answer_key_date ON answer_keys(answer_key_date)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'students'
    AND COLUMN_NAME = 'sequential_number'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE students ADD COLUMN sequential_number INT NULL AFTER classroom_id',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE students AS student
JOIN (
  SELECT current_student.id, COUNT(earlier_student.id) AS sequence_value
  FROM students AS current_student
  JOIN students AS earlier_student
    ON earlier_student.user_id = current_student.user_id
   AND earlier_student.classroom_id = current_student.classroom_id
   AND earlier_student.id <= current_student.id
  GROUP BY current_student.id
) AS numbered ON numbered.id = student.id
SET student.sequential_number = numbered.sequence_value
WHERE student.sequential_number IS NULL;

ALTER TABLE students
  ALTER COLUMN sequential_number SET DEFAULT 1;

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'students'
    AND INDEX_NAME = 'unique_user_classroom_sequential'
);
SET @sql = IF(
  @index_exists = 0,
  'ALTER TABLE students ADD UNIQUE KEY unique_user_classroom_sequential (user_id, classroom_id, sequential_number)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @index_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'students'
    AND INDEX_NAME = 'idx_students_sequential_number'
);
SET @sql = IF(
  @index_exists = 0,
  'CREATE INDEX idx_students_sequential_number ON students(sequential_number)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'scanned_tests'
    AND COLUMN_NAME = 'sequential_number_detected'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE scanned_tests ADD COLUMN sequential_number_detected INT NULL AFTER student_number_detected',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @column_exists = (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'scanned_tests'
    AND COLUMN_NAME = 'answer_key_date_detected'
);
SET @sql = IF(
  @column_exists = 0,
  'ALTER TABLE scanned_tests ADD COLUMN answer_key_date_detected DATE NULL AFTER sequential_number_detected',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO schema_migrations (filename)
VALUES ('006_add_sequential_number_and_answer_key_date.sql');

-- Complete migration 007 even when a previous attempt added only `epoch`.
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
  'ALTER TABLE scanned_tests ADD COLUMN epoch_detected VARCHAR(50) NULL',
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

INSERT IGNORE INTO schema_migrations (filename)
VALUES ('007_add_epoch_to_answer_keys_and_scanned_tests.sql');

-- Complete migration 015.
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
  'ALTER TABLE answer_keys ADD COLUMN qr_token VARCHAR(64) NULL',
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
  'ALTER TABLE answer_keys ADD COLUMN print_status ENUM(''pending'', ''printed'') NOT NULL DEFAULT ''pending''',
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
  'ALTER TABLE answer_keys ADD COLUMN printed_at TIMESTAMP NULL',
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
WHERE classroom_id IS NULL
  AND subject REGEXP '^[0-9]+$';

INSERT IGNORE INTO schema_migrations (filename)
VALUES ('015_add_answer_key_qr_printing.sql');

SELECT
  COLUMN_NAME,
  COLUMN_TYPE,
  IS_NULLABLE,
  COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'answer_keys'
  AND COLUMN_NAME IN ('classroom_id', 'qr_token', 'print_status', 'printed_at')
ORDER BY ORDINAL_POSITION;
