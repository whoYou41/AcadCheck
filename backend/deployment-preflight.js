'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const { inspectScannerRuntime } = require('./python-runtime');
const {
  prewarmAdaptiveWorker,
  shutdownAdaptiveWorker,
} = require('./adaptive-form-omr');

const ROOT = path.join(__dirname, '..');
const REQUIRED_FILES = [
  'www/index.html',
  'ml-training/fast_omr_worker.py',
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

async function fetchWithTimeout(url, options = {}, timeoutMs = 5500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      redirect: 'manual',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function checkCameraTunnel(report) {
  const required = /^(1|true)$/i.test(String(process.env.REQUIRE_PI_CAMERA || ''));
  const rawCameraUrl = String(process.env.PI_CAMERA_URL || '').trim().replace(/\/+$/, '');
  if (!rawCameraUrl) {
    addCheck(
      report,
      'camera-tunnel',
      !required,
      required
        ? 'REQUIRE_PI_CAMERA is enabled but PI_CAMERA_URL is missing'
        : 'not required for this deployment'
    );
    return;
  }

  try {
    const cameraUrl = new URL(rawCameraUrl);
    if (!['http:', 'https:'].includes(cameraUrl.protocol)) {
      throw new Error('PI_CAMERA_URL must use http or https');
    }
    const statusResponse = await fetchWithTimeout(
      new URL('status', `${cameraUrl.toString().replace(/\/+$/, '')}/`)
    );
    if (!statusResponse.ok) {
      throw new Error(`status returned HTTP ${statusResponse.status}`);
    }
    const status = await statusResponse.json();
    if (status.camera_initialized !== true || status.frame_available === false) {
      throw new Error(status.last_error || status.hint || 'camera has no current frame');
    }

    const captureUrl = new URL(
      'capture?max_width=1440&quality=92',
      `${cameraUrl.toString().replace(/\/+$/, '')}/`
    );
    const captureResponse = await fetchWithTimeout(captureUrl);
    if (!captureResponse.ok) {
      throw new Error(`capture returned HTTP ${captureResponse.status}`);
    }
    const contentType = String(captureResponse.headers.get('content-type') || '').toLowerCase();
    if (!contentType.startsWith('image/jpeg') && !contentType.startsWith('image/png')) {
      throw new Error(`capture returned unexpected content type ${contentType || 'unknown'}`);
    }
    const frame = Buffer.from(await captureResponse.arrayBuffer());
    if (frame.length < 1024 || frame.length > 12 * 1024 * 1024) {
      throw new Error(`capture size ${frame.length} bytes is outside the allowed range`);
    }
    addCheck(
      report,
      'camera-tunnel',
      true,
      `status and 1440px capture passed (${frame.length} bytes)`
    );
  } catch (error) {
    const detail = error?.name === 'AbortError'
      ? 'private camera tunnel timed out'
      : String(error.message || error.code || 'camera tunnel probe failed');
    addCheck(report, 'camera-tunnel', false, detail);
  }
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

  const scannerRuntime = inspectScannerRuntime('OMR_PYTHON');
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
      const availableCpus = typeof os.availableParallelism === 'function'
        ? os.availableParallelism()
        : os.cpus().length;
      const configuredQueue = Number.parseInt(process.env.OMR_MAX_PENDING_REQUESTS, 10);
      const oneCpuSettingsOk = availableCpus > 1 || (
        warmup.opencvThreads === 1
        && Number.isInteger(configuredQueue)
        && configuredQueue >= 1
        && configuredQueue <= 2
      );
      addCheck(
        report,
        'omr-one-cpu-concurrency',
        oneCpuSettingsOk,
        availableCpus > 1
          ? `${availableCpus} CPUs available; worker reports ${warmup.opencvThreads || 'default'} OpenCV threads`
          : oneCpuSettingsOk
            ? `one CPU available; OpenCV uses one thread and the queue limit is ${configuredQueue}`
            : 'one-CPU deployments require OMR_OPENCV_THREADS=1 and OMR_MAX_PENDING_REQUESTS=1 or 2'
      );
    } catch (error) {
      addCheck(report, 'omr-worker', false, error.message);
    } finally {
      shutdownAdaptiveWorker();
    }
  }

  await checkCameraTunnel(report);

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
    const databaseDetail = String(error.message || error.code || 'database connection failed without details');
    addCheck(report, 'database-schema', false, databaseDetail);
  } finally {
    if (connection) await connection.end();
  }

  console.log(JSON.stringify(report, null, 2));
  return report.success ? 0 : 1;
}

if (require.main === module) {
  run()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      console.error(error);
      shutdownAdaptiveWorker();
      process.exitCode = 1;
    });
}

module.exports = {
  checkCameraTunnel,
};
