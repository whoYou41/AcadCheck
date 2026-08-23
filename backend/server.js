const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const EnhancedScanner = require('./enhanced-scanner');
const SequenceDetector = require('./sequence-detector');
const ExamSheetDetector = require('./exam-sheet-detector');
const { rectifyExamSheet } = require('./perspective-corrector');
const OnnxService = require('./onnx-scanner-service');
const ScannerTrainer = require('./scanner-trainer');
const { generateAnswerSheet } = require('./answer-sheet-generator');
const QrCodeDetector = require('./qr-code-detector');
const { prewarmAdaptiveWorker } = require('./adaptive-form-omr');

const PI_CAMERA_URL = (process.env.PI_CAMERA_URL || '').replace(/\/+$/, '');
const PI_SCAN_ENDPOINT = PI_CAMERA_URL ? (PI_CAMERA_URL + '/scan') : '';
const OMR_DIAGNOSTICS_ROOT = path.resolve(__dirname, '../uploads/diagnostics');
const OMR_DIAGNOSTIC_KEY_PATTERN = /^[a-f0-9]{32}$/;
const OMR_DIAGNOSTIC_FILE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.png$/i;
const OMR_DIAGNOSTIC_TTL_MS = (() => {
  const configured = Number.parseInt(process.env.OMR_DIAGNOSTIC_TTL_MS, 10);
  if (!Number.isFinite(configured)) return 2 * 60 * 60 * 1000;
  return Math.min(24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, configured));
})();
const OMR_DIAGNOSTIC_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const OMR_DIAGNOSTIC_METADATA_FILE = '.metadata.json';

function diagnosticSessionPath(diagnosticKey) {
  if (!OMR_DIAGNOSTIC_KEY_PATTERN.test(String(diagnosticKey || ''))) return null;
  const candidate = path.resolve(OMR_DIAGNOSTICS_ROOT, diagnosticKey);
  return path.dirname(candidate) === OMR_DIAGNOSTICS_ROOT ? candidate : null;
}

function isSafeDiagnosticArtifactName(filename) {
  const value = String(filename || '');
  return OMR_DIAGNOSTIC_FILE_PATTERN.test(value)
    && path.basename(value) === value;
}

function createOmrDiagnosticSession(ownerId) {
  if (ownerId === undefined || ownerId === null || ownerId === '') {
    throw new Error('An authenticated owner is required for OMR diagnostics');
  }
  const diagnosticKey = crypto.randomBytes(16).toString('hex');
  const diagnosticDir = diagnosticSessionPath(diagnosticKey);
  const createdAt = new Date();
  const metadata = {
    version: 1,
    diagnosticKey,
    ownerId: String(ownerId),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + OMR_DIAGNOSTIC_TTL_MS).toISOString(),
    artifacts: [],
  };
  fs.mkdirSync(diagnosticDir, { recursive: true });
  fs.writeFileSync(
    path.join(diagnosticDir, OMR_DIAGNOSTIC_METADATA_FILE),
    JSON.stringify(metadata, null, 2),
    { encoding: 'utf8', flag: 'wx' }
  );
  return { diagnosticKey, diagnosticDir, metadata };
}

function readOmrDiagnosticMetadata(diagnosticKey) {
  const diagnosticDir = diagnosticSessionPath(diagnosticKey);
  if (!diagnosticDir) return null;
  try {
    const directoryStat = fs.lstatSync(diagnosticDir);
    const metadataPath = path.join(diagnosticDir, OMR_DIAGNOSTIC_METADATA_FILE);
    const metadataStat = fs.lstatSync(metadataPath);
    if (
      !directoryStat.isDirectory()
      || directoryStat.isSymbolicLink()
      || !metadataStat.isFile()
      || metadataStat.isSymbolicLink()
      || metadataStat.size <= 0
      || metadataStat.size > 64 * 1024
    ) {
      return null;
    }
    const metadata = JSON.parse(fs.readFileSync(
      metadataPath,
      'utf8'
    ));
    if (
      metadata?.version !== 1
      || metadata?.diagnosticKey !== diagnosticKey
      || typeof metadata?.ownerId !== 'string'
      || !Array.isArray(metadata?.artifacts)
    ) {
      return null;
    }
    const expiresAtMs = Date.parse(metadata.expiresAt);
    if (!Number.isFinite(expiresAtMs)) return null;
    return {
      diagnosticDir,
      metadata: {
        ...metadata,
        artifacts: metadata.artifacts.filter(isSafeDiagnosticArtifactName),
      },
      expired: expiresAtMs <= Date.now(),
    };
  } catch {
    return null;
  }
}

function updateOmrDiagnosticMetadata(diagnosticKey, ownerId, artifacts) {
  const session = readOmrDiagnosticMetadata(diagnosticKey);
  if (!session || session.expired || session.metadata.ownerId !== String(ownerId)) {
    throw new Error('OMR diagnostic session metadata is missing, expired, or has the wrong owner');
  }
  const metadata = {
    ...session.metadata,
    artifacts: [...new Set((artifacts || []).filter(isSafeDiagnosticArtifactName))],
  };
  fs.writeFileSync(
    path.join(session.diagnosticDir, OMR_DIAGNOSTIC_METADATA_FILE),
    JSON.stringify(metadata, null, 2),
    'utf8'
  );
  return metadata;
}

async function cleanupExpiredOmrDiagnostics() {
  let entries;
  try {
    entries = await fs.promises.readdir(OMR_DIAGNOSTICS_ROOT, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[FAST-OMR] Diagnostic cleanup could not list sessions:', error.message);
    }
    return;
  }
  await Promise.all(entries.map(async entry => {
    if (!entry.isDirectory() || !OMR_DIAGNOSTIC_KEY_PATTERN.test(entry.name)) return;
    const session = readOmrDiagnosticMetadata(entry.name);
    let shouldRemove = session?.expired === true;
    if (!session) {
      try {
        const stat = await fs.promises.stat(path.join(OMR_DIAGNOSTICS_ROOT, entry.name));
        shouldRemove = stat.mtimeMs + OMR_DIAGNOSTIC_TTL_MS <= Date.now();
      } catch {
        shouldRemove = false;
      }
    }
    if (!shouldRemove) return;
    const exactSessionPath = diagnosticSessionPath(entry.name);
    if (!exactSessionPath) return;
    try {
      await fs.promises.rm(exactSessionPath, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[FAST-OMR] Could not expire diagnostic session ${entry.name}:`, error.message);
    }
  }));
}

function escapeDiagnosticHtml(value) {
  return String(value || '').replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

/**
 * Submit an image through the Windows printer driver installed on the
 * AcadCheck backend computer. Mobile clients only trigger this authenticated
 * API operation and need no printer driver or third-party print application.
 */
function printImageWithWindowsDriver(imagePath) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Direct printing requires the AcadCheck backend to run on Windows.'));
  }

  const powershellPath = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
  );
  const configuredPrinter = (process.env.ACADCHECK_PRINTER_NAME || '').trim();
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$image = [System.Drawing.Image]::FromFile($env:ACADCHECK_PRINT_IMAGE)
$document = New-Object System.Drawing.Printing.PrintDocument
$document.DocumentName = 'AcadCheck Score'
$document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
if (-not [string]::IsNullOrWhiteSpace($env:ACADCHECK_PRINT_TARGET)) {
  $document.PrinterSettings.PrinterName = $env:ACADCHECK_PRINT_TARGET
}
if (-not $document.PrinterSettings.IsValid) {
  throw "Windows printer '$($document.PrinterSettings.PrinterName)' is unavailable."
}
$printHandler = [System.Drawing.Printing.PrintPageEventHandler] {
  param($sender, $eventArgs)
  # Print at the same approximate physical size as the existing 80x300 label.
  $printWidth = 84
  $printHeight = 313
  # Keep the score in the lower-right printable margin, beside the answer
  # sheet, with enough inset to avoid common printer clipping.
  $rightPadding = 32
  $bottomPadding = 36
  $x = [Math]::Max(0, [int]($eventArgs.PageBounds.Right - $printWidth - $rightPadding))
  $y = [Math]::Max(0, [int]($eventArgs.PageBounds.Bottom - $printHeight - $bottomPadding))
  $eventArgs.Graphics.DrawImage($image, $x, $y, $printWidth, $printHeight)
  $eventArgs.HasMorePages = $false
}
$document.add_PrintPage($printHandler)
try {
  $printerName = $document.PrinterSettings.PrinterName
  $document.Print()
  Write-Output $printerName
} finally {
  $document.remove_PrintPage($printHandler)
  $document.Dispose()
  $image.Dispose()
}
`;

  return new Promise((resolve, reject) => {
    execFile(
      powershellPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          ACADCHECK_PRINT_IMAGE: path.resolve(imagePath),
          ACADCHECK_PRINT_TARGET: configuredPrinter,
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim();
          reject(new Error(detail || 'Windows rejected the print job.'));
          return;
        }
        resolve({ printerName: String(stdout || configuredPrinter || 'Windows default printer').trim() });
      }
    );
  });
}

async function proxyToPi(base64Image, answerKey = '') {
  if (!PI_SCAN_ENDPOINT) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const response = await fetch(PI_SCAN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageBuffer: base64Image, answerKey }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.json();
  } catch (e) {
    console.warn('Pi proxy failed, falling back to local processing:', e.message);
    return null;
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const SCANNER_PIPELINE_VERSION = process.env.SCANNER_PIPELINE_VERSION || 'acadcheck-omr-2026.08';
const OMR_MINIMUM_QUALITY = Math.min(
  100,
  Math.max(0, Number.parseFloat(process.env.OMR_MINIMUM_QUALITY) || 55)
);
const LIVE_DETECTION_TTL_MS = Math.min(
  30_000,
  Math.max(5_000, Number.parseInt(process.env.LIVE_DETECTION_TTL_MS, 10) || 15_000)
);
const LIVE_DETECTION_CACHE_LIMIT = Math.min(
  64,
  Math.max(4, Number.parseInt(process.env.LIVE_DETECTION_CACHE_LIMIT, 10) || 24)
);
const liveDetectionCache = new Map();
const LIVE_SHEET_STATE_TTL_MS = Math.min(
  2 * 60 * 60 * 1000,
  Math.max(2 * 60 * 1000, Number.parseInt(process.env.LIVE_SHEET_STATE_TTL_MS, 10) || 30 * 60 * 1000)
);
const LIVE_SHEET_REMOVAL_FRAMES = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.LIVE_SHEET_REMOVAL_FRAMES, 10) || 2)
);
const LIVE_NEW_SHEET_FRAMES = Math.min(
  4,
  Math.max(1, Number.parseInt(process.env.LIVE_NEW_SHEET_FRAMES, 10) || 2)
);
const LIVE_SAME_SHEET_DISTANCE = Math.min(
  16,
  Math.max(0, Number.parseInt(process.env.LIVE_SAME_SHEET_DISTANCE, 10) || 7)
);
const LIVE_NEW_SHEET_IDENTITY_DISTANCE = Math.min(
  12,
  Math.max(2, Number.parseInt(process.env.LIVE_NEW_SHEET_IDENTITY_DISTANCE, 10) || 6)
);
const finalizedLiveSheets = new Map();
const activeLiveFinalizations = new Set();
const HEX_BIT_COUNTS = Object.freeze([0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]);

function elapsedMs(started) {
  return Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(2));
}

function setServerTiming(res, timings) {
  const values = Object.entries(timings || {})
    .filter(([, duration]) => Number.isFinite(Number(duration)) && Number(duration) >= 0)
    .map(([name, duration]) => `${String(name).replace(/[^a-zA-Z0-9_-]/g, '')};dur=${Number(duration).toFixed(2)}`);
  if (values.length > 0 && !res.headersSent) res.set('Server-Timing', values.join(', '));
}

function omrProcessingTimings(details, totalMs) {
  const source = details && typeof details === 'object' ? details : {};
  const stages = source.stagesMs && typeof source.stagesMs === 'object'
    ? source.stagesMs
    : {};
  const timings = {
    omr: Number(source.processingMs || 0),
    omrBridge: Number(source.totalBridgeMs ?? source.bridgeMs ?? 0),
    omrTransport: Number(source.transportMs || 0),
    omrInputValidation: Number(source.inputValidationMs || 0),
  };
  for (const [stage, duration] of Object.entries(stages)) {
    if (!Number.isFinite(Number(duration)) || Number(duration) < 0) continue;
    const name = `omr_${String(stage).replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    timings[name] = Number(duration);
  }
  timings.total = Number(totalMs || 0);
  return timings;
}

function pruneLiveDetectionCache(now = Date.now()) {
  for (const [token, entry] of liveDetectionCache) {
    if (now - entry.createdAt > LIVE_DETECTION_TTL_MS) liveDetectionCache.delete(token);
  }
  while (liveDetectionCache.size > LIVE_DETECTION_CACHE_LIMIT) {
    liveDetectionCache.delete(liveDetectionCache.keys().next().value);
  }
}

function cacheLiveDetection(entry) {
  pruneLiveDetectionCache();
  const token = crypto.randomBytes(24).toString('hex');
  liveDetectionCache.set(token, {
    ...entry,
    createdAt: Date.now(),
    imageSha256: crypto.createHash('sha256').update(entry.imageBuffer).digest('hex'),
  });
  pruneLiveDetectionCache();
  return token;
}

function consumeLiveDetection(token, userId) {
  pruneLiveDetectionCache();
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  const entry = liveDetectionCache.get(token);
  if (!entry || String(entry.userId) !== String(userId)) return null;
  // Single-use consumption prevents duplicate grades from racing each other.
  liveDetectionCache.delete(token);
  if (Date.now() - entry.createdAt > LIVE_DETECTION_TTL_MS) return null;
  return entry;
}

async function claimScanForProcessing(scanId, userId) {
  const connection = await transactionPool.promise().getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, scan_status, updated_at
       FROM scanned_tests
       WHERE id = ? AND user_id = ?
       FOR UPDATE`,
      [scanId, userId]
    );
    if (rows.length === 0) {
      await connection.rollback();
      return { claimed: false, reason: 'not-found' };
    }
    const current = rows[0];
    const updatedAt = Date.parse(current.updated_at);
    const activeProcessing = current.scan_status === 'processing'
      && Number.isFinite(updatedAt)
      && Date.now() - updatedAt < 5 * 60 * 1000;
    if (activeProcessing) {
      await connection.rollback();
      return { claimed: false, reason: 'already-processing' };
    }

    // Once a reprocess starts, prior child rows are no longer current. Clear
    // them atomically with the status claim so failed retries cannot expose an
    // older score or OCR extraction as the new result.
    await connection.query('DELETE FROM exam_responses WHERE scanned_test_id = ? AND user_id = ?', [scanId, userId]);
    await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ? AND user_id = ?', [scanId, userId]);
    await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ? AND user_id = ?', [scanId, userId]);
    await connection.query(
      `UPDATE scanned_tests
       SET scan_status = 'processing', error_message = NULL,
           processed_at = NULL, processing_started_at = NOW(),
           processing_duration_ms = NULL, scanner_version = ?,
           student_number_detected = NULL, student_name_detected = NULL,
           sequential_number_detected = NULL, answer_key_date_detected = NULL,
           epoch_detected = NULL, sequence_detected = NULL,
           ocr_confidence = NULL, suspicious_uniform_detection = FALSE
       WHERE id = ? AND user_id = ?`,
      [SCANNER_PIPELINE_VERSION, scanId, userId]
    );
    await connection.commit();
    return { claimed: true };
  } catch (error) {
    try { await connection.rollback(); } catch (_) {}
    throw error;
  } finally {
    connection.release();
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// Diagnostic images can contain student answers. Never let the broad uploads
// static handler expose them without authentication; the owner-scoped API
// below returns a protected, self-contained gallery instead.
app.use('/uploads', (req, res, next) => {
  let decodedPath = String(req.path || '');
  try {
    // Express/static and Windows path handling can normalize percent-encoded
    // separators differently. Decode defensively before deciding whether this
    // request may reach the uploads static handler.
    for (let pass = 0; pass < 2; pass++) {
      const decoded = decodeURIComponent(decodedPath);
      if (decoded === decodedPath) break;
      decodedPath = decoded;
    }
  } catch {
    return res.status(400).json({ success: false, message: 'Invalid upload path' });
  }
  const normalizedPath = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (/^diagnostics(?:\/|$)/i.test(normalizedPath)) {
    return res.status(404).json({ success: false, message: 'Diagnostic resource not found' });
  }
  next();
});
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.use(express.static(path.join(__dirname, '../www')));

// Rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// JWT Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

function getOwnedOmrDiagnosticSession(req, res) {
  const diagnosticKey = String(req.params.diagnosticKey || '');
  if (!OMR_DIAGNOSTIC_KEY_PATTERN.test(diagnosticKey)) {
    res.status(404).json({ success: false, message: 'Diagnostic resource not found' });
    return null;
  }
  const session = readOmrDiagnosticMetadata(diagnosticKey);
  // Hide the existence of another account's diagnostics.
  if (!session || session.metadata.ownerId !== String(req.user.userId)) {
    res.status(404).json({ success: false, message: 'Diagnostic resource not found' });
    return null;
  }
  if (session.expired) {
    const exactSessionPath = diagnosticSessionPath(diagnosticKey);
    if (exactSessionPath) {
      fs.promises.rm(exactSessionPath, { recursive: true, force: true }).catch(() => {});
    }
    res.status(410).json({ success: false, message: 'Diagnostic session has expired' });
    return null;
  }
  return session;
}

function setPrivateDiagnosticHeaders(res) {
  res.set({
    'Cache-Control': 'private, no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
  });
}

app.get('/api/omr/diagnostics/:diagnosticKey', authenticateToken, (req, res) => {
  const session = getOwnedOmrDiagnosticSession(req, res);
  if (!session) return;

  const cards = [];
  let embeddedBytes = 0;
  const maximumGalleryBytes = 64 * 1024 * 1024;
  for (const filename of session.metadata.artifacts.slice(0, 24)) {
    if (!isSafeDiagnosticArtifactName(filename)) continue;
    const artifactPath = path.resolve(session.diagnosticDir, filename);
    if (path.dirname(artifactPath) !== session.diagnosticDir) continue;
    try {
      const stat = fs.lstatSync(artifactPath);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size <= 0
        || stat.size > 12 * 1024 * 1024
      ) continue;
      if (embeddedBytes + stat.size > maximumGalleryBytes) continue;
      embeddedBytes += stat.size;
      const imageData = fs.readFileSync(artifactPath).toString('base64');
      const label = path.parse(filename).name.replace(/^\d+_?/, '').replace(/_/g, ' ');
      cards.push(
        `<figure><img src="data:image/png;base64,${imageData}" alt="${escapeDiagnosticHtml(label)}">`
        + `<figcaption>${escapeDiagnosticHtml(label)}</figcaption></figure>`
      );
    } catch {
      // A partially written or already cleaned artifact is simply omitted.
    }
  }

  if (cards.length === 0) {
    return res.status(404).json({ success: false, message: 'No diagnostic artifacts are available' });
  }
  const expiresAt = escapeDiagnosticHtml(session.metadata.expiresAt);
  const gallery = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="referrer" content="no-referrer"><title>AcadCheck OMR diagnostics</title><style>body{margin:0;padding:20px;background:#f4f7fb;color:#172033;font:15px system-ui,sans-serif}h1{font-size:1.25rem;margin-bottom:4px}.expiry{margin:0 0 18px;color:#5b667a}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px}figure{margin:0;padding:12px;background:#fff;border:1px solid #dce3ee;border-radius:12px;box-shadow:0 4px 16px #17203312}img{display:block;width:100%;height:auto;border-radius:8px}figcaption{padding-top:9px;text-transform:capitalize;font-weight:650}</style></head><body><h1>AcadCheck OMR diagnostics</h1><p class="expiry">Private diagnostic session. Expires ${expiresAt}.</p><div class="grid">${cards.join('')}</div></body></html>`;
  setPrivateDiagnosticHeaders(res);
  res.type('html').send(gallery);
});

app.get(
  '/api/omr/diagnostics/:diagnosticKey/artifacts/:filename',
  authenticateToken,
  (req, res) => {
    const session = getOwnedOmrDiagnosticSession(req, res);
    if (!session) return;
    const filename = String(req.params.filename || '');
    if (
      !isSafeDiagnosticArtifactName(filename)
      || !session.metadata.artifacts.includes(filename)
    ) {
      return res.status(404).json({ success: false, message: 'Diagnostic artifact not found' });
    }
    const artifactPath = path.resolve(session.diagnosticDir, filename);
    if (path.dirname(artifactPath) !== session.diagnosticDir) {
      return res.status(404).json({ success: false, message: 'Diagnostic artifact not found' });
    }
    try {
      const stat = fs.lstatSync(artifactPath);
      if (
        !stat.isFile()
        || stat.isSymbolicLink()
        || stat.size <= 0
        || stat.size > 12 * 1024 * 1024
      ) {
        return res.status(404).json({ success: false, message: 'Diagnostic artifact not found' });
      }
    } catch {
      return res.status(404).json({ success: false, message: 'Diagnostic artifact not found' });
    }
    setPrivateDiagnosticHeaders(res);
    res.type('png').sendFile(artifactPath);
  }
);

cleanupExpiredOmrDiagnostics().catch(() => {});
const omrDiagnosticCleanupTimer = setInterval(
  () => cleanupExpiredOmrDiagnostics().catch(() => {}),
  OMR_DIAGNOSTIC_CLEANUP_INTERVAL_MS
);
if (typeof omrDiagnosticCleanupTimer.unref === 'function') {
  omrDiagnosticCleanupTimer.unref();
}

/**
 * Resolve the camera's known network names and verify which supported port is
 * serving its capture endpoint. The camera's current DHCP address is also
 * checked because some routers advertise the device without providing mDNS.
 */
const CAMERA_PROBE_TIMEOUT_MS = Math.min(
  4_000,
  Math.max(750, Number.parseInt(process.env.ACADCAM_PROBE_TIMEOUT_MS, 10) || 1_800)
);
const CAMERA_PROBE_ATTEMPTS = Math.min(
  3,
  Math.max(1, Number.parseInt(process.env.ACADCAM_PROBE_ATTEMPTS, 10) || 2)
);
const CAMERA_DISCOVERY_TIMEOUT_MS = Math.min(
  9_000,
  Math.max(2_000, Number.parseInt(process.env.ACADCAM_DISCOVERY_TIMEOUT_MS, 10) || 7_000)
);
let lastKnownCamera = null;

function cameraStatusResult(candidate, baseUrl, status, probeAttempts) {
  const reportedFrameAgeSeconds = Number(status?.frame_age_seconds);
  const reportedFrameAgeMs = Number(status?.last_frame_age_ms);
  const frameAgeSeconds = Number.isFinite(reportedFrameAgeSeconds)
    ? reportedFrameAgeSeconds
    : Number.isFinite(reportedFrameAgeMs)
      ? reportedFrameAgeMs / 1000
      : null;
  const frameAvailable = typeof status?.frame_available === 'boolean'
    ? status.frame_available
    : status.camera_initialized === true;
  return {
    ...candidate,
    cameraUrl: baseUrl,
    cameraInitialized: status.camera_initialized === true,
    frameAvailable,
    frameAgeSeconds,
    deviceOpened: status.device_opened === true,
    recoveryInProgress: status.recovery_in_progress === true,
    recoveryCount: Number.isFinite(Number(status.recovery_count))
      ? Number(status.recovery_count)
      : 0,
    lastError: typeof status.last_error === 'string' ? status.last_error : null,
    hint: typeof status.hint === 'string' ? status.hint : null,
    resolution: typeof status.resolution === 'string' ? status.resolution : null,
    frameCount: Number.isFinite(Number(status.frame_count)) ? Number(status.frame_count) : null,
    probeAttempts,
  };
}

function normalizedSheetFingerprint(value) {
  const fingerprint = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{16,128}$/.test(fingerprint) && fingerprint.length % 2 === 0
    ? fingerprint
    : null;
}

function sheetFingerprintDistance(left, right) {
  const a = normalizedSheetFingerprint(left);
  const b = normalizedSheetFingerprint(right);
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  return hexHammingDistance(a, b);
}

function hexHammingDistance(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return Number.POSITIVE_INFINITY;
  }
  let distance = 0;
  for (let index = 0; index < a.length; index++) {
    distance += HEX_BIT_COUNTS[Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16)];
  }
  return distance;
}

function sheetIdentityDistance(left, right) {
  const a = normalizedSheetFingerprint(left);
  const b = normalizedSheetFingerprint(right);
  if (!a || !b || a.length !== b.length) return Number.POSITIVE_INFINITY;
  // v2 fingerprints reserve their first 24 bits for dynamic header/footer
  // handwriting and their remaining 40 bits for answer-state stability.
  return hexHammingDistance(a.slice(0, 6), b.slice(0, 6));
}

function pruneFinalizedLiveSheets(now = Date.now()) {
  for (const [userKey, state] of finalizedLiveSheets) {
    if (now - state.finalizedAt > LIVE_SHEET_STATE_TTL_MS) finalizedLiveSheets.delete(userKey);
  }
}

function liveSheetUserKey(userId) {
  return String(userId);
}

function liveSheetSignals(overrides = {}) {
  return {
    duplicateSheet: false,
    removalRequired: false,
    sheetIdentityChanged: false,
    removalFrames: 0,
    requiredRemovalFrames: LIVE_SHEET_REMOVAL_FRAMES,
    newSheetFrames: 0,
    requiredNewSheetFrames: LIVE_NEW_SHEET_FRAMES,
    fingerprintDistance: null,
    identityFingerprintDistance: null,
    ...overrides,
  };
}

function resetLiveSheetCandidate(state) {
  state.newFingerprint = null;
  state.newFingerprintFrames = 0;
  state.newFingerprintLastObservationId = null;
  state.confirmedFingerprint = null;
  state.confirmedFingerprintVersion = null;
}

function normalizedLiveObservationId(value) {
  const observationId = String(value || '').trim();
  return observationId.length > 0 && observationId.length <= 256
    ? observationId
    : null;
}

function observeLiveSheet(userId, omrResult, rawObservationId = null) {
  pruneFinalizedLiveSheets();
  const userKey = liveSheetUserKey(userId);
  const state = finalizedLiveSheets.get(userKey);
  if (!state) return liveSheetSignals();

  const observationId = normalizedLiveObservationId(rawObservationId);
  const details = omrResult?.details && typeof omrResult.details === 'object'
    ? omrResult.details
    : {};
  const presence = String(details.sheetPresence || 'unknown').toLowerCase();
  if (presence === 'absent') {
    if (state.absentFrames === 0) {
      state.absentFrames = 1;
      state.lastAbsentObservationId = observationId;
    } else if (observationId && observationId !== state.lastAbsentObservationId) {
      state.absentFrames++;
      state.lastAbsentObservationId = observationId;
    }
    resetLiveSheetCandidate(state);
    state.updatedAt = Date.now();
    if (state.absentFrames >= LIVE_SHEET_REMOVAL_FRAMES) {
      finalizedLiveSheets.delete(userKey);
      return liveSheetSignals({
        sheetIdentityChanged: true,
        removalConfirmed: true,
        removalFrames: state.absentFrames,
      });
    }
    return liveSheetSignals({
      duplicateSheet: true,
      removalRequired: true,
      removalFrames: state.absentFrames,
      reason: `Confirming sheet removal ${state.absentFrames}/${LIVE_SHEET_REMOVAL_FRAMES}`,
    });
  }

  state.absentFrames = 0;
  state.lastAbsentObservationId = null;
  state.updatedAt = Date.now();
  const fingerprint = normalizedSheetFingerprint(details.sheetFingerprint);
  const distance = sheetFingerprintDistance(fingerprint, state.fingerprint);
  const identityDistance = sheetIdentityDistance(fingerprint, state.fingerprint);
  if (!fingerprint || !state.fingerprint) {
    resetLiveSheetCandidate(state);
    return liveSheetSignals({
      removalRequired: true,
      reason: 'Remove the previously graded sheet before scanning another one',
    });
  }
  if (Number(details.sheetFingerprintVersion) !== 2 || Number(state.fingerprintVersion) !== 2) {
    resetLiveSheetCandidate(state);
    return liveSheetSignals({
      duplicateSheet: distance <= LIVE_SAME_SHEET_DISTANCE,
      removalRequired: true,
      fingerprintDistance: distance,
      reason: 'Remove the previous sheet; this scanner version cannot prove a new physical sheet from pixels alone',
    });
  }
  if (identityDistance < LIVE_NEW_SHEET_IDENTITY_DISTANCE) {
    resetLiveSheetCandidate(state);
    return liveSheetSignals({
      duplicateSheet: true,
      removalRequired: true,
      fingerprintDistance: distance,
      identityFingerprintDistance: identityDistance,
      reason: distance <= LIVE_SAME_SHEET_DISTANCE
        ? 'This sheet was already graded; remove it before scanning the next one'
        : 'Answer pixels changed, but the physical sheet identity did not; remove the previous sheet',
    });
  }

  // A confirmed replacement remains provisional until its database
  // transaction commits. Keeping the previous finalized identity here makes
  // a validation or persistence failure retryable without reopening the gate
  // for arbitrary sheets or forgetting what was already graded.
  const confirmedDistance = sheetFingerprintDistance(fingerprint, state.confirmedFingerprint);
  if (state.confirmedFingerprint && confirmedDistance <= LIVE_SAME_SHEET_DISTANCE) {
    return liveSheetSignals({
      sheetIdentityChanged: true,
      newSheetConfirmed: true,
      newSheetFrames: Math.max(LIVE_NEW_SHEET_FRAMES, state.newFingerprintFrames),
      fingerprintDistance: distance,
      identityFingerprintDistance: identityDistance,
    });
  }
  if (state.confirmedFingerprint) resetLiveSheetCandidate(state);

  const candidateDistance = sheetFingerprintDistance(fingerprint, state.newFingerprint);
  if (state.newFingerprint && candidateDistance <= LIVE_SAME_SHEET_DISTANCE) {
    if (observationId && observationId !== state.newFingerprintLastObservationId) {
      state.newFingerprintFrames++;
      state.newFingerprintLastObservationId = observationId;
    }
  } else {
    state.newFingerprint = fingerprint;
    state.newFingerprintFrames = 1;
    state.newFingerprintLastObservationId = observationId;
  }
  if (state.newFingerprintFrames >= LIVE_NEW_SHEET_FRAMES) {
    state.confirmedFingerprint = state.newFingerprint;
    state.confirmedFingerprintVersion = Number(details.sheetFingerprintVersion);
    return liveSheetSignals({
      sheetIdentityChanged: true,
      newSheetConfirmed: true,
      newSheetFrames: state.newFingerprintFrames,
      fingerprintDistance: distance,
      identityFingerprintDistance: identityDistance,
    });
  }
  return liveSheetSignals({
    removalRequired: true,
    newSheetFrames: state.newFingerprintFrames,
    fingerprintDistance: distance,
    identityFingerprintDistance: identityDistance,
    reason: `Confirming a genuinely new sheet ${state.newFingerprintFrames}/${LIVE_NEW_SHEET_FRAMES}`,
  });
}

