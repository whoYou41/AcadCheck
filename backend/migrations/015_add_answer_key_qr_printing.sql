-- QR identity replaces date/epoch matching for newly created answer sheets.
ALTER TABLE answer_keys
  ADD COLUMN classroom_id INT NULL AFTER user_id,
  ADD COLUMN qr_token VARCHAR(64) NULL AFTER epoch,
  ADD COLUMN print_status ENUM('pending', 'printed') NOT NULL DEFAULT 'pending' AFTER qr_token,
  ADD COLUMN printed_at TIMESTAMP NULL AFTER print_status,
  ADD UNIQUE KEY unique_answer_key_qr_token (qr_token),
  ADD CONSTRAINT fk_answer_keys_classroom
    FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL;

UPDATE answer_keys
SET classroom_id = CAST(subject AS UNSIGNED)
WHERE classroom_id IS NULL AND subject REGEXP '^[0-9]+$';
