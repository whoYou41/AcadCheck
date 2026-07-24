SET @dbname = DATABASE();
SET @tablename = 'omr_results';
SET @columnname = 'marked_letters';
SET @preparedStatement = (
  SELECT IF(
    (SELECT COUNT(*) FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = @dbname AND TABLE_NAME = @tablename AND COLUMN_NAME = @columnname
    ) > 0,
    'SELECT "Column_marked_letters_already_exists" AS msg',
    'ALTER TABLE omr_results ADD COLUMN marked_letters JSON NULL AFTER confidence'
  )
);
PREPARE stmt FROM @preparedStatement;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
