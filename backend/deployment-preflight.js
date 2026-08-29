'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const { inspectScannerRuntime } = require('./python-runtime');
const {
  prewarmAdaptiveWorker,
  shutdownAdaptiveWorker,
} = require('./adaptive-form-omr');
const {
  prewarmQrWorker,
  shutdownQrWorker,
} = require('./qr-code-detector');

const ROOT = path.join(__dirname, '..');
const REQUIRED_FILES = [
  'www/index.html',
  'ml-training/fast_omr_worker.py',
  'ml-training/detect_qr.py',
  'backend/models/bubble-classifier.onnx',
  'backend/models/digit-classifier.onnx',
  'backend/models/text-recognizer.onnx',
  'backend/templates/Answer-Sheet.docx',
];
const REQUIRED_TABLES = [
  'users',
  'classrooms',
  'students',
  'answer_keys',
  'scanned_tests',
  'omr_results',
  'exam_responses',
  'schema_migrations',
];

function addCheck(report, name, ok, detail) {
  report.checks.push({ name, ok, detail });
  if (!ok) report.success = false;
}

async function run() {
  const report = { success: true, checkedAt: new Date().toISOString(), checks: [] };
  addCheck(
    report,
    'node-environment',
    process.env.NODE_ENV === 'production',
    process.env.NODE_ENV === 'production'
      ? 'production mode enabled'
      : 'NODE_ENV must be production for deployment'
  );
  const jwtSecret = String(process.env.JWT_SECRET || '');
  addCheck(
    report,
    'jwt-secret',
    jwtSecret.length >= 32 && jwtSecret !== 'replace-with-a-long-random-secret',
    jwtSecret.length >= 32 ? 'configured' : 'missing or shorter than 32 characters'
  );

  const missingFiles = REQUIRED_FILES.filter(relative => !fs.existsSync(path.join(ROOT, relative)));
  addCheck(
    report,
    'runtime-files',
    missingFiles.length === 0,
    missingFiles.length ? `missing: ${missingFiles.join(', ')}` : `${REQUIRED_FILES.length} required files present`
  );

  const scannerRuntime = inspectScannerRuntime('OMR_PYTHON', 'QR_PYTHON');
  addCheck(
    report,
    'scanner-python',
    scannerRuntime.available,
    scannerRuntime.available
      ? `Python ${scannerRuntime.pythonVersion}, OpenCV ${scannerRuntime.openCvVersion}, NumPy ${scannerRuntime.numpyVersion}`
      : scannerRuntime.reason
  );

  if (scannerRuntime.available) {
    try {
      const warmup = await prewarmAdaptiveWorker();
      addCheck(
        report,
        'omr-worker',
        warmup.success === true,
        warmup.success
          ? `warmup passed in ${Number(warmup.processingMs || 0).toFixed(1)} ms`
          : 'warmup image was not recognized'
      );
    } catch (error) {
      addCheck(report, 'omr-worker', false, error.message);
    } finally {
      shutdownAdaptiveWorker();
    }
    try {
      const qrWarmup = await prewarmQrWorker();
      addCheck(
        report,
        'qr-worker',
        qrWarmup.ready === true,
        qrWarmup.ready
          ? `warmup passed in ${Number(qrWarmup.wallMs || 0).toFixed(1)} ms`
          : qrWarmup.reason
      );
    } catch (error) {
      addCheck(report, 'qr-worker', false, error.message);
    } finally {
      shutdownQrWorker();
    }
  }

  let connection;
  try {
    connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: Number.parseInt(process.env.DB_PORT, 10) || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'acadcheck_db',
      connectTimeout: 5000,
    });
    const [tableRows] = await connection.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE()'
    );
    const tables = new Set(tableRows.map(row => String(row.TABLE_NAME || row.table_name)));
    const missingTables = REQUIRED_TABLES.filter(table => !tables.has(table));
    addCheck(
      report,
      'database-schema',
      missingTables.length === 0,
      missingTables.length ? `missing tables: ${missingTables.join(', ')}` : 'connection and required tables passed'
    );

    if (missingTables.length === 0) {
      const [[{ userCount }]] = await connection.query('SELECT COUNT(*) AS userCount FROM users');
      const bootstrapToken = String(process.env.BOOTSTRAP_ADMIN_TOKEN || '');
      addCheck(
        report,
        'administrator-bootstrap',
        Number(userCount) > 0 || bootstrapToken.length >= 24,
        Number(userCount) > 0
          ? `${userCount} account(s) exist; bootstrap token is no longer required`
          : bootstrapToken.length >= 24
            ? 'first-administrator bootstrap token configured'
            : 'database has no accounts and BOOTSTRAP_ADMIN_TOKEN is missing or too short'
      );
      const migrationDir = path.join(__dirname, 'migrations');
      const migrationFiles = fs.existsSync(migrationDir)
        ? fs.readdirSync(migrationDir).filter(file => file.endsWith('.sql')).sort()
        : [];
      const [appliedRows] = await connection.query('SELECT filename FROM schema_migrations');
      const applied = new Set(appliedRows.map(row => row.filename));
      const pending = migrationFiles.filter(file => !applied.has(file));
      addCheck(
        report,
        'database-migrations',
        pending.length === 0,
        pending.length ? `pending: ${pending.join(', ')}` : `${migrationFiles.length} migrations applied`
      );
    }
  } catch (error) {
    addCheck(report, 'database-schema', false, error.message);
  } finally {
    if (connection) await connection.end();
  }

  console.log(JSON.stringify(report, null, 2));
  return report.success ? 0 : 1;
}

run()
  .then(code => { process.exitCode = code; })
  .catch(error => {
    console.error(error);
    shutdownAdaptiveWorker();
    shutdownQrWorker();
    process.exitCode = 1;
  });
