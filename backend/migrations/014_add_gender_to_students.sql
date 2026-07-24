-- Store the student's gender for records filtering and sorting.
-- Existing students remain NULL until their profile is updated.
ALTER TABLE students
  ADD COLUMN gender ENUM('male', 'female') NULL AFTER last_name;
