const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { resolveScannerPython } = require('./python-runtime');

const ROOT = path.resolve(process.env.ACADCHECK_ROOT_DIR || path.join(__dirname, '..'));
const SCRIPT = path.join(ROOT, 'ml-training', 'fast_omr_worker.py');
const WORKER_EXECUTABLE = String(process.env.OMR_WORKER_EXECUTABLE || '').trim();
const WORKER_ASSET_ROOTS = [
  SCRIPT,
  WORKER_EXECUTABLE,
  path.join(ROOT, 'backend', 'models', 'bubble-classifier.onnx'),
  path.join(ROOT, 'backend', 'models', 'digit-classifier.onnx'),
  path.join(ROOT, 'ml-training', 'registration_templates', 'acadcheck-50-v1'),
];
const PYTHON = resolveScannerPython('OMR_PYTHON');
const WORKER_COMMAND = WORKER_EXECUTABLE || PYTHON;
const WORKER_ARGUMENTS = WORKER_EXECUTABLE ? ['--worker'] : [SCRIPT, '--worker'];
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.OMR_FAST_TIMEOUT_MS, 10) || 5000;
const MAX_PENDING_REQUESTS = Math.min(
  12,
  Math.max(1, Number.parseInt(process.env.OMR_MAX_PENDING_REQUESTS, 10) || 4)
);
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 60 * 1024 * 1024;
const MAX_INPUT_PIXELS = Number.parseInt(process.env.OMR_MAX_INPUT_PIXELS, 10) || 50_000_000;

let worker = null;
let workerAssetVersion = null;
let stdoutBuffer = Buffer.alloc(0);
let nextRequestId = 1;
const pending = new Map();

function workerError(stage, message) {
  const error = new Error(message);
  error.omrStage = stage;
  return error;
}

function workerFailure(stage, reason) {
  return {
    success: false,
    source: 'fast-hybrid-grid-error',
    reason,
    stage,
    geometryVerified: false,
    answers: [],
    confidenceScores: [],
    markedLetters: [],
    processingMs: 0,
    stagesMs: {},
    stageTrace: [{ stage, status: 'failed', reason }],
    diagnosticArtifacts: [],
  };
}

function elapsedMs(started) {
  return Number((Number(process.hrtime.bigint() - started) / 1e6).toFixed(3));
}

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function currentWorkerAssetVersion() {
  const entries = [];
  const pendingPaths = [...WORKER_ASSET_ROOTS];
  while (pendingPaths.length > 0) {
    const entryPath = pendingPaths.pop();
    if (!entryPath || !fs.existsSync(entryPath)) continue;
    const stat = fs.statSync(entryPath);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entryPath)) {
        pendingPaths.push(path.join(entryPath, name));
      }
      continue;
    }
    entries.push([
      path.relative(ROOT, entryPath).replace(/\\/g, '/'),
      stat.size,
      Math.trunc(stat.mtimeMs),
    ].join(':'));
  }
  return entries.sort().join('|');
}

function reloadStaleWorkerIfIdle(assetVersion) {
  if (!worker || worker.killed || workerAssetVersion === assetVersion) return;
  if (pending.size > 0) return;
  console.warn('[FAST-OMR] Detector assets changed; reloading the persistent worker.');
  stopWorker(null, worker);
}

function stopWorker(error, expectedWorker = null) {
  // A rejected caller may resume after another caller has already created a
  // replacement. Only the generation that observed the failure may tear
  // itself down; stale callbacks must never kill the new worker.
  if (expectedWorker && worker !== expectedWorker) return false;
  const active = worker;
  worker = null;
  workerAssetVersion = null;
  stdoutBuffer = Buffer.alloc(0);
  if (active && !active.killed) {
    try { active.kill(); } catch (_) {}
  }
  if (error) rejectPending(error);
  return true;
}

function parseResponses(expectedWorker) {
  while (stdoutBuffer.length >= 4) {
    const responseLength = stdoutBuffer.readUInt32BE(0);
    if (responseLength <= 0 || responseLength > MAX_RESPONSE_BYTES) {
      stopWorker(workerError(
        'worker-protocol',
        `Fast OMR returned an invalid ${responseLength}-byte frame`
      ), expectedWorker);
      return;
    }
    if (stdoutBuffer.length < responseLength + 4) return;
    const payload = stdoutBuffer.subarray(4, responseLength + 4);
    stdoutBuffer = stdoutBuffer.subarray(responseLength + 4);
    let response;
    try {
      response = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      stopWorker(workerError(
        'worker-protocol',
        `Fast OMR returned invalid JSON: ${error.message}`
      ), expectedWorker);
      return;
    }
    const request = pending.get(String(response.id));
    if (!request) continue;
    pending.delete(String(response.id));
    clearTimeout(request.timer);
    request.resolve(response);
  }
}