function markLiveSheetFinalized(userId, entry) {
  pruneFinalizedLiveSheets();
  finalizedLiveSheets.set(liveSheetUserKey(userId), {
    fingerprint: normalizedSheetFingerprint(entry?.omrResult?.details?.sheetFingerprint),
    fingerprintVersion: Number(entry?.omrResult?.details?.sheetFingerprintVersion || 1),
    answerKeyId: Number(entry?.answerKeyId || 0) || null,
    finalizedAt: Date.now(),
    updatedAt: Date.now(),
    absentFrames: 0,
    lastAbsentObservationId: null,
    newFingerprint: null,
    newFingerprintFrames: 0,
    newFingerprintLastObservationId: null,
    confirmedFingerprint: null,
    confirmedFingerprintVersion: null,
  });
}

function liveEntryMatchesFinalizedSheet(userId, entry) {
  pruneFinalizedLiveSheets();
  const state = finalizedLiveSheets.get(liveSheetUserKey(userId));
  if (!state) return false;
  const fingerprint = normalizedSheetFingerprint(entry?.omrResult?.details?.sheetFingerprint);
  if (!fingerprint || !state.fingerprint) return true;
  return sheetFingerprintDistance(fingerprint, state.fingerprint) <= LIVE_SAME_SHEET_DISTANCE;
}

function invalidateLiveDetectionsForUser(userId) {
  for (const [token, entry] of liveDetectionCache) {
    if (String(entry.userId) === String(userId)) liveDetectionCache.delete(token);
  }
}

function processingFailureDisposition(transactionCommitted) {
  return transactionCommitted
    ? {
        committed: true,
        retrySafe: false,
        rollback: false,
        persistFailure: false,
        status: 503,
      }
    : {
        committed: false,
        retrySafe: true,
        rollback: true,
        persistFailure: true,
        status: 500,
      };
}

async function probeAcadcamCandidate(candidate) {
  const baseUrl = candidate.baseUrl
    || `http://${candidate.address}${candidate.port === 80 ? '' : `:${candidate.port}`}`;
  let lastReason = 'no response';
  for (let attempt = 1; attempt <= CAMERA_PROBE_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CAMERA_PROBE_TIMEOUT_MS);
    try {
      // /status is intentionally used instead of /capture: discovery must not
      // block on camera warm-up or a multi-megabyte JPEG. A reachable service
      // is returned even when its camera is recovering so the UI can offer
      // restart/retry instead of reporting the host as missing.
      const response = await fetch(`${baseUrl}/status`, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.ok) {
        const status = await response.json().catch(() => null);
        if (status && typeof status.camera_initialized === 'boolean') {
          return cameraStatusResult(candidate, baseUrl, status, attempt);
        }
        lastReason = 'status response was not an AcadCheck camera payload';
      } else {
        lastReason = `status returned HTTP ${response.status}`;
      }
    } catch (error) {
      lastReason = error?.name === 'AbortError'
        ? `status check timed out after ${CAMERA_PROBE_TIMEOUT_MS} ms`
        : error.message;
    } finally {
      clearTimeout(timer);
    }
  }
  console.warn(`[CAMERA] ${baseUrl}/status did not respond: ${lastReason}`);
  return null;
}

function preferredCameraResult(results) {
  const candidates = Array.isArray(results) ? results.filter(Boolean) : [];
  return candidates.find(result => result.cameraInitialized && result.frameAvailable)
    || candidates[0]
    || null;
}

function firstHealthyCameraOrFallback(groupPromises, timeoutMs) {
  return new Promise(resolve => {
    const groups = Array.isArray(groupPromises) ? groupPromises : [];
    let remaining = groups.length;
    let fallback = null;
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result || null);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    if (remaining === 0) {
      finish(null);
      return;
    }
    for (const groupPromise of groups) {
      Promise.resolve(groupPromise).then(result => {
        remaining--;
        if (result?.cameraInitialized && result?.frameAvailable) {
          finish(result);
          return;
        }
        if (result && !fallback) fallback = result;
        if (remaining === 0) finish(fallback);
      }).catch(error => {
        remaining--;
        console.warn(`[CAMERA] Candidate group failed unexpectedly: ${error.message}`);
        if (remaining === 0) finish(fallback);
      });
    }
  });
}

async function probeAcadcamAddresses(addresses) {
  const seen = new Set();
  const candidates = [];
  for (const item of addresses) {
    const ports = Number.isInteger(Number(item.port))
      ? [Number(item.port)]
      : [5000, 80];
    for (const port of ports) {
      const baseUrl = item.baseUrl
        ? String(item.baseUrl).replace(/\/+$/, '')
        : `http://${item.address}${port === 80 ? '' : `:${port}`}`;
      if (seen.has(baseUrl)) continue;
      seen.add(baseUrl);
      candidates.push({ ...item, port, baseUrl });
    }
  }
  if (candidates.length === 0) return null;

  // Ports and addresses are independent candidates. Resolve as soon as the
  // first valid camera status arrives, so a dead :5000 never delays a healthy
  // :80 and one stale configured IP cannot consume the browser's whole
  // discovery timeout. Slow probes finish harmlessly in the background.
  return new Promise(resolve => {
    let unresolved = candidates.length;
    let settled = false;
    let reachableButRecovering = null;
    for (const candidate of candidates) {
      probeAcadcamCandidate(candidate).then(result => {
        unresolved--;
        if (result?.cameraInitialized && result?.frameAvailable && !settled) {
          settled = true;
          resolve(result);
        } else if (result && !reachableButRecovering) {
          reachableButRecovering = result;
        } else if (unresolved === 0 && !settled) {
          settled = true;
          resolve(reachableButRecovering);
        }
      }).catch(error => {
        unresolved--;
        console.warn(`[CAMERA] Probe failed unexpectedly: ${error.message}`);
        if (unresolved === 0 && !settled) {
          settled = true;
          resolve(reachableButRecovering);
        }
      });
    }
  });
}

async function discoverAcadcam() {
  const hostnames = ['acadacam.local', 'acadacam', 'acadcam.local', 'acadcam'];
  const configuredAddresses = String(process.env.ACADCAM_IPS || '192.168.254.104')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => /^192\.168\.254\.\d{1,3}$/.test(address));
  const configuredCandidates = configuredAddresses.map((address) => ({
    hostname: 'acadacam',
    address
  }));

  for (const configuredUrl of [process.env.ACADCAM_URL, PI_CAMERA_URL]) {
    if (!configuredUrl) continue;
    try {
      const parsed = new URL(configuredUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      configuredCandidates.unshift({
        hostname: parsed.hostname,
        address: parsed.hostname,
        port: Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80)),
        baseUrl: `${parsed.protocol}//${parsed.host}`,
      });
    } catch (error) {
      console.warn(`[CAMERA] Ignoring invalid configured camera URL: ${error.message}`);
    }
  }
  if (lastKnownCamera?.address) configuredCandidates.unshift(lastKnownCamera);

  const resolvedPromise = Promise.all(hostnames.map(async hostname => {
    try {
      const resolved = await dns.lookup(hostname, { all: true, family: 4 });
      return resolved.map(entry => ({ hostname, address: entry.address }));
    } catch (error) {
      console.warn(`[CAMERA] Could not resolve ${hostname}: ${error.message}`);
      return [];
    }
  })).then(groups => probeAcadcamAddresses(groups.flat()));
  const configuredPromise = probeAcadcamAddresses(configuredCandidates);
  // Do not let a quickly responding but frame-less configured host mask a
  // healthy camera discovered through mDNS. Return a healthy group as soon as
  // it responds; retain a recovering service only as the bounded fallback.
  const camera = await firstHealthyCameraOrFallback(
    [configuredPromise, resolvedPromise],
    CAMERA_DISCOVERY_TIMEOUT_MS
  );
  if (camera) lastKnownCamera = camera;
  return camera;
}

app.get('/api/camera/discover', authenticateToken, async (req, res) => {
  try {
    const camera = await discoverAcadcam();
    if (!camera) {
      return res.status(404).json({
        success: false,
        message: 'acadacam was not found. Confirm that the camera and AcadCheck computer are connected to the 192.168.254.x network.'
      });
    }
    res.json({
      success: true,
      message: `acadacam detected at ${camera.address}`,
      hostname: camera.hostname,
      ipAddress: camera.address,
      port: camera.port,
      cameraUrl: camera.cameraUrl,
      cameraInitialized: camera.cameraInitialized,
      frameAvailable: camera.frameAvailable,
      frameAgeSeconds: camera.frameAgeSeconds,
      deviceOpened: camera.deviceOpened,
      recoveryInProgress: camera.recoveryInProgress,
      recoveryCount: camera.recoveryCount,
      lastError: camera.lastError,
      hint: camera.hint,
      resolution: camera.resolution,
      frameCount: camera.frameCount,
      probeAttempts: camera.probeAttempts,
      retryAfterMs: camera.cameraInitialized && camera.frameAvailable ? 0 : 1000,
    });
  } catch (error) {
    console.error('[CAMERA] Discovery failed:', error);
    res.status(500).json({ success: false, message: 'Camera discovery failed', error: error.message });
  }
});

// Admin middleware - requires admin role
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, message: 'Access denied. Admin only.' });
  }
  next();
};

// Multer config for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads/scans');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'scan-' + uniqueSuffix + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|bmp|tiff|tif/;
    const extname = allowed.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowed.test(file.mimetype || '');
    if (!extname || !mimetype) {
      console.warn('Multer rejected file:', {
        originalname: file.originalname,
        mimetype: file.mimetype,
        extname: path.extname(file.originalname).toLowerCase(),
      });
    }
    cb(null, extname && mimetype);
  }
});

// MySQL connection
const SERVER_UNIT_TEST = process.env.ACADCHECK_SERVER_UNIT_TEST === '1';
if (!SERVER_UNIT_TEST) console.log('Initializing database connection...');
const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'acadcheck_db',
  port: process.env.DB_PORT || 3306,
  multipleStatements: true,
  dateStrings: true
};
const unavailableTestDatabase = {
  promise() {
    throw new Error('Database access is unavailable in scanner unit-test mode');
  },
};
const db = SERVER_UNIT_TEST ? unavailableTestDatabase : mysql.createConnection(DB_CONFIG);
// Result persistence and scan claiming must never share the long-lived
// connection with unrelated requests while a transaction is open.
const transactionPool = SERVER_UNIT_TEST
  ? unavailableTestDatabase
  : mysql.createPool({
      ...DB_CONFIG,
      multipleStatements: false,
      connectionLimit: Number.parseInt(process.env.DB_TRANSACTION_POOL_SIZE, 10) || 4,
      waitForConnections: true,
      queueLimit: 0,
    });

if (!SERVER_UNIT_TEST) db.connect((err) => {
  if (err) {
    console.error('❌ Database connection failed:', err);
    console.error('\n📋 Troubleshooting Steps:');
    console.error('1. Check MySQL service is running:');
    console.error('   Windows: Get-Service -Name *mysql*');
    console.error('   Linux/Mac: sudo systemctl status mysql');
    console.error('2. Verify credentials in backend/.env:');
    console.error('   DB_HOST=localhost');
    console.error('   DB_USER=root');
    console.error('   DB_PASSWORD= (empty or your password)');
    console.error('   DB_NAME=acadcheck_db');
    console.error('3. Test connection manually:');
    console.error('   mysql -u root -p -e "USE acadcheck_db; SHOW TABLES;"');
    console.error('4. Check if database exists:');
    console.error('   mysql -u root -p -e "SHOW DATABASES;"');
    process.exit(1);
  }
  console.log('✅ Connected to MySQL database "acadcheck_db" on localhost:3306');
  runMigrations()
    .then(() => {
      console.log('✅ Database migrations completed');
      return initOnnxService();
    })
    .then(() => {
      startServer();
    })
    .catch(err => {
      console.error('❌ Migration failed:', err);
      process.exit(1);
    });
});

async function initOnnxService() {
  try {
    const modelsDir = process.env.ONNX_MODELS_DIR || path.join(__dirname, 'models');
    const initialized = await OnnxService.init(modelsDir);
    console.log(`ONNX service initialized. Available models: ${initialized ? OnnxService.getLoadedModels().join(', ') : 'none (classical CV mode)'}`);
  } catch (err) {
    console.warn('ONNX service initialization failed, continuing with classical CV:', err.message);
  }
  try {
    const warmup = await prewarmAdaptiveWorker();
    console.log(
      `Fast OMR worker prewarmed${warmup.processed ? ` in ${warmup.processingMs.toFixed(1)} ms` : ''}.`
    );
  } catch (err) {
    console.warn('Fast OMR warmup failed; the first scan will initialize it lazily:', err.message);
  }
}

async function resolveAnswerKeyQr(imageBuffer, userId) {
  const qrResult = await QrCodeDetector.detectQrCode(imageBuffer);
  const parsed = QrCodeDetector.parseAnswerKeyQr(qrResult?.payload);
  if (!parsed) return { qrResult, answerKey: null };

  const [rows] = await db.promise().query(
    `SELECT ak.id, ak.answer_key_json, ak.num_questions, ak.classroom_id, ak.exam_title,
            c.name AS classroom_name, c.section AS classroom_section
     FROM answer_keys ak
     LEFT JOIN classrooms c ON c.id = ak.classroom_id
     WHERE ak.id = ? AND ak.qr_token = ? AND ak.user_id = ? AND ak.is_active = TRUE
     LIMIT 1`,
    [parsed.answerKeyId, parsed.qrToken, userId]
  );
  const answerKey = rows[0] || null;
  if (answerKey && parsed.numQuestions && (
    Number(answerKey.num_questions) !== parsed.numQuestions
    || !/^[A-D]{50}$/.test(String(answerKey.answer_key_json || '').replace(/\s/g, ''))
  )) {
    return {
      qrResult: { ...qrResult, reason: 'QR layout does not match the stored answer key' },
      answerKey: null,
    };
  }
  return { qrResult, answerKey };
}

// ============================================================================
// IMAGE PROCESSING FUNCTIONS
// ============================================================================

// Use enhanced preprocessing from enhanced-scanner module
const preprocessImage = EnhancedScanner.advancedPreprocessImage;

function attachOmrDiagnosticManifest(result, diagnosticKey, ownerId) {
  const artifactNames = (
    Array.isArray(result?.details?.diagnosticArtifacts)
      ? result.details.diagnosticArtifacts
      : []
  ).filter(isSafeDiagnosticArtifactName);
  const diagnosticArtifacts = artifactNames.map(
    name => `/api/omr/diagnostics/${diagnosticKey}/artifacts/${encodeURIComponent(name)}`
  );
  let diagnosticPath = null;
  if (artifactNames.length > 0) {
    try {
      updateOmrDiagnosticMetadata(diagnosticKey, ownerId, artifactNames);
      diagnosticPath = `/api/omr/diagnostics/${diagnosticKey}`;
    } catch (error) {
      console.warn('[FAST-OMR] Could not finalize protected diagnostic metadata:', error.message);
    }
  }
  result.details = {
    ...(result.details || {}),
    diagnosticPath,
    diagnosticArtifacts,
  };
  return result;
}

function omrStructuredSignals(result) {
  const details = result?.details && typeof result.details === 'object'
    ? result.details
    : (result && typeof result === 'object' ? result : {});
  return {
    sheetPresence: typeof details.sheetPresence === 'string'
      ? details.sheetPresence
      : undefined,
    answerContentDetected: (
      typeof details.answerContentDetected === 'boolean'
      || details.answerContentDetected === null
    )
      ? details.answerContentDetected
      : undefined,
    presenceConfidence: details.presenceConfidence !== undefined
      && details.presenceConfidence !== null
      && Number.isFinite(Number(details.presenceConfidence))
      ? Number(details.presenceConfidence)
      : undefined,
    registrationConfidence: details.registrationConfidence !== undefined
      && details.registrationConfidence !== null
      && Number.isFinite(Number(details.registrationConfidence))
      ? Number(details.registrationConfidence)
      : undefined,
    requiredRegistrationConfidence: details.requiredRegistrationConfidence !== undefined
      && details.requiredRegistrationConfidence !== null
      && Number.isFinite(Number(details.requiredRegistrationConfidence))
      ? Number(details.requiredRegistrationConfidence)
      : undefined,
    templateAlignmentError: details.templateAlignmentError !== undefined
      && details.templateAlignmentError !== null
      && Number.isFinite(Number(details.templateAlignmentError))
      ? Number(details.templateAlignmentError)
      : undefined,
    bubbleLocalizationConfidence: details.bubbleLocalizationConfidence !== undefined
      && details.bubbleLocalizationConfidence !== null
      && Number.isFinite(Number(details.bubbleLocalizationConfidence))
      ? Number(details.bubbleLocalizationConfidence)
      : undefined,
    registrationAttempts: Array.isArray(details.registrationAttempts)
      ? details.registrationAttempts
      : [],
    registrationMetrics: details.registrationMetrics
      && typeof details.registrationMetrics === 'object'
      && !Array.isArray(details.registrationMetrics)
      ? details.registrationMetrics
      : {},
    qualityMetrics: details.qualityMetrics
      && typeof details.qualityMetrics === 'object'
      && !Array.isArray(details.qualityMetrics)
      ? details.qualityMetrics
      : {},
    timingMetrics: details.timingMetrics
      && typeof details.timingMetrics === 'object'
      && !Array.isArray(details.timingMetrics)
      ? details.timingMetrics
      : {},
    sheetFingerprint: normalizedSheetFingerprint(details.sheetFingerprint),
    sheetFingerprintVersion: Number.isFinite(Number(details.sheetFingerprintVersion))
      ? Number(details.sheetFingerprintVersion)
      : null,
    duplicateSheet: details.duplicateSheet === true,
    removalRequired: details.removalRequired === true,
    sheetIdentityChanged: details.sheetIdentityChanged === true,
  };
}

// Use enhanced bubble detection from enhanced-scanner module
  async function detectBubbles(imageBuffer, answerKey, scanFilename, context = {}) {
    console.log(`[DETECT-BUBBLES] Called with answerKey length=${(answerKey || '').length}`);

    const numQuestions = (answerKey || '').replace(/\s/g, '').length;
    let rectifiedBuffer = context.rectifiedBuffer || imageBuffer;
    if (!context.rectifiedBuffer && numQuestions !== 50) {
      try {
        const rectified = await rectifyExamSheet(imageBuffer);
        rectifiedBuffer = rectified.buffer;
      } catch (e) {
        console.warn('Rectification skipped for detectBubbles:', e.message);
      }
    }
    let processedBuffer = rectifiedBuffer;

    async function detectHorizontalGaps(imageBuffer, width, height, top, bottom) {
      const raw = await sharp(imageBuffer).greyscale().raw().toBuffer();
      const threshold = 100;
      const minDarkRun = Math.max(20, Math.floor(width * 0.03));
      const minLightRun = Math.max(40, Math.floor(width * 0.08));
      const mergeDarkThreshold = Math.max(30, Math.floor(width * 0.04));
      const numSamples = 5;
      const sampleYs = [];
      for (let i = 0; i < numSamples; i++) {
        const y = Math.floor(top + (bottom - top) * (i + 1) / (numSamples + 1));
        sampleYs.push(y);
      }

      let allRuns = [];
      for (const sampleY of sampleYs) {
        let runs = [];
        let curVal = raw[sampleY * width] > threshold ? 'light' : 'dark';
        let runStart = 0;

        for (let x = 1; x < width; x++) {
          const val = raw[sampleY * width + x] > threshold ? 'light' : 'dark';
          if (val !== curVal) {
            runs.push({ type: curVal, start: runStart, end: x, width: x - runStart });
            curVal = val;
            runStart = x;
          }
        }
        runs.push({ type: curVal, start: runStart, end: width, width: width - runStart });
        allRuns.push(...runs);
      }

      const mergedRuns = [];
      let i = 0;
      while (i < allRuns.length) {
        if (allRuns[i].type === 'light') {
          let lightStart = allRuns[i].start;
          let lightEnd = allRuns[i].end;
          let j = i + 1;
          while (j < allRuns.length && allRuns[j].type === 'dark' && allRuns[j].width <= mergeDarkThreshold) {
            lightEnd = allRuns[j + 1] ? allRuns[j + 1].end : lightEnd;
            j += 2;
          }
          mergedRuns.push({ type: 'light', start: lightStart, end: lightEnd, width: lightEnd - lightStart });
          i = j;
        } else {
          mergedRuns.push(allRuns[i]);
          i++;
        }
      }

      const lightGaps = mergedRuns.filter(r => r.type === 'light' && r.width >= minLightRun);
      const darkBlocks = mergedRuns.filter(r => r.type === 'dark' && r.width >= minDarkRun);

      return { lightGaps, darkBlocks, runs: mergedRuns };
    }

    async function inferColumnBlockLayout(imgBuffer, numQuestions, width, height) {
      const aspectRatio = width && height ? width / height : 1.3;
      if (numQuestions <= 25) return { questionsPerBlock: numQuestions, blocksPerRow: 1 };

      let blocksPerRow = 1;
      let questionsPerBlock = numQuestions;

      if (numQuestions <= 50) {
        blocksPerRow = 2;
        questionsPerBlock = 25;
      } else if (numQuestions <= 75) {
        blocksPerRow = 3;
        questionsPerBlock = 25;
      } else if (numQuestions <= 100) {
        blocksPerRow = 4;
        questionsPerBlock = 25;
      } else {
        blocksPerRow = Math.ceil(numQuestions / 25);
        questionsPerBlock = 25;
      }

      if (imgBuffer && numQuestions === 50) {
        try {
          const { lightGaps, darkBlocks } = await detectHorizontalGaps(imgBuffer, width, height, 0, height);
          const largeGaps = lightGaps.filter(g => g.width > width * 0.20);
          if (largeGaps.length > 0 && darkBlocks.length >= 2 && darkBlocks.length <= 3) {
            const inferredCols = darkBlocks.length;
            const qPerBlock = Math.ceil(numQuestions / inferredCols);
            blocksPerRow = inferredCols;
            questionsPerBlock = qPerBlock;
            console.log(`[LAYOUT-GAP] Detected ${largeGaps.length} large gap(s), ${darkBlocks.length} dark block(s). Adjusted to ${blocksPerRow}x${questionsPerBlock}`);
          }
        } catch (e) {
          console.warn('Gap detection failed:', e.message);
        }
      }

      return { questionsPerBlock: questionsPerBlock, blocksPerRow };
    }

    // The original camera frame preserves the paper edges and printed-ring
    // evidence used to establish A-D identity. Rectification/normalization can
    // change that evidence enough to relabel an otherwise correct column, so
    // a verified raw-frame result is authoritative.
    const trustedFormSources = [
      'fast-hybrid-grid',
      'verified-grid',
      'adaptive-solid-mark-grid',
      'adaptive-ring-grid',
      'adaptive-multi-mark-grid',
      'adaptive-partial-mark-grid',
      'form-solid-marks'
    ];

    // The normalized page is both smaller and geometrically stable, so run
    // the OpenCV locator there before attempting a 4K camera frame. This
    // prevents a slow raw-frame pass from consuming the live-scan timeout.
    if (numQuestions === 50) {
      const fastFormOptions = {
        blocksPerRow: 2,
        questionsPerBlock: 25,
        numChoices: 4,
        formLayout: 'acadcheck-50',
        contentFirst: true,
        fastMode: true,
        trustedOnly: true,
        rectify: false,
        qrAnchorCorners: context.qrAnchorCorners,
        geometryTolerances: {
          // Safe runtime overrides can be supplied here or by a future
          // per-template configuration without changing the detector.
          minimumGeometryConfidence: Number(
            process.env.OMR_GEOMETRY_CONFIDENCE || 42
          ),
        },
      };
      let diagnosticKey = null;
      let diagnosticDir = null;
      if (context.forceDiagnostics === true && scanFilename) {
        const diagnosticSession = createOmrDiagnosticSession(context.userId);
        diagnosticKey = diagnosticSession.diagnosticKey;
        diagnosticDir = diagnosticSession.diagnosticDir;
      }
      let formOnlyResult = await EnhancedScanner.hybridDetectAnswers(
        rectifiedBuffer,
        answerKey,
        numQuestions,
        diagnosticDir
          ? {
              ...fastFormOptions,
              includeDiagnostics: true,
              debugDir: diagnosticDir,
            }
          : fastFormOptions
      );
      const isTrustedRectified = trustedFormSources.includes(formOnlyResult?.details?.source);
      if (isTrustedRectified && !diagnosticDir) {
        console.log('[DETECT-BUBBLES] Using normalized-form OMR.');
      } else if (!diagnosticDir && scanFilename) {
        // Re-run only a rejected final scan with diagnostics enabled. Live and
        // successful scans keep the fast path free of image-writing overhead.
        const diagnosticSession = createOmrDiagnosticSession(context.userId);
        diagnosticKey = diagnosticSession.diagnosticKey;
        diagnosticDir = diagnosticSession.diagnosticDir;
        formOnlyResult = await EnhancedScanner.hybridDetectAnswers(
          rectifiedBuffer,
          answerKey,
          numQuestions,
          {
            ...fastFormOptions,
            includeDiagnostics: true,
            debugDir: diagnosticDir,
          }
        );
      }
      if (diagnosticDir && diagnosticKey) {
        formOnlyResult = attachOmrDiagnosticManifest(
          formOnlyResult,
          diagnosticKey,
          context.userId
        );
      }
      // The fast worker owns page localization and perspective correction.
      // Rejections may make one explicit diagnostic pass, but never fall
      // through to a second legacy geometry detector.
      return formOnlyResult;
    }

    // Legacy/non-versioned layouts still use the older preprocessing path.
    // The canonical 50x4 form above returns before this extra full-image copy.
    const imgForBrightness = sharp(rectifiedBuffer);
    const brightnessMeta = await imgForBrightness.metadata();
    let highContrast = false;
    if (brightnessMeta.width && brightnessMeta.height) {
      try {
        const rawForBrightness = await imgForBrightness.greyscale().raw().toBuffer();
        let sum = 0;
        for (let i = 0; i < rawForBrightness.length; i++) sum += rawForBrightness[i];
        const avgBrightness = sum / rawForBrightness.length;
        highContrast = avgBrightness < 100;
      } catch (e) {
        console.warn('Brightness detection failed:', e.message);
      }
    }
    processedBuffer = await preprocessImage(rectifiedBuffer, { rectify: false, highContrast });
    const rawImg = sharp(processedBuffer);
    const rawMetadata = await rawImg.metadata();
    const primaryLayout = await inferColumnBlockLayout(processedBuffer, numQuestions, rawMetadata.width, rawMetadata.height);

    if (numQuestions === 50) {
      const fixed = await EnhancedScanner.hybridDetectAnswers(processedBuffer, answerKey, numQuestions, {
        blocksPerRow: 2,
        questionsPerBlock: 25,
        numChoices: 4,
        formLayout: 'acadcheck-50',
        fastMode: true,
        rectify: false,
        calibrationFilename: scanFilename,
      });
      if (fixed && fixed.detectedAnswers && fixed.detectedAnswers.length > 0) {
        console.log(`[DETECT-BUBBLES] Skipped layout search for 50-question acadcheck-50 form, using 2x25`);
        return fixed;
      }
    }

    const triedLayouts = new Set();
    
    async function tryLayout(l) {
      const key = JSON.stringify(l);
      if (triedLayouts.has(key)) return null;
      triedLayouts.add(key);
      try {
        const result = await EnhancedScanner.hybridDetectAnswers(processedBuffer, answerKey, numQuestions, {
          ...l,
          rectify: false,
          numChoices: 4,
          fastMode: true,
        });
        if (result && result.detectedAnswers && result.detectedAnswers.length > 0) {
          const valid = result.detectedAnswers.filter(a => a && ['A','B','C','D'].includes(a)).length;
          console.log(`[TRY-LAYOUT] ${l.blocksPerRow}x${l.questionsPerBlock}: valid=${valid}/${result.detectedAnswers.length} conf=${(result.details?.averageConfidence || 0).toFixed(1)} metric=${result.details?.selectedMetric || 'unknown'}`);
          return result;
        }
      } catch (err) {
        console.warn('Layout detection failed:', key, err.message);
      }
      return null;
    }

    const candidates = new Map();
    const primary = await tryLayout(primaryLayout);
    if (primary) candidates.set(JSON.stringify(primaryLayout), primary);

    const fallbackLayouts = [
      { questionsPerBlock: 25, blocksPerRow: 2 },
      { questionsPerBlock: 50, blocksPerRow: 1 },
      { questionsPerBlock: 2, blocksPerRow: 25 },
    ];
    if (numQuestions === 50) {
      fallbackLayouts.push({ questionsPerBlock: 5, blocksPerRow: 10 });
      fallbackLayouts.push({ questionsPerBlock: 50, blocksPerRow: 1 });
    }
    if (numQuestions === 50 || numQuestions === 100) {
      fallbackLayouts.push({ questionsPerBlock: 25, blocksPerRow: 2 });
    }
    for (const fallback of fallbackLayouts) {
      const result = await tryLayout(fallback);
      if (result) candidates.set(JSON.stringify(fallback), result);
    }

    let bestResult = null;
    let bestScore = -1;
    const cleanKey = (answerKey || '').replace(/\s/g, '');
    for (const result of candidates.values()) {
      const answers = (result.detectedAnswers || []).filter(a => a && ['A','B','C','D'].includes(a));
      const validCount = answers.length;
      const avgConf = result.details?.averageConfidence || 0;
      const uniqueLetters = new Set(answers).size;
      const varietyBonus = Math.min(50, uniqueLetters * 5);
      const keyLetters = new Set(cleanKey.split(''));
      const isUniformKey = cleanKey.length > 10 && keyLetters.size === 1;
      const sameLetterPenalty = (validCount > 10 && uniqueLetters === 1 && !isUniformKey) ? -100 : 0;

      let keyMatchCount = 0;
      if (cleanKey.length > 0) {
        for (let i = 0; i < Math.min(answers.length, cleanKey.length); i++) {
          if (answers[i] === cleanKey[i]) keyMatchCount++;
        }
      }
      const keyMatchRatio = cleanKey.length > 0 ? keyMatchCount / cleanKey.length : 0;
      const coverageRatio = cleanKey.length > 0 ? validCount / cleanKey.length : 0;

      // Choose geometry without looking at whether the answers happen to
      // match the key. Using keyMatchRatio here can select the layout that
      // awards the highest score rather than the layout supported by the
      // current sheet. Key similarity remains log-only diagnostics.
      const uniformDetection = uniqueLetters === 1 && validCount > 10;
      const reliableUniform = uniformDetection && isUniformKey && avgConf >= 90;
      const uniformPenalty = uniformDetection && !reliableUniform ? -100 : 0;
      const emptyCount = Math.max(0, numQuestions - validCount);
      const emptyPenalty = emptyCount > 5 ? emptyCount * 2 : 0;
      const score = validCount * 10
        + avgConf * 2
        + coverageRatio * 50
        + varietyBonus
        + uniformPenalty
        - emptyPenalty
        + sameLetterPenalty;

      console.log(`[DETECT-BUBBLES] Layout ${result.details?.selectedMetric || 'unknown'}: valid=${validCount}/50 unique=${uniqueLetters} conf=${avgConf.toFixed(1)} keyMatch=${(keyMatchRatio*100).toFixed(0)}% score=${score.toFixed(1)}`);

      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
      }
    }

    if (bestResult) {
      const bestAnswers = (bestResult.detectedAnswers || []).filter(a => a && ['A','B','C','D'].includes(a));
      const bestUnique = new Set(bestAnswers).size;
      console.log(`[DETECT-BUBBLES] SELECTED: valid=${bestAnswers.length}/50 unique=${bestUnique} conf=${(bestResult.details?.averageConfidence || 0).toFixed(1)} metric=${bestResult.details?.selectedMetric || 'unknown'}`);
    }

    return bestResult;
  }

