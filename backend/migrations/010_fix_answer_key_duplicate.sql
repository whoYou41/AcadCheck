ALTER TABLE answer_keys DROP INDEX unique_user_answer_key;
ALTER TABLE answer_keys ADD UNIQUE KEY unique_user_answer_key (user_id, exam_title);
