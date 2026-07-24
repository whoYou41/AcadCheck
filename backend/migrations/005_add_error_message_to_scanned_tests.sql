-- Add error_message column to scanned_tests for failed scan tracking
ALTER TABLE scanned_tests ADD COLUMN IF NOT EXISTS error_message TEXT NULL AFTER scan_status;