// Use enhanced student info extraction from enhanced-scanner module
const extractStudentInfo = EnhancedScanner.enhancedExtractStudentInfo;

const MAX_GRADING_PERCENTAGE = 40;
const PASSING_GRADING_PERCENTAGE = 20;

function calculateGradingPercentage(correctCount, totalQuestions = 50) {
  if (!Number.isFinite(Number(correctCount)) || !Number.isFinite(Number(totalQuestions)) || Number(totalQuestions) <= 0) {
    return 0;
  }
  // Linear 40% grading contribution: every correct answer receives the same
  // weight. On a 50-item exam each answer is worth 0.8 percentage points.
  const percentage = (Number(correctCount) / Number(totalQuestions)) * MAX_GRADING_PERCENTAGE;
  return parseFloat(Math.max(0, Math.min(MAX_GRADING_PERCENTAGE, percentage)).toFixed(2));
}

function gradeExam(detectedAnswers, answerKeyArray, markedLetters) {
  const results = [];
  let correctCount = 0;
  let blankCount = 0;
  let multiMarkCount = 0;
  const totalQuestions = answerKeyArray.length;
  for (let i = 0; i < totalQuestions; i++) {
    const detected = (detectedAnswers[i] || '').trim().toUpperCase();
    const correct = (answerKeyArray[i] || '').trim().toUpperCase();
    const qMarked = Array.isArray(markedLetters) && markedLetters[i]
      ? markedLetters[i]
      : (detected ? [detected] : []);
    const isMultiMark = qMarked.length > 1;
    const isBlank = !isMultiMark && detected === '';
    const isCorrect = !isMultiMark && !isBlank && detected === correct;
    if (isCorrect) correctCount++;
    if (isBlank) blankCount++;
    if (isMultiMark) multiMarkCount++;
    results.push({
      questionNumber: i + 1,
      detectedAnswer: isMultiMark ? '' : detected,
      correctAnswer: correct,
      isCorrect: isCorrect,
      score: isCorrect ? 1 : 0,
      isBlank,
      responseStatus: isMultiMark ? 'multiple' : (isBlank ? 'blank' : (isCorrect ? 'correct' : 'incorrect')),
      markedLetters: qMarked
    });
  }
  const percentage = calculateGradingPercentage(correctCount, totalQuestions);
  return {
    results,
    totalScore: correctCount,
    totalQuestions,
    blankCount,
    multiMarkCount,
    incorrectCount: totalQuestions - correctCount,
    percentage
  };
}

async function logLoginAttempt(userId, username, ip, userAgent, success, failureReason) {
  await db.promise().query(
    `CREATE TABLE IF NOT EXISTS login_attempts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      username VARCHAR(255) NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      success BOOLEAN NOT NULL,
      failure_reason VARCHAR(255),
      attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_username (username),
      INDEX idx_attempted_at (attempted_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
  await db.promise().query(
    `INSERT INTO login_attempts (user_id, username, ip_address, user_agent, success, failure_reason)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, username, ip || null, userAgent || null, success, failureReason]
  );
}

// ============================================================================
// AUTH ROUTES
// ============================================================================

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, message: 'Username and password are required' });
    }
    const [users] = await db.promise().query(
      'SELECT * FROM users WHERE username = ? AND is_active = TRUE',
      [username]
    );
    if (users.length === 0) {
      await logLoginAttempt(null, username, req.ip, req.get('User-Agent'), false, 'Invalid username');
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    const user = users[0];
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      await logLoginAttempt(user.id, username, req.ip, req.get('User-Agent'), false, 'Invalid password');
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    await logLoginAttempt(user.id, username, req.ip, req.get('User-Agent'), true, null);
    const token = jwt.sign(
      { userId: user.id, username: user.username, role: user.role || 'teacher' },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );
    const { password_hash, ...userData } = user;
    res.json({ success: true, message: 'Login successful', user: { ...userData, role: user.role || 'teacher' }, token });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { first_name, last_name, email, phone, username, password, role } = req.body;
    if (!first_name || !last_name || !email || !username || !password) {
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    const validRoles = ['admin', 'teacher', 'staff'];
    const userRole = validRoles.includes(role) ? role : 'teacher';
    const [existingUsers] = await db.promise().query(
      'SELECT id FROM users WHERE username = ? OR email = ?',
      [username, email]
    );
    if (existingUsers.length > 0) {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const [result] = await db.promise().query(
      'INSERT INTO users (first_name, last_name, email, phone, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [first_name, last_name, email, phone || null, username, passwordHash, userRole]
    );
    res.status(201).json({ success: true, message: 'User registered successfully', userId: result.insertId });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================================
// SCAN/OMR ROUTES
// ============================================================================

/**
 * Fast answer-key lookup. This only decodes the QR and intentionally skips
 * page rectification and bubble analysis so a visible code responds quickly.
 */
app.post('/api/omr/detect-answer-key-qr', authenticateToken, async (req, res) => {
  try {
    const { imageBuffer: base64Image } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, message: 'imageBuffer (base64) is required' });
    }
    const qrMatch = await resolveAnswerKeyQr(Buffer.from(base64Image, 'base64'), req.user.userId);
    if (!qrMatch.answerKey) {
      return res.json({
        success: true,
        detected: false,
        message: qrMatch.qrResult?.detected
          ? 'This QR code is not a valid answer key for your account'
          : 'No answer-key QR code is visible'
      });
    }
    res.json({
      success: true,
      detected: true,
      answerKeyId: qrMatch.answerKey.id,
      examTitle: qrMatch.answerKey.exam_title,
      classroomId: qrMatch.answerKey.classroom_id,
      classroomName: qrMatch.answerKey.classroom_name,
      classroomSection: qrMatch.answerKey.classroom_section,
      sequence: qrMatch.qrResult?.sequence || null,
      sequenceConfidence: qrMatch.qrResult?.sequenceConfidence || 0
    });
  } catch (error) {
    console.error('Answer-key QR detection error:', error);
    res.status(500).json({ success: false, detected: false, message: 'Failed to read answer-key QR code' });
  }
});

/**
 * Real-time OMR Detection Endpoint
 * POST /api/omr/detect-frame
 * Body: {
 *   imageBuffer (base64), answerKeyId or answerKey (string),
 *   trackingSessionId?, frameId?
 * }
 * Returns: { detectedAnswers, confidenceScores, details }
 */
