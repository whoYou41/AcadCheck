-- Migration: 002_fix_answer_key_json_type
-- Change answer_key_json column from JSON to TEXT to allow plain answer strings
-- This automatically drops any implicit CHECK constraint that enforces valid JSON

-- Step 1: Change column type (automatically drops CHECK constraints on this column)
ALTER TABLE answer_keys MODIFY answer_key_json TEXT NOT NULL;

-- Step 2: Unquote existing data if it was stored as JSON strings (e.g. "ABCDE" -> ABCDE)
-- JSON_UNQUOTE returns the unquoted value for JSON strings; otherwise returns unchanged.
UPDATE answer_keys
SET answer_key_json = JSON_UNQUOTE(answer_key_json)
WHERE answer_key_json LIKE '"%' AND answer_key_json LIKE '%"';

-- Verification
SELECT '✅ Migration 002 applied: answer_key_json is now TEXT' AS status,
       DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'answer_keys'
  AND COLUMN_NAME = 'answer_key_json';