function ensureWorker() {
  const assetVersion = currentWorkerAssetVersion();
  reloadStaleWorkerIfIdle(assetVersion);
  if (worker && !worker.killed) return worker;
  if (WORKER_EXECUTABLE && !fs.existsSync(WORKER_EXECUTABLE)) {
    throw new Error(`Bundled fast OMR worker is missing: ${WORKER_EXECUTABLE}`);
  }
  if (!WORKER_EXECUTABLE && !fs.existsSync(SCRIPT)) {
    throw new Error(`Fast OMR worker is missing: ${SCRIPT}`);
  }

  const child = spawn(WORKER_COMMAND, WORKER_ARGUMENTS, {
    // A frozen worker's __file__ lives in its extraction directory, not next
    // to the installed models. Resolve assets from the application root for
    // both packaged Windows and source runtimes, preserving explicit overrides.
    env: {
      ...process.env,
      OMR_BUBBLE_MODEL_PATH: process.env.OMR_BUBBLE_MODEL_PATH
        || path.join(ROOT, 'backend', 'models', 'bubble-classifier.onnx'),
      OMR_DIGIT_MODEL_PATH: process.env.OMR_DIGIT_MODEL_PATH
        || path.join(ROOT, 'backend', 'models', 'digit-classifier.onnx'),
      OMR_REGISTRATION_TEMPLATE_DIR: process.env.OMR_REGISTRATION_TEMPLATE_DIR
        || path.join(ROOT, 'ml-training', 'registration_templates', 'acadcheck-50-v1'),
    },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;
  workerAssetVersion = assetVersion;
  stdoutBuffer = Buffer.alloc(0);

  child.stdout.on('data', chunk => {
    if (worker !== child) return;
    stdoutBuffer = stdoutBuffer.length
      ? Buffer.concat([stdoutBuffer, chunk])
      : Buffer.from(chunk);
    parseResponses(child);
  });
  child.stderr.on('data', chunk => {
    const message = chunk.toString().trim();
    if (message) console.warn(`[FAST-OMR] ${message}`);
  });
  child.stdin.on('error', error => {
    if (worker !== child) return;
    stopWorker(
      workerError('worker-write', `Fast OMR input failed: ${error.message}`),
      child
    );
  });
  child.on('error', error => {
    if (worker === child) {
      stopWorker(workerError(
        'worker-start',
        `Could not start ${WORKER_COMMAND}: ${error.message}`
      ), child);
    }
  });
  child.on('close', code => {
    if (worker === child) {
      stopWorker(workerError(
        'worker-exit',
        `Fast OMR worker exited with code ${code}`
      ), child);
    }
  });

  // The HTTP server keeps the process alive. These handles should not make
  // one-shot tests hang after their final response.
  child.unref();
  if (typeof child.stdin.unref === 'function') child.stdin.unref();
  if (typeof child.stdout.unref === 'function') child.stdout.unref();
  if (typeof child.stderr.unref === 'function') child.stderr.unref();
  return child;
}

/**
 * Read one AcadCheck 50x4 answer sheet with the persistent OpenCV worker.
 *
 * Backward compatible call forms:
 *   detectAdaptiveForm(buffer)
 *   detectAdaptiveForm(buffer, timeoutMs)
 *   detectAdaptiveForm(buffer, {
 *     timeoutMs, useCnn, includeDiagnostics, trackingSessionId, frameId
 *   })
 */
async function detectAdaptiveFormAttempt(imageBuffer, timeoutOrOptions = DEFAULT_TIMEOUT_MS) {
  const requestStarted = process.hrtime.bigint();
  if (!Buffer.isBuffer(imageBuffer)) {
    return {
      ...workerFailure('worker-input', 'Fast OMR requires an image buffer'),
      bridgeMs: elapsedMs(requestStarted),
    };
  }
  if (imageBuffer.length <= 0 || imageBuffer.length > MAX_INPUT_BYTES) {
    return {
      ...workerFailure(
        'image-limits',
        `OMR image must be between 1 byte and ${MAX_INPUT_BYTES} bytes`
      ),
      bridgeMs: elapsedMs(requestStarted),
    };
  }
  const validationStarted = process.hrtime.bigint();
  try {
    const metadata = await sharp(imageBuffer, {
      failOn: 'error',
      limitInputPixels: MAX_INPUT_PIXELS,
    }).metadata();
    const width = Number(metadata.width || 0);
    const pageHeight = Number(metadata.pageHeight || metadata.height || 0);
    const pages = Math.max(1, Number(metadata.pages || 1));
    const decodedPixels = width * pageHeight * pages;
    if (!width || !pageHeight || decodedPixels > MAX_INPUT_PIXELS) {
      return {
        ...workerFailure(
          'image-limits',
          `Decoded OMR image exceeds the ${MAX_INPUT_PIXELS}-pixel safety limit`
        ),
        inputValidationMs: elapsedMs(validationStarted),
        bridgeMs: elapsedMs(requestStarted),
      };
    }
  } catch (error) {
    return {
      ...workerFailure(
        'image-limits',
        `OMR image metadata is invalid or exceeds the pixel safety limit: ${error.message}`
      ),
      inputValidationMs: elapsedMs(validationStarted),
      bridgeMs: elapsedMs(requestStarted),
    };
  }
  const inputValidationMs = elapsedMs(validationStarted);
  // The Python process reads frames serially. Check at the actual enqueue
  // boundary (after asynchronous metadata validation) so simultaneous camera
  // requests cannot all observe an empty queue and slip through together.
  if (pending.size >= MAX_PENDING_REQUESTS) {
    return {
      ...workerFailure(
        'worker-busy',
        'Fast OMR is busy; retry with the next camera frame'
      ),
      inputValidationMs,
      queueDepth: pending.size,
      bridgeMs: elapsedMs(requestStarted),
    };
  }
  const options = typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null
    ? timeoutOrOptions
    : { timeoutMs: timeoutOrOptions };
  const requestedTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.min(60_000, Math.max(250, requestedTimeoutMs))
    : DEFAULT_TIMEOUT_MS;
  const id = String(nextRequestId++);
  const qrAnchorCorners = Array.isArray(options.qrAnchorCorners)
    && options.qrAnchorCorners.length === 4
    && options.qrAnchorCorners.every(point => Array.isArray(point)
      && point.length >= 2
      && Number.isFinite(Number(point[0]))
      && Number.isFinite(Number(point[1])))
    ? options.qrAnchorCorners.map(point => [Number(point[0]), Number(point[1])])
    : undefined;
  const header = Buffer.from(JSON.stringify({
    id,
    formLayout: 'acadcheck-50-v1',
    numQuestions: 50,
    useCnn: options.useCnn !== false,
    includeDiagnostics: options.includeDiagnostics === true,
    includeOverlayGeometry: options.includeOverlayGeometry === true,
    debugDir: typeof options.debugDir === 'string' ? options.debugDir : undefined,
    geometryTolerances: options.geometryTolerances
      && typeof options.geometryTolerances === 'object'
      ? options.geometryTolerances
      : undefined,
    trackingSessionId: typeof options.trackingSessionId === 'string'
      ? options.trackingSessionId.slice(0, 160)
      : undefined,
    frameId: typeof options.frameId === 'string'
      ? options.frameId.slice(0, 96)
      : undefined,
    qrAnchorCorners,
  }), 'utf8');
  const frame = Buffer.allocUnsafe(8 + header.length + imageBuffer.length);
  frame.writeUInt32BE(header.length, 0);
  header.copy(frame, 4);
  frame.writeUInt32BE(imageBuffer.length, 4 + header.length);
  imageBuffer.copy(frame, 8 + header.length);

  const workerRoundTripStarted = process.hrtime.bigint();
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureWorker();
    } catch (error) {
      console.warn(`[FAST-OMR] ${error.message}`);
      resolve({
        ...workerFailure(error.omrStage || 'worker-start', error.message),
        inputValidationMs,
        bridgeMs: elapsedMs(requestStarted),
      });
      return;
    }
    const timer = setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      const error = workerError(
        'worker-timeout',
        `Fast OMR timed out after ${timeoutMs} ms`
      );
      request.reject(error);
      // The timed-out owner is not retried automatically. Other requests
      // queued behind it receive a distinct retryable failure and may move to
      // one shared replacement worker without killing each other's attempt.
      stopWorker(
        workerError('worker-restarted', 'Fast OMR worker restarted after another request timed out'),
        child
      );
    }, timeoutMs);
    pending.set(id, {
      timer,
      resolve: response => {
        const workerRoundTripMs = elapsedMs(workerRoundTripStarted);
        const processingMs = Number(response?.processingMs || 0);
        const bridgeMs = elapsedMs(requestStarted);
        resolve({
          ...response,
          inputValidationMs,
          workerRoundTripMs,
          // Transport includes framing, process IPC, and worker queueing. It
          // intentionally excludes Sharp's input validation above.
          transportMs: Number(Math.max(0, workerRoundTripMs - processingMs).toFixed(3)),
          bridgeMs,
          timingMetrics: {
            ...(response?.timingDetails && typeof response.timingDetails === 'object'
              ? { worker: { ...response.timingDetails } }
              : {}),
            ...(response?.timingMetrics && typeof response.timingMetrics === 'object'
              ? response.timingMetrics
              : {}),
            inputValidationMs,
            workerRoundTripMs,
            transportMs: Number(Math.max(0, workerRoundTripMs - processingMs).toFixed(3)),
            bridgeMs,
          },
        });
      },
      reject,
    });
    child.stdin.write(frame, error => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(timer);
      const writeError = workerError(
        'worker-write',
        `Fast OMR input failed: ${error.message}`
      );
      request.reject(writeError);
      stopWorker(writeError, child);
    });
  }).catch(error => {
    console.warn(`[FAST-OMR] ${error.message}`);
    return {
      ...workerFailure(error.omrStage || 'worker-runtime', error.message),
      inputValidationMs,
      bridgeMs: elapsedMs(requestStarted),
    };
  });
}