app.post('/api/omr/detect-frame', authenticateToken, async (req, res) => {
  const detectionStarted = process.hrtime.bigint();
  try {
    const {
      imageBuffer: base64Image,
      answerKeyId,
      answerKey,
      answerKeyDate,
      numChoices,
      trackingSessionId,
      frameId,
      requireQrAnchor = false,
      previewOnly = false
    } = req.body;

    if (!base64Image) {
      return res.status(400).json({ success: false, message: 'imageBuffer (base64) is required' });
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');
    const validTrackingToken = (value, maxLength) => {
      if (typeof value !== 'string') return undefined;
      const token = value.trim();
      return token.length > 0
        && token.length <= maxLength
        && /^[a-zA-Z0-9._:-]+$/.test(token)
        ? token
        : undefined;
    };
    const clientTrackingSessionId = validTrackingToken(trackingSessionId, 128);
    const trackingFrameId = validTrackingToken(frameId, 96);
    // Scope client-generated session IDs to the authenticated account so a
    // future worker-side tracking cache cannot be shared across users.
    const workerTrackingSessionId = clientTrackingSessionId
      ? `user-${req.user.userId}:session-${
          crypto.createHash('sha256')
            .update(clientTrackingSessionId, 'utf8')
            .digest('hex')
            .slice(0, 32)
        }`
      : undefined;

    // The scanner page already supplies its bounded q92 grayscale preview.
    // Preserve those exact bytes for QR anchoring, registration, fingerprint,
    // and finalization. A second JPEG encode added latency and could only
    // discard mark/feature detail without changing the coordinate system.
    const livePreviewBuffer = imageBuffer;

    let answerKeyString = answerKey;
    let resolvedAnswerKeyId = answerKeyId || null;
    let resolvedClassroomId = null;
    let detectedQrPayload = null;
    let detectedSequenceFromFallback = null;
    let detectedSequenceConfidence = 0;
    let qrAnchorCorners = null;

    // Resolve an explicitly selected key before doing any image work. The
    // scanner UI normally sends answerKeyId; looking it up here avoids an
    // unnecessary QR pass and legacy page rectification on every live frame.
    if (answerKeyId) {
      const [rows] = await db.promise().query(
        'SELECT answer_key_json, classroom_id FROM answer_keys WHERE id = ? AND user_id = ? AND is_active = TRUE',
        [answerKeyId, req.user.userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Answer key not found' });
      }
      // The database value is authoritative even if a stale client also sent
      // an answer string. This binds live detection and its finalize token to
      // one active answer-key record.
      answerKeyString = rows[0].answer_key_json;
      resolvedAnswerKeyId = Number(answerKeyId);
      resolvedClassroomId = rows[0].classroom_id || null;
    }

    // Decode the identity before the page-quality gate. This lets the UI
    // recognize a newly presented sheet as soon as its QR is visible, while
    // still requiring the complete page before grading bubbles.
    if (!answerKeyString) {
      const qrMatch = await resolveAnswerKeyQr(livePreviewBuffer, req.user.userId);
      detectedQrPayload = qrMatch.qrResult?.payload || null;
      if (Array.isArray(qrMatch.qrResult?.sourceCorners)
        && qrMatch.qrResult.sourceCorners.length === 4) {
        qrAnchorCorners = qrMatch.qrResult.sourceCorners;
      }
      if (qrMatch.answerKey) {
        answerKeyString = qrMatch.answerKey.answer_key_json;
        resolvedAnswerKeyId = qrMatch.answerKey.id;
        resolvedClassroomId = qrMatch.answerKey.classroom_id || null;
        detectedSequenceFromFallback = qrMatch.qrResult?.sequence || detectedSequenceFromFallback;
        detectedSequenceConfidence = qrMatch.qrResult?.sequenceConfidence || detectedSequenceConfidence;
        console.log(`[QR] Live frame matched answer key ${resolvedAnswerKeyId}.`);
      }
    }

    let rectifiedBuffer = imageBuffer;
    let placement = null;
    const canonicalFastForm = String(answerKeyString || '').replace(/\s/g, '').length === 50;
    // A manually selected key previously skipped QR work entirely. That is
    // normally desirable, but the photographed AcadCheck form relies on its
    // QR position to make the *first* registration robust. The client asks
    // for this only until the worker has stored a verified temporal transform.
    // The decoded payload must agree with the already-authorized key; QR data
    // is used solely as current-frame geometry, never as an authorization
    // override in this branch.
    if (
      canonicalFastForm
      && previewOnly === true
      && requireQrAnchor === true
      && !qrAnchorCorners
    ) {
      const qrResult = await QrCodeDetector.detectQrCode(livePreviewBuffer);
      const parsedQr = QrCodeDetector.parseAnswerKeyQr(qrResult?.payload);
      detectedQrPayload = qrResult?.payload || detectedQrPayload;
      if (
        parsedQr
        && Number(parsedQr.answerKeyId) === Number(resolvedAnswerKeyId)
        && Array.isArray(qrResult?.sourceCorners)
        && qrResult.sourceCorners.length === 4
      ) {
        qrAnchorCorners = qrResult.sourceCorners;
        detectedSequenceFromFallback = qrResult?.sequence
          || detectedSequenceFromFallback;
        detectedSequenceConfidence = Number(
          qrResult?.sequenceConfidence || detectedSequenceConfidence || 0
        );
        console.log(`[QR] Live frame anchor verified for answer key ${resolvedAnswerKeyId}.`);
      }
    }
    if (!canonicalFastForm) {
      try {
        const rectified = await rectifyExamSheet(imageBuffer);
        rectifiedBuffer = rectified.buffer;
        placement = rectified.placement || null;
      } catch (e) {
        console.warn('Rectification skipped for detect-frame:', e.message);
      }
    }

    // A shifted/partial page must never be interpreted with a fixed bubble
    // grid. Report the placement problem to live auto-scan instead of grading
    // a geometrically unreliable frame.
    if (!canonicalFastForm && (!placement || !placement.acceptable)) {
      return res.json({
        success: true,
        detectedAnswers: [],
        confidenceScores: [],
        markedLetters: [],
        averageConfidence: 0,
        answerKeyId: resolvedAnswerKeyId,
        qrDetected: !!detectedQrPayload,
        qrPayload: detectedQrPayload,
        placement: placement || { detected: false, acceptable: false, confidence: 0, reason: 'Answer sheet boundary not found' },
        qualityGate: { recommendation: 'reject', confidence: 0, filledCount: 0, totalCount: 0, fillRatio: 0, reason: placement?.reason || 'Center the answer sheet inside the camera frame' }
      });
    }

    if (!answerKeyString) {
      const qrMatch = await resolveAnswerKeyQr(rectifiedBuffer, req.user.userId);
      detectedQrPayload = qrMatch.qrResult?.payload || null;
      if (Array.isArray(qrMatch.qrResult?.sourceCorners)
        && qrMatch.qrResult.sourceCorners.length === 4) {
        qrAnchorCorners = qrMatch.qrResult.sourceCorners;
      }
      if (qrMatch.answerKey) {
        answerKeyString = qrMatch.answerKey.answer_key_json;
        resolvedAnswerKeyId = qrMatch.answerKey.id;
        resolvedClassroomId = qrMatch.answerKey.classroom_id || null;
        detectedSequenceFromFallback = qrMatch.qrResult?.sequence || detectedSequenceFromFallback;
        detectedSequenceConfidence = qrMatch.qrResult?.sequenceConfidence || detectedSequenceConfidence;
        console.log(`[QR] Live frame matched answer key ${resolvedAnswerKeyId}.`);
      }
    }
    if (!answerKeyString) {
      return res.json({
        success: true,
        detectedAnswers: [],
        confidenceScores: [],
        markedLetters: [],
        averageConfidence: 0,
        answerKeyId: null,
        qrDetected: !!detectedQrPayload,
        qrPayload: detectedQrPayload,
        placement,
        details: {
          source: 'answer-key-qr-required',
          currentSheetGeometry: false,
          geometryEvidenceUnreliable: true
        },
        qualityGate: {
          recommendation: 'reject',
          confidence: 0,
          filledCount: 0,
          totalCount: 50,
          fillRatio: 0,
          reason: 'Select an answer key or show its complete AcadCheck QR code'
        }
      });
    }

    const trustedLiveSources = new Set([
      'fast-hybrid-grid',
      'verified-grid',
      'adaptive-solid-mark-grid',
      'adaptive-ring-grid',
      'adaptive-multi-mark-grid',
      'adaptive-partial-mark-grid'
    ]);
    const diagnosticLiveSources = new Set([
      'adaptive-multiple-marks',
      'adaptive-ring-diagnostic'
    ]);
    const isTrustedLiveResult = result => trustedLiveSources.has(result?.details?.source);
    const isDiagnosticLiveResult = result => diagnosticLiveSources.has(result?.details?.source)
      && result?.details?.geometryEvidenceUnreliable !== true;

    // Browser canvas JPEGs below q92 can destabilize feature descriptors for
    // the small printed form. The tested q92 preview is used directly for live
    // canonical OMR and is also the exact frame persisted after acceptance.
    const liveOmrBuffer = canonicalFastForm && previewOnly === true
      ? livePreviewBuffer
      : imageBuffer;

    // Live frames can place the sheet anywhere in the camera view. Read the
    // normalized canonical preview first, then retry against the detected
    // paper crop when raw-frame perspective/background prevents row-grid
    // verification. Previously rectifiedBuffer was calculated above but never
    // used for live OMR, which made Auto Scan fail while saved scans succeeded.
    const detectLiveOmr = async (key, extraOptions = {}) => {
      const cleanKey = (key || '').replace(/\s/g, '');
      // A client-side reset is helpful but not a trust boundary. Binding the
      // worker cache key to the selected form contents prevents optical-flow
      // state from one answer key being reused after a stale/racing UI update.
      const templateIdentity = crypto.createHash('sha256')
        .update(`acadcheck-50:${cleanKey}`, 'utf8')
        .digest('hex')
        .slice(0, 24);
      const options = {
        ...extraOptions,
        numChoices: 4,
        formLayout: cleanKey.length === 50 ? 'acadcheck-50' : undefined,
        contentFirst: cleanKey.length === 50,
        fastMode: true,
        trustedOnly: cleanKey.length === 50,
        trackingSessionId: workerTrackingSessionId
          ? `${workerTrackingSessionId}:template-${templateIdentity}`
          : undefined,
        frameId: trackingFrameId,
        qrAnchorCorners,
      };
      let normalizedResult = null;
      if (rectifiedBuffer !== imageBuffer) {
        normalizedResult = await EnhancedScanner.hybridDetectAnswers(
          rectifiedBuffer, key, cleanKey.length, options
        );
      }

      if (isTrustedLiveResult(normalizedResult)) {
        console.log(`[AUTO-SCAN] Using normalized-sheet ${normalizedResult.details.source} before raw-frame fallback.`);
        return normalizedResult;
      }

      // The isolated paper is the only frame with usable form geometry. A
      // raw 4K retry mainly analyzes the desk/background and is the source of
      // the repeated live locator timeouts.
      if (rectifiedBuffer !== imageBuffer) return normalizedResult;

      const rawResult = await EnhancedScanner.hybridDetectAnswers(
        liveOmrBuffer, key, cleanKey.length, options
      );
      if (cleanKey.length !== 50 || isTrustedLiveResult(rawResult)) return rawResult;

      if (isDiagnosticLiveResult(normalizedResult)) return normalizedResult;
      if (isDiagnosticLiveResult(rawResult)) return rawResult;
      // No old scan/template fallback: the live decision must be supported by
      // the current raw frame or its current rectified paper crop.
      // Prefer the normalized rejection because it describes the isolated
      // sheet rather than background objects in the full camera frame.
      return normalizedResult || rawResult;
    };

    // OMR does not depend on OCR/Pi output when the caller already supplied
    // an answer key. Start the geometry reader immediately so live preview
    // latency is bounded by one form read rather than form read + Pi roundtrip.
    const initialAnswerKey = answerKeyString || answerKey || '';
    const liveOmrPromise = initialAnswerKey
      ? detectLiveOmr(initialAnswerKey)
      : null;
    // A selected answer key lets the local current-sheet reader start
    // immediately. Waiting for a Raspberry Pi/OCR round trip here added
    // latency to every live camera frame without improving OMR accuracy.
    // Live grading never falls back to the weaker Pi proportional-grid/OCR
    // path. If QR identity is not visible yet, ask for another frame instead
    // of waiting up to 45 seconds and risking an unverified grade.
    const piResult = null;
    if (piResult && piResult.success) {
      if (!resolvedAnswerKeyId) {
        const normalizedSeq = (piResult.sequence || '').match(/^(\d{2})-(\d{2})-(\d{4})/);
        if (normalizedSeq) {
          const detectedDate = `${normalizedSeq[3]}-${normalizedSeq[2]}-${normalizedSeq[1]}`;
          const [keyRows] = await db.promise().query(
            'SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND answer_key_date = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
            [req.user.userId, detectedDate]
          );
          if (keyRows.length > 0) {
            answerKeyString = keyRows[0].answer_key_json;
            resolvedAnswerKeyId = keyRows[0].id;
          }
        }
      }

      if (!resolvedAnswerKeyId && answerKeyDate) {
        const normalizeDate = (val) => {
          if (!val) return null;
          const parts = String(val).trim().split('-');
          if (parts.length === 3) {
            const [a, b, c] = parts;
            if (a.length === 4) return `${a}-${b}-${c}`;
            return `${c}-${b}-${a}`;
          }
          return null;
        };
        const formattedDate = normalizeDate(answerKeyDate);
        if (formattedDate) {
          const [keyRows] = await db.promise().query(
            'SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND answer_key_date = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
            [req.user.userId, formattedDate]
          );
          if (keyRows.length > 0) {
            answerKeyString = keyRows[0].answer_key_json;
            resolvedAnswerKeyId = keyRows[0].id;
          }
        }
      }

      if (!answerKeyString && answerKeyId) {
        const [rows] = await db.promise().query(
          'SELECT answer_key_json FROM answer_keys WHERE id = ? AND user_id = ? AND is_active = TRUE',
          [answerKeyId, req.user.userId]
        );
        if (rows.length > 0) {
          answerKeyString = rows[0].answer_key_json;
        }
      }

      if (!answerKeyString) {
        return res.status(400).json({ success: false, message: 'answerKey, answerKeyId or answerKeyDate is required' });
      }

      const imgForBrightness = sharp(imageBuffer);
      const brightnessMeta = await imgForBrightness.metadata();
      let highContrast = false;
      if (brightnessMeta.width && brightnessMeta.height) {
        try {
          const rawForBrightness = await imgForBrightness.greyscale().raw().toBuffer();
          let sum = 0;
          for (let i = 0; i < rawForBrightness.length; i++) sum += rawForBrightness[i];
          const avgBrightness = sum / rawForBrightness.length;
          highContrast = avgBrightness < 100;
          if (highContrast) {
            console.log(`Dark image detected (avg brightness=${avgBrightness.toFixed(1)}), applying high-contrast preprocessing`);
          }
        } catch (e) {
          console.warn('Brightness detection failed:', e.message);
        }
      }

      // Preserve paper-edge geometry for the adaptive reader. Client/server
      // preprocessing and rectification can change lane identity even when
      // the untouched camera frame is readable.
      const omrResult = liveOmrPromise && answerKeyString === initialAnswerKey
        ? await liveOmrPromise
        : await detectLiveOmr(answerKeyString, {
          ...(piResult.columnBlockLayout || {}),
        });
      placement = omrResult?.details?.placement || placement;

      let epochResult = { epoch: null, confidence: 0 };
      try {
        const ocrBuffer = await preprocessImage(rectifiedBuffer, { rectify: false });
        epochResult = await EnhancedScanner.detectEpoch(ocrBuffer);
      } catch (e) {
        console.warn('Epoch detection in detect-frame failed:', e.message);
      }

      const detectedAnswers = omrResult.detectedAnswers || [];
      const confidenceScores = omrResult.confidenceScores || [];
      const rawAvgConfidence = parseFloat(omrResult.details.averageConfidence);
      const filledCount = (detectedAnswers || []).filter((a) => a && String(a).trim() !== '').length;
      const totalCount = detectedAnswers.length || (answerKeyString || '').replace(/\s/g, '').length;
      const fillRatio = totalCount > 0 ? filledCount / totalCount : 0;
      const avgConfidence = Number.isFinite(rawAvgConfidence) ? rawAvgConfidence : (Array.isArray(confidenceScores) && confidenceScores.length ? Number((confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length).toFixed(2)) : 0);
      const ambiguousRows = (omrResult.markedLetters || []).filter(row => Array.isArray(row) && row.length > 1).length;
      const uncertainRows = Number(omrResult?.details?.uncertainRows || 0);

      const multiMarkRead = omrResult?.details?.source === 'adaptive-multi-mark-grid'
        && detectedAnswers.length === 50
        && (omrResult.markedLetters || []).length === 50
        && ambiguousRows > 0;
      const partialMarkRead = omrResult?.details?.source === 'adaptive-partial-mark-grid'
        && detectedAnswers.length === 50
        && (omrResult.markedLetters || []).length === 50;
      const trustedGeometry = new Set([
        'fast-hybrid-grid',
        'verified-grid',
        'adaptive-solid-mark-grid',
        'adaptive-ring-grid',
        'adaptive-multi-mark-grid',
        'adaptive-partial-mark-grid'
      ]).has(omrResult?.details?.source)
        && omrResult?.details?.geometryEvidenceUnreliable !== true;
      const answerRows = Array.isArray(omrResult.markedLetters) ? omrResult.markedLetters : [];
      const completeRowMap = detectedAnswers.length === 50 && answerRows.length === 50;
      const blankRows = answerRows.filter(row => Array.isArray(row) && row.length === 0).length;
      const minimumConfidence = 70;
      let qualityGate = { recommendation: 'accept', confidence: avgConfidence, filledCount, totalCount, fillRatio, reason: 'No answers detected' };
      if (!trustedGeometry) {
        qualityGate.reason = omrResult?.details?.rejectionReason || 'Waiting for a stable 50-row answer-sheet read';
        qualityGate.recommendation = 'reject';
      } else if (!completeRowMap) {
        qualityGate.reason = 'Waiting for all 50 answer-row positions';
        qualityGate.recommendation = 'watch';
      } else if (uncertainRows > 0) {
        qualityGate.reason = `${uncertainRows} answer row${uncertainRows === 1 ? '' : 's'} could not be resolved safely`;
        qualityGate.recommendation = 'reject';
      } else if (avgConfidence < minimumConfidence) {
        qualityGate.reason = 'Low confidence';
        qualityGate.recommendation = 'reject';
      } else {
        const zeroPointRows = blankRows + ambiguousRows;
        qualityGate.reason = zeroPointRows > 0
          ? `Ready; ${blankRows} blank and ${ambiguousRows} multi-mark row${zeroPointRows === 1 ? '' : 's'} will score zero`
          : 'Ready';
        qualityGate.recommendation = 'accept';
      }

      res.json({
        success: true,
        ...omrStructuredSignals(omrResult),
        detectedAnswers,
        confidenceScores,
        markedLetters: omrResult.markedLetters || [],
        averageConfidence: Number.isFinite(avgConfidence) ? avgConfidence : 0,
        epoch: epochResult.epoch,
        epochConfidence: epochResult.epochConfidence || 0,
        answerKeyId: resolvedAnswerKeyId,
        qrDetected: !!detectedQrPayload,
        qrPayload: detectedQrPayload,
        sequence: piResult.sequence || null,
        sequenceConfidence: piResult.sequenceConfidence || 0,
        details: omrResult.details,
        placement,
        qualityGate
      });
      return;
    }

    // Get answer key
    if (!answerKeyString) {
      const normalizeDate = (val) => {
        if (!val) return null;
        const parts = String(val).trim().split('-');
        if (parts.length === 3) {
          const [a, b, c] = parts;
          if (a.length === 4) return `${a}-${b}-${c}`;
          return `${c}-${b}-${a}`;
        }
        return null;
      };

      if (answerKeyDate) {
        const formattedDate = normalizeDate(answerKeyDate);
        if (formattedDate) {
          const [rows] = await db.promise().query(
            'SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND answer_key_date = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
            [req.user.userId, formattedDate]
          );
          if (rows.length > 0) {
            answerKeyString = rows[0].answer_key_json;
            resolvedAnswerKeyId = rows[0].id;
          }
        }
      }

      if (!answerKeyString) {
        const seqResponse = await SequenceDetector.detectSequenceFromBottom(rectifiedBuffer, {
          bottomRegionHeight: 0.18,
          cropLeft: 0.08,
          cropRight: 0.92
        });
        if (seqResponse && seqResponse.sequence) {
          detectedSequenceFromFallback = seqResponse.sequence;
          detectedSequenceConfidence = seqResponse.confidence || 0;
          const seqDateMatch = seqResponse.sequence.match(/^(\d{2})-(\d{2})-(\d{4})/);
          if (seqDateMatch) {
            const detectedDate = `${seqDateMatch[3]}-${seqDateMatch[2]}-${seqDateMatch[1]}`;
            const [keyRows] = await db.promise().query(
              'SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND answer_key_date = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
              [req.user.userId, detectedDate]
            );
            if (keyRows.length > 0) {
              answerKeyString = keyRows[0].answer_key_json;
              resolvedAnswerKeyId = keyRows[0].id;
            }
          }
        }
      }

      if (!resolvedAnswerKeyId && answerKeyId) {
        const [rows] = await db.promise().query(
          'SELECT answer_key_json FROM answer_keys WHERE id = ? AND user_id = ? AND is_active = TRUE',
          [answerKeyId, req.user.userId]
        );
        if (rows.length === 0) {
          return res.status(404).json({ success: false, message: 'Answer key not found' });
        }
        answerKeyString = rows[0].answer_key_json;
      }
     }

    if (!answerKeyString) {
      return res.status(400).json({ success: false, message: 'answerKey, answerKeyId or answerKeyDate is required' });
    }

      const processedBuffer = imageBuffer;
      const cleanKey = answerKeyString.replace(/\s/g, '');
     const numQuestions = cleanKey.length;
     const inferredNumChoices = 4;

      const columnBlockLayout = await (async () => {
        if (numQuestions <= 25) return null;
        if (numQuestions <= 50) {
          return { questionsPerBlock: 25, blocksPerRow: 2 };
        }
        if (numQuestions <= 75) {
          const img = sharp(processedBuffer);
          const meta = await img.metadata();
          const aspectRatio = (meta.width || 1) / (meta.height || 1);
          if (aspectRatio > 1.0) {
            return { questionsPerBlock: 15, blocksPerRow: 5 };
          }
          return { questionsPerBlock: 25, blocksPerRow: 3 };
        }
        if (numQuestions <= 100) {
          const img = sharp(processedBuffer);
          const meta = await img.metadata();
          const aspectRatio = (meta.width || 1) / (meta.height || 1);
          if (aspectRatio > 1.0) {
            return { questionsPerBlock: 20, blocksPerRow: 5 };
          }
          return { questionsPerBlock: 25, blocksPerRow: 4 };
        }
        const img = sharp(processedBuffer);
        const meta = await img.metadata();
        const aspectRatio = (meta.width || 1) / (meta.height || 1);
        const blocksPerRow = aspectRatio > 1.0 ? 5 : 4;
        return { questionsPerBlock: 25, blocksPerRow };
      })();

      // `liveOmrPromise` was started before the optional Pi lookup. Reuse it
      // when its answer key is still current. Starting a second Python OMR
      // process here made both processes contend for CPU and reliably hit the
      // adaptive timeout on the production server.
      const omrResult = liveOmrPromise && answerKeyString === initialAnswerKey
        ? await liveOmrPromise
        : await detectLiveOmr(answerKeyString, {
            ...columnBlockLayout,
          });
      placement = omrResult?.details?.placement || placement;

     let epochResult = { epoch: null, confidence: 0 };
     if (!previewOnly) {
       try {
         epochResult = await EnhancedScanner.detectEpoch(processedBuffer);
       } catch (e) {
         console.warn('Epoch detection in detect-frame failed:', e.message);
       }
     }

    const detectedAnswers = omrResult.detectedAnswers || [];
    const confidenceScores = omrResult.confidenceScores || [];
    const rawAvgConfidence = parseFloat(omrResult.details.averageConfidence);
    const filledCount = (detectedAnswers || []).filter((a) => a && String(a).trim() !== '').length;
    const totalCount = detectedAnswers.length || (answerKeyString || '').replace(/\s/g, '').length;
    const fillRatio = totalCount > 0 ? filledCount / totalCount : 0;
    const avgConfidence = Number.isFinite(rawAvgConfidence) ? rawAvgConfidence : (Array.isArray(confidenceScores) && confidenceScores.length ? Number((confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length).toFixed(2)) : 0);
    const ambiguousRows = (omrResult.markedLetters || []).filter(row => Array.isArray(row) && row.length > 1).length;
    const uncertainRows = Number(omrResult?.details?.uncertainRows || 0);

    const multiMarkRead = omrResult?.details?.source === 'adaptive-multi-mark-grid'
      && detectedAnswers.length === 50
      && (omrResult.markedLetters || []).length === 50
      && ambiguousRows > 0;
    const partialMarkRead = omrResult?.details?.source === 'adaptive-partial-mark-grid'
      && detectedAnswers.length === 50
      && (omrResult.markedLetters || []).length === 50;
    const trustedGeometry = new Set([
      'fast-hybrid-grid',
      'verified-grid',
      'adaptive-solid-mark-grid',
      'adaptive-ring-grid',
      'adaptive-multi-mark-grid',
      'adaptive-partial-mark-grid'
    ]).has(omrResult?.details?.source)
      && omrResult?.details?.geometryEvidenceUnreliable !== true;
    const answerRows = Array.isArray(omrResult.markedLetters) ? omrResult.markedLetters : [];
    const completeRowMap = detectedAnswers.length === 50 && answerRows.length === 50;
    const blankRows = answerRows.filter(row => Array.isArray(row) && row.length === 0).length;
    const workerQualityMetrics = omrResult?.details?.qualityMetrics
      && typeof omrResult.details.qualityMetrics === 'object'
      ? omrResult.details.qualityMetrics
      : {};
    const workerQualityScore = Number(
      workerQualityMetrics.overall
      ?? workerQualityMetrics.overallScore
      ?? workerQualityMetrics.score
    );
    const weakestQualityComponent = Object.entries({
      lighting: workerQualityMetrics.lighting,
      contrast: workerQualityMetrics.contrast,
      focus: workerQualityMetrics.sharpness,
      perspective: workerQualityMetrics.perspective,
      geometry: workerQualityMetrics.geometry,
      registration: workerQualityMetrics.registration,
      'bubble localization': workerQualityMetrics.bubbleLocalization,
    })
      .filter(([, value]) => Number.isFinite(Number(value)))
      .sort((left, right) => Number(left[1]) - Number(right[1]))[0];
    const minimumConfidence = 70;
    let qualityGate = {
      recommendation: 'accept',
      confidence: avgConfidence,
      qualityScore: Number.isFinite(workerQualityScore) ? workerQualityScore : null,
      filledCount,
      totalCount,
      fillRatio,
      reason: 'No answers detected',
    };
    if (!trustedGeometry) {
      qualityGate.reason = omrResult?.details?.rejectionReason || 'Waiting for a stable 50-row answer-sheet read';
      qualityGate.recommendation = 'reject';
    } else if (!completeRowMap) {
      qualityGate.reason = 'Waiting for all 50 answer-row positions';
      qualityGate.recommendation = 'watch';
    } else if (uncertainRows > 0) {
      qualityGate.reason = `${uncertainRows} answer row${uncertainRows === 1 ? '' : 's'} could not be resolved safely`;
      qualityGate.recommendation = 'reject';
    } else if (workerQualityMetrics.gradeable === false) {
      qualityGate.reason = workerQualityMetrics.reason
        || workerQualityMetrics.limitingFactor
        || 'Image quality is not sufficient for a reliable grade';
      qualityGate.recommendation = 'reject';
    } else if (Number.isFinite(workerQualityScore) && workerQualityScore < OMR_MINIMUM_QUALITY) {
      qualityGate.reason = weakestQualityComponent
        ? `Image quality is too low (${weakestQualityComponent[0]} ${Number(weakestQualityComponent[1]).toFixed(1)}%)`
        : `Image quality ${workerQualityScore.toFixed(1)}% is below the ${OMR_MINIMUM_QUALITY}% threshold`;
      qualityGate.recommendation = 'reject';
    } else if (avgConfidence < minimumConfidence) {
      qualityGate.reason = 'Low confidence';
      qualityGate.recommendation = 'reject';
    } else {
      const zeroPointRows = blankRows + ambiguousRows;
      qualityGate.reason = zeroPointRows > 0
        ? `Ready; ${blankRows} blank and ${ambiguousRows} multi-mark row${zeroPointRows === 1 ? '' : 's'} will score zero`
        : 'Ready';
      qualityGate.recommendation = 'accept';
    }

    // Count distinct image evidence, not merely client frame counters. A
    // replayed/cached JPEG with a new frameId must not satisfy the two-frame
    // sheet-removal or replacement requirement.
    const liveObservationId = `sha256:${
      crypto.createHash('sha256').update(imageBuffer).digest('hex')
    }`;
    const liveSheetState = observeLiveSheet(
      req.user.userId,
      omrResult,
      liveObservationId
    );
    omrResult.details = {
      ...(omrResult.details || {}),
      ...liveSheetState,
    };
    if (liveSheetState.removalRequired) {
      qualityGate.recommendation = 'watch';
      qualityGate.reason = liveSheetState.reason
        || 'Remove the previously graded sheet before scanning another one';
    }

    const detectionToken = qualityGate.recommendation === 'accept'
      && resolvedAnswerKeyId
      ? cacheLiveDetection({
          userId: req.user.userId,
          imageBuffer,
          answerKeyId: resolvedAnswerKeyId,
          answerKeyString,
          classroomId: resolvedClassroomId,
          omrResult,
          sequence: detectedSequenceFromFallback || null,
          sequenceConfidence: detectedSequenceConfidence || 0,
          qrPayload: detectedQrPayload,
          trackingSessionId: clientTrackingSessionId || null,
          frameId: trackingFrameId || null,
        })
      : null;

    const processingTimings = omrProcessingTimings(
      omrResult?.details,
      elapsedMs(detectionStarted)
    );
    setServerTiming(res, processingTimings);
    res.json({
      success: true,
      ...omrStructuredSignals(omrResult),
      detectedAnswers,
      confidenceScores,
      markedLetters: omrResult.markedLetters || [],
      averageConfidence: Number.isFinite(avgConfidence) ? avgConfidence : 0,
      epoch: epochResult.epoch,
      epochConfidence: epochResult.epochConfidence || 0,
      answerKeyId: resolvedAnswerKeyId,
      classroomId: resolvedClassroomId,
      qrDetected: !!detectedQrPayload,
      qrPayload: detectedQrPayload,
      sequence: detectedSequenceFromFallback || null,
      sequenceConfidence: detectedSequenceConfidence || 0,
      detectionToken,
      detectionExpiresInMs: detectionToken ? LIVE_DETECTION_TTL_MS : 0,
      processingTimings,
      details: omrResult.details,
      placement,
      qualityGate
    });
  } catch (error) {
    console.error('OMR detection error:', error);
    res.status(500).json({ success: false, message: 'OMR detection failed', error: error.message });
  }
});

/**
 * Persist a recently accepted live frame without running OMR a second time.
 * The opaque token is owner-bound, single-use, short-lived, and points to the
 * exact image bytes that produced the cached result.
 */
app.post('/api/omr/finalize-detection', authenticateToken, async (req, res) => {
  const routeStarted = process.hrtime.bigint();
  const timings = {};
  let imagePath = null;
  let connection = null;
  let transactionCommitted = false;
  let finalizationClaimKey = null;
  let finalizationClaimed = false;
  try {
    const entry = consumeLiveDetection(req.body?.detectionToken, req.user.userId);
    if (!entry) {
      return res.status(410).json({
        success: false,
        message: 'This live detection expired or was already finalized. Capture the sheet again.'
      });
    }
    finalizationClaimKey = liveSheetUserKey(req.user.userId);
    if (activeLiveFinalizations.has(finalizationClaimKey)) {
      return res.status(409).json({
        success: false,
        retrySafe: false,
        duplicateSheet: true,
        removalRequired: true,
        message: 'A live sheet is already being finalized. Wait for that result instead of rescanning.',
      });
    }
    if (liveEntryMatchesFinalizedSheet(req.user.userId, entry)) {
      return res.status(409).json({
        success: false,
        retrySafe: false,
        duplicateSheet: true,
        removalRequired: true,
        message: 'This physical sheet was already finalized. Remove it before scanning the next one.',
      });
    }
    activeLiveFinalizations.add(finalizationClaimKey);
    finalizationClaimed = true;
    const acceptedTiming = omrProcessingTimings(
      entry.omrResult?.details,
      Number(entry.omrResult?.details?.totalBridgeMs ?? entry.omrResult?.details?.bridgeMs ?? 0)
    );
    timings.detectionOmr = Number(acceptedTiming.omr || 0);
    timings.detectionBridge = Number(acceptedTiming.omrBridge || 0);
    timings.detectionTransport = Number(acceptedTiming.omrTransport || 0);
    let studentId = Number(req.body?.studentId || 0);
    const requestedClassroomId = Number(req.body?.classroomId || 0) || null;

    const validationStarted = process.hrtime.bigint();
    // Live detection already verified any visible QR before issuing this
    // owner-bound token. Reuse that verified identity so finalization does
    // only indexed database validation and persistence.
    const [keyRows] = await db.promise().query(
      `SELECT id, answer_key_json, classroom_id, exam_title, subject, answer_key_date, epoch
       FROM answer_keys
       WHERE id = ? AND user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [entry.answerKeyId, req.user.userId]
    );
    const answerKeyRecord = keyRows[0];
    if (!answerKeyRecord) {
      return res.status(422).json({ success: false, message: 'The selected answer key is no longer active.' });
    }
    if (answerKeyRecord.answer_key_json.replace(/\s/g, '') !== entry.answerKeyString.replace(/\s/g, '')) {
      return res.status(409).json({
        success: false,
        message: 'The answer key changed after detection. Scan the current sheet again.'
      });
    }
    const authoritativeClassroomId = answerKeyRecord.classroom_id || entry.classroomId || requestedClassroomId;
    let student = null;
    if (Number.isInteger(studentId) && studentId > 0) {
      const [studentRows] = await db.promise().query(
        `SELECT id, classroom_id, student_number, first_name, last_name, sequential_number
         FROM students
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [studentId, req.user.userId]
      );
      student = studentRows[0] || null;
      if (!student) {
        return res.status(422).json({ success: false, message: 'The selected student is unavailable.' });
      }
    } else {
      // The UI normally resolves the handwritten sequence while previewing.
      // If a tracked frame omitted it, recover it from the exact accepted
      // image rather than uploading and re-registering a different frame.
      let detectedSequence = String(entry.sequence || '').trim();
      if (!/^\d{1,4}$/.test(detectedSequence)) {
        const qrMatch = await resolveAnswerKeyQr(entry.imageBuffer, req.user.userId);
        if (qrMatch.answerKey && Number(qrMatch.answerKey.id) === Number(entry.answerKeyId)) {
          detectedSequence = String(qrMatch.qrResult?.sequence || '').trim();
          entry.sequence = detectedSequence || null;
          entry.sequenceConfidence = Number(qrMatch.qrResult?.sequenceConfidence || 0);
        }
      }

      const sequenceCandidates = [];
      if (/^\d{1,4}$/.test(detectedSequence)) {
        sequenceCandidates.push(Number.parseInt(detectedSequence, 10));
        // A shaded first digit can occasionally turn 0003 into 6003. Only
        // consider the zero-padded suffix form and still require a unique
        // match inside the answer key's classroom.
        if (/^[1-9]00\d$/.test(detectedSequence)) {
          sequenceCandidates.push(Number.parseInt(detectedSequence.slice(1), 10));
        }
      }
      const validCandidates = [...new Set(sequenceCandidates.filter(value => Number.isInteger(value) && value > 0))];
      if (validCandidates.length > 0) {
        const classroomSql = authoritativeClassroomId ? ' AND classroom_id = ?' : '';
        const placeholders = validCandidates.map(() => '?').join(', ');
        const params = [req.user.userId, ...validCandidates];
        if (authoritativeClassroomId) params.push(Number(authoritativeClassroomId));
        const [studentRows] = await db.promise().query(
          `SELECT id, classroom_id, student_number, first_name, last_name, sequential_number
           FROM students
           WHERE user_id = ? AND sequential_number IN (${placeholders})
             AND deleted_at IS NULL${classroomSql}
           ORDER BY FIELD(sequential_number, ${placeholders})
           LIMIT 2`,
          [...params, ...validCandidates]
        );
        if (studentRows.length === 1) {
          student = studentRows[0];
          studentId = Number(student.id);
        }
      }
      if (!student) {
        return res.status(422).json({
          success: false,
          retrySafe: false,
          message: 'Could not uniquely match the handwritten sequence to a student. Select the student, then scan again.'
        });
      }
    }
    if (
      (requestedClassroomId && authoritativeClassroomId && requestedClassroomId !== Number(authoritativeClassroomId))
      || (authoritativeClassroomId && Number(student.classroom_id) !== Number(authoritativeClassroomId))
    ) {
      return res.status(422).json({
        success: false,
        message: 'The selected student, classroom, and answer key do not match.'
      });
    }
    const imageSha256 = crypto.createHash('sha256').update(entry.imageBuffer).digest('hex');
    if (imageSha256 !== entry.imageSha256) {
      throw new Error('The accepted live frame failed its integrity check.');
    }
    timings.validation = elapsedMs(validationStarted);

    const answerKeyArray = answerKeyRecord.answer_key_json.replace(/\s/g, '').split('');
    const detectedAnswers = entry.omrResult.detectedAnswers || [];
    const markedLetters = entry.omrResult.markedLetters || [];
    if (answerKeyArray.length !== 50 || detectedAnswers.length !== 50 || markedLetters.length !== 50) {
      return res.status(422).json({
        success: false,
        message: 'The accepted frame no longer has a complete 50-row result.'
      });
    }
    const gradingResult = gradeExam(detectedAnswers, answerKeyArray, markedLetters);
    const uniqueDetected = new Set(detectedAnswers.filter(answer => ['A', 'B', 'C', 'D'].includes(answer)));
    const uniformDetection = detectedAnswers.length > 10 && uniqueDetected.size === 1;
    const distribution = EnhancedScanner.countAnswerDistribution(detectedAnswers, markedLetters);

    const fileStarted = process.hrtime.bigint();
    const uploadDir = path.resolve(__dirname, '../uploads/scans');
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const filename = `scan-live-${Date.now()}-${crypto.randomInt(100000000, 1000000000)}.jpg`;
    imagePath = path.resolve(uploadDir, filename);
    if (path.dirname(imagePath) !== uploadDir) throw new Error('Invalid live scan output path');
    await fs.promises.writeFile(imagePath, entry.imageBuffer, { flag: 'wx' });
    timings.fileWrite = elapsedMs(fileStarted);

    const persistenceStarted = process.hrtime.bigint();
    connection = await transactionPool.promise().getConnection();
    await connection.beginTransaction();
    const [scanInsert] = await connection.query(
      `INSERT INTO scanned_tests
         (user_id, filename, file_path, image_sha256, file_size, mime_type,
          classroom_id, answer_key_id, scan_status, created_by, student_id,
          sequence_detected, sequential_number_detected, ocr_confidence,
          processed_at, processing_started_at, scanner_version,
          suspicious_uniform_detection)
       VALUES (?, ?, ?, ?, ?, 'image/jpeg', ?, ?, 'processing', ?, ?, ?, ?, 0,
               NULL, NOW(), ?, ?)`,
      [req.user.userId, filename, imagePath, imageSha256, entry.imageBuffer.length,
       authoritativeClassroomId || student.classroom_id || null, entry.answerKeyId,
       req.user.userId, studentId, entry.sequence || null,
       student.sequential_number || null, SCANNER_PIPELINE_VERSION,
       uniformDetection ? 1 : 0]
    );
    const scanId = scanInsert.insertId;
    const [attemptInsert] = await connection.query(
      `INSERT INTO scan_processing_attempts
         (user_id, scanned_test_id, image_sha256, scanner_version, status)
       VALUES (?, ?, ?, ?, 'processing')`,
      [req.user.userId, scanId, imageSha256, SCANNER_PIPELINE_VERSION]
    );
    const attemptId = attemptInsert.insertId;

    const omrRows = gradingResult.results.map((result, index) => [
      req.user.userId,
      scanId,
      attemptId,
      result.questionNumber,
      result.detectedAnswer,
      result.correctAnswer,
      result.isCorrect,
      entry.omrResult.confidenceScores?.[index] ?? 95,
      result.markedLetters?.length ? JSON.stringify(result.markedLetters) : null,
    ]);
    const omrPlaceholders = omrRows
      .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, JSON_ARRAY()))')
      .join(', ');
    await connection.query(
      `INSERT INTO omr_results
         (user_id, scanned_test_id, processing_attempt_id, question_number,
          detected_answer, correct_answer, is_correct, confidence, marked_letters)
       VALUES ${omrPlaceholders}`,
      omrRows.flat()
    );

    await connection.query(
      `INSERT INTO ocr_extractions
         (user_id, scanned_test_id, processing_attempt_id, field_name, extracted_value, confidence, raw_ocr_text)
       VALUES (?, ?, ?, 'student_number', NULL, 0, NULL),
              (?, ?, ?, 'student_name', NULL, 0, NULL),
              (?, ?, ?, 'epoch', NULL, 0, NULL),
              (?, ?, ?, 'sequence', ?, ?, NULL)`,
      [req.user.userId, scanId, attemptId,
       req.user.userId, scanId, attemptId,
       req.user.userId, scanId, attemptId,
       req.user.userId, scanId, attemptId, entry.sequence || null, entry.sequenceConfidence || 0]
    );

    const answersJson = JSON.stringify(
      gradingResult.results.reduce((values, result) => {
        values[result.questionNumber] = result.detectedAnswer;
        return values;
      }, {})
    );
    const scoreJson = JSON.stringify(
      gradingResult.results.reduce((values, result) => {
        values[result.questionNumber] = result.score;
        return values;
      }, {})
    );
    const [responseInsert] = await connection.query(
      `INSERT INTO exam_responses
         (user_id, student_id, scanned_test_id, processing_attempt_id, answer_key_id,
          answers_json, score_per_question_json, total_score, percentage,
          is_graded, graded_by, graded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW())`,
      [req.user.userId, studentId, scanId, attemptId, entry.answerKeyId,
       answersJson, scoreJson, gradingResult.totalScore, gradingResult.percentage,
       req.user.userId]
    );
    timings.persistence = elapsedMs(persistenceStarted);
    timings.omrReused = 0;
    timings.total = elapsedMs(routeStarted);
    const persistedProcessingMetrics = {
      ...timings,
      omrStages: entry.omrResult?.details?.stagesMs || {},
      omrTimingMetrics: entry.omrResult?.details?.timingMetrics || {},
      qualityMetrics: entry.omrResult?.details?.qualityMetrics || {},
    };
    await connection.query(
      `UPDATE scanned_tests
       SET scan_status = 'completed', processed_at = NOW(), error_message = NULL,
           processing_duration_ms = ?, current_processing_attempt_id = ?
       WHERE id = ? AND user_id = ?`,
      [Math.round(timings.total), attemptId, scanId, req.user.userId]
    );
    await connection.query(
      `UPDATE scan_processing_attempts
       SET status = 'completed', timings_json = ?, completed_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [JSON.stringify(persistedProcessingMetrics), attemptId, req.user.userId]
    );
    await connection.commit();
    transactionCommitted = true;
    markLiveSheetFinalized(req.user.userId, entry);
    invalidateLiveDetectionsForUser(req.user.userId);
    connection.release();
    connection = null;

    const sanitizedOmr = gradingResult.results.map((result, index) => ({
      scanned_test_id: scanId,
      processing_attempt_id: attemptId,
      question_number: result.questionNumber,
      detected_answer: result.detectedAnswer,
      is_correct: result.isCorrect,
      confidence: entry.omrResult.confidenceScores?.[index] ?? 95,
      marked_letters: result.markedLetters || [],
    }));
    const examResponse = {
      id: responseInsert.insertId,
      user_id: req.user.userId,
      student_id: studentId,
      scanned_test_id: scanId,
      processing_attempt_id: attemptId,
      answer_key_id: entry.answerKeyId,
      answers_json: answersJson,
      score_per_question_json: scoreJson,
      total_score: gradingResult.totalScore,
      percentage: gradingResult.percentage,
      is_graded: true,
    };
    const fullScan = {
      id: scanId,
      user_id: req.user.userId,
      filename,
      file_path: imagePath,
      image_sha256: imageSha256,
      file_size: entry.imageBuffer.length,
      mime_type: 'image/jpeg',
      classroom_id: authoritativeClassroomId || student.classroom_id || null,
      answer_key_id: entry.answerKeyId,
      student_id: studentId,
      scan_status: 'completed',
      scanner_version: SCANNER_PIPELINE_VERSION,
      processing_duration_ms: Math.round(timings.total),
      current_processing_attempt_id: attemptId,
      sequence_detected: entry.sequence || null,
      sequential_number_detected: student.sequential_number || null,
      exam_title: answerKeyRecord.exam_title,
      subject: answerKeyRecord.subject,
      answer_key_date: answerKeyRecord.answer_key_date,
      epoch: answerKeyRecord.epoch,
      student_full_name: `${student.first_name} ${student.last_name}`.trim(),
      sequential_number: student.sequential_number,
      qr_detected: !!entry.qrPayload,
      omrResults: sanitizedOmr,
      ocrExtractions: [],
      examResponse,
      omrAnalysis: omrStructuredSignals(entry.omrResult),
      answerDistribution: {
        counts: distribution.counts,
        totalAnswered: distribution.totalAnswered,
        totalQuestions: distribution.totalQuestions,
        unanswered: distribution.unanswered,
        questionMap: distribution.questionMap,
      },
    };

    // Activity logging and realtime notification do not delay the grade.
    db.promise().query(
      `INSERT INTO activity_logs (user_id, scanned_test_id, action, description, performed_by)
       VALUES (?, ?, 'scan_processed', 'Live OMR scan finalized from verified frame', ?)`,
      [req.user.userId, scanId, req.user.userId]
    ).then(() => {
      emitActivityEvent({
        scanned_test_id: scanId,
        action: 'scan_processed',
        performedByName: req.user.username,
        user_id: req.user.userId,
      });
    }).catch(error => console.warn('Live scan activity log failed:', error.message));
    emitScanEvent({ scanId, status: 'completed', scan: fullScan, user_id: req.user.userId });
    setServerTiming(res, timings);
    res.json({
      success: true,
      message: 'Scan finalized from the verified live frame',
      fastPath: true,
      processingTimings: timings,
      ...omrStructuredSignals(entry.omrResult),
      scan: fullScan,
    });
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); } catch (_) {}
      connection.release();
    }
    if (imagePath && !transactionCommitted) {
      try { await fs.promises.unlink(imagePath); } catch (_) {}
    }
    console.error('Live detection finalization failed:', error);
    timings.total = elapsedMs(routeStarted);
    setServerTiming(res, timings);
    if (transactionCommitted) {
      return res.status(503).json({
        success: false,
        committed: true,
        retrySafe: false,
        message: 'The scan was saved, but its response could not be assembled. Reload scan history instead of rescanning.',
        error: error.message,
      });
    }
    res.status(500).json({
      success: false,
      retrySafe: true,
      message: 'Fast finalization failed; the frame can be processed through the normal scan path.',
      error: error.message,
    });
  } finally {
    if (finalizationClaimed && finalizationClaimKey) {
      activeLiveFinalizations.delete(finalizationClaimKey);
    }
  }
});

app.post('/api/omr/detect-sequence', authenticateToken, async (req, res) => {
  try {
    const { imageBuffer: base64Image, bottomRegionHeight, cropLeft, cropWidth, cropRight } = req.body;

    if (!base64Image) {
      return res.status(400).json({ success: false, message: 'imageBuffer (base64) is required' });
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');
    const qrMatch = await resolveAnswerKeyQr(imageBuffer, req.user.userId);
    if (qrMatch.answerKey) {
      return res.json({
        success: true,
        sequence: qrMatch.qrResult?.sequence || null,
        confidence: qrMatch.qrResult?.sequenceConfidence || 0,
        rawText: '',
        cropRegion: {
          source: 'qr-anchored-digit-boxes',
          boxes: qrMatch.qrResult?.sequenceBoxes || [],
          reason: qrMatch.qrResult?.sequenceReason || null,
        }
      });
    }

    const piSeq = await proxyToPi(base64Image, '');
    if (piSeq && piSeq.success && piSeq.sequence) {
      return res.json({
        success: true,
        sequence: piSeq.sequence,
        confidence: piSeq.sequenceConfidence || 0,
        rawText: piSeq.rawOcrText || '',
        cropRegion: piSeq.qualityMetrics || {}
      });
    }

    let seqBuffer = imageBuffer;
    try {
      const rectified = await rectifyExamSheet(imageBuffer);
      seqBuffer = rectified.buffer;
    } catch (e) {
      console.warn('Rectification skipped for detect-sequence:', e.message);
      seqBuffer = imageBuffer;
    }

    // The QR-era sequence field is beside the code in the lower page area.
    // OCR the isolated page once; scanning both the full camera frame and the
    // same rectified bytes doubled Tesseract work and made patterned desk
    // backgrounds produce tiny, unrecognizable line fragments.
    const sequenceResult = await SequenceDetector.detectSequenceFromBottom(seqBuffer, {
      bottomRegionHeight: bottomRegionHeight ?? 0.30,
      cropLeft: cropLeft ?? 0.36,
      cropWidth,
      cropRight: cropRight ?? (cropWidth == null ? 0.96 : undefined),
      allowStandalone: true
    });

    res.json({
      success: true,
      sequence: sequenceResult.sequence,
      confidence: sequenceResult.confidence,
      rawText: sequenceResult.rawText,
      cropRegion: sequenceResult.cropRegion
    });
  } catch (error) {
    console.error('Sequence detection error:', error);
    res.status(500).json({ success: false, message: 'Sequence detection failed', error: error.message });
  }
});

app.post('/api/omr/detect-exam-sheet', authenticateToken, async (req, res) => {
  try {
    const { imageBuffer: base64Image, fast = false } = req.body;

    if (!base64Image) {
      return res.status(400).json({ success: false, message: 'imageBuffer (base64) is required' });
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');
    const result = await ExamSheetDetector.detectExamSheet(imageBuffer, { fast: fast === true });

    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    console.error('Exam sheet detection error:', error);
    res.status(500).json({ success: false, message: 'Exam sheet detection failed', error: error.message });
  }
});

// ============================================================================
// ONNX MODEL MANAGEMENT ENDPOINTS
// ============================================================================

app.get('/api/omr/onnx/status', authenticateToken, async (req, res) => {
  try {
    const status = {
      available: OnnxService.isAvailable(),
      loadedModels: OnnxService.getLoadedModels(),
      bubbleCalibration: OnnxService.getBubbleCalibration(),
      modelsDir: process.env.ONNX_MODELS_DIR || path.join(__dirname, 'models'),
    };
    res.json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get ONNX status', error: error.message });
  }
});

app.post('/api/omr/onnx/reload', authenticateToken, isAdmin, async (req, res) => {
  try {
    const modelsDir = req.body.modelsDir || process.env.ONNX_MODELS_DIR || path.join(__dirname, 'models');
    const initialized = await OnnxService.reload(modelsDir);
    res.json({
      success: true,
      available: initialized,
      loadedModels: OnnxService.getLoadedModels(),
      message: initialized ? 'ONNX models reloaded successfully' : 'No ONNX models found in directory',
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to reload ONNX models', error: error.message });
  }
});

app.post('/api/admin/scanner/train', authenticateToken, isAdmin, async (req, res) => {
  try {
    console.log(`Training request received from user ${req.user.userId}`);
    const result = await ScannerTrainer.main();
    res.json({
      success: true,
      message: 'Scanner training completed successfully',
      calibration: result
    });
  } catch (error) {
    console.error('Scanner training error:', error);
    res.status(500).json({ success: false, message: 'Training failed', error: error.message });
  }
});

app.get('/api/admin/scanner/calibration', authenticateToken, isAdmin, async (req, res) => {
  try {
    const calPath = path.join(__dirname, 'bubble-calibration.json');
    if (!fs.existsSync(calPath)) {
      return res.status(404).json({ success: false, message: 'No calibration file found' });
    }
    const calibration = JSON.parse(fs.readFileSync(calPath, 'utf8'));
    res.json({ success: true, calibration });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to load calibration', error: error.message });
  }
});

// ============================================================================
// SCAN/OMR ROUTES
// ============================================================================

app.post('/api/scans/upload', authenticateToken, upload.single('scanImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No image file provided' });
    }
    const { classroom_id, answer_key_id, student_id } = req.body;
    const imageSha256 = await new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const input = fs.createReadStream(req.file.path);
      input.on('data', chunk => hash.update(chunk));
      input.on('end', () => resolve(hash.digest('hex')));
      input.on('error', reject);
    });
    const [result] = await db.promise().query(
      `INSERT INTO scanned_tests 
         (filename, file_path, image_sha256, file_size, mime_type, classroom_id, answer_key_id, scan_status, user_id, created_by, student_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
       [req.file.filename, req.file.path, imageSha256, req.file.size, req.file.mimetype,
        classroom_id || null, answer_key_id || null, req.user.userId, req.user.userId,
        student_id || null]
    );
    const scanId = result.insertId;
    res.json({
      success: true,
      message: 'Scan uploaded successfully',
      scanId,
      scan: { id: scanId, filename: req.file.filename, status: 'pending' }
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: 'Failed to upload scan', error: error.message });
  }
});

