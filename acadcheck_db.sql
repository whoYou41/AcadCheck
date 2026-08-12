-- AcadCheck Database Schema
-- Create database
CREATE DATABASE IF NOT EXISTS acadcheck_db;
USE acadcheck_db;

-- Users table for storing user accounts
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    first_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    phone VARCHAR(20),
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    is_active BOOLEAN DEFAULT TRUE,
    role ENUM('admin', 'teacher', 'staff') DEFAULT 'teacher'
);

-- Login logs table to record all sign-in attempts
CREATE TABLE IF NOT EXISTS login_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT,
    username VARCHAR(50),
    login_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    user_agent TEXT,
    success BOOLEAN DEFAULT FALSE,
    failure_reason VARCHAR(255),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- Create indexes for better performance
CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_login_logs_user_id ON login_logs(user_id);
CREATE INDEX idx_login_logs_username ON login_logs(username);
CREATE INDEX idx_login_logs_login_time ON login_logs(login_time);

-- Classrooms table
CREATE TABLE IF NOT EXISTS classrooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(100) NOT NULL,
    section VARCHAR(50),
    teacher VARCHAR(100),
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    deleted_by INT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_classroom (user_id, name, section)
);
CREATE INDEX idx_classrooms_user_id ON classrooms(user_id);
CREATE INDEX idx_classrooms_name ON classrooms(name);
CREATE INDEX idx_classrooms_active ON classrooms(is_active);
CREATE INDEX idx_classrooms_deleted_at ON classrooms(deleted_at);

-- Students table
CREATE TABLE IF NOT EXISTS students (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    classroom_id INT NOT NULL,
    sequential_number INT NULL,
    student_number VARCHAR(50) NOT NULL,
    first_name VARCHAR(50) NOT NULL,
    middle_name VARCHAR(50) NOT NULL,
    last_name VARCHAR(50) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL,
    deleted_by INT NULL,
    FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_classroom_student (user_id, classroom_id, student_number)
);
CREATE INDEX idx_students_user_id ON students(user_id);
CREATE INDEX idx_students_classroom_id ON students(classroom_id);
CREATE INDEX idx_students_student_number ON students(student_number);
CREATE INDEX idx_students_deleted_at ON students(deleted_at);
CREATE UNIQUE INDEX unique_user_classroom_sequential ON students(user_id, classroom_id, sequential_number);

-- Answer Keys table
CREATE TABLE IF NOT EXISTS answer_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    classroom_id INT NULL,
    subject VARCHAR(100) NOT NULL,
    exam_title VARCHAR(255) NOT NULL,
    epoch VARCHAR(50) NULL,
    num_questions INT NOT NULL,
    answer_key_date DATE NULL,
    answer_key_json TEXT NOT NULL,
    qr_token CHAR(64) NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_answer_key (user_id, exam_title)
);
CREATE INDEX idx_answer_keys_user_id ON answer_keys(user_id);
CREATE INDEX idx_answer_keys_subject ON answer_keys(subject);
CREATE INDEX idx_answer_keys_is_active ON answer_keys(is_active);
CREATE INDEX idx_answer_keys_classroom_id ON answer_keys(classroom_id);
CREATE INDEX idx_answer_keys_answer_key_date ON answer_keys(answer_key_date);
CREATE INDEX idx_answer_keys_epoch ON answer_keys(epoch);
CREATE UNIQUE INDEX unique_answer_key_qr_token ON answer_keys(qr_token);

