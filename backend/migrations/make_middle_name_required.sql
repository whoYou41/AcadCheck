-- Migration: Make middle_name NOT NULL in students table
-- Date: 2026-05-03
-- Description: Change middle_name from nullable to required (NOT NULL)

-- Step 1: Update any existing NULL middle_name values to empty string
UPDATE students SET middle_name = '' WHERE middle_name IS NULL;

-- Step 2: Modify column to NOT NULL
ALTER TABLE students 
MODIFY COLUMN middle_name VARCHAR(50) NOT NULL;

-- Verify the change
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE 
FROM INFORMATION_SCHEMA.COLUMNS 
WHERE TABLE_SCHEMA = 'acadcheck_db' 
  AND TABLE_NAME = 'students' 
  AND COLUMN_NAME = 'middle_name';