app.post('/api/scans/:id/process', authenticateToken, async (req, res) => {
  const scanId = req.params.id;
  const userId = req.user.userId;
  const liveCapture = req.body?.liveCapture === true || req.body?.liveCapture === 'true';
  const PROCESS_TIMEOUT_MS = 180000;
  const routeStarted = process.hrtime.bigint();
  const processingTimings = {};
  let processingAttemptId = null;
  let persistenceConnection = null;
  let processingTransactionCommitted = false;

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, PROCESS_TIMEOUT_MS);
  const finishRejectedAttempt = async (message) => {
    processingTimings.total = elapsedMs(routeStarted);
    await db.promise().query(
      `UPDATE scanned_tests
       SET scan_status = 'failed', error_message = ?, processed_at = NOW(),
           processing_duration_ms = ?, scanner_version = ?
       WHERE id = ? AND user_id = ?`,
      [message, Math.round(processingTimings.total), SCANNER_PIPELINE_VERSION, scanId, userId]
    );
    if (processingAttemptId) {
      await db.promise().query(
        `UPDATE scan_processing_attempts
         SET status = 'failed', timings_json = ?, error_message = ?, completed_at = NOW()
         WHERE id = ? AND user_id = ? AND scanned_test_id = ?`,
        [JSON.stringify(processingTimings), message, processingAttemptId, userId, scanId]
      );
    }
  };

  try {
    const claimStarted = process.hrtime.bigint();
    const claim = await claimScanForProcessing(scanId, userId);
    processingTimings.claim = elapsedMs(claimStarted);
    if (!claim.claimed) {
      clearTimeout(timeoutHandle);
      if (claim.reason === 'not-found') {
        return res.status(404).json({ success: false, message: 'Scan not found' });
      }
      return res.status(409).json({
        success: false,
        message: 'This scan is already being processed. Wait for the current attempt to finish.'
      });
    }

    const [scans] = await db.promise().query(
      `SELECT s.*, ak.answer_key_json, ak.num_questions, ak.subject, ak.exam_title, ak.epoch
       FROM scanned_tests s 
       LEFT JOIN answer_keys ak
         ON s.answer_key_id = ak.id
        AND s.user_id = ak.user_id
        AND ak.is_active = TRUE
       WHERE s.id = ? AND s.user_id = ?`,
      [scanId, userId]
    );
    if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');
    if (scans.length === 0) {
      clearTimeout(timeoutHandle);
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    const scan = scans[0];
    const readStarted = process.hrtime.bigint();
    const rawImageBuffer = await fs.promises.readFile(scan.file_path);
    processingTimings.fileRead = elapsedMs(readStarted);
    const currentImageSha256 = crypto.createHash('sha256').update(rawImageBuffer).digest('hex');
    if (scan.image_sha256 && scan.image_sha256 !== currentImageSha256) {
      throw new Error('The stored scan image changed after upload. Upload the sheet again.');
    }
    const [attemptResult] = await db.promise().query(
      `INSERT INTO scan_processing_attempts
         (user_id, scanned_test_id, image_sha256, scanner_version, status)
       VALUES (?, ?, ?, ?, 'processing')`,
      [userId, scanId, currentImageSha256, SCANNER_PIPELINE_VERSION]
    );
    processingAttemptId = attemptResult.insertId;
    await db.promise().query(
      `UPDATE scanned_tests
       SET image_sha256 = ?, current_processing_attempt_id = ?
       WHERE id = ? AND user_id = ?`,
      [currentImageSha256, processingAttemptId, scanId, userId]
    );
    // QR identity and the 50-row OMR geometry are independent. Run both
    // persistent CV workers together; the placeholder key supplies only the
    // fixed form length and is never used for grading.
    let fastOmrPreflightPromise = detectBubbles(
      rawImageBuffer,
      'A'.repeat(50),
      null,
      { rectifiedBuffer: rawImageBuffer, userId, scanId }
    ).then(
      result => ({ result, error: null }),
      error => ({ result: null, error })
    );
    let currentAnswerKeyJson = scan.answer_key_json || '';
    let detectedQrPayload = null;
    // When present, the QR printed on the physical page is authoritative.
    // Sheets without a QR may still use the explicitly selected answer key
    // and student after both records are verified for the signed-in user.
    const qrStarted = process.hrtime.bigint();
    const qrMatch = await resolveAnswerKeyQr(rawImageBuffer, userId);
    processingTimings.qr = elapsedMs(qrStarted);
    detectedQrPayload = qrMatch.qrResult?.payload || null;
    const qrStudentSequence = qrMatch.answerKey
      && /^\d{1,4}$/.test(String(qrMatch.qrResult?.sequence || ''))
      ? String(Number.parseInt(qrMatch.qrResult.sequence, 10))
      : null;
    if (qrMatch.answerKey) {
      scan.answer_key_id = qrMatch.answerKey.id;
      scan.answer_key_json = qrMatch.answerKey.answer_key_json;
      scan.classroom_id = qrMatch.answerKey.classroom_id || scan.classroom_id;
      currentAnswerKeyJson = qrMatch.answerKey.answer_key_json;
      await db.promise().query(
        `UPDATE scanned_tests
         SET answer_key_id = ?, classroom_id = COALESCE(?, classroom_id)
         WHERE id = ? AND user_id = ?`,
        [qrMatch.answerKey.id, qrMatch.answerKey.classroom_id || null, scanId, userId]
      );
      console.log(`[QR] Scan ${scanId} matched answer key ${qrMatch.answerKey.id}.`);
    }
    const qrAnchorCorners = Array.isArray(qrMatch.qrResult?.sourceCorners)
      && qrMatch.qrResult.sourceCorners.length === 4
      && qrMatch.qrResult.sourceCorners.every(point => Array.isArray(point)
        && point.length >= 2
        && Number.isFinite(Number(point[0]))
        && Number.isFinite(Number(point[1])))
      ? qrMatch.qrResult.sourceCorners.map(point => [Number(point[0]), Number(point[1])])
      : null;

    // Keep QR lookup and the ordinary full-resolution OMR preflight parallel.
    // If that preflight cannot register a camera frame, retry only then with
    // the same bounded raster used by live detection and with the QR corners
    // scaled into it. This prevents a successfully verified live sheet from
    // failing when the saved 4K frame is processed a second time.
    if (qrMatch.answerKey && qrAnchorCorners) {
      fastOmrPreflightPromise = fastOmrPreflightPromise.then(async preflight => {
        const assessRetry = result => {
          const details = result?.details || {};
          const locator = String(details.placement?.locator || '');
          const phaseError = Number(details.grid?.rowPhaseAnchorErrorRows);
          const phaseSafe = locator !== 'qr-anchor-lattice'
            || (Number.isFinite(phaseError) && phaseError <= 0.30);
          const uncertainRows = Number(details.uncertainRows || 0);
          const currentGeometry = details.source === 'fast-hybrid-grid'
            && details.currentSheetGeometry === true
            && details.geometryEvidenceUnreliable !== true;
          const gradeable = details.gradeable !== false && uncertainRows === 0;
          return {
            trusted: currentGeometry && gradeable && phaseSafe,
            rank: (currentGeometry ? 100 : 0)
              + (gradeable ? 30 : 0)
              + (phaseSafe ? 10 : 0)
              + Math.min(9, Number(details.registrationConfidence || 0) / 12),
          };
        };
        const initialAssessment = assessRetry(preflight.result);
        if (initialAssessment.trusted) return preflight;

        const metadata = await sharp(rawImageBuffer).metadata();
        const sourceWidth = Number(metadata.width || 0);
        const sourceHeight = Number(metadata.height || 0);
        if (!sourceWidth || !sourceHeight) return preflight;
        const previewScale = Math.min(1, 1600 / Math.max(sourceWidth, sourceHeight));
        const previewWidth = Math.max(1, Math.round(sourceWidth * previewScale));
        const previewHeight = Math.max(1, Math.round(sourceHeight * previewScale));
        const scaledQrAnchor = qrAnchorCorners.map(([x, y]) => [
          x * previewWidth / sourceWidth,
          y * previewHeight / sourceHeight,
        ]);
        let bestRetry = preflight;
        let bestRank = initialAssessment.rank;
        // Prefer the high-quality preview. Lower JPEG quality can erase the
        // first right-block row while leaving a plausible shifted lattice.
        for (const jpegQuality of [92, 82]) {
          const previewBuffer = await sharp(rawImageBuffer)
            .resize(previewWidth, previewHeight, { fit: 'fill' })
            .greyscale()
            .jpeg({ quality: jpegQuality, chromaSubsampling: '4:4:4' })
            .toBuffer();
          console.log(
            `[FAST-OMR] Retrying scan ${scanId} with QR-guided ${previewWidth}x${previewHeight} registration (JPEG q${jpegQuality}).`
          );
          try {
            const result = await detectBubbles(
              previewBuffer,
              currentAnswerKeyJson || 'A'.repeat(50),
              scan.filename,
              {
                rectifiedBuffer: previewBuffer,
                userId,
                scanId,
                qrAnchorCorners: scaledQrAnchor,
              }
            );
            const assessment = assessRetry(result);
            if (assessment.rank > bestRank) {
              bestRetry = { result, error: null };
              bestRank = assessment.rank;
            }
            if (assessment.trusted) return { result, error: null };
          } catch (error) {
            if (!bestRetry.result && preflight.error) bestRetry = { result: null, error };
          }
        }
        return bestRetry;
      });
    }
    let usingManualConfiguration = false;
    if (!qrMatch.answerKey && !detectedQrPayload && scan.answer_key_id && currentAnswerKeyJson && scan.student_id) {
      const [manualStudents] = await db.promise().query(
        `SELECT id, classroom_id
         FROM students
         WHERE id = ? AND user_id = ? AND deleted_at IS NULL
         LIMIT 1`,
        [scan.student_id, userId]
      );
      const manualStudent = manualStudents[0] || null;
      const classroomMatches = manualStudent
        && (!scan.classroom_id || Number(manualStudent.classroom_id) === Number(scan.classroom_id));
      if (classroomMatches) {
        usingManualConfiguration = true;
        if (!scan.classroom_id && manualStudent.classroom_id) {
          scan.classroom_id = manualStudent.classroom_id;
          await db.promise().query(
            'UPDATE scanned_tests SET classroom_id = ? WHERE id = ? AND user_id = ?',
            [manualStudent.classroom_id, scanId, userId]
          );
        }
        console.log(
          `[MANUAL] Scan ${scanId} using selected answer key ${scan.answer_key_id} and student ${scan.student_id}; QR not required.`
        );
      }
    }

    if (!qrMatch.answerKey && !usingManualConfiguration) {
      const message = detectedQrPayload
        ? 'The visible QR code is not an active answer key for this account'
        : 'No answer-key QR was found and a valid answer key and student were not both selected';
      await finishRejectedAttempt(`Automatic grading withheld: ${message}.`);
      clearTimeout(timeoutHandle);
      setServerTiming(res, processingTimings);
      return res.status(422).json({
        success: false,
        requiresReview: true,
        message: detectedQrPayload
          ? `${message}. Select the matching key or scan the correct sheet.`
          : `${message}. Select the answer key and student, then scan again.`
      });
    }
    // The legacy Pi proportional-grid reader can bypass geometry rejection
    // and is not compatible with the calibrated 50x4 form. Camera capture may
    // still live on the Pi, but grading has one authoritative local pipeline.
    const piScanResult = null;

    let ocrResult, detectedEpoch, omrResult;
    let detectedSequence = qrStudentSequence;
    let epochResult = { epoch: null, confidence: 0, rawText: '' };
    let sequenceResult = {
      sequence: qrStudentSequence,
      confidence: qrStudentSequence ? (qrMatch.qrResult?.sequenceConfidence || 0) : 0,
      rawText: '',
      source: qrStudentSequence ? 'qr-anchored-digit-boxes' : null,
    };

    if (piScanResult && piScanResult.success) {
      const piOcr = piScanResult.studentInfo || {};
      ocrResult = {
        studentNumber: piOcr.studentNumber || '',
        studentName: piOcr.studentName || '',
        confidence: piOcr.confidence || 0,
        rawText: piOcr.rawText || '',
      };
      epochResult = { epoch: piScanResult.epoch || null, confidence: piScanResult.epochConfidence || 0, rawText: '' };
      detectedEpoch = epochResult.epoch;
      sequenceResult = {
        sequence: piScanResult.sequence || qrStudentSequence || null,
        confidence: piScanResult.sequenceConfidence || sequenceResult.confidence || 0,
        rawText: ''
      };
      detectedSequence = sequenceResult.sequence;
      const detectedAnswers = piScanResult.detectedAnswers || [];
      const confidenceScores = piScanResult.confidenceScores || [];
      omrResult = {
        detectedAnswers,
        confidenceScores,
        markedLetters: piScanResult.markedLetters || [],
        details: {
          numQuestions: detectedAnswers.length,
          averageConfidence: piScanResult.averageConfidence || 0,
          source: 'pi-native',
        },
      };
    } else {
      // Fallback to existing local processing with perspective rectification
      let rectifiedBuffer = rawImageBuffer;
      let scanPlacement = null;
      const canonicalFastForm = String(currentAnswerKeyJson || '').replace(/\s/g, '').length === 50;
      if (!canonicalFastForm) {
        try {
          const rectified = await rectifyExamSheet(rawImageBuffer);
          rectifiedBuffer = rectified.buffer;
          scanPlacement = rectified.placement || null;
          if (rectified.rectified) {
            console.log(`Rectified scan ${scanId}: ${rectified.dstWidth}x${rectified.dstHeight}`);
          }
        } catch (e) {
          console.warn('Rectification skipped for scan', scanId, ':', e.message);
        }
      }

      const hasAnswerKey = !!(scan.answer_key_json || scan.answer_key_id);
      const hasStudent = !!scan.student_id;
      const processedBufferPromise = (!hasAnswerKey || !hasStudent)
        ? preprocessImage(rectifiedBuffer, { rectify: false })
        : Promise.resolve(rectifiedBuffer);
      let processedBuffer = hasAnswerKey ? rectifiedBuffer : await processedBufferPromise;
      if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');

      // Legacy date/epoch OCR remains available for old sheets. New QR sheets
      // already own their answer-key identity and need only the handwritten
      // student sequence field.
      if (!hasAnswerKey) {
        const localEpochResult = await EnhancedScanner.detectEpoch(processedBuffer);
        if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');
        epochResult = localEpochResult;
        detectedEpoch = localEpochResult.epoch;
      }

      if (!hasStudent && !detectedSequence) {
        // Bubble geometry intentionally uses the untouched canonical-form
        // frame. The handwritten sequence field benefits from a separate
        // page-only crop, especially when the narrow sheet is surrounded by
        // patterned fabric. Run one bounded OCR pass instead of duplicate raw
        // and rectified passes.
        let sequenceBuffer = rectifiedBuffer;
        if (canonicalFastForm && rectifiedBuffer === rawImageBuffer) {
          try {
            const sequenceRectified = await rectifyExamSheet(rawImageBuffer);
            sequenceBuffer = sequenceRectified.buffer || rawImageBuffer;
          } catch (e) {
            console.warn('Sequence-only rectification skipped for scan', scanId, ':', e.message);
          }
        }
        const seqFromPage = await SequenceDetector.detectSequenceFromBottom(sequenceBuffer, {
          bottomRegionHeight: 0.30,
          cropLeft: 0.36,
          cropRight: 0.96,
          allowStandalone: true,
        });
        if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');
        sequenceResult = seqFromPage;
        detectedSequence = sequenceResult.sequence;
      }

      let currentAnswerKeyJsonForOMR = scan.answer_key_json || '';
      if (!currentAnswerKeyJsonForOMR && scan.answer_key_id) {
        const [keyData] = await db.promise().query(
          'SELECT answer_key_json FROM answer_keys WHERE id = ? AND user_id = ?',
          [scan.answer_key_id, userId]
        );
        if (keyData.length > 0) currentAnswerKeyJsonForOMR = keyData[0].answer_key_json;
      }
      if (!currentAnswerKeyJsonForOMR && detectedSequence) {
        const seqMatch = detectedSequence.match(/^(\d{2})-(\d{2})-(\d{4})/);
        if (seqMatch) {
          const detectedDate = `${seqMatch[3]}-${seqMatch[2]}-${seqMatch[1]}`;
          const [keyRows] = await db.promise().query(
            'SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND answer_key_date = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1',
            [userId, detectedDate]
          );
          if (keyRows.length > 0) {
            currentAnswerKeyJsonForOMR = keyRows[0].answer_key_json;
            await db.promise().query(
              'UPDATE scanned_tests SET answer_key_id = ? WHERE id = ?',
              [keyRows[0].id, scanId]
            );
          }
        }
      }

      if (currentAnswerKeyJsonForOMR) {
        if (!canonicalFastForm && (!scanPlacement || !scanPlacement.acceptable)) {
          const placementMessage = scanPlacement?.reason || 'Answer sheet boundary not found';
          await finishRejectedAttempt(`Automatic grading withheld: ${placementMessage}.`);
          clearTimeout(timeoutHandle);
          setServerTiming(res, processingTimings);
          return res.status(422).json({
            success: false,
            requiresReview: true,
            message: 'Answer sheet placement could not be verified. Reposition the full sheet and scan again.',
            placement: scanPlacement || { detected: false, acceptable: false, confidence: 0, reason: placementMessage }
          });
        }
        if (canonicalFastForm) {
          const preflight = await fastOmrPreflightPromise;
          if (preflight.error) throw preflight.error;
          omrResult = preflight.result;
        } else {
          omrResult = await detectBubbles(
            rawImageBuffer,
            currentAnswerKeyJsonForOMR,
            scan.filename,
            { rectifiedBuffer, userId, scanId }
          );
        }
        scanPlacement = omrResult?.details?.placement || scanPlacement;
        const detected = omrResult?.detectedAnswers || [];
        const unique = new Set(detected.filter(answer => ['A', 'B', 'C', 'D'].includes(answer)));
        const blur = Number(omrResult?.details?.blurScore || 0);
        const confidenceScores = omrResult?.confidenceScores || [];
        const avgConfidence = Number(omrResult?.details?.averageConfidence || 0);
        const filledCount = detected.filter(answer => answer && String(answer).trim()).length;
        const fillRatio = filledCount / Math.max(1, detected.length);
        const ambiguousRows = Math.max(
          Number(omrResult?.details?.ambiguousRows || 0),
          (omrResult?.markedLetters || []).filter(row => Array.isArray(row) && row.length > 1).length
        );
        const uncertainRows = Number(omrResult?.details?.uncertainRows || 0);
        const verifiedGeometry = omrResult?.details?.source === 'verified-grid';
        const fastHybridGeometry = omrResult?.details?.source === 'fast-hybrid-grid'
          && omrResult?.details?.currentSheetGeometry === true
          && omrResult?.details?.geometryEvidenceUnreliable !== true;
        const adaptiveFormGeometry = ['adaptive-solid-mark-grid', 'adaptive-ring-grid'].includes(omrResult?.details?.source)
          && omrResult?.details?.geometryEvidenceUnreliable !== true;
        const multiMarkGeometry = omrResult?.details?.source === 'adaptive-multi-mark-grid'
          && omrResult?.details?.multiMarkCapable === true
          && detected.length === 50
          && (omrResult?.markedLetters || []).length === 50
          && ambiguousRows > 0;
        const partialMarkGeometry = omrResult?.details?.source === 'adaptive-partial-mark-grid'
          && omrResult?.details?.partialMarkCapable === true
          && detected.length === 50
          && (omrResult?.markedLetters || []).length === 50;
        const answerRows = Array.isArray(omrResult?.markedLetters) ? omrResult.markedLetters : [];
        const completeRowMap = detected.length === 50 && answerRows.length === 50;
        const blankRows = answerRows.filter(row => Array.isArray(row) && row.length === 0).length;
        const referenceSimilarity = Number(omrResult?.details?.referenceSimilarity || 0);
        const geometryEvidenceUnreliable = omrResult?.details?.geometryEvidenceUnreliable === true;
        const qualityMetrics = omrResult?.details?.qualityMetrics
          && typeof omrResult.details.qualityMetrics === 'object'
          ? omrResult.details.qualityMetrics
          : {};
        const overallQuality = Number(qualityMetrics.overall);
        // A canonical form grid is a candidate locator, not proof that its
        // projected bubble centres land on this frame. Below this evidence
        // level, withhold the grade instead of converting a misaligned crop
        // into a confident-looking answer string.
        const unreliableGeometry = false
          || (verifiedGeometry && referenceSimilarity < 0.65 && unique.size > 1);
        // Full-frame Laplacian blur is inflated by the fixed dark camera tray.
        // Treat it as a rejection signal only when recognition confidence also
        // falls below the acceptance threshold. Likewise, a uniform response
        // is valid (for example a deliberate all-B calibration sheet) when a
        // verified grid read every row confidently.
        const unreliableBlur = blur >= 45 && avgConfidence < 80;
        const reliableUniformGeometry = fastHybridGeometry || verifiedGeometry || adaptiveFormGeometry || multiMarkGeometry || partialMarkGeometry;
        const uniformConfidenceThreshold = fastHybridGeometry ? 70 : 90;
        const unreliableUniform = detected.length >= 20 && unique.size === 1
          && (!reliableUniformGeometry || avgConfidence < uniformConfidenceThreshold);
        // A complete row map is gradeable even when some or all bubbles are
        // blank. Empty rows are intentional OMR values and score zero; they
        // are not evidence that the sheet layout is incomplete.
        const incompleteRead = !completeRowMap;
        const minimumConfidence = fastHybridGeometry ? 70 : 30;
        const unreliableQuality = qualityMetrics.gradeable === false
          || (Number.isFinite(overallQuality) && overallQuality < OMR_MINIMUM_QUALITY);
        if (geometryEvidenceUnreliable || unreliableGeometry || unreliableBlur || unreliableUniform
            || uncertainRows > 0
            || avgConfidence < minimumConfidence || incompleteRead || unreliableQuality) {
          const existingArtifacts = omrResult?.details?.diagnosticArtifacts;
          if (
            scan?.filename
            && !omrResult?.details?.diagnosticPath
            && (!Array.isArray(existingArtifacts) || existingArtifacts.length === 0)
          ) {
            const diagnosticResult = await detectBubbles(
              rawImageBuffer,
              currentAnswerKeyJsonForOMR,
              scan.filename,
              {
                rectifiedBuffer,
                userId,
                scanId,
                forceDiagnostics: true,
              }
            );
            if (diagnosticResult?.details) {
              omrResult.details = {
                ...(omrResult.details || {}),
                ...diagnosticResult.details,
              };
            }
          }
          const omrDetails = omrResult?.details || {};
          const failedTrace = Array.isArray(omrDetails.stageTrace)
            ? omrDetails.stageTrace.find(stage => stage?.status === 'failed')
            : null;
          const rejectionReason = omrDetails.rejectionReason
            || failedTrace?.reason
            || (uncertainRows > 0
              ? `${uncertainRows} answer row${uncertainRows === 1 ? '' : 's'} could not be classified without guessing`
              : incompleteRead
                ? `Only ${detected.length} of 50 answer rows were recovered`
                : unreliableQuality
                  ? `Overall scan quality ${Number.isFinite(overallQuality) ? overallQuality.toFixed(1) : '0.0'}% is below the ${OMR_MINIMUM_QUALITY}% grading threshold`
                : avgConfidence < minimumConfidence
                  ? `Average mark confidence ${avgConfidence.toFixed(1)}% is below the ${minimumConfidence}% grading threshold`
                  : 'Current-sheet geometry evidence did not meet the grading threshold');
          const failureStage = omrDetails.rejectionStage
            || failedTrace?.stage
            || (uncertainRows > 0 ? 'mark-classification' : 'quality-gate');
          const geometryConfidence = Number(
            omrDetails.geometryConfidence
            ?? omrDetails.grid?.confidence
            ?? omrDetails.geometryMetrics?.geometryConfidence
            ?? 0
          );
          const requiredGeometryConfidence = Number(
            omrDetails.grid?.requiredConfidence
            ?? omrDetails.geometryMetrics?.requiredGeometryConfidence
            ?? 42
          );
          const diagnosticPath = typeof omrDetails.diagnosticPath === 'string'
            ? omrDetails.diagnosticPath
            : null;
          const diagnosticArtifacts = Array.isArray(omrDetails.diagnosticArtifacts)
            ? omrDetails.diagnosticArtifacts
            : [];
          const structuredSignals = omrStructuredSignals(omrDetails);
          const recommendation = failedTrace?.recommendation
            || (failureStage === 'document-detection'
              ? 'Keep the complete answer area visible; the outer paper border and page corners may remain outside the frame.'
              : failureStage === 'mark-classification'
                ? 'Erase stray marks, darken intended bubbles, and scan again under even lighting.'
                : 'Keep the complete answer area visible and improve focus or lighting. Rotation, perspective, scale, and minor spacing changes are recovered automatically.');
          const rejectionIsOnlyAboutMultiMarks = /multiple shaded|multi-mark/i.test(String(rejectionReason));
          const userMessage = (!rejectionIsOnlyAboutMultiMarks && rejectionReason)
            ? `${rejectionReason}. No score was saved.`
            : `Scan geometry could not be verified. ${ambiguousRows > 0 ? 'Multi-mark rows will score zero after the sheet geometry is verified. ' : ''}No score was saved.`;
          const persistedFailure = [
            `Automatic grading withheld at ${failureStage}: ${rejectionReason}.`,
            `Geometry ${geometryConfidence.toFixed(1)}%/${requiredGeometryConfidence.toFixed(1)}%,`,
            `invalid grid evidence ${geometryEvidenceUnreliable}, blur ${blur}%,`,
            `quality ${Number.isFinite(overallQuality) ? overallQuality.toFixed(1) : 'n/a'}%, average confidence ${avgConfidence.toFixed(1)}%, filled ${filledCount}/${detected.length},`,
            `blank rows ${blankRows}, ambiguous rows ${ambiguousRows},`,
            `uncertain rows ${uncertainRows}, complete row map ${completeRowMap},`,
            `unique answers ${unique.size}.`
          ].join(' ');
          processingTimings.omr = Number(omrResult?.details?.processingMs || 0);
          await finishRejectedAttempt(persistedFailure);
          clearTimeout(timeoutHandle);
          setServerTiming(res, processingTimings);
          return res.status(422).json({
            success: false,
            requiresReview: true,
            message: userMessage,
            failure: {
              ...structuredSignals,
              stage: failureStage,
              reason: rejectionReason,
              recommendation,
              diagnosticPath,
              diagnosticArtifacts,
              stageTrace: Array.isArray(omrDetails.stageTrace)
                ? omrDetails.stageTrace
                : [],
              rowDiagnostics: Array.isArray(omrDetails.rowDiagnostics)
                ? omrDetails.rowDiagnostics
                : [],
              metrics: {
                ...(omrDetails.geometryMetrics || {}),
                ...(failedTrace?.metrics || {}),
                geometryConfidence,
                requiredGeometryConfidence,
                cellSupport: omrDetails.geometryMetrics?.cellSupport ?? omrDetails.grid?.cellSupport ?? null,
                rowSupport: omrDetails.geometryMetrics?.rowSupport ?? omrDetails.grid?.rowSupport ?? null,
                featureClustering: omrDetails.featureClustering || null,
                registration: structuredSignals.registrationMetrics,
                registrationAttempts: structuredSignals.registrationAttempts,
              },
            },
            quality: {
              ...structuredSignals,
              geometryConfidence,
              requiredGeometryConfidence,
              referenceSimilarity,
              geometryEvidenceUnreliable,
              blurScore: blur,
              averageConfidence: avgConfidence,
              fillRatio,
              ambiguousRows,
              uncertainRows,
              uniqueAnswers: unique.size,
            }
          });
        }
      }
      if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');

      if (!hasStudent && !qrMatch.answerKey) {
        processedBuffer = await processedBufferPromise;
        ocrResult = await extractStudentInfo(processedBuffer);
        if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');
      } else {
        ocrResult = {
          studentNumber: '',
          studentName: '',
          confidence: 0,
          rawText: '',
        };
      }
    }

    // Persist all current result rows and the completed status atomically.
    // Reads used for student/key resolution may still use the shared
    // connection, but no partial score or OCR result becomes visible before
    // this dedicated transaction commits.
    const persistenceStarted = process.hrtime.bigint();
    persistenceConnection = await transactionPool.promise().getConnection();
    await persistenceConnection.beginTransaction();

    await persistenceConnection.query(
      `INSERT INTO ocr_extractions
         (user_id, scanned_test_id, processing_attempt_id, field_name, extracted_value, confidence, raw_ocr_text)
       VALUES (?, ?, ?, 'student_number', ?, ?, ?),
         (?, ?, ?, 'student_name', ?, ?, ?),
         (?, ?, ?, 'epoch', ?, ?, ?),
         (?, ?, ?, 'sequence', ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         processing_attempt_id = VALUES(processing_attempt_id),
         extracted_value = VALUES(extracted_value),
         confidence = VALUES(confidence),
         raw_ocr_text = VALUES(raw_ocr_text)`,
      [userId, scanId, processingAttemptId, ocrResult.studentNumber, ocrResult.confidence, ocrResult.rawText,
       userId, scanId, processingAttemptId, ocrResult.studentName, ocrResult.confidence, ocrResult.rawText,
       userId, scanId, processingAttemptId, detectedEpoch, epochResult.confidence, epochResult.rawText,
       userId, scanId, processingAttemptId, detectedSequence, sequenceResult.confidence, sequenceResult.rawText]
    );

    // Find student by sequential number from OCR (format: DD-MM-YYYY-N)
    let studentId = scan.student_id || null;
    let detectedSequentialNumber = null;
    let detectedDate = null;
    let detectedDateFormatted = null;
    let detectedClassroomId = null;

    if (!studentId && ocrResult.studentNumber) {
      const normalizedStudentNumber = ocrResult.studentNumber
        .replace(/\bI\b/g, '1')
        .replace(/\bO\b/g, '0')
        .replace(/(?<=\d)I/g, '1')
        .replace(/(?<=\d)O/g, '0');
      const seqMatch = normalizedStudentNumber.match(/^(\d{2}-\d{2}-\d{4})(?:-(\d+))?$/);
      if (seqMatch) {
        detectedDate = seqMatch[1];
        detectedDateFormatted = detectedDate.split('-').reverse().join('-');
        detectedSequentialNumber = seqMatch[2] ? parseInt(seqMatch[2]) : null;
        if (detectedSequentialNumber) {
          const [studentsFound] = await db.promise().query(
            `SELECT id, classroom_id, student_number, first_name, last_name FROM students 
             WHERE user_id = ? AND sequential_number = ? AND deleted_at IS NULL`,
            [userId, detectedSequentialNumber]
          );
          if (studentsFound.length > 0) {
            studentId = studentsFound[0].id;
            if (!scan.classroom_id && studentsFound[0].classroom_id) {
              await persistenceConnection.query(
                'UPDATE scanned_tests SET classroom_id = ? WHERE id = ? AND user_id = ?',
                [studentsFound[0].classroom_id, scanId, userId]
              );
            }
          }
        }
      } else {
        const [students] = await db.promise().query(
          'SELECT id FROM students WHERE student_number = ? AND user_id = ? AND deleted_at IS NULL',
          [ocrResult.studentNumber, userId]
        );
        if (students.length > 0) studentId = students[0].id;
      }
    }

    // QR-era form: the four boxes contain only the student's classroom
    // sequence number. The QR already fixes the classroom and answer key, so
    // match inside that classroom and reject cross-class ambiguity.
    const standaloneSequenceMatch = String(detectedSequence || '').match(/^(\d{1,4})$/);
    if (standaloneSequenceMatch) {
      detectedSequentialNumber = Number.parseInt(standaloneSequenceMatch[1], 10);
      if (!studentId && detectedSequentialNumber > 0) {
        const classroomId = scan.classroom_id || qrMatch.answerKey?.classroom_id || null;
        const params = classroomId
          ? [userId, detectedSequentialNumber, classroomId]
          : [userId, detectedSequentialNumber];
        const classroomClause = classroomId ? 'AND classroom_id = ?' : '';
        const [studentsFound] = await db.promise().query(
          `SELECT id, classroom_id, student_number, first_name, last_name
           FROM students
           WHERE user_id = ? AND sequential_number = ? AND deleted_at IS NULL
           ${classroomClause}
           ORDER BY id
           LIMIT 2`,
          params
        );
        if (studentsFound.length === 1) {
          studentId = studentsFound[0].id;
          if (!scan.classroom_id && studentsFound[0].classroom_id) {
            scan.classroom_id = studentsFound[0].classroom_id;
            await persistenceConnection.query(
              'UPDATE scanned_tests SET classroom_id = ? WHERE id = ? AND user_id = ?',
              [scan.classroom_id, scanId, userId]
            );
          }
          console.log(`Matched student ID ${studentId} from handwritten sequence ${detectedSequence}.`);
        } else if (studentsFound.length > 1) {
          console.warn(`Sequence ${detectedSequence} is ambiguous without a classroom; student auto-match withheld.`);
        }
      }
    }

    // Legacy fallback: match the old DD-MM-YYYY-N sequence format.
    // The trailing number is treated as classroom_id. If a student in that classroom has the
    // same sequential number, it will be matched; otherwise the classroom_id is set and
    // student matching is skipped.
    if (!studentId && detectedSequence) {
      const seqMatch = detectedSequence.match(/^(\d{2}-\d{2}-\d{4})-(\d+)$/);
      if (seqMatch) {
        if (!detectedDate) {
          detectedDate = seqMatch[1];
          detectedDateFormatted = detectedDate.split('-').reverse().join('-');
        }
        detectedClassroomId = parseInt(seqMatch[2]);
        if (detectedClassroomId && !scan.classroom_id) {
          await persistenceConnection.query(
            'UPDATE scanned_tests SET classroom_id = ? WHERE id = ? AND user_id = ?',
            [detectedClassroomId, scanId, userId]
          );
        }
        if (!detectedSequentialNumber) {
          detectedSequentialNumber = detectedClassroomId;
        }
        if (detectedSequentialNumber) {
          const classroomFilter = detectedClassroomId ? 'AND s.classroom_id = ?' : '';
          const studentParams = detectedClassroomId ? [userId, detectedSequentialNumber, detectedClassroomId] : [userId, detectedSequentialNumber];
          const [studentsFound] = await db.promise().query(
            `SELECT id, classroom_id, student_number, first_name, last_name FROM students s
             WHERE s.user_id = ? AND s.sequential_number = ? AND s.deleted_at IS NULL ${classroomFilter}`,
            studentParams
          );
          if (studentsFound.length > 0) {
            studentId = studentsFound[0].id;
            console.log(`✅ Matched student ID ${studentId} from detected sequence: ${detectedSequence}`);
          }
        }
      } else {
        // Try just the trailing number as sequential number and classroom hint
        const trailingNumMatch = detectedSequence.match(/-(\d+)$/);
        if (trailingNumMatch) {
          const seqNum = parseInt(trailingNumMatch[1]);
          if (seqNum && !detectedSequentialNumber) {
            detectedSequentialNumber = seqNum;
            const [studentsFound] = await db.promise().query(
              `SELECT id, classroom_id, student_number, first_name, last_name FROM students 
               WHERE user_id = ? AND sequential_number = ? AND deleted_at IS NULL`,
              [userId, seqNum]
            );
            if (studentsFound.length > 0) {
              studentId = studentsFound[0].id;
              console.log(`✅ Matched student ID ${studentId} from trailing number in sequence: ${detectedSequence}`);
              if (!scan.classroom_id && studentsFound[0].classroom_id) {
                await persistenceConnection.query(
                  'UPDATE scanned_tests SET classroom_id = ? WHERE id = ? AND user_id = ?',
                  [studentsFound[0].classroom_id, scanId, userId]
                );
              }
            }
          }
        }
      }
    }

    // Connect detected sequence/date to the assigned answer key
    // The date portion of the detected sequence (DD-MM-YYYY) must match answer_key_date
    // so that grading happens against the correct answer key.
    let answerKeyId = scan.answer_key_id;
    let seqDateStr = null;
    let seqDateFormatted = null;

    if (detectedSequence) {
      const seqMatch = detectedSequence.match(/^(\d{2})-(\d{2})-(\d{4})/);
      if (seqMatch) {
        seqDateStr = `${seqMatch[1]}-${seqMatch[2]}-${seqMatch[3]}`;
        seqDateFormatted = `${seqMatch[3]}-${seqMatch[2]}-${seqMatch[1]}`;
      }
    }

    if (detectedEpoch && !answerKeyId) {
      const [keyRows] = await db.promise().query(
        `SELECT id, answer_key_json FROM answer_keys WHERE user_id = ? AND epoch = ? AND is_active = TRUE ORDER BY id DESC LIMIT 1`,
        [userId, detectedEpoch]
      );
      if (keyRows.length > 0) {
        answerKeyId = keyRows[0].id;
        await persistenceConnection.query(
          'UPDATE scanned_tests SET answer_key_id = ? WHERE id = ? AND user_id = ?',
          [answerKeyId, scanId, userId]
        );
      }
    }

    if (seqDateFormatted && !answerKeyId) {
      const dateCandidates = [seqDateFormatted];
      if (seqDateStr) dateCandidates.push(seqDateStr);
      const [keyRows] = await db.promise().query(
        `SELECT id, answer_key_json FROM answer_keys
          WHERE user_id = ?
            AND is_active = TRUE
            AND (answer_key_date = ? OR answer_key_date = ?)
          ORDER BY id DESC
          LIMIT 1`,
        [userId, dateCandidates[0], dateCandidates[1]]
      );
      if (keyRows.length > 0) {
        const matchedKeyId = keyRows[0].id;
        answerKeyId = matchedKeyId;
        await persistenceConnection.query(
          'UPDATE scanned_tests SET answer_key_id = ? WHERE id = ? AND user_id = ?',
          [answerKeyId, scanId, userId]
        );
      }
    }

    if (answerKeyId) {
      const [keyData] = await db.promise().query(
        'SELECT answer_key_json FROM answer_keys WHERE id = ? AND user_id = ?',
        [answerKeyId, userId]
      );
      if (keyData.length > 0) currentAnswerKeyJson = keyData[0].answer_key_json;
    }

    let gradingResult = null;
    let uniformDetection = false;
    if (currentAnswerKeyJson && omrResult && omrResult.detectedAnswers && omrResult.detectedAnswers.length > 0) {
      await persistenceConnection.query(
        'DELETE FROM omr_results WHERE scanned_test_id = ? AND user_id = ?',
        [scanId, userId]
      );
      await persistenceConnection.query(
        'DELETE FROM exam_responses WHERE scanned_test_id = ? AND user_id = ?',
        [scanId, userId]
      );

      const answerKeyArray = currentAnswerKeyJson.replace(/\s/g, '').split('');
      
      const detectedAnswers = omrResult.detectedAnswers;
      const uniqueDetected = new Set(detectedAnswers.filter(a => a && ['A','B','C','D'].includes(a)));
      uniformDetection = detectedAnswers.length > 10 && uniqueDetected.size === 1;
      if (uniformDetection) {
        console.warn(`⚠ Suspicious uniform detection for scan ${scanId}: all answers are "${uniqueDetected.values().next().value}". Layout or detection may be wrong.`);
      }
      
      gradingResult = gradeExam(detectedAnswers, answerKeyArray, omrResult.markedLetters);
      
      console.log(`[GRADE] First 10 detected: ${detectedAnswers.slice(0, 10).join('')}`);
      console.log(`[GRADE] First 10 key: ${answerKeyArray.slice(0, 10).join('')}`);
      console.log(`[GRADE] Score: ${gradingResult.totalScore}/${gradingResult.totalQuestions} = ${gradingResult.percentage}%`);
      console.log(`[GRADE] Recorded ${gradingResult.blankCount} blank and ${gradingResult.multiMarkCount} multi-mark answer(s) as incorrect.`);
      
      if (uniformDetection && gradingResult.totalScore === gradingResult.totalQuestions) {
        gradingResult.suspicious = true;
        console.warn(`⚠ Uniform detection matched answer key perfectly for scan ${scanId}. Flagging for manual review.`);
      }

      const omrRows = gradingResult.results.map((result, index) => [
        userId,
        scanId,
        processingAttemptId,
        result.questionNumber,
        result.detectedAnswer,
        result.correctAnswer,
        result.isCorrect,
        omrResult.confidenceScores ? omrResult.confidenceScores[index] : 95,
        result.markedLetters?.length ? JSON.stringify(result.markedLetters) : null,
      ]);
      if (omrRows.length > 0) {
        const placeholders = omrRows
          .map(() => '(?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, JSON_ARRAY()))')
          .join(', ');
        await persistenceConnection.query(
          `INSERT INTO omr_results
             (user_id, scanned_test_id, processing_attempt_id, question_number, detected_answer, correct_answer, is_correct, confidence, marked_letters)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
             processing_attempt_id = VALUES(processing_attempt_id),
             detected_answer = VALUES(detected_answer),
             correct_answer = VALUES(correct_answer),
             is_correct = VALUES(is_correct),
             confidence = VALUES(confidence),
             marked_letters = COALESCE(VALUES(marked_letters), JSON_ARRAY())`,
          omrRows.flat()
        );
      }
      if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');

      const answersJson = JSON.stringify(
        gradingResult.results.reduce((acc, r) => { acc[r.questionNumber] = r.detectedAnswer; return acc; }, {})
      );
      const scoreJson = JSON.stringify(
        gradingResult.results.reduce((acc, r) => { acc[r.questionNumber] = r.score; return acc; }, {})
      );
      await persistenceConnection.query(
        `INSERT INTO exam_responses 
           (user_id, student_id, scanned_test_id, processing_attempt_id, answer_key_id, answers_json, score_per_question_json,
            total_score, percentage, is_graded, graded_by, graded_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW())
         ON DUPLICATE KEY UPDATE 
           processing_attempt_id = VALUES(processing_attempt_id),
           answers_json = VALUES(answers_json),
           score_per_question_json = VALUES(score_per_question_json),
           total_score = VALUES(total_score),
           percentage = VALUES(percentage),
           is_graded = TRUE,
           graded_by = VALUES(graded_by),
           graded_at = NOW()`,
        [userId, studentId, scanId, processingAttemptId, answerKeyId || scan.answer_key_id, answersJson, scoreJson,
         gradingResult.totalScore, gradingResult.percentage, userId]
      );
    }

    processingTimings.omr = Number(omrResult?.details?.processingMs || 0);
    processingTimings.omrBridge = Number(omrResult?.details?.totalBridgeMs ?? omrResult?.details?.bridgeMs ?? 0);
    processingTimings.omrTransport = Number(omrResult?.details?.transportMs || 0);
    processingTimings.persistence = elapsedMs(persistenceStarted);
    processingTimings.total = elapsedMs(routeStarted);
    const persistedProcessingMetrics = {
      ...processingTimings,
      omrStages: omrResult?.details?.stagesMs || {},
      omrTimingMetrics: omrResult?.details?.timingMetrics || {},
      qualityMetrics: omrResult?.details?.qualityMetrics || {},
    };
    await persistenceConnection.query(
      `UPDATE scanned_tests 
       SET student_id = ?, student_number_detected = ?, student_name_detected = ?,
           sequential_number_detected = ?, answer_key_date_detected = ?, epoch_detected = ?, sequence_detected = ?,
           ocr_confidence = ?, scan_status = 'completed', processed_at = NOW(),
           error_message = NULL, suspicious_uniform_detection = ?,
           processing_duration_ms = ?, scanner_version = ?, current_processing_attempt_id = ?
       WHERE id = ? AND user_id = ?`,
      [studentId, ocrResult.studentNumber, ocrResult.studentName,
       detectedSequentialNumber, detectedDateFormatted, detectedEpoch, detectedSequence,
       ocrResult.confidence, uniformDetection ? 1 : 0,
       Math.round(processingTimings.total), SCANNER_PIPELINE_VERSION, processingAttemptId,
       scanId, userId]
    );
    await persistenceConnection.query(
      `UPDATE scan_processing_attempts
       SET status = 'completed', timings_json = ?, error_message = NULL, completed_at = NOW()
       WHERE id = ? AND user_id = ? AND scanned_test_id = ?`,
      [JSON.stringify(persistedProcessingMetrics), processingAttemptId, userId, scanId]
    );
    await persistenceConnection.commit();
    processingTransactionCommitted = true;
    if (liveCapture) {
      markLiveSheetFinalized(userId, {
        answerKeyId: answerKeyId || scan.answer_key_id,
        omrResult,
      });
      invalidateLiveDetectionsForUser(userId);
    }
    persistenceConnection.release();
    persistenceConnection = null;

    // Activity log
    const [newLog] = await db.promise().query(
      `INSERT INTO activity_logs (user_id, scanned_test_id, action, description, performed_by) 
       VALUES (?, ?, 'scan_processed', 'OMR scan processed successfully', ?)`,
      [userId, scanId, userId]
    );
    emitActivityEvent({ ...newLog[0], performedByName: req.user.username, user_id: req.user.userId });

    // Return full scan details
    const [fullScans] = await db.promise().query(`
      SELECT s.*, ak.exam_title, ak.subject, ak.answer_key_date, ak.epoch,
             CONCAT(st.first_name, ' ', st.last_name) as student_full_name,
             st.sequential_number
      FROM scanned_tests s
      LEFT JOIN answer_keys ak ON s.answer_key_id = ak.id
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.id = ?
    `, [scanId]);

    const [omrResults] = await db.promise().query(
      'SELECT * FROM omr_results WHERE scanned_test_id = ? ORDER BY question_number',
      [scanId]
    );
    const sanitizedOmr = omrResults.map(r => {
      const { correct_answer, ...rest } = r;
      if (rest.marked_letters) {
        if (typeof rest.marked_letters === 'string') {
          try { rest.marked_letters = JSON.parse(rest.marked_letters); } catch {}
        }
        if (!Array.isArray(rest.marked_letters)) {
          rest.marked_letters = [];
        }
      } else {
        rest.marked_letters = [];
      }
      return rest;
    });

    const [ocrExtractions] = await db.promise().query(
      'SELECT * FROM ocr_extractions WHERE scanned_test_id = ?',
      [scanId]
    );

    const [responses] = await db.promise().query(
      'SELECT * FROM exam_responses WHERE scanned_test_id = ?',
      [scanId]
    );

    const fullScan = fullScans[0];
    delete fullScan.answer_key_json;
    fullScan.qr_detected = !!detectedQrPayload;
    fullScan.omrResults = sanitizedOmr;
    fullScan.ocrExtractions = ocrExtractions;
    fullScan.examResponse = responses.length > 0 ? responses[0] : null;
    const omrAnalysis = omrStructuredSignals(omrResult);
    fullScan.omrAnalysis = omrAnalysis;

    if (omrResult && omrResult.detectedAnswers) {
      try {
        const dist = EnhancedScanner.countAnswerDistribution(omrResult.detectedAnswers, omrResult.markedLetters || []);
        fullScan.answerDistribution = {
          counts: dist.counts,
          totalAnswered: dist.totalAnswered,
          totalQuestions: dist.totalQuestions,
          unanswered: dist.unanswered,
          questionMap: dist.questionMap
        };
      } catch (e) {
        console.warn('answer distribution failed:', e.message);
      }
    }

    emitScanEvent({ scanId, status: 'completed', scan: fullScan, user_id: req.user.userId });
    processingTimings.total = elapsedMs(routeStarted);
    setServerTiming(res, processingTimings);
    res.json({
      success: true,
      message: 'Scan processed successfully',
      ...omrAnalysis,
      processingTimings,
      scan: fullScan,
    });
    clearTimeout(timeoutHandle);

  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error('Processing error:', error);
    const failureDisposition = processingFailureDisposition(processingTransactionCommitted);
    if (persistenceConnection) {
      if (failureDisposition.rollback) {
        try { await persistenceConnection.rollback(); } catch (_) {}
      }
      persistenceConnection.release();
      persistenceConnection = null;
    }
    processingTimings.total = elapsedMs(routeStarted);
    if (failureDisposition.committed) {
      setServerTiming(res, processingTimings);
      return res.status(failureDisposition.status).json({
        success: false,
        committed: true,
        retrySafe: false,
        message: 'The scan and grade were saved, but the response could not be assembled. Reload scan history instead of processing this sheet again.',
        error: error.message,
      });
    }
    try {
      if (failureDisposition.persistFailure) await db.promise().query(
        `UPDATE scanned_tests
         SET scan_status = 'failed', error_message = ?, processed_at = NOW(),
             processing_duration_ms = ?, scanner_version = ?
         WHERE id = ? AND user_id = ?`,
        [error.message, Math.round(processingTimings.total), SCANNER_PIPELINE_VERSION, scanId, userId]
      );
      if (failureDisposition.persistFailure && processingAttemptId) {
        await db.promise().query(
          `UPDATE scan_processing_attempts
           SET status = 'failed', timings_json = ?, error_message = ?, completed_at = NOW()
           WHERE id = ? AND user_id = ? AND scanned_test_id = ?`,
          [JSON.stringify(processingTimings), error.message, processingAttemptId, userId, scanId]
        );
      }
    } catch (persistenceError) {
      console.error('Could not persist processing failure:', persistenceError);
    }
    setServerTiming(res, processingTimings);
    res.status(failureDisposition.status).json({
      success: false,
      committed: false,
      retrySafe: failureDisposition.retrySafe,
      message: 'Failed to process scan',
      error: error.message,
    });
  }
});

