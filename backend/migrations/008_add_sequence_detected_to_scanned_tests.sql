SET @col_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                   AND TABLE_NAME = 'scanned_tests' 
                   AND COLUMN_NAME = 'sequence_detected');
SET @sql = IF(@col_exists = 0, 
              'ALTER TABLE scanned_tests ADD COLUMN sequence_detected VARCHAR(255) NULL AFTER epoch_detected',
              'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS 
                   WHERE TABLE_SCHEMA = DATABASE() 
                   AND TABLE_NAME = 'scanned_tests' 
                   AND INDEX_NAME = 'idx_scanned_tests_sequence');
SET @sql2 = IF(@idx_exists = 0,
               'CREATE INDEX idx_scanned_tests_sequence ON scanned_tests(sequence_detected)',
               'SELECT 1');
PREPARE stmt2 FROM @sql2;
EXECUTE stmt2;
DEALLOCATE PREPARE stmt2;
