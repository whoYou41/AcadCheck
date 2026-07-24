-- Migration: 003_add_middle_name_to_students
-- Add middle_name column to students table

-- Add middle_name column if it doesn't exist
SET @columnExists = (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'students'
    AND COLUMN_NAME = 'middle_name'
);

SET @sql = IF(@columnExists = 0,
  'ALTER TABLE students ADD COLUMN middle_name VARCHAR(50) NULL AFTER first_name',
  'SELECT "middle_name column already exists"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify
SELECT '✅ Migration 003 applied: middle_name column added to students' AS status,
       COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'students'
  AND COLUMN_NAME = 'middle_name';