app.get('/api/scans/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const [scans] = await db.promise().query(`
      SELECT s.*, ak.exam_title, ak.subject, ak.answer_key_date, ak.epoch,
             CONCAT(st.first_name, ' ', st.last_name) as student_full_name,
             st.sequential_number
      FROM scanned_tests s
      LEFT JOIN answer_keys ak ON s.answer_key_id = ak.id
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.id = ? AND s.user_id = ?
    `, [req.params.id, userId]);
    if (scans.length === 0) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    const scan = scans[0];
    // Child rows are current only after the attempt commits as completed.
    // This also protects older databases that may still contain pre-fix rows
    // left behind by a failed retry.
    const completed = scan.scan_status === 'completed';
    const [omrResults] = completed
      ? await db.promise().query(
          'SELECT * FROM omr_results WHERE scanned_test_id = ? AND user_id = ?',
          [req.params.id, userId]
        )
      : [[]];
    const sanitizedOmr = omrResults.map(r => {
      const { correct_answer, ...rest } = r;
      if (rest.marked_letters && typeof rest.marked_letters === 'string') {
        try { rest.marked_letters = JSON.parse(rest.marked_letters); } catch {}
      }
      return rest;
    });
    const [ocrExtractions] = completed
      ? await db.promise().query(
          'SELECT * FROM ocr_extractions WHERE scanned_test_id = ? AND user_id = ?',
          [req.params.id, userId]
        )
      : [[]];
    const [responses] = completed
      ? await db.promise().query(
          'SELECT * FROM exam_responses WHERE scanned_test_id = ? AND user_id = ?',
          [req.params.id, userId]
        )
      : [[]];
    scan.omrResults = sanitizedOmr;
    scan.ocrExtractions = ocrExtractions;
    scan.examResponse = responses[0] || null;
    res.json({ success: true, scan });
  } catch (error) {
    console.error('Get scan error:', error);
    res.status(500).json({ success: false, message: 'Failed to get scan', error: error.message });
  }
});

app.get('/api/scans', authenticateToken, async (req, res) => {
  try {
    const { classroom_id, status, limit = 50, offset = 0 } = req.query;
    const userId = req.user.userId;  // Get user ID from JWT token
    let query = `
      SELECT s.*, ak.exam_title, ak.subject, ak.answer_key_date, ak.epoch,
             CONCAT(st.first_name, ' ', st.last_name) as student_name,
             st.sequential_number
      FROM scanned_tests s
      LEFT JOIN answer_keys ak ON s.answer_key_id = ak.id
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.user_id = ?
    `;
    const params = [userId];
    if (classroom_id) { query += ' AND s.classroom_id = ?'; params.push(classroom_id); }
    if (status) { query += ' AND s.scan_status = ?'; params.push(status); }
    query += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), parseInt(offset));
    const [scans] = await db.promise().query(query, params);
    let countQuery = 'SELECT COUNT(*) as total FROM scanned_tests WHERE user_id = ?';
    const countParams = [userId];
    if (classroom_id) { countQuery += ' AND classroom_id = ?'; countParams.push(classroom_id); }
    if (status) { countQuery += ' AND scan_status = ?'; countParams.push(status); }
    const [countResult] = await db.promise().query(countQuery, countParams);
    res.json({ success: true, scans, total: countResult[0].total });
  } catch (error) {
    console.error('List scans error:', error);
    res.status(500).json({ success: false, message: 'Failed to list scans', error: error.message });
  }
});

app.delete('/api/scans/:id', authenticateToken, async (req, res) => {
  let connection;
  const userId = req.user.userId;  // Get user ID from JWT token
  try {
    connection = await db.promise();
    const [scans] = await connection.query('SELECT file_path FROM scanned_tests WHERE id = ? AND user_id = ?', [req.params.id, userId]);
    if (scans.length === 0) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    const scan = scans[0];
    await connection.beginTransaction();
    try {
      await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ?', [req.params.id]);
      await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ?', [req.params.id]);
      await connection.query('DELETE FROM exam_responses WHERE scanned_test_id = ?', [req.params.id]);
      await connection.query('DELETE FROM activity_logs WHERE scanned_test_id = ?', [req.params.id]);
      await connection.query('DELETE FROM scanned_tests WHERE id = ?', [req.params.id]);
      if (scan.file_path) {
        try {
          if (fs.existsSync(scan.file_path)) fs.unlinkSync(scan.file_path);
        } catch (fileErr) {
          console.warn('Failed to delete file:', scan.file_path, fileErr.message);
        }
      }
      await connection.commit();
      res.json({ success: true, message: 'Scan deleted successfully' });
    } catch (txError) {
      await connection.rollback();
      throw txError;
    }
  } catch (error) {
    console.error('Delete scan error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete scan', error: error.message });
  }
});

// ============================================================================
// PRINT SCORE ON EXAM SHEET ENDPOINT
// ============================================================================

/**
 * Print/Overlay the exam score onto the original scanned exam sheet image.
 * POST /api/scans/:id/print-score
 * The score text is rendered directly onto the image file (no new paper).
 * Uses sharp to composite the score text as an SVG overlay onto the image.
 */
app.post('/api/scans/:id/print-score', authenticateToken, async (req, res) => {
  const scanId = req.params.id;
  const userId = req.user.userId;  // Get user ID from JWT token
  const directPrintRequested = req.body?.directPrint === true;
  try {
    // Get scan info
    const [scans] = await db.promise().query(
      `SELECT s.id, s.file_path, s.student_name_detected, s.student_number_detected,
              ak.exam_title, ak.subject
       FROM scanned_tests s
       LEFT JOIN answer_keys ak ON s.answer_key_id = ak.id
       WHERE s.id = ? AND s.user_id = ?`,
      [scanId, userId]
    );

    if (scans.length === 0) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }

    const scan = scans[0];

    // Get exam response (score)
    const [responses] = await db.promise().query(
      `SELECT total_score, percentage, score_per_question_json, answers_json
       FROM exam_responses WHERE scanned_test_id = ?`,
      [scanId]
    );

    if (responses.length === 0) {
      return res.status(404).json({ success: false, message: 'No exam response found for this scan. Process the scan first.' });
    }

    const examResponse = responses[0];
    const score = examResponse.percentage;
    const totalScore = examResponse.total_score;

    // Read the original image
    if (!scan.file_path || !fs.existsSync(scan.file_path)) {
      return res.status(404).json({ success: false, message: 'Scanned image file not found on disk' });
    }

    const imageBuffer = fs.readFileSync(scan.file_path);
    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 800;
    const imgHeight = metadata.height || 600;

    // Score details for overlay
    const studentName = scan.student_name_detected || 'Student';
    const examTitle = scan.exam_title || 'Exam';
    const subject = scan.subject || '';

    // Build an SVG overlay with the score information to be placed at the bottom-right
    const scoreText = `${totalScore}/50`;

    const scoreSvg = `
      <svg width="80" height="300" xmlns="http://www.w3.org/2000/svg">
        <text x="40" y="150" font-family="Arial, sans-serif"
              font-size="22" fill="none" stroke="#ff0000" stroke-width="1.2"
              text-anchor="middle" font-weight="bold"
              transform="rotate(90 40 150)">${scoreText}</text>
      </svg>`;

    const scoreBuffer = await sharp(Buffer.from(scoreSvg))
      .png({ quality: 100 })
      .toBuffer();

    const scoreFileName = `score-${scanId}-${Date.now()}.png`;
    const scorePath = path.join(__dirname, '../uploads/scores', scoreFileName);
    if (!fs.existsSync(path.dirname(scorePath))) {
      fs.mkdirSync(path.dirname(scorePath), { recursive: true });
    }
    fs.writeFileSync(scorePath, scoreBuffer);

    const relativePath = `/uploads/scores/${scoreFileName}`;
    const imageUrl = `${req.protocol || 'http'}://${req.get('host')}${relativePath}`;

    let printedDirectly = false;
    let printerName = null;
    let directPrintError = null;
    if (directPrintRequested) {
      try {
        const printResult = await printImageWithWindowsDriver(scorePath);
        printedDirectly = true;
        printerName = printResult.printerName;
        console.log(`[PRINT] Score for scan ${scanId} submitted to ${printerName}`);
      } catch (printError) {
        directPrintError = printError.message;
        console.warn(`[PRINT] Direct print failed for scan ${scanId}: ${directPrintError}`);
      }
    }

    console.log(`✅ Score image generated for scan ID ${scanId}`);

    res.json({
      success: true,
      message: printedDirectly
        ? `Score ${scoreText} was sent to ${printerName}.`
        : `Score ${scoreText} is ready to print.`,
      totalScore: totalScore,
      scoreImageUrl: imageUrl,
      directPrintRequested,
      printedDirectly,
      printerName,
      directPrintError
    });
  } catch (error) {
    console.error('Print score error:', error);
    res.status(500).json({ success: false, message: 'Failed to print score on exam sheet', error: error.message });
  }
});

// ============================================================================
// IMAGE QUALITY ANALYSIS ENDPOINT
// ============================================================================

/**
 * Analyze image quality and blur level
 * POST /api/scans/:id/analyze-quality
 * Returns: { blurScore, sharpnessLevel, recommendation, canBeProcessed }
 */
app.post('/api/scans/:id/analyze-quality', authenticateToken, async (req, res) => {
  const scanId = req.params.id;
  const userId = req.user.userId;  // Get user ID from JWT token
  try {
    const [scans] = await db.promise().query(
      `SELECT id, file_path FROM scanned_tests WHERE id = ? AND user_id = ?`,
      [scanId, userId]
    );
    if (scans.length === 0) {
      return res.status(404).json({ success: false, message: 'Scan not found' });
    }
    const scan = scans[0];

    // Use the detectBlurLevel function from enhanced-scanner
    const blurScore = await EnhancedScanner.detectBlurLevel(
      fs.readFileSync(scan.file_path)
    );

    // Interpret blur score
    let sharpnessLevel, recommendation;
    if (blurScore < 0.2) {
      sharpnessLevel = 'EXCELLENT - Very Sharp';
      recommendation = 'Image is perfectly sharp, no sharpening needed';
    } else if (blurScore < 0.4) {
      sharpnessLevel = 'GOOD - Minor Blur';
      recommendation = 'Slight blur detected, will be sharpened during processing';
    } else if (blurScore < 0.6) {
      sharpnessLevel = 'FAIR - Moderate Blur';
      recommendation = 'Moderate blur detected, will apply aggressive sharpening';
    } else if (blurScore < 0.8) {
      sharpnessLevel = 'POOR - Significant Blur';
      recommendation = 'Significant blur, multiple sharpening passes will be applied';
    } else {
      sharpnessLevel = 'VERY POOR - Severe Blur';
      recommendation = 'Image too blurry, may have reduced accuracy despite sharpening';
    }

    // All images can be processed, but quality varies
    const canBeProcessed = blurScore < 0.95;

    res.json({
      success: true,
      quality: {
        blurScore: parseFloat((blurScore * 100).toFixed(1)),
        sharpnessLevel,
        recommendation,
        canBeProcessed,
        processingStrategy: 'Adaptive sharpening based on blur level'
      }
    });
  } catch (error) {
    console.error('Image quality analysis error:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to analyze image quality', 
      error: error.message 
    });
  }
});

// ============================================================================
// CLASSROOM ROUTES
// ============================================================================

app.get('/api/classrooms', authenticateToken, async (req, res) => {
  try {
    console.log('GET /api/classrooms called');
    const userId = req.user.userId;  // Get user ID from JWT token
    const [classrooms] = await db.promise().query(`
      SELECT 
        c.id, c.name, c.section, c.teacher, c.is_active,
        c.created_at, c.updated_at, c.deleted_at, c.deleted_by,
        COUNT(s.id) as student_count
       FROM classrooms c
       LEFT JOIN students s ON c.id = s.classroom_id AND s.deleted_at IS NULL
       WHERE c.deleted_at IS NULL AND c.user_id = ?
       GROUP BY c.id
       ORDER BY c.name, c.section
     `, [userId]);
    console.log(`Retrieved ${classrooms.length} classrooms from database`);
    res.json({ success: true, classrooms });
  } catch (error) {
    console.error('Get classrooms error:', error);
    res.status(500).json({ success: false, message: 'Failed to get classrooms', error: error.message });
  }
});

app.get('/api/classrooms/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const [classrooms] = await db.promise().query(`
      SELECT 
        c.id, c.name, c.section, c.teacher, c.is_active,
        c.created_at, c.updated_at, c.deleted_at, c.deleted_by,
        COUNT(s.id) as student_count
      FROM classrooms c
      LEFT JOIN students s ON c.id = s.classroom_id AND s.deleted_at IS NULL
      WHERE c.id = ? AND c.deleted_at IS NULL AND c.user_id = ?
      GROUP BY c.id
    `, [req.params.id, userId]);
    if (classrooms.length === 0) return res.status(404).json({ success: false, message: 'Classroom not found' });
    res.json({ success: true, classroom: classrooms[0] });
  } catch (error) {
    console.error('Get classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to get classroom', error: error.message });
  }
});

app.post('/api/classrooms', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const { name, section, teacher } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Classroom name is required' });

    console.log('Creating classroom:', { name, section, teacher });

    // Check if classroom with same name/section already exists for this user (excluding soft deleted)
    const [existing] = await db.promise().query(
      'SELECT id FROM classrooms WHERE name = ? AND section = ? AND user_id = ? AND deleted_at IS NULL',
      [name, section || '', userId]
    );

    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        message: 'Classroom with this name and section already exists'
      });
    }

    const [result] = await db.promise().query(
      'INSERT INTO classrooms (user_id, name, section, teacher, is_active) VALUES (?, ?, ?, ?, TRUE)',
      [userId, name, section || null, teacher || null]
    );

    console.log('Insert result:', result);

    const [newClassroom] = await db.promise().query(
      'SELECT id, name, section, teacher, is_active, created_at, updated_at FROM classrooms WHERE id = ?',
      [result.insertId]
    );

    console.log('New classroom:', newClassroom[0]);

    if (newClassroom.length === 0) {
      console.error('Classroom not found after creation');
      return res.status(500).json({ success: false, message: 'Failed to retrieve created classroom' });
    }

    console.log('✅ Classroom created successfully:', newClassroom[0].id);
    res.status(201).json({ success: true, message: 'Classroom created', classroom: newClassroom[0] });
  } catch (error) {
    console.error('Create classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to create classroom', error: error.message });
  }
});

app.put('/api/classrooms/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const { name, section, teacher } = req.body;

    // Check for conflicts (exclude current classroom and scope by user)
    if (name) {
      const [existing] = await db.promise().query(
        'SELECT id FROM classrooms WHERE name = ? AND section = ? AND user_id = ? AND id != ? AND deleted_at IS NULL',
        [name, section || '', userId, req.params.id]
      );
      if (existing.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Classroom with this name and section already exists'
        });
      }
    }

    const [result] = await db.promise().query(
      `UPDATE classrooms SET 
        name = ?, 
        section = ?, 
        teacher = ?, 
        updated_at = NOW()
       WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      [name, section || null, teacher || null, req.params.id, req.user.userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }

    const [updated] = await db.promise().query(`
      SELECT 
        c.id, c.name, c.section, c.teacher, c.is_active,
        c.created_at, c.updated_at, c.deleted_at, c.deleted_by,
        COUNT(s.id) as student_count
      FROM classrooms c
      LEFT JOIN students s ON c.id = s.classroom_id AND s.deleted_at IS NULL
      WHERE c.id = ?
      GROUP BY c.id
    `, [req.params.id]);

    res.json({ success: true, message: 'Classroom updated', classroom: updated[0] });
  } catch (error) {
    console.error('Update classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to update classroom', error: error.message });
  }
});

