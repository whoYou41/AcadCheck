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

-- Answer Keys table
CREATE TABLE IF NOT EXISTS answer_keys (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    subject VARCHAR(100) NOT NULL,
    exam_title VARCHAR(255) NOT NULL,
    num_questions INT NOT NULL,
    answer_key_json TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_answer_key (user_id, exam_title)
);
CREATE INDEX idx_answer_keys_user_id ON answer_keys(user_id);
CREATE INDEX idx_answer_keys_subject ON answer_keys(subject);
CREATE INDEX idx_answer_keys_is_active ON answer_keys(is_active);

-- Scanned Tests table
CREATE TABLE IF NOT EXISTS scanned_tests (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(500) NOT NULL,
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
    ocr_confidence DECIMAL(5,2),
    processed_at TIMESTAMP NULL,
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

-- OMR Results table
CREATE TABLE IF NOT EXISTS omr_results (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
    question_number INT NOT NULL,
    detected_answer VARCHAR(10),
    correct_answer VARCHAR(10),
    is_correct BOOLEAN,
    confidence DECIMAL(5,2) DEFAULT 95.00,
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
    field_name VARCHAR(100) NOT NULL,
    extracted_value TEXT,
    confidence DECIMAL(5,2),
    raw_ocr_text TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (scanned_test_id) REFERENCES scanned_tests(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_ocr_extractions_user_id ON ocr_extractions(user_id);
CREATE INDEX idx_ocr_extractions_scanned_test_id ON ocr_extractions(scanned_test_id);

-- Exam Responses table
CREATE TABLE IF NOT EXISTS exam_responses (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    student_id INT NOT NULL,
    scanned_test_id INT NOT NULL,
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