async function detectAdaptiveForm(imageBuffer, timeoutOrOptions = DEFAULT_TIMEOUT_MS) {
  const options = typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null
    ? timeoutOrOptions
    : { timeoutMs: timeoutOrOptions };
  const retryableStages = new Set([
    'worker-start',
    'worker-write',
    'worker-exit',
    'worker-protocol',
    'worker-runtime',
    'worker-restarted',
  ]);
  const maximumAttempts = options.retryWorker === false ? 1 : 2;
  const started = process.hrtime.bigint();
  let result = null;
  for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
    result = await detectAdaptiveFormAttempt(imageBuffer, options);
    if (result?.success === true || !retryableStages.has(result?.stage)) {
      return {
        ...result,
        workerAttempts: attempt,
        totalBridgeMs: elapsedMs(started),
      };
    }
    console.warn(`[FAST-OMR] Retrying after ${result.stage} failure (attempt ${attempt}/${maximumAttempts}).`);
  }
  return {
    ...result,
    workerAttempts: maximumAttempts,
    totalBridgeMs: elapsedMs(started),
  };
}

function shutdownAdaptiveWorker() {
  stopWorker(workerError('worker-shutdown', 'Fast OMR worker was shut down'));
}

async function prewarmAdaptiveWorker() {
  const warmupImage = path.join(
    ROOT,
    'ml-training',
    'registration_templates',
    'acadcheck-50-v1',
    'images',
    'ensemble-static.png'
  );
  if (!fs.existsSync(warmupImage)) {
    ensureWorker();
    return { started: true, processed: false };
  }
  const result = await detectAdaptiveForm(await fs.promises.readFile(warmupImage), {
    timeoutMs: Number.parseInt(process.env.OMR_WARMUP_TIMEOUT_MS, 10) || 15000,
    useCnn: true,
    includeDiagnostics: false,
  });
  return {
    started: true,
    processed: true,
    success: result?.success === true,
    processingMs: Number(result?.processingMs || 0),
    opencvThreads: Number(result?.timingDetails?.opencvThreads || 0),
  };
}

module.exports = { detectAdaptiveForm, prewarmAdaptiveWorker, shutdownAdaptiveWorker };

if (process.env.ACADCHECK_SERVER_UNIT_TEST === '1') {
  module.exports.__adaptiveWorkerTest = Object.freeze({
    pendingCount: () => pending.size,
    maxPendingRequests: MAX_PENDING_REQUESTS,
    workerPid: () => worker?.pid || null,
    markAssetVersionStale() {
      if (!worker || worker.killed) return false;
      workerAssetVersion = 'forced-stale-test-version';
      return true;
    },
    restart() {
      const active = worker;
      if (!active) return false;
      return stopWorker(
        workerError('worker-restarted', 'Fast OMR worker restarted by the concurrency contract test'),
        active
      );
    },
  });
}
