const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcrypt');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
require('dotenv').config();

const PI_CAMERA_URL = (process.env.PI_CAMERA_URL || '').replace(/\/+$/, '');
const PI_SCAN_ENDPOINT = PI_CAMERA_URL ? (PI_CAMERA_URL + '/scan') : '';

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

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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
console.log('Initializing database connection...');
const db = mysql.createConnection({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'acadcheck_db',
  port: process.env.DB_PORT || 3306,
  multipleStatements: true,
  dateStrings: true
});

db.connect((err) => {
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
      const formOnlyResult = await EnhancedScanner.hybridDetectAnswers(rectifiedBuffer, answerKey, numQuestions, {
        blocksPerRow: 2,
        questionsPerBlock: 25,
        numChoices: 4,
        formLayout: 'acadcheck-50',
        contentFirst: true,
        fastMode: true,
        trustedOnly: true,
        rectify: false,
      });
      const isTrustedRectified = trustedFormSources.includes(formOnlyResult?.details?.source);
      if (isTrustedRectified) {
        console.log('[DETECT-BUBBLES] Using normalized-form OMR.');
      }
      // The fast worker locates and perspective-corrects the current page
      // itself. A second call here used to analyze the same bytes twice on a
      // rejection, doubling latency without adding independent evidence.
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
    const hasKey = cleanKey.length > 10;
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
      if (hasKey) {
        for (let i = 0; i < Math.min(answers.length, cleanKey.length); i++) {
          if (answers[i] === cleanKey[i]) keyMatchCount++;
        }
      }
      const keyMatchRatio = hasKey && cleanKey.length > 0 ? keyMatchCount / cleanKey.length : 0;
      const coverageRatio = hasKey && cleanKey.length > 0 ? validCount / cleanKey.length : 0;

      let score;
      if (hasKey && validCount > 5) {
        const uniformDetection = uniqueLetters === 1 && validCount > 10;
        const keyMatchWeight = uniformDetection && isUniformKey ? 0.05 : 1.0;
        const confWeight = uniformDetection ? 3.0 : 1.0;
        const uniformPenalty = uniformDetection && isUniformKey ? -100 : 0;
        const emptyCount = numQuestions - validCount;
        const emptyPenalty = emptyCount > 5 ? emptyCount * 2 : 0;
        score = keyMatchRatio * 500 * keyMatchWeight + avgConf * confWeight + coverageRatio * 50 + varietyBonus + uniformPenalty + emptyPenalty + sameLetterPenalty;
      } else {
        score = validCount * 10 + avgConf + varietyBonus + sameLetterPenalty;
      }

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
 * Body: { imageBuffer (base64), answerKeyId or answerKey (string) }
 * Returns: { detectedAnswers, confidenceScores, details }
 */
app.post('/api/omr/detect-frame', authenticateToken, async (req, res) => {
  try {
    const { imageBuffer: base64Image, answerKeyId, answerKey, answerKeyDate, numChoices, previewOnly = false } = req.body;

    if (!base64Image) {
      return res.status(400).json({ success: false, message: 'imageBuffer (base64) is required' });
    }

    const imageBuffer = Buffer.from(base64Image, 'base64');

    let answerKeyString = answerKey;
    let resolvedAnswerKeyId = answerKeyId || null;
    let resolvedClassroomId = null;
    let detectedQrPayload = null;
    let detectedSequenceFromFallback = null;
    let detectedSequenceConfidence = 0;

    // Resolve an explicitly selected key before doing any image work. The
    // scanner UI normally sends answerKeyId; looking it up here avoids an
    // unnecessary QR pass and legacy page rectification on every live frame.
    if (!answerKeyString && answerKeyId) {
      const [rows] = await db.promise().query(
        'SELECT answer_key_json, classroom_id FROM answer_keys WHERE id = ? AND user_id = ? AND is_active = TRUE',
        [answerKeyId, req.user.userId]
      );
      if (rows.length === 0) {
        return res.status(404).json({ success: false, message: 'Answer key not found' });
      }
      answerKeyString = rows[0].answer_key_json;
      resolvedClassroomId = rows[0].classroom_id || null;
    }

    // Decode the identity before the page-quality gate. This lets the UI
    // recognize a newly presented sheet as soon as its QR is visible, while
    // still requiring the complete page before grading bubbles.
    if (!answerKeyString) {
      const qrMatch = await resolveAnswerKeyQr(imageBuffer, req.user.userId);
      detectedQrPayload = qrMatch.qrResult?.payload || null;
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

    // Live frames can place the sheet anywhere in the camera view. Read the
    // untouched frame first (best detail), then retry against the detected
    // paper crop when raw-frame perspective/background prevents row-grid
    // verification. Previously rectifiedBuffer was calculated above but never
    // used for live OMR, which made Auto Scan fail while saved scans succeeded.
    const detectLiveOmr = async (key, extraOptions = {}) => {
      const cleanKey = (key || '').replace(/\s/g, '');
      const options = {
        ...extraOptions,
        numChoices: 4,
        formLayout: cleanKey.length === 50 ? 'acadcheck-50' : undefined,
        contentFirst: cleanKey.length === 50,
        fastMode: true,
        trustedOnly: cleanKey.length === 50,
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
        imageBuffer, key, cleanKey.length, options
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
      details: omrResult.details,
      placement,
      qualityGate
    });
  } catch (error) {
    console.error('OMR detection error:', error);
    res.status(500).json({ success: false, message: 'OMR detection failed', error: error.message });
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
    if (qrMatch.answerKey && qrMatch.qrResult?.sequence) {
      return res.json({
        success: true,
        sequence: qrMatch.qrResult.sequence,
        confidence: qrMatch.qrResult.sequenceConfidence || 0,
        rawText: '',
        cropRegion: {
          source: 'qr-anchored-digit-boxes',
          boxes: qrMatch.qrResult.sequenceBoxes || []
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

    const seqFromRaw = await SequenceDetector.detectSequenceFromBottom(imageBuffer, {
      bottomRegionHeight,
      cropLeft,
      cropWidth,
      cropRight,
      allowStandalone: true
    });
    const seqFromBuffer = await SequenceDetector.detectSequenceFromBottom(seqBuffer, {
      bottomRegionHeight,
      cropLeft,
      cropWidth,
      cropRight,
      allowStandalone: true
    });
    const sequenceResult = (seqFromRaw.sequence && (seqFromRaw.confidence || 0) >= (seqFromBuffer.confidence || 0)) ? seqFromRaw : seqFromBuffer;

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
    const [result] = await db.promise().query(
      `INSERT INTO scanned_tests 
         (filename, file_path, file_size, mime_type, classroom_id, answer_key_id, scan_status, user_id, created_by, student_id) 
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
       [req.file.filename, req.file.path, req.file.size, req.file.mimetype,
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
  const PROCESS_TIMEOUT_MS = 180000;

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
  }, PROCESS_TIMEOUT_MS);

  try {
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
    await db.promise().query(`UPDATE scanned_tests SET scan_status = 'processing' WHERE id = ?`, [scanId]);

    const rawImageBuffer = fs.readFileSync(scan.file_path);
    // QR identity and the 50-row OMR geometry are independent. Run both
    // persistent CV workers together; the placeholder key supplies only the
    // fixed form length and is never used for grading.
    const fastOmrPreflightPromise = detectBubbles(
      rawImageBuffer,
      'A'.repeat(50),
      scan.filename,
      { rectifiedBuffer: rawImageBuffer }
    ).then(
      result => ({ result, error: null }),
      error => ({ result: null, error })
    );
    let currentAnswerKeyJson = scan.answer_key_json || '';
    let detectedQrPayload = null;
    // The QR printed on this physical page is authoritative. A UI selection
    // is useful for fast live preview, but must not grade a newly entered
    // sheet against the previous key. Decode once on the final capture and
    // update the scan to the QR-owned key before OMR/grading.
    const qrMatch = await resolveAnswerKeyQr(rawImageBuffer, userId);
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
    if (!qrMatch.answerKey) {
      const message = detectedQrPayload
        ? 'The visible QR code is not an active answer key for this account'
        : 'No valid AcadCheck answer-key QR code was visible';
      await db.promise().query(
        `UPDATE scanned_tests
         SET scan_status = 'failed', error_message = ?, processed_at = NOW()
         WHERE id = ? AND user_id = ?`,
        [`Automatic grading withheld: ${message}.`, scanId, userId]
      );
      clearTimeout(timeoutHandle);
      return res.status(422).json({
        success: false,
        requiresReview: true,
        message: `${message}. Reposition the complete sheet and scan again.`
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
        const seqPromise = SequenceDetector.detectSequenceFromBottom(rawImageBuffer, {
          bottomRegionHeight: 0.18,
          cropLeft: 0.08,
          cropRight: 0.92,
          allowStandalone: true,
        });
        const seqRectifiedPromise = SequenceDetector.detectSequenceFromBottom(rectifiedBuffer, {
          bottomRegionHeight: 0.18,
          cropLeft: 0.08,
          cropRight: 0.92,
          allowStandalone: true,
        });
        const [seqFromRaw, seqFromRectified] = await Promise.all([seqPromise, seqRectifiedPromise]);
        if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');
        sequenceResult = (seqFromRaw.sequence && (seqFromRaw.confidence || 0) >= (seqFromRectified.confidence || 0)) ? seqFromRaw : seqFromRectified;
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
          await db.promise().query(
            `UPDATE scanned_tests SET scan_status = 'failed', error_message = ?, processed_at = NOW() WHERE id = ?`,
            [`Automatic grading withheld: ${placementMessage}.`, scanId]
          );
          clearTimeout(timeoutHandle);
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
            { rectifiedBuffer }
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
        const unreliableUniform = detected.length >= 20 && unique.size === 1
          && (!reliableUniformGeometry || avgConfidence < 90);
        // A complete row map is gradeable even when some or all bubbles are
        // blank. Empty rows are intentional OMR values and score zero; they
        // are not evidence that the sheet layout is incomplete.
        const incompleteRead = !completeRowMap;
        const minimumConfidence = 30;
        if (geometryEvidenceUnreliable || unreliableGeometry || unreliableBlur || unreliableUniform
            || uncertainRows > 0
            || avgConfidence < minimumConfidence || incompleteRead) {
          await db.promise().query(
            `UPDATE scanned_tests SET scan_status = 'failed', error_message = ?, processed_at = NOW() WHERE id = ?`,
            [`Automatic grading withheld: unreliable OMR detection (geometry ${referenceSimilarity.toFixed(3)}, invalid grid evidence ${geometryEvidenceUnreliable}, blur ${blur}%, average confidence ${avgConfidence.toFixed(1)}%, filled ${filledCount}/${detected.length}, blank rows ${blankRows}, ambiguous rows ${ambiguousRows}, uncertain rows ${uncertainRows}, complete row map ${completeRowMap}, unique answers ${unique.size}).`, scanId]
          );
          const rejectionReason = omrResult?.details?.rejectionReason;
          const rejectionIsOnlyAboutMultiMarks = /multiple shaded|multi-mark/i.test(String(rejectionReason || ''));
          const userMessage = (!rejectionIsOnlyAboutMultiMarks && rejectionReason)
            || `Scan alignment or current-sheet bubble geometry is not reliable enough to grade. ${ambiguousRows > 0 ? 'Multi-mark rows will score zero after the sheet geometry is verified. ' : ''}No score was saved.`;
          clearTimeout(timeoutHandle);
          return res.status(422).json({
            success: false,
            requiresReview: true,
            message: userMessage,
            quality: { referenceSimilarity, geometryEvidenceUnreliable, blurScore: blur, averageConfidence: avgConfidence, fillRatio, ambiguousRows, uniqueAnswers: unique.size }
          });
        }
      }
      if (timedOut) throw new Error('Processing timed out. The scan is taking too long. Please try again.');

      if (!hasStudent) {
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

    // Save OCR extractions
    await db.promise().query(
      `INSERT INTO ocr_extractions (user_id, scanned_test_id, field_name, extracted_value, confidence, raw_ocr_text) 
       VALUES (?, ?, 'student_number', ?, ?, ?),
         (?, ?, 'student_name', ?, ?, ?),
         (?, ?, 'epoch', ?, ?, ?),
         (?, ?, 'sequence', ?, ?, ?)`,
      [userId, scanId, ocrResult.studentNumber, ocrResult.confidence, ocrResult.rawText,
       userId, scanId, ocrResult.studentName, ocrResult.confidence, ocrResult.rawText,
       userId, scanId, detectedEpoch, epochResult.confidence, epochResult.rawText,
       userId, scanId, detectedSequence, sequenceResult.confidence, sequenceResult.rawText]
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
              await db.promise().query(`UPDATE scanned_tests SET classroom_id = ? WHERE id = ?`, [studentsFound[0].classroom_id, scanId]);
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
            await db.promise().query(
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
          await db.promise().query(`UPDATE scanned_tests SET classroom_id = ? WHERE id = ?`, [detectedClassroomId, scanId]);
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
                await db.promise().query(`UPDATE scanned_tests SET classroom_id = ? WHERE id = ?`, [studentsFound[0].classroom_id, scanId]);
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
        await db.promise().query(`UPDATE scanned_tests SET answer_key_id = ? WHERE id = ?`, [answerKeyId, scanId]);
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
        await db.promise().query(`UPDATE scanned_tests SET answer_key_id = ? WHERE id = ?`, [answerKeyId, scanId]);
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
      await db.promise().query('DELETE FROM omr_results WHERE scanned_test_id = ?', [scanId]);
      await db.promise().query('DELETE FROM exam_responses WHERE scanned_test_id = ?', [scanId]);

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
        result.questionNumber,
        result.detectedAnswer,
        result.correctAnswer,
        result.isCorrect,
        omrResult.confidenceScores ? omrResult.confidenceScores[index] : 95,
        result.markedLetters?.length ? JSON.stringify(result.markedLetters) : null,
      ]);
      if (omrRows.length > 0) {
        const placeholders = omrRows
          .map(() => '(?, ?, ?, ?, ?, ?, ?, COALESCE(?, JSON_ARRAY()))')
          .join(', ');
        await db.promise().query(
          `INSERT INTO omr_results
             (user_id, scanned_test_id, question_number, detected_answer, correct_answer, is_correct, confidence, marked_letters)
           VALUES ${placeholders}
           ON DUPLICATE KEY UPDATE
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
      await db.promise().query(
        `INSERT INTO exam_responses 
           (user_id, student_id, scanned_test_id, answer_key_id, answers_json, score_per_question_json,
            total_score, percentage, is_graded, graded_by, graded_at) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, TRUE, ?, NOW())
         ON DUPLICATE KEY UPDATE 
           answers_json = VALUES(answers_json),
           score_per_question_json = VALUES(score_per_question_json),
           total_score = VALUES(total_score),
           percentage = VALUES(percentage),
           is_graded = TRUE,
           graded_by = VALUES(graded_by),
           graded_at = NOW()`,
        [userId, studentId, scanId, answerKeyId || scan.answer_key_id, answersJson, scoreJson,
         gradingResult.totalScore, gradingResult.percentage, userId]
      );
    }

    await db.promise().query(
      `UPDATE scanned_tests 
       SET student_id = ?, student_number_detected = ?, student_name_detected = ?,
           sequential_number_detected = ?, answer_key_date_detected = ?, epoch_detected = ?, sequence_detected = ?,
           ocr_confidence = ?, scan_status = 'completed', processed_at = NOW(),
           suspicious_uniform_detection = ?
       WHERE id = ?`,
      [studentId, ocrResult.studentNumber, ocrResult.studentName,
       detectedSequentialNumber, detectedDateFormatted, detectedEpoch, detectedSequence,
       ocrResult.confidence, uniformDetection ? 1 : 0, scanId]
    );

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
    res.json({ success: true, message: 'Scan processed successfully', scan: fullScan });
    clearTimeout(timeoutHandle);

  } catch (error) {
    clearTimeout(timeoutHandle);
    console.error('Processing error:', error);
    await db.promise().query(`UPDATE scanned_tests SET scan_status = 'failed', error_message = ? WHERE id = ?`, [error.message, scanId]);
    res.status(500).json({ success: false, message: 'Failed to process scan', error: error.message });
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
    const [omrResults] = await db.promise().query('SELECT * FROM omr_results WHERE scanned_test_id = ?', [req.params.id]);
    const sanitizedOmr = omrResults.map(r => {
      const { correct_answer, ...rest } = r;
      if (rest.marked_letters && typeof rest.marked_letters === 'string') {
        try { rest.marked_letters = JSON.parse(rest.marked_letters); } catch {}
      }
      return rest;
    });
    const [ocrExtractions] = await db.promise().query('SELECT * FROM ocr_extractions WHERE scanned_test_id = ?', [req.params.id]);
    const [responses] = await db.promise().query('SELECT * FROM exam_responses WHERE scanned_test_id = ?', [req.params.id]);
    const scan = scans[0];
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