-- Scanned Tests table
CREATE TABLE IF NOT EXISTS scanned_tests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
    image_sha256 CHAR(64) NULL,
    file_size BIGINT,
    mime_type VARCHAR(100),
    classroom_id INT NULL,
    answer_key_id INT NULL,
    scan_status ENUM('pending','processing','completed','failed') DEFAULT 'pending',
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    student_id INT NULL,
    student_number_detected VARCHAR(50),
    student_name_detected VARCHAR(100),
    sequential_number_detected INT NULL,
    answer_key_date_detected DATE NULL,
    epoch_detected VARCHAR(50) NULL,
    sequence_detected VARCHAR(255) NULL,
    ocr_confidence DECIMAL(5,2),
    suspicious_uniform_detection BOOLEAN NOT NULL DEFAULT FALSE,
    processed_at TIMESTAMP NULL,
    processing_started_at TIMESTAMP NULL,
    processing_duration_ms INT NULL,
    scanner_version VARCHAR(80) NULL,
    current_processing_attempt_id BIGINT NULL,
    FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL,
    FOREIGN KEY (answer_key_id) REFERENCES answer_keys(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_scanned_tests_user_id ON scanned_tests(user_id);
CREATE INDEX idx_scanned_tests_status ON scanned_tests(scan_status);
CREATE INDEX idx_scanned_tests_created_by ON scanned_tests(created_by);
CREATE INDEX idx_scanned_tests_student_id ON scanned_tests(student_id);
CREATE INDEX idx_scanned_tests_image_hash ON scanned_tests(user_id, image_sha256);
CREATE INDEX idx_scanned_tests_epoch ON scanned_tests(epoch_detected);
CREATE INDEX idx_scanned_tests_sequence ON scanned_tests(sequence_detected);

-- Scanner processing attempts retain provenance and timing for every retry.
CREATE TABLE IF NOT EXISTS scan_processing_attempts (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
    image_sha256 CHAR(64) NOT NULL,
    scanner_version VARCHAR(80) NOT NULL,
    status ENUM('processing','completed','failed') NOT NULL DEFAULT 'processing',
    timings_json JSON NULL,
    error_message TEXT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    INDEX idx_scan_attempt_scan (scanned_test_id, id),
    INDEX idx_scan_attempt_user_status (user_id, status)
);

-- OMR Results table
CREATE TABLE IF NOT EXISTS omr_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
    processing_attempt_id BIGINT NULL,
    question_number INT NOT NULL,
    detected_answer VARCHAR(10),
    correct_answer VARCHAR(10),
    is_correct BOOLEAN,
    confidence DECIMAL(5,2) DEFAULT 95.00,
    marked_letters JSON NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_omr_results_user_id ON omr_results(user_id);
CREATE INDEX idx_omr_results_scanned_test_id ON omr_results(scanned_test_id);
CREATE INDEX idx_omr_results_question_number ON omr_results(question_number);

-- OCR Extractions table
CREATE TABLE IF NOT EXISTS ocr_extractions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
    processing_attempt_id BIGINT NULL,
    field_name VARCHAR(100) NOT NULL,
    extracted_value TEXT,
    confidence DECIMAL(5,2),
    raw_ocr_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_scan_field (user_id, scanned_test_id, field_name)
);
CREATE INDEX idx_ocr_extractions_user_id ON ocr_extractions(user_id);
CREATE INDEX idx_ocr_extractions_scanned_test_id ON ocr_extractions(scanned_test_id);

-- Exam Responses table
CREATE TABLE IF NOT EXISTS exam_responses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    student_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
    processing_attempt_id BIGINT NULL,
    answer_key_id INT NOT NULL,
    answers_json JSON NOT NULL,
    score_per_question_json JSON,
    total_score INT DEFAULT 0,
    percentage DECIMAL(5,2) DEFAULT 0.00,
    is_graded BOOLEAN DEFAULT TRUE,
    graded_by INT,
    graded_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
    FOREIGN KEY (answer_key_id) REFERENCES answer_keys(id) ON DELETE CASCADE,
    FOREIGN KEY (graded_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_student_scan (user_id, student_id, scanned_test_id)
);
CREATE INDEX idx_exam_responses_user_id ON exam_responses(user_id);
CREATE INDEX idx_exam_responses_student_id ON exam_responses(student_id);
CREATE INDEX idx_exam_responses_scanned_test_id ON exam_responses(scanned_test_id);
CREATE INDEX idx_exam_responses_is_graded ON exam_responses(is_graded);

-- Activity Logs table
CREATE TABLE IF NOT EXISTS activity_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    scanned_test_id INT NULL,
    action VARCHAR(100) NOT NULL,
    description TEXT,
    performed_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE SET NULL,
    FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE SET NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_activity_logs_user_id ON activity_logs(user_id);
CREATE INDEX idx_activity_logs_scanned_test_id ON activity_logs(scanned_test_id);
CREATE INDEX idx_activity_logs_created_at ON activity_logs(created_at);

-- Repair/update existing answer_keys tables imported from an older AcadCheck
-- schema. CREATE TABLE IF NOT EXISTS does not add newly introduced columns to
-- an existing table, so keep this upgrade block idempotent for phpMyAdmin.
SET @answer_keys_classroom_id_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'answer_keys'
      AND COLUMN_NAME = 'classroom_id'
);
SET @add_answer_keys_classroom_id = IF(
    @answer_keys_classroom_id_exists = 0,
    'ALTER TABLE answer_keys ADD COLUMN classroom_id INT NULL AFTER user_id',
    'SELECT 1'
);
PREPARE stmt FROM @add_answer_keys_classroom_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @answer_keys_classroom_index_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'answer_keys'
      AND INDEX_NAME = 'idx_answer_keys_classroom_id'
);
SET @add_answer_keys_classroom_index = IF(
    @answer_keys_classroom_index_exists = 0,
    'CREATE INDEX idx_answer_keys_classroom_id ON answer_keys(classroom_id)',
    'SELECT 1'
);
PREPARE stmt FROM @add_answer_keys_classroom_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @answer_keys_classroom_fk_exists = (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = DATABASE()
      AND TABLE_NAME = 'answer_keys'
      AND CONSTRAINT_NAME = 'fk_answer_keys_classroom'
      AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @add_answer_keys_classroom_fk = IF(
    @answer_keys_classroom_fk_exists = 0,
    'ALTER TABLE answer_keys ADD CONSTRAINT fk_answer_keys_classroom FOREIGN KEY (classroom_id) REFERENCES classrooms(id) ON DELETE SET NULL',
    'SELECT 1'
);
PREPARE stmt FROM @add_answer_keys_classroom_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
