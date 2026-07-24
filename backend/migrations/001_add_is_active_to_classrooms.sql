-- Migration script: Add is_active column to classrooms table
-- Run this if acadcheck_db already exists but classrooms table was created without is_active

USE acadcheck_db;

-- Check if is_active column exists
SET @columnExists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.COLUMNS 
  WHERE TABLE_SCHEMA = 'acadcheck_db' 
    AND TABLE_NAME = 'classrooms' 
    AND COLUMN_NAME = 'is_active'
);

-- Add is_active column if it doesn't exist
SET @sql = IF(@columnExists = 0,
  'ALTER TABLE classrooms ADD COLUMN is_active BOOLEAN DEFAULT TRUE AFTER teacher',
  'SELECT "is_active column already exists"'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Update existing classrooms to be active (if they weren't soft deleted)
UPDATE classrooms 
SET is_active = TRUE 
WHERE deleted_at IS NULL AND is_active IS NULL;

-- Add index on is_active if it doesn't exist
SET @indexExists = (
  SELECT COUNT(*) 
  FROM INFORMATION_SCHEMA.STATISTICS 
  WHERE TABLE_SCHEMA = 'acadcheck_db' 
    AND TABLE_NAME = 'classrooms' 
    AND INDEX_NAME = 'idx_classrooms_active'
);

SET @sql2 = IF(@indexExists = 0,
  'CREATE INDEX idx_classrooms_active ON classrooms(is_active)',
  'SELECT "Index idx_classrooms_active already exists"'
);

PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;

SELECT '✅ Migration completed: is_active column added to classrooms' as status;