app.delete('/api/classrooms/:id', authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await db.promise();
    await connection.beginTransaction();

    // Get all student IDs in this classroom
    const [students] = await connection.query('SELECT id FROM students WHERE classroom_id = ?', [req.params.id]);
    const studentIds = students.map((s) => s.id);

    // Collect all scans to delete: direct scans + scans from students
    const [directScans] = await connection.query('SELECT id, file_path FROM scanned_tests WHERE classroom_id = ?', [req.params.id]);
    let scansToDelete = [...directScans];

    if (studentIds.length > 0) {
      const placeholders = studentIds.map(() => '?').join(',');
      const [studentScans] = await connection.query(`SELECT id, file_path FROM scanned_tests WHERE student_id IN (${placeholders})`, studentIds);
      const existingIds = new Set(scansToDelete.map(s => s.id));
      for (const scan of studentScans) {
        if (!existingIds.has(scan.id)) {
          scansToDelete.push(scan);
          existingIds.add(scan.id);
        }
      }
    }

    // Delete child records for each scan and remove files
    for (const scan of scansToDelete) {
      await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM exam_responses WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM activity_logs WHERE scanned_test_id = ?', [scan.id]);
      if (scan.file_path) {
        try {
          if (fs.existsSync(scan.file_path)) fs.unlinkSync(scan.file_path);
        } catch (fileErr) {
          console.warn('Failed to delete file:', scan.file_path, fileErr.message);
        }
      }
    }

    // Delete scans themselves (batched)
    if (scansToDelete.length > 0) {
      const scanIds = scansToDelete.map(s => s.id);
      for (let i = 0; i < scanIds.length; i += 100) {
        const batch = scanIds.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        await connection.query(`DELETE FROM scanned_tests WHERE id IN (${placeholders})`, batch);
      }
    }

    // Delete all students in this classroom
    if (studentIds.length > 0) {
      for (let i = 0; i < studentIds.length; i += 100) {
        const batch = studentIds.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        await connection.query(`DELETE FROM students WHERE id IN (${placeholders})`, batch);
      }
    }

    // Finally delete the classroom
    const [result] = await connection.query('DELETE FROM classrooms WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }

    await connection.commit();
    res.json({ success: true, message: 'Classroom deleted' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Delete classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete classroom', error: error.message });
  }
});

// ============================================================================
// STUDENT ROUTES
// ============================================================================

app.get('/api/students', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const { classroom_id, student_number, q } = req.query;
    let query = `SELECT s.*, c.name as classroom_name, c.section as classroom_section FROM students s 
      LEFT JOIN classrooms c ON s.classroom_id = c.id 
      WHERE s.deleted_at IS NULL AND s.user_id = ?`;
    const params = [userId];
    if (classroom_id) { query += ' AND s.classroom_id = ?'; params.push(classroom_id); }
    if (student_number) { query += ' AND s.student_number = ?'; params.push(student_number); }
     if (q) {
       query += ' AND (s.first_name LIKE ? OR s.middle_name LIKE ? OR s.last_name LIKE ? OR s.student_number LIKE ? OR s.sequential_number LIKE ?)';
       const likeQ = `%${q}%`;
       params.push(likeQ, likeQ, likeQ, likeQ, likeQ);
     }
    query += ' ORDER BY s.sequential_number, s.last_name, s.first_name';
    const [students] = await db.promise().query(query, params);
    res.json({ success: true, students });
  } catch (error) {
    console.error('Get students error:', error);
    res.status(500).json({ success: false, message: 'Failed to get students', error: error.message });
  }
});

app.get('/api/students/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const [students] = await db.promise().query('SELECT * FROM students WHERE id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.id, userId]);
    if (students.length === 0) return res.status(404).json({ success: false, message: 'Student not found' });
    res.json({ success: true, student: students[0] });
  } catch (error) {
    console.error('Get student error:', error);
    res.status(500).json({ success: false, message: 'Failed to get student', error: error.message });
  }
});

app.post('/api/students', authenticateToken, async (req, res) => {
  try {
    const { student_number, first_name, middle_name, last_name, gender, email, phone, classroom_id, sequential_number } = req.body;
    if (!student_number || !first_name || !middle_name || !last_name) {
      return res.status(400).json({ success: false, message: 'Student number, first name, middle name, and last name are required' });
    }
    const normalizedGender = gender ? String(gender).trim().toLowerCase() : null;
    if (normalizedGender && !['male', 'female'].includes(normalizedGender)) {
      return res.status(400).json({ success: false, message: 'Gender must be male or female' });
    }
    
    let finalSequentialNumber = sequential_number;
    if (!finalSequentialNumber && classroom_id) {
      const [maxRows] = await db.promise().query(
        'SELECT MAX(sequential_number) as max_seq FROM students WHERE user_id = ? AND classroom_id = ?',
        [req.user.userId, classroom_id]
      );
      finalSequentialNumber = (maxRows[0].max_seq || 0) + 1;
    } else if (!finalSequentialNumber) {
      finalSequentialNumber = 1;
    }

    const [result] = await db.promise().query(
      'INSERT INTO students (user_id, student_number, first_name, middle_name, last_name, gender, email, phone, classroom_id, sequential_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [req.user.userId, student_number, first_name, middle_name, last_name, normalizedGender, email || null, phone || null, classroom_id || null, finalSequentialNumber]
    );
    const [newStudent] = await db.promise().query('SELECT * FROM students WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Student created', student: newStudent[0] });
  } catch (error) {
    console.error('Create student error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Student number already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create student', error: error.message });
  }
});

app.put('/api/students/:id', authenticateToken, async (req, res) => {
  try {
    const { student_number, first_name, middle_name, last_name, gender, email, phone, classroom_id, sequential_number } = req.body;
    if (!first_name || !middle_name || !last_name) {
      return res.status(400).json({ success: false, message: 'First name, middle name, and last name are required' });
    }
    const normalizedGender = gender ? String(gender).trim().toLowerCase() : null;
    if (normalizedGender && !['male', 'female'].includes(normalizedGender)) {
      return res.status(400).json({ success: false, message: 'Gender must be male or female' });
    }

    const [existingRows] = await db.promise().query(
      'SELECT classroom_id, sequential_number FROM students WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [req.params.id, req.user.userId]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const existingStudent = existingRows[0];
    const targetClassroomId = classroom_id || null;
    const classroomChanged = Number(existingStudent.classroom_id || 0) !== Number(targetClassroomId || 0);
    let finalSequentialNumber = Number(sequential_number) > 0
      ? Number(sequential_number)
      : Number(existingStudent.sequential_number || 1);

    if (classroomChanged && targetClassroomId) {
      const [maxRows] = await db.promise().query(
        'SELECT MAX(sequential_number) AS max_seq FROM students WHERE user_id = ? AND classroom_id = ? AND deleted_at IS NULL',
        [req.user.userId, targetClassroomId]
      );
      finalSequentialNumber = Number(maxRows[0]?.max_seq || 0) + 1;
    }

    const [result] = await db.promise().query(
      'UPDATE students SET student_number = ?, first_name = ?, middle_name = ?, last_name = ?, gender = COALESCE(?, gender), email = ?, phone = ?, classroom_id = ?, sequential_number = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [student_number, first_name, middle_name, last_name, normalizedGender, email || null, phone || null, targetClassroomId, finalSequentialNumber, req.params.id, req.user.userId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Student not found' });
    const [updated] = await db.promise().query('SELECT * FROM students WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Student updated', student: updated[0] });
  } catch (error) {
    console.error('Update student error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      const sequenceConflict = String(error.message || '').includes('unique_user_classroom_sequential');
      return res.status(409).json({
        success: false,
        message: sequenceConflict
          ? 'That sequence number is already assigned in this classroom'
          : 'Student number already exists'
      });
    }
    res.status(500).json({ success: false, message: 'Failed to update student', error: error.message });
  }
});

app.delete('/api/students/:id', authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await db.promise();
    await connection.beginTransaction();

    // First verify the student belongs to this user
    const [students] = await connection.query('SELECT id FROM students WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
    if (students.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const studentId = students[0].id;

    // Get all scans for this student (to delete related data and files)
    const [scans] = await connection.query('SELECT id, file_path FROM scanned_tests WHERE user_id = ? AND student_id = ?', [req.user.userId, studentId]);

    // Delete child records for each scan and remove files
    for (const scan of scans) {
      await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM activity_logs WHERE scanned_test_id = ?', [scan.id]);
      if (scan.file_path) {
        try {
          if (fs.existsSync(scan.file_path)) fs.unlinkSync(scan.file_path);
        } catch (fileErr) {
          console.warn('Failed to delete file:', scan.file_path, fileErr.message);
        }
      }
    }

    // Delete the scans themselves
    await connection.query('DELETE FROM scanned_tests WHERE user_id = ? AND student_id = ?', [req.user.userId, studentId]);

    // exam_responses for this student will cascade automatically via FK constraint
    // Finally delete the student
    const [result] = await connection.query('DELETE FROM students WHERE id = ? AND user_id = ?', [studentId, req.user.userId]);

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await connection.commit();
    res.json({ success: true, message: 'Student deleted' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Delete student error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete student', error: error.message });
  }
});

// ============================================================================
// ANSWER KEY ROUTES
// ============================================================================

app.get('/api/answer-keys', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const [answerKeys] = await db.promise().query(`
      SELECT ak.*, CONCAT(u.first_name, ' ', u.last_name) as created_by_name,
             c.name AS classroom_name, c.section AS classroom_section
      FROM answer_keys ak
      LEFT JOIN users u ON ak.user_id = u.id
      LEFT JOIN classrooms c ON c.id = ak.classroom_id
      WHERE ak.is_active = TRUE AND ak.user_id = ?
      ORDER BY ak.answer_key_date DESC, ak.created_at DESC
    `, [userId]);
    res.json({ success: true, answerKeys });
  } catch (error) {
    console.error('Get answer keys error:', error);
    res.status(500).json({ success: false, message: 'Failed to get answer keys', error: error.message });
  }
});

app.get('/api/answer-keys/:id', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    const [answerKeys] = await db.promise().query('SELECT * FROM answer_keys WHERE id = ? AND user_id = ? AND is_active = TRUE', [req.params.id, userId]);
    if (answerKeys.length === 0) return res.status(404).json({ success: false, message: 'Answer key not found' });
    res.json({ success: true, answerKey: answerKeys[0] });
  } catch (error) {
    console.error('Get answer key error:', error);
    res.status(500).json({ success: false, message: 'Failed to get answer key', error: error.message });
  }
});

app.post('/api/answer-keys', authenticateToken, async (req, res) => {
  try {
    const { subject, classroom_id, exam_title, num_questions, answer_key_json } = req.body;
    const classroomId = Number(classroom_id || subject);
    if (!classroomId || !exam_title || !answer_key_json) {
      return res.status(400).json({ success: false, message: 'Classroom, exam title, and answer key are required' });
    }
    const expectedCount = Number.parseInt(num_questions, 10);
    const normalizedAnswerKey = String(answer_key_json).toUpperCase().replace(/\s/g, '');
    if (expectedCount !== 50 || !/^[A-D]{50}$/.test(normalizedAnswerKey)) {
      return res.status(400).json({
        success: false,
        message: 'AcadCheck answer sheets require exactly 50 answers using A, B, C, or D',
      });
    }
    const [classrooms] = await db.promise().query(
      'SELECT id, name, section FROM classrooms WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [classroomId, req.user.userId]
    );
    if (classrooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }
    const finalDate = new Date().toISOString().split('T')[0];
    const qrToken = crypto.randomBytes(16).toString('hex');
    const [result] = await db.promise().query(
      `INSERT INTO answer_keys
         (user_id, classroom_id, subject, exam_title, num_questions, answer_key_json,
          answer_key_date, epoch, qr_token, print_status, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pending', ?)`,
      [req.user.userId, classroomId, String(classroomId), exam_title, expectedCount,
       normalizedAnswerKey, finalDate, qrToken, req.user.userId]
    );
    const [newKey] = await db.promise().query(
      `SELECT ak.*, c.name AS classroom_name, c.section AS classroom_section
       FROM answer_keys ak
       LEFT JOIN classrooms c ON c.id = ak.classroom_id
       WHERE ak.id = ?`,
      [result.insertId]
    );
    res.status(201).json({
      success: true,
      message: 'Answer key created with QR code',
      answerKey: newKey[0],
      printPrompt: true
    });
  } catch (error) {
    console.error('Create answer key error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'An answer key with this title already exists for your account.' });
    }
    res.status(500).json({ success: false, message: 'Failed to create answer key', error: error.message });
  }
});

app.put('/api/answer-keys/:id', authenticateToken, async (req, res) => {
  try {
    const { subject, classroom_id, exam_title, num_questions, answer_key_json, is_active } = req.body;
    const targetClassroomId = Number(classroom_id || subject);
    const [current] = await db.promise().query(
      'SELECT is_active, classroom_id, answer_key_date FROM answer_keys WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    if (current.length === 0) return res.status(404).json({ success: false, message: 'Answer key not found' });
    const currentIsActive = current.length > 0 ? current[0].is_active : true;
    const normalizedAnswerKey = String(answer_key_json || '').toUpperCase().replace(/\s/g, '');
    if (Number.parseInt(num_questions, 10) !== 50 || !/^[A-D]{50}$/.test(normalizedAnswerKey)) {
      return res.status(400).json({
        success: false,
        message: 'AcadCheck answer sheets require exactly 50 answers using A, B, C, or D',
      });
    }
    const finalClassroomId = targetClassroomId || current[0].classroom_id;
    const [classrooms] = await db.promise().query(
      'SELECT id FROM classrooms WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      [finalClassroomId, req.user.userId]
    );
    if (classrooms.length === 0) return res.status(404).json({ success: false, message: 'Classroom not found' });
    const [result] = await db.promise().query(
      `UPDATE answer_keys
       SET classroom_id = ?, subject = ?, exam_title = ?, num_questions = ?,
           answer_key_json = ?, is_active = ?, updated_at = NOW()
       WHERE id = ? AND user_id = ?`,
      [finalClassroomId, String(finalClassroomId), exam_title, 50,
       normalizedAnswerKey, is_active !== undefined ? is_active : currentIsActive,
       req.params.id, req.user.userId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Answer key not found' });
    const [updated] = await db.promise().query('SELECT * FROM answer_keys WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Answer key updated', answerKey: updated[0] });
  } catch (error) {
    console.error('Update answer key error:', error);
    res.status(500).json({ success: false, message: 'Failed to update answer key', error: error.message });
  }
});

app.get('/api/answer-keys/:id/answer-sheet', authenticateToken, async (req, res) => {
  try {
    const [rows] = await db.promise().query(
      `SELECT ak.id, ak.exam_title, ak.num_questions, ak.answer_key_json, ak.qr_token,
              c.name AS classroom_name, c.section AS classroom_section
       FROM answer_keys ak
       JOIN classrooms c ON c.id = ak.classroom_id
       WHERE ak.id = ? AND ak.user_id = ? AND ak.is_active = TRUE`,
      [req.params.id, req.user.userId]
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Answer key not found' });
    const answerKey = rows[0];
    if (Number(answerKey.num_questions) !== 50
        || !/^[A-D]{50}$/.test(String(answerKey.answer_key_json || '').replace(/\s/g, ''))) {
      return res.status(409).json({
        success: false,
        message: 'This key is not compatible with the AcadCheck 50-question A–D answer sheet',
      });
    }
    if (!answerKey.qr_token) {
      answerKey.qr_token = crypto.randomBytes(16).toString('hex');
      await db.promise().query(
        'UPDATE answer_keys SET qr_token = ?, print_status = ? WHERE id = ? AND user_id = ?',
        [answerKey.qr_token, 'pending', answerKey.id, req.user.userId]
      );
    }
    const classroomName = `${answerKey.classroom_name}${answerKey.classroom_section ? ` ${answerKey.classroom_section}` : ''}`;
    const generated = await generateAnswerSheet({
      classroomName,
      answerKeyId: answerKey.id,
      qrToken: answerKey.qr_token,
    });
    const safeTitle = String(answerKey.exam_title || 'answer-sheet').replace(/[^a-z0-9_-]+/gi, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}-answer-sheet.docx"`);
    res.send(generated.buffer);
  } catch (error) {
    console.error('Generate answer sheet error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate answer sheet', error: error.message });
  }
});

app.post('/api/answer-keys/:id/print-status', authenticateToken, async (req, res) => {
  try {
    const status = req.body?.status === 'printed' ? 'printed' : 'pending';
    const [result] = await db.promise().query(
      `UPDATE answer_keys
       SET print_status = ?, printed_at = CASE WHEN ? = 'printed' THEN NOW() ELSE NULL END
       WHERE id = ? AND user_id = ?`,
      [status, status, req.params.id, req.user.userId]
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Answer key not found' });
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update print status', error: error.message });
  }
});

app.delete('/api/answer-keys/:id', authenticateToken, async (req, res) => {
  let connection;
  try {
    connection = await db.promise();
    await connection.beginTransaction();
    
    // Verify the answer key belongs to this user
    const [keyCheck] = await connection.query('SELECT id FROM answer_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
    if (keyCheck.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Answer key not found' });
    }
    
    try {
      // Hard delete the answer key (cascade will handle exam_responses, SET NULL for scanned_tests)
      await connection.query('DELETE FROM answer_keys WHERE id = ? AND user_id = ?', [req.params.id, req.user.userId]);
      await connection.commit();
      res.json({ success: true, message: 'Answer key deleted successfully' });
    } catch (txError) {
      await connection.rollback();
      throw txError;
    }
  } catch (error) {
    console.error('Delete answer key error:', error);
    if (error.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ success: false, message: 'Cannot delete answer key: It is still referenced by other records.' });
    }
    res.status(500).json({ success: false, message: 'Failed to delete answer key', error: error.message });
  }
});

// ============================================================================
// EXAM RESPONSE ROUTES
// ============================================================================

app.get('/api/exam-responses', authenticateToken, async (req, res) => {
  try {
       const { student_id, classroom_id, limit = 50 } = req.query;
       let query = `
         SELECT er.*, s.first_name, s.middle_name, s.last_name, s.student_number,
                ak.exam_title, ak.subject,
                st.student_name_detected, st.student_number_detected
         FROM exam_responses er
         JOIN answer_keys ak ON er.answer_key_id = ak.id
         LEFT JOIN students s ON er.student_id = s.id
         LEFT JOIN scanned_tests st ON er.scanned_test_id = st.id
         WHERE er.user_id = ?
       `;
       const params = [req.user.userId];
    if (student_id) { query += ' AND (er.student_id = ? OR st.student_number_detected = ?)'; params.push(student_id, student_id); }
    if (classroom_id) { query += ' AND (s.classroom_id = ? OR st.classroom_id = ?)'; params.push(classroom_id, classroom_id); }
    query += ' ORDER BY er.created_at DESC LIMIT ?';
    params.push(parseInt(limit));
    const [responses] = await db.promise().query(query, params);
    res.json({ success: true, responses });
  } catch (error) {
    console.error('Get exam responses error:', error);
    res.status(500).json({ success: false, message: 'Failed to get exam responses', error: error.message });
  }
});

app.get('/api/exam-responses/:id', authenticateToken, async (req, res) => {
  try {
      const [responses] = await db.promise().query(`
        SELECT er.*, s.first_name, s.middle_name, s.last_name, s.student_number, ak.exam_title, ak.subject
        FROM exam_responses er
        JOIN students s ON er.student_id = s.id
        JOIN answer_keys ak ON er.answer_key_id = ak.id
        WHERE er.id = ? AND er.user_id = ?
      `, [req.params.id, req.user.userId]);
    if (responses.length === 0) return res.status(404).json({ success: false, message: 'Exam response not found' });
    const response = responses[0];
    const answers = JSON.parse(response.answers_json);
    const scorePerQuestion = JSON.parse(response.score_per_question_json || '{}');
    res.json({ success: true, response: { ...response, answers, scorePerQuestion } });
  } catch (error) {
    console.error('Get exam response error:', error);
    res.status(500).json({ success: false, message: 'Failed to get exam response', error: error.message });
  }
});

app.put('/api/exam-responses/:id', authenticateToken, async (req, res) => {
  try {
    const requestedScore = Number(req.body.total_score);
    if (!Number.isFinite(requestedScore) || requestedScore < 0 || requestedScore > 50) {
      return res.status(400).json({ success: false, message: 'Score must be between 0 and 50' });
    }
    const total_score = Math.round(requestedScore);
    const percentage = calculateGradingPercentage(total_score, 50);
    const [result] = await db.promise().query(
      `UPDATE exam_responses SET total_score = ?, percentage = ? WHERE id = ? AND user_id = ?`,
      [total_score, percentage, req.params.id, req.user.userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Exam response not found' });
    }
    const [updated] = await db.promise().query(
      'SELECT * FROM exam_responses WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    res.json({ success: true, message: 'Score updated', response: updated[0] });
  } catch (error) {
    console.error('Update exam response error:', error);
    res.status(500).json({ success: false, message: 'Failed to update score', error: error.message });
  }
});

app.post('/api/exam-responses/bulk-delete', authenticateToken, async (req, res) => {
  try {
    const responseIds = Array.isArray(req.body?.response_ids)
      ? [...new Set(req.body.response_ids.map(Number).filter(Number.isInteger))]
      : [];

    if (responseIds.length === 0) {
      return res.status(400).json({ success: false, message: 'Select at least one exam result to delete' });
    }
    if (responseIds.length > 2000) {
      return res.status(400).json({ success: false, message: 'A maximum of 2000 results can be deleted at once' });
    }

    const placeholders = responseIds.map(() => '?').join(',');
    const [result] = await db.promise().query(
      `DELETE FROM exam_responses WHERE user_id = ? AND id IN (${placeholders})`,
      [req.user.userId, ...responseIds]
    );

    res.json({
      success: true,
      message: `${result.affectedRows} exam result(s) deleted`,
      deletedCount: result.affectedRows
    });
  } catch (error) {
    console.error('Bulk delete exam responses error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete selected results', error: error.message });
  }
});

app.delete('/api/exam-responses/:id', authenticateToken, async (req, res) => {
  try {
    const [result] = await db.promise().query(
      'DELETE FROM exam_responses WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.userId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: 'Exam response not found' });
    }
    res.json({ success: true, message: 'Exam response deleted' });
  } catch (error) {
    console.error('Delete exam response error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete response', error: error.message });
  }
});

app.get('/api/analytics/questions', authenticateToken, async (req, res) => {
  try {
    const { exam_title, classroom_name } = req.query;
    let where = 'WHERE omr.user_id = ?';
    const params = [req.user.userId];
    if (exam_title && exam_title !== 'All Exams') {
      where += ' AND ak.exam_title = ?';
      params.push(exam_title);
    }
    if (classroom_name && classroom_name !== 'All Classrooms') {
      where += ` AND TRIM(CONCAT(c.name, ' ', COALESCE(c.section, ''))) = ?`;
      params.push(classroom_name);
    }

    const [rows] = await db.promise().query(
      `SELECT omr.question_number,
              COUNT(*) AS attempts,
              SUM(CASE WHEN omr.is_correct = TRUE THEN 1 ELSE 0 END) AS correct_count,
              SUM(CASE WHEN omr.is_correct = TRUE THEN 0 ELSE 1 END) AS wrong_count
       FROM omr_results omr
       JOIN scanned_tests st ON st.id = omr.scanned_test_id AND st.user_id = omr.user_id
       LEFT JOIN answer_keys ak ON ak.id = st.answer_key_id
       LEFT JOIN classrooms c ON c.id = st.classroom_id
       ${where}
       GROUP BY omr.question_number
       ORDER BY omr.question_number`,
      params
    );

    const questionStats = rows.map(row => {
      const attempts = Number(row.attempts || 0);
      const correct = Number(row.correct_count || 0);
      const wrong = Number(row.wrong_count || 0);
      return {
        questionNumber: Number(row.question_number),
        attempts,
        correct,
        wrong,
        correctRate: attempts ? Number(((correct / attempts) * 100).toFixed(1)) : 0,
        wrongRate: attempts ? Number(((wrong / attempts) * 100).toFixed(1)) : 0,
      };
    });
    const attempted = questionStats.reduce((sum, row) => sum + row.attempts, 0);
    const studentResponses = questionStats.reduce((highest, row) => Math.max(highest, row.attempts), 0);
    const correctTotal = questionStats.reduce((sum, row) => sum + row.correct, 0);
    const byCorrect = [...questionStats].sort((a, b) => b.correctRate - a.correctRate || b.correct - a.correct);
    const byWrong = [...questionStats].sort((a, b) => b.wrongRate - a.wrongRate || b.wrong - a.wrong);
    const mostCorrect = byCorrect[0] || null;
    const mostWrong = byWrong[0] || null;
    const recommendations = [];
    if (mostWrong) {
      recommendations.push(`Review question ${mostWrong.questionNumber}; ${mostWrong.wrongRate}% of ${mostWrong.attempts} student responses were incorrect.`);
    }
    if (mostCorrect) {
      recommendations.push(`Question ${mostCorrect.questionNumber} shows the strongest mastery at ${mostCorrect.correctRate}% correct.`);
    }
    const difficultQuestions = byWrong.filter(row => row.wrongRate >= 50).slice(0, 5);
    if (difficultQuestions.length > 1) {
      recommendations.push(`Prioritize questions ${difficultQuestions.map(row => row.questionNumber).join(', ')} for reteaching or item review.`);
    }

    res.json({
      success: true,
      overview: {
        totalResponses: studentResponses,
        overallCorrectRate: attempted ? Number(((correctTotal / attempted) * 100).toFixed(1)) : 0,
        questionsAnalyzed: questionStats.length,
      },
      mostCorrect,
      mostWrong,
      difficultQuestions,
      recommendations,
      questionStats,
    });
  } catch (error) {
    console.error('Question analytics error:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze question performance', error: error.message });
  }
});

app.get('/api/records', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { classroom_id, exam_id } = req.query;

    let query = `
      SELECT 
        c.id as classroom_id,
        c.name as classroom_name,
        c.section as classroom_section,
        s.id as student_id,
        s.student_number,
        s.sequential_number,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.gender,
        er.id as response_id,
        er.total_score,
        er.percentage,
        er.is_graded,
        er.created_at as graded_at,
        ak.id as answer_key_id,
        ak.exam_title,
        ak.subject,
        ak.num_questions
      FROM classrooms c
      JOIN students s ON s.classroom_id = c.id AND s.deleted_at IS NULL AND s.user_id = ?
      LEFT JOIN exam_responses er ON er.student_id = s.id AND er.user_id = ?
      LEFT JOIN answer_keys ak ON ak.id = er.answer_key_id AND ak.user_id = ?
      WHERE c.user_id = ? AND c.deleted_at IS NULL
    `;
    const params = [userId, userId, userId, userId];
    if (classroom_id) { query += ' AND c.id = ?'; params.push(classroom_id); }
    if (exam_id) { query += ' AND ak.id = ?'; params.push(exam_id); }
    query += ' ORDER BY c.name, s.sequential_number, s.last_name, s.first_name';

    const [records] = await db.promise().query(query, params);
    res.json({ success: true, records });
  } catch (error) {
    console.error('Get records error:', error);
    res.status(500).json({ success: false, message: 'Failed to get records', error: error.message });
  }
});

app.get('/api/export/records', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { classroom_id } = req.query;

    let query = `
      SELECT 
        c.name as classroom_name,
        c.section as classroom_section,
        s.student_number,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.gender,
        er.total_score,
        er.percentage,
        er.is_graded,
        er.created_at as graded_at,
        ak.exam_title,
        ak.subject
      FROM classrooms c
      JOIN students s ON s.classroom_id = c.id AND s.deleted_at IS NULL AND s.user_id = ?
      LEFT JOIN exam_responses er ON er.student_id = s.id AND er.user_id = ?
      LEFT JOIN answer_keys ak ON ak.id = er.answer_key_id AND ak.user_id = ?
      WHERE c.user_id = ? AND c.deleted_at IS NULL
    `;
    const params = [userId, userId, userId, userId];
    if (classroom_id) { query += ' AND c.id = ?'; params.push(classroom_id); }
    query += ' ORDER BY c.name, s.sequential_number, s.last_name, s.first_name';

    const [records] = await db.promise().query(query, params);

    const headers = ['Classroom', 'Section', 'Student Number', 'First Name', 'Middle Name', 'Last Name', 'Gender', 'Score', 'Percentage', 'Status', 'Graded At', 'Exam Title', 'Subject'];
    const rows = records.map(r => [
      r.classroom_name,
      r.classroom_section || '',
      r.student_number,
      r.first_name,
      r.middle_name || '',
      r.last_name,
      r.gender || '',
      r.total_score ?? '',
      r.percentage ?? '',
      r.is_graded ? 'Graded' : 'Not Graded',
      r.graded_at ? r.graded_at.split(' ')[0] : '',
      r.exam_title || '',
      r.subject || ''
    ]);

    const csvContent = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    res.header('Content-Type', 'text/csv');
    res.header('Content-Disposition', 'attachment; filename="records.csv"');
    res.send(csvContent);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: 'Failed to export records', error: error.message });
  }
});

const Excel = require('exceljs');

