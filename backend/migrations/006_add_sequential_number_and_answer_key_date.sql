-- Add answer-key dates and per-classroom student sequence numbers.
-- All operations are guarded so interrupted/partial migrations can resume.

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

-- Do not set DEFAULT CURRENT_DATE here. Older MySQL/MariaDB versions reject
-- that ALTER COLUMN syntax, and the application supplies this date explicitly.

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

-- Assign stable 1..N values within each user's classroom. The derived table
-- keeps this compatible with MySQL's same-table update restriction.
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