app.get('/api/export/records/excel', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { classroom_id } = req.query;

    let query = `
      SELECT
        c.name as classroom_name,
        c.section as classroom_section,
        c.id as classroom_id,
        s.student_number,
        s.first_name,
        s.middle_name,
        s.last_name,
        s.gender,
        er.total_score,
        er.percentage,
        er.is_graded,
        er.created_at as graded_at,
        ak.exam_title,
        ak.subject
      FROM classrooms c
      JOIN students s ON s.classroom_id = c.id AND s.deleted_at IS NULL AND s.user_id = ?
      LEFT JOIN exam_responses er ON er.student_id = s.id AND er.user_id = ?
      LEFT JOIN answer_keys ak ON ak.id = er.answer_key_id AND ak.user_id = ?
      WHERE c.user_id = ? AND c.deleted_at IS NULL
    `;
    const params = [userId, userId, userId, userId];
    if (classroom_id) { query += ' AND c.id = ?'; params.push(classroom_id); }
    query += ' ORDER BY c.name, s.sequential_number, s.last_name, s.first_name';

    const [records] = await db.promise().query(query, params);

    const workbook = new Excel.Workbook();
    workbook.creator = 'AcadCheck';
    workbook.created = new Date();

    const passedRecords = records.filter((r) => r.percentage != null && r.percentage >= PASSING_GRADING_PERCENTAGE);
    const failedRecords = records.filter((r) => r.percentage != null && r.percentage < PASSING_GRADING_PERCENTAGE);
    const noResultRecords = records.filter((r) => r.percentage == null);

    const baseHeaders = ['Classroom', 'Section', 'Student Number', 'First Name', 'Middle Name', 'Last Name', 'Gender', 'Score', 'Percentage', 'Status', 'Exam Title', 'Graded At'];

    const addSheet = (sheetName, data) => {
      const sheet = workbook.addWorksheet(sheetName);
      sheet.columns = baseHeaders.map(h => ({ key: h, width: 18 }));

      const lastColumn = sheet.getColumn(baseHeaders.length).letter;
      const titleRows = [
        'COLLEGE OF COMPUTING AND INFORMATION SCIENCE',
        'Examination',
        'Academic Year 2025-2026'
      ];
      titleRows.forEach((title, index) => {
        const rowNumber = index + 1;
        sheet.mergeCells(`A${rowNumber}:${lastColumn}${rowNumber}`);
        const cell = sheet.getCell(`A${rowNumber}`);
        cell.value = title;
        cell.alignment = { horizontal: 'center', vertical: 'middle' };
        cell.font = {
          bold: true,
          size: index === 0 ? 16 : 12,
          color: { argb: 'FFFFFFFF' }
        };
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: index === 0 ? 'FF1B5E20' : 'FF2E7D32' }
        };
        sheet.getRow(rowNumber).height = index === 0 ? 26 : 21;
      });

      sheet.addRow([]);
      const headerRow = sheet.addRow(baseHeaders);
      headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2E7D32' } };
      headerRow.alignment = { horizontal: 'center', vertical: 'middle' };
      headerRow.height = 22;
      sheet.views = [{ state: 'frozen', ySplit: headerRow.number }];
      sheet.autoFilter = {
        from: { row: headerRow.number, column: 1 },
        to: { row: headerRow.number, column: baseHeaders.length }
      };
      data.forEach((r, idx) => {
        const pct = r.percentage != null ? r.percentage : '';
        const status = r.is_graded ? 'Graded' : 'Not Graded';
        const row = {
          Classroom: r.classroom_name,
          Section: r.classroom_section || '',
          'Student Number': r.student_number,
          'First Name': r.first_name,
          'Middle Name': r.middle_name || '',
          'Last Name': r.last_name,
          Gender: r.gender ? r.gender.charAt(0).toUpperCase() + r.gender.slice(1) : '',
          Score: r.total_score ?? '',
          Percentage: pct !== '' ? `${pct}%` : '',
          Status: status,
          'Exam Title': r.exam_title || '',
          'Graded At': r.graded_at ? r.graded_at.split(' ')[0] : ''
        };
        const excelRow = sheet.addRow(row);
        if (sheetName === 'Passed Students') {
          excelRow.getCell('Percentage').font = { color: { argb: 'FF2E7D32' } };
        } else if (sheetName === 'Failed Students') {
          excelRow.getCell('Percentage').font = { color: { argb: 'FFC62828' } };
        }
      });
    };

    addSheet('Passed Students', passedRecords);
    addSheet('Failed Students', failedRecords);
    if (noResultRecords.length > 0) {
      addSheet('No Results Yet', noResultRecords);
    }

    const classroomLabel = classroom_id
      ? records.find((r) => r.classroom_id == classroom_id)?.classroom_name || 'classroom'
      : 'all-classrooms';
    const fileName = `records-${classroomLabel.replace(/\s+/g, '-').toLowerCase()}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ success: false, message: 'Failed to export Excel', error: error.message });
  }
});

// ============================================================================
// ACTIVITY LOG ROUTES
// ============================================================================

app.get('/api/activity-logs', authenticateToken, async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const userId = req.user.id;  // Get user ID from JWT token
    const [logs] = await db.promise().query(`
      SELECT al.*, u.first_name as user_first, u.last_name as user_last
      FROM activity_logs al
      LEFT JOIN users u ON al.performed_by = u.id
      WHERE al.user_id = ?
      ORDER BY al.created_at DESC
      LIMIT ?
    `, [userId, parseInt(limit)]);
    res.json({ success: true, logs });
  } catch (error) {
    console.error('Get activity logs error:', error);
    res.status(500).json({ success: false, message: 'Failed to get activity logs', error: error.message });
  }
});

// ============================================================================
// DASHBOARD STATS ENDPOINT
// ============================================================================

app.get('/api/dashboard/stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;  // Get user ID from JWT token
    
    const [scanStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_scans,
        SUM(CASE WHEN scan_status = 'completed' THEN 1 ELSE 0 END) as completed_scans,
        SUM(CASE WHEN scan_status = 'processing' THEN 1 ELSE 0 END) as processing_scans,
        SUM(CASE WHEN scan_status = 'pending' THEN 1 ELSE 0 END) as pending_scans,
        SUM(CASE WHEN scan_status = 'failed' THEN 1 ELSE 0 END) as failed_scans
      FROM scanned_tests
      WHERE user_id = ?
    `, [userId]);

    const [studentStats] = await db.promise().query(`
      SELECT COUNT(*) as total_students FROM students WHERE user_id = ? AND deleted_at IS NULL
    `, [userId]);

    const [classroomStats] = await db.promise().query(`
      SELECT COUNT(*) as total_classrooms FROM classrooms WHERE user_id = ? AND deleted_at IS NULL
    `, [userId]);

    const [answerKeyStats] = await db.promise().query(`
      SELECT COUNT(*) as total_answer_keys FROM answer_keys WHERE user_id = ? AND is_active = TRUE
    `, [userId]);

    const [examStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_exam_responses,
        SUM(CASE WHEN er.percentage >= 20 THEN 1 ELSE 0 END) as passed_count,
        SUM(CASE WHEN er.percentage < 20 THEN 1 ELSE 0 END) as failed_count,
        AVG(er.percentage) as average_score
      FROM exam_responses er
      WHERE er.user_id = ?
    `, [userId]);

    const [recentActivity] = await db.promise().query(`
      SELECT al.*, CONCAT(u.first_name, ' ', u.last_name) as user_name
      FROM activity_logs al
      LEFT JOIN users u ON al.performed_by = u.id
      WHERE al.user_id = ?
      ORDER BY al.created_at DESC
      LIMIT 20
    `, [userId]);

    const [recentScans] = await db.promise().query(`
      SELECT s.id, s.filename, s.scan_status, s.created_at,
             ak.exam_title, ak.subject,
             CONCAT(st.first_name, ' ', st.last_name) as student_name
      FROM scanned_tests s
      LEFT JOIN answer_keys ak ON s.answer_key_id = ak.id
      LEFT JOIN students st ON s.student_id = st.id
      WHERE s.user_id = ?
      ORDER BY s.created_at DESC
      LIMIT 20
    `, [userId]);

    const [recentResponses] = await db.promise().query(`
      SELECT er.id, er.total_score, er.percentage, er.created_at,
             CONCAT(s.first_name, ' ', s.last_name) as student_name,
             ak.exam_title, ak.subject
      FROM exam_responses er
      JOIN students s ON er.student_id = s.id
      JOIN answer_keys ak ON er.answer_key_id = ak.id
      WHERE er.user_id = ?
      ORDER BY er.created_at DESC
      LIMIT 20
    `, [userId]);

    const [classroomPerformance] = await db.promise().query(`
      SELECT c.id, c.name, c.section,
             COUNT(DISTINCT s.id) as student_count,
             COALESCE(AVG(er.percentage), 0) as avg_score,
             COALESCE(SUM(CASE WHEN er.percentage >= 20 THEN 1 ELSE 0 END), 0) as passed_count,
             COALESCE(SUM(CASE WHEN er.percentage < 20 THEN 1 ELSE 0 END), 0) as failed_count
      FROM classrooms c
      LEFT JOIN students s ON s.classroom_id = c.id AND s.deleted_at IS NULL
      LEFT JOIN exam_responses er ON er.student_id = s.id
      WHERE c.user_id = ? AND c.deleted_at IS NULL
      GROUP BY c.id, c.name, c.section
      ORDER BY c.name, c.section
    `, [userId]);

    const [questionDifficulty] = await db.promise().query(`
      SELECT
        omr.question_number AS questionNumber,
        COUNT(omr.id) AS totalResponses,
        SUM(CASE WHEN omr.is_correct = 1 THEN 1 ELSE 0 END) AS correctCount,
        ROUND(
          (SUM(CASE WHEN omr.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(omr.id)) * 100,
          1
        ) AS accuracyRate
      FROM omr_results omr
      INNER JOIN scanned_tests st ON st.id = omr.scanned_test_id
      WHERE st.user_id = ? AND st.scan_status = 'completed'
      GROUP BY omr.question_number
      ORDER BY omr.question_number ASC
    `, [userId]);

    res.json({
      success: true,
      stats: {
        scans: scanStats[0],
        students: studentStats[0],
        classrooms: classroomStats[0],
        answerKeys: answerKeyStats[0],
        exams: examStats[0],
        recentActivity,
        recentScans,
        recentResponses,
        classroomPerformance,
        questionerRanking: questionDifficulty,
      }
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to get dashboard stats', error: error.message });
  }
});

// ============================================================================
// ADMIN ROUTES
// ============================================================================

app.get('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [users] = await db.promise().query(
      'SELECT id, first_name, last_name, email, phone, username, role, is_active, created_at FROM users ORDER BY created_at DESC'
    );
    const [stats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_count,
        SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) as teacher_count,
        SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff_count
      FROM users
    `);
    res.json({ success: true, users, stats: stats[0] });
  } catch (error) {
    console.error('Get admin users error:', error);
    res.status(500).json({ success: false, message: 'Failed to get users', error: error.message });
  }
});

app.post('/api/admin/users', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { first_name, last_name, email, phone, username, password, role } = req.body;
    if (!first_name || !last_name || !email || !username || !password) {
      return res.status(400).json({ success: false, message: 'All required fields must be provided' });
    }
    const validRoles = ['admin', 'teacher', 'staff'];
    const userRole = validRoles.includes(role) ? role : 'teacher';

    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(password, saltRounds);
    const [result] = await db.promise().query(
      'INSERT INTO users (first_name, last_name, email, phone, username, password_hash, role) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [first_name, last_name, email, phone || null, username, passwordHash, userRole]
    );
    const [newUser] = await db.promise().query(
      'SELECT id, first_name, last_name, email, phone, username, role, is_active, created_at FROM users WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json({ success: true, message: 'User created', user: newUser[0] });
  } catch (error) {
    console.error('Create admin user error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create user', error: error.message });
  }
});

app.delete('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await db.promise().query('SELECT id FROM users WHERE id = ?', [userId]);
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    await db.promise().query('UPDATE users SET is_active = FALSE WHERE id = ?', [userId]);
    res.json({ success: true, message: 'User deactivated successfully' });
  } catch (error) {
    console.error('Delete admin user error:', error);
    res.status(500).json({ success: false, message: 'Failed to deactivate user', error: error.message });
  }
});

app.put('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { first_name, last_name, email, phone, username, password, role } = req.body;

    const [existing] = await db.promise().query('SELECT id FROM users WHERE id = ?', [userId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const validRoles = ['admin', 'teacher', 'staff'];
    const userRole = validRoles.includes(role) ? role : 'teacher';

    let query = 'UPDATE users SET first_name = ?, last_name = ?, email = ?, phone = ?, username = ?, role = ?';
    const params = [first_name, last_name, email, phone || null, username, userRole];

    if (password && password.trim() !== '') {
      const saltRounds = 10;
      const passwordHash = await bcrypt.hash(password, saltRounds);
      query += ', password_hash = ?';
      params.push(passwordHash);
    }

    query += ' WHERE id = ?';
    params.push(userId);

    await db.promise().query(query, params);

    const [updated] = await db.promise().query(
      'SELECT id, first_name, last_name, email, phone, username, role, is_active, created_at FROM users WHERE id = ?',
      [userId]
    );
    res.json({ success: true, message: 'User updated', user: updated[0] });
  } catch (error) {
    console.error('Update admin user error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Username or email already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to update user', error: error.message });
  }
});

app.get('/api/admin/users/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const [users] = await db.promise().query(
      'SELECT id, first_name, last_name, email, phone, username, role, is_active, created_at FROM users WHERE id = ?',
      [userId]
    );
    if (users.length === 0) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.json({ success: true, user: users[0] });
  } catch (error) {
    console.error('Get admin user error:', error);
    res.status(500).json({ success: false, message: 'Failed to get user', error: error.message });
  }
});

app.get('/api/admin/classrooms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [classrooms] = await db.promise().query(`
      SELECT
        c.id, c.name, c.section, c.teacher, c.is_active,
        c.created_at, c.updated_at, c.deleted_at, c.user_id,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name,
        u.username as owner_username,
        COUNT(s.id) as student_count
      FROM classrooms c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN students s ON c.id = s.classroom_id AND s.deleted_at IS NULL
      WHERE c.deleted_at IS NULL
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, classrooms });
  } catch (error) {
    console.error('Get admin classrooms error:', error);
    res.status(500).json({ success: false, message: 'Failed to get classrooms', error: error.message });
  }
});

app.get('/api/admin/classrooms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const classroomId = parseInt(req.params.id);
    const [classrooms] = await db.promise().query(`
      SELECT
        c.id, c.name, c.section, c.teacher, c.is_active,
        c.created_at, c.updated_at, c.user_id,
        CONCAT(u.first_name, ' ', u.last_name) as owner_name,
        u.username as owner_username,
        COUNT(s.id) as student_count
      FROM classrooms c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN students s ON s.classroom_id = c.id AND s.deleted_at IS NULL
      WHERE c.id = ? AND c.deleted_at IS NULL
      GROUP BY c.id
    `, [classroomId]);
    if (classrooms.length === 0) {
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }
    res.json({ success: true, classroom: classrooms[0] });
  } catch (error) {
    console.error('Get admin classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to get classroom', error: error.message });
  }
});

app.delete('/api/admin/classrooms/:id', authenticateToken, isAdmin, async (req, res) => {
  let connection;
  try {
    connection = await db.promise();
    await connection.beginTransaction();

    const [classrooms] = await connection.query('SELECT id FROM classrooms WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (classrooms.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }
    const classroomId = classrooms[0].id;

    const [students] = await connection.query('SELECT id FROM students WHERE classroom_id = ?', [classroomId]);
    const studentIds = students.map((s) => s.id);

    const [directScans] = await connection.query('SELECT id, file_path FROM scanned_tests WHERE classroom_id = ?', [classroomId]);
    let scansToDelete = [...directScans];

    if (studentIds.length > 0) {
      const placeholders = studentIds.map(() => '?').join(',');
      const [studentScans] = await connection.query(`SELECT id, file_path FROM scanned_tests WHERE student_id IN (${placeholders})`, studentIds);
      const existingIds = new Set(scansToDelete.map(s => s.id));
      for (const scan of studentScans) {
        if (!existingIds.has(scan.id)) scansToDelete.push(scan);
      }
    }

    for (const scan of scansToDelete) {
      await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM exam_responses WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM activity_logs WHERE scanned_test_id = ?', [scan.id]);
      if (scan.file_path) {
        try { if (fs.existsSync(scan.file_path)) fs.unlinkSync(scan.file_path); } catch (fileErr) {}
      }
    }

    if (scansToDelete.length > 0) {
      const scanIds = scansToDelete.map(s => s.id);
      for (let i = 0; i < scanIds.length; i += 100) {
        const batch = scanIds.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        await connection.query(`DELETE FROM scanned_tests WHERE id IN (${placeholders})`, batch);
      }
    }

    if (studentIds.length > 0) {
      for (let i = 0; i < studentIds.length; i += 100) {
        const batch = studentIds.slice(i, i + 100);
        const placeholders = batch.map(() => '?').join(',');
        await connection.query(`DELETE FROM students WHERE id IN (${placeholders})`, batch);
      }
    }

    await connection.query("UPDATE classrooms SET deleted_at = NOW(), deleted_by = ? WHERE id = ?", [req.user.userId, classroomId]);
    await connection.commit();
    res.json({ success: true, message: 'Classroom deleted' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Delete admin classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete classroom', error: error.message });
  }
});

app.post('/api/admin/classrooms', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { name, section, teacher, user_id } = req.body;
    if (!name) return res.status(400).json({ success: false, message: 'Classroom name is required' });

    const [existing] = await db.promise().query(
      'SELECT id FROM classrooms WHERE name = ? AND section = ? AND user_id = ? AND deleted_at IS NULL',
      [name, section || '', user_id || req.user.userId]
    );
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Classroom with this name and section already exists' });
    }

    const ownerId = user_id || req.user.userId;
    const [result] = await db.promise().query(
      'INSERT INTO classrooms (user_id, name, section, teacher, is_active) VALUES (?, ?, ?, ?, TRUE)',
      [ownerId, name, section || null, teacher || null]
    );

    const [newClassroom] = await db.promise().query(
      'SELECT id, name, section, teacher, is_active, created_at, updated_at, user_id FROM classrooms WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json({ success: true, message: 'Classroom created', classroom: newClassroom[0] });
  } catch (error) {
    console.error('Create admin classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to create classroom', error: error.message });
  }
});

app.put('/api/admin/classrooms/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const classroomId = parseInt(req.params.id);
    const { name, section, teacher } = req.body;

    const [existing] = await db.promise().query('SELECT id FROM classrooms WHERE id = ? AND deleted_at IS NULL', [classroomId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Classroom not found' });
    }

    const [conflict] = await db.promise().query(
      'SELECT id FROM classrooms WHERE name = ? AND section = ? AND id != ? AND deleted_at IS NULL',
      [name, section || '', classroomId]
    );
    if (conflict.length > 0) {
      return res.status(409).json({ success: false, message: 'Classroom with this name and section already exists' });
    }

    await db.promise().query(
      'UPDATE classrooms SET name = ?, section = ?, teacher = ?, updated_at = NOW() WHERE id = ?',
      [name, section || null, teacher || null, classroomId]
    );

    const [updated] = await db.promise().query(
      'SELECT id, name, section, teacher, is_active, created_at, updated_at, user_id FROM classrooms WHERE id = ?',
      [classroomId]
    );
    res.json({ success: true, message: 'Classroom updated', classroom: updated[0] });
  } catch (error) {
    console.error('Update admin classroom error:', error);
    res.status(500).json({ success: false, message: 'Failed to update classroom', error: error.message });
  }
});

app.get('/api/admin/students', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { classroom_id, q } = req.query;
    let query = `
      SELECT s.*, c.name as classroom_name, c.section as classroom_section,
             CONCAT(u.first_name, ' ', u.last_name) as owner_name,
             u.username as owner_username
      FROM students s
      LEFT JOIN classrooms c ON s.classroom_id = c.id
      LEFT JOIN users u ON s.user_id = u.id
       WHERE s.deleted_at IS NULL
    `;
     const params = [];
    if (classroom_id) { query += ' AND s.classroom_id = ?'; params.push(classroom_id); }
    if (q) {
      query += ' AND (s.first_name LIKE ? OR s.last_name LIKE ? OR s.student_number LIKE ?)';
      const likeQ = `%${q}%`;
      params.push(likeQ, likeQ, likeQ);
    }
    query += ' ORDER BY s.created_at DESC';
    const [students] = await db.promise().query(query, params);
    res.json({ success: true, students });
  } catch (error) {
    console.error('Get admin students error:', error);
    res.status(500).json({ success: false, message: 'Failed to get students', error: error.message });
  }
});

app.get('/api/admin/students/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const studentId = parseInt(req.params.id);
    const [students] = await db.promise().query(`
      SELECT s.*, c.name as classroom_name, c.section as classroom_section,
             CONCAT(u.first_name, ' ', u.last_name) as owner_name,
             u.username as owner_username
      FROM students s
      LEFT JOIN classrooms c ON s.classroom_id = c.id
      LEFT JOIN users u ON s.user_id = u.id
      WHERE s.id = ? AND s.deleted_at IS NULL
    `, [studentId]);
    if (students.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    res.json({ success: true, student: students[0] });
  } catch (error) {
    console.error('Get admin student error:', error);
    res.status(500).json({ success: false, message: 'Failed to get student', error: error.message });
  }
});

app.delete('/api/admin/students/:id', authenticateToken, isAdmin, async (req, res) => {
  let connection;
  try {
    connection = await db.promise();
    await connection.beginTransaction();

    const [students] = await connection.query('SELECT id, user_id FROM students WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
    if (students.length === 0) {
      await connection.rollback();
      return res.status(404).json({ success: false, message: 'Student not found' });
    }
    const studentId = students[0].id;

    const [scans] = await connection.query('SELECT id, file_path FROM scanned_tests WHERE user_id = ? AND student_id = ?', [students[0].user_id, studentId]);
    for (const scan of scans) {
      await connection.query('DELETE FROM omr_results WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM ocr_extractions WHERE scanned_test_id = ?', [scan.id]);
      await connection.query('DELETE FROM activity_logs WHERE scanned_test_id = ?', [scan.id]);
      if (scan.file_path) {
        try { if (fs.existsSync(scan.file_path)) fs.unlinkSync(scan.file_path); } catch (fileErr) {}
      }
    }
    await connection.query('DELETE FROM scanned_tests WHERE user_id = ? AND student_id = ?', [students[0].user_id, studentId]);
    await connection.query("UPDATE students SET deleted_at = NOW(), deleted_by = ? WHERE id = ?", [req.user.userId, studentId]);
    await connection.commit();
    res.json({ success: true, message: 'Student deleted' });
  } catch (error) {
    if (connection) await connection.rollback();
    console.error('Delete admin student error:', error);
    res.status(500).json({ success: false, message: 'Failed to delete student', error: error.message });
  }
});

app.post('/api/admin/students', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { student_number, first_name, middle_name, last_name, email, phone, classroom_id, user_id } = req.body;
    if (!student_number || !first_name || !middle_name || !last_name) {
      return res.status(400).json({ success: false, message: 'Student number, first name, middle name, and last name are required' });
    }
    const userId = user_id || req.user.userId;
    const classroomId = classroom_id || null;

    let finalSequentialNumber = 1;
    if (classroomId) {
      const [maxRows] = await db.promise().query(
        'SELECT MAX(sequential_number) as max_seq FROM students WHERE user_id = ? AND classroom_id = ?',
        [userId, classroomId]
      );
      finalSequentialNumber = (maxRows[0].max_seq || 0) + 1;
    }

    const [result] = await db.promise().query(
      'INSERT INTO students (user_id, student_number, first_name, middle_name, last_name, email, phone, classroom_id, sequential_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [userId, student_number, first_name, middle_name, last_name, email || null, phone || null, classroomId, finalSequentialNumber]
    );
    const [newStudent] = await db.promise().query('SELECT * FROM students WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, message: 'Student created', student: newStudent[0] });
  } catch (error) {
    console.error('Create admin student error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Student number already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to create student', error: error.message });
  }
});

app.put('/api/admin/students/:id', authenticateToken, isAdmin, async (req, res) => {
  try {
    const studentId = parseInt(req.params.id);
    const { student_number, first_name, middle_name, last_name, email, phone, classroom_id } = req.body;

    const [existing] = await db.promise().query('SELECT id FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
    if (existing.length === 0) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    await db.promise().query(
      'UPDATE students SET student_number = ?, first_name = ?, middle_name = ?, last_name = ?, email = ?, phone = ?, classroom_id = ?, updated_at = NOW() WHERE id = ?',
      [student_number, first_name, middle_name, last_name, email || null, phone || null, classroom_id || null, studentId]
    );

    const [updated] = await db.promise().query('SELECT * FROM students WHERE id = ?', [studentId]);
    res.json({ success: true, message: 'Student updated', student: updated[0] });
  } catch (error) {
    console.error('Update admin student error:', error);
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Student number already exists' });
    }
    res.status(500).json({ success: false, message: 'Failed to update student', error: error.message });
  }
});

app.get('/api/admin/stats', authenticateToken, isAdmin, async (req, res) => {
  try {
    const [userStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_users,
        SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) as admin_count,
        SUM(CASE WHEN role = 'teacher' THEN 1 ELSE 0 END) as teacher_count,
        SUM(CASE WHEN role = 'staff' THEN 1 ELSE 0 END) as staff_count,
        SUM(CASE WHEN is_active = TRUE THEN 1 ELSE 0 END) as active_users
      FROM users
    `);

    const [globalExamStats] = await db.promise().query(`
      SELECT 
        COUNT(*) as total_exam_responses,
        SUM(CASE WHEN er.percentage >= 20 THEN 1 ELSE 0 END) as total_passed,
        SUM(CASE WHEN er.percentage < 20 THEN 1 ELSE 0 END) as total_failed,
        ROUND(AVG(er.percentage), 2) as average_score
      FROM exam_responses er
    `);

    const [classroomStats] = await db.promise().query(`
      SELECT COUNT(*) as total_classrooms FROM classrooms WHERE deleted_at IS NULL
    `);

    const [studentStats] = await db.promise().query(`
      SELECT COUNT(*) as total_students FROM students WHERE deleted_at IS NULL
    `);

    const [answerKeyStats] = await db.promise().query(`
      SELECT COUNT(*) as total_answer_keys FROM answer_keys WHERE is_active = TRUE
    `);

    const [recentUsers] = await db.promise().query(
      'SELECT id, first_name, last_name, email, username, role, is_active, created_at FROM users ORDER BY created_at DESC LIMIT 10'
    );

    res.json({
      success: true,
      stats: {
        users: userStats[0],
        exams: globalExamStats[0],
        classrooms: classroomStats[0],
        students: studentStats[0],
        answerKeys: answerKeyStats[0],
        recentUsers,
        updated_at: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ success: false, message: 'Failed to get admin stats', error: error.message });
  }
});

// ============================================================================
// SSE REALTIME EVENTS ENDPOINT
// ============================================================================

const sseClients = new Set();

app.get('/api/events', (req, res) => {
  const token = req.query.token || (req.headers.authorization && req.headers.authorization.split(' ')[1]);
  if (!token) {
    return res.status(401).json({ success: false, message: 'No token provided' });
  }
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ success: false, message: 'Invalid token' });
    }
    req.user = user;
    setupSSE(req, res);
  });
});

function setupSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now();
  const client = { id: clientId, res };
  sseClients.add(client);

  req.on('close', () => {
    sseClients.delete(client);
  });

  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);
}

function broadcastSSE(event) {
  const data = JSON.stringify(event);
  for (const client of sseClients) {
    try {
      client.res.write(`data: ${data}\n\n`);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

function emitScanEvent(event) {
  broadcastSSE({
    type: 'scan_event',
    data: event,
    timestamp: new Date().toISOString()
  });
}

function emitActivityEvent(event) {
  broadcastSSE({
    type: 'activity_event',
    data: event,
    timestamp: new Date().toISOString()
  });
}

// ============================================================================
// MIGRATIONS
// ============================================================================
async function runMigrations() {
  console.log('🔍 Checking for pending migrations...');

  // Ensure schema_migrations table exists
  await db.promise().query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) UNIQUE NOT NULL,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  // Get already applied migrations
  const [appliedRows] = await db.promise().query('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedRows.map(row => row.filename));

  // Read migration files
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log('📁 No migrations directory found, skipping');
    return;
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('📁 No migration files found');
    return;
  }

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`⏭️  Migration ${file} already applied`);
      continue;
    }

    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');

    console.log(`▶️  Applying migration: ${file}`);
    try {
      await db.promise().query(sql);
      await db.promise().query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log(`✅ Applied migration: ${file}`);
      appliedCount++;
    } catch (err) {
      console.error(`❌ Migration ${file} failed:`, err);
      throw err;
    }
  }

  if (appliedCount === 0) {
    console.log('✅ No pending migrations');
  } else {
    console.log(`✅ Applied ${appliedCount} migration(s)`);
  }
}

app.get('/api/admin/training/status', authenticateToken, isAdmin, async (req, res) => {
  try {
    const combinedDir = path.join(__dirname, '../ml-training/ai_labeled_dataset/combined/bubbles');
    const blankDir = path.join(combinedDir, 'blank');
    const markedDir = path.join(combinedDir, 'marked');
    const blankCount = fs.existsSync(blankDir) ? fs.readdirSync(blankDir).filter(f => f.endsWith('.png')).length : 0;
    const markedCount = fs.existsSync(markedDir) ? fs.readdirSync(markedDir).filter(f => f.endsWith('.png')).length : 0;

    const modelPath = path.join(__dirname, 'models/bubble-classifier.onnx');
    const modelExists = fs.existsSync(modelPath);
    const modelStat = modelExists ? fs.statSync(modelPath) : null;

    res.json({
      success: true,
      dataset: {
        blankPatches: blankCount,
        markedPatches: markedCount,
        totalPatches: blankCount + markedCount,
        outputDir: combinedDir,
      },
      model: {
        exists: modelExists,
        sizeBytes: modelStat ? modelStat.size : 0,
        lastModified: modelStat ? modelStat.mtime.toISOString() : null,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get training status', error: error.message });
  }
});

app.post('/api/admin/training/prepare-dataset', authenticateToken, isAdmin, async (req, res) => {
  try {
    const { runPipeline = true } = req.body;

    if (!runPipeline) {
      return res.json({ success: true, message: 'Dataset preparation skipped', outputDir: path.join(__dirname, '../ml-training/ai_labeled_dataset') });
    }

    res.json({ success: true, message: 'Dataset preparation started. Run node backend/prepare-ai-dataset.js from the backend directory to execute the pipeline.', outputDir: path.join(__dirname, '../ml-training/ai_labeled_dataset') });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to prepare dataset', error: error.message });
  }
});

// Start server after migrations
function startServer() {
  app.get('/*', (req, res) => {
    res.sendFile(path.join(__dirname, '../www/index.html'));
  });

  app.listen(PORT, () => {
    console.log(`AcadCheck backend with OMR/OCR running on port ${PORT}`);
  });
}

// Pure in-memory state hooks for the focused scanner contract test. The
// server skips its database connection only when that test sets the explicit
// environment flag above; production startup and route behavior are unchanged.
if (process.env.ACADCHECK_SERVER_UNIT_TEST === '1') {
  module.exports.__liveSheetStateTest = Object.freeze({
    observeLiveSheet,
    markLiveSheetFinalized,
    sheetFingerprintDistance,
    sheetIdentityDistance,
    processingFailureDisposition,
    preferredCameraResult,
    firstHealthyCameraOrFallback,
    reset() {
      finalizedLiveSheets.clear();
      activeLiveFinalizations.clear();
      liveDetectionCache.clear();
    },
  });
}
