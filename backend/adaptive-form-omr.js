const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'ml-training', 'fast_omr_worker.py');
const PYTHON = process.env.OMR_PYTHON || 'python3';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.OMR_FAST_TIMEOUT_MS, 10) || 5000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_INPUT_BYTES = 60 * 1024 * 1024;
const MAX_INPUT_PIXELS = Number.parseInt(process.env.OMR_MAX_INPUT_PIXELS, 10) || 50_000_000;

let worker = null;
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
    stageTrace: [{ stage, status: 'failed', reason }],
    diagnosticArtifacts: [],
  };
}

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function stopWorker(error) {
  const active = worker;
  worker = null;
  stdoutBuffer = Buffer.alloc(0);
  if (active && !active.killed) {
    try { active.kill(); } catch (_) {}
  }
  if (error) rejectPending(error);
}

function parseResponses() {
  while (stdoutBuffer.length >= 4) {
    const responseLength = stdoutBuffer.readUInt32BE(0);
    if (responseLength <= 0 || responseLength > MAX_RESPONSE_BYTES) {
      stopWorker(workerError(
        'worker-protocol',
        `Fast OMR returned an invalid ${responseLength}-byte frame`
      ));
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
      ));
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
  if (worker && !worker.killed) return worker;
  if (!fs.existsSync(SCRIPT)) {
    throw new Error(`Fast OMR worker is missing: ${SCRIPT}`);
  }

  const child = spawn(PYTHON, [SCRIPT, '--worker'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;
  stdoutBuffer = Buffer.alloc(0);

  child.stdout.on('data', chunk => {
    if (worker !== child) return;
    stdoutBuffer = stdoutBuffer.length
      ? Buffer.concat([stdoutBuffer, chunk])
      : Buffer.from(chunk);
    parseResponses();
  });
  child.stderr.on('data', chunk => {
    const message = chunk.toString().trim();
    if (message) console.warn(`[FAST-OMR] ${message}`);
  });
  child.stdin.on('error', error => {
    if (worker !== child) return;
    stopWorker(workerError('worker-write', `Fast OMR input failed: ${error.message}`));
  });
  child.on('error', error => {
    if (worker === child) {
      stopWorker(workerError(
        'worker-start',
        `Could not start ${PYTHON}: ${error.message}`
      ));
    }
  });
  child.on('close', code => {
    if (worker === child) {
      stopWorker(workerError(
        'worker-exit',
        `Fast OMR worker exited with code ${code}`
      ));
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
async function detectAdaptiveForm(imageBuffer, timeoutOrOptions = DEFAULT_TIMEOUT_MS) {
  if (!Buffer.isBuffer(imageBuffer)) {
    return workerFailure('worker-input', 'Fast OMR requires an image buffer');
  }
  if (imageBuffer.length <= 0 || imageBuffer.length > MAX_INPUT_BYTES) {
    return workerFailure(
      'image-limits',
      `OMR image must be between 1 byte and ${MAX_INPUT_BYTES} bytes`
    );
  }
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
      return workerFailure(
        'image-limits',
        `Decoded OMR image exceeds the ${MAX_INPUT_PIXELS}-pixel safety limit`
      );
    }
  } catch (error) {
    return workerFailure(
      'image-limits',
      `OMR image metadata is invalid or exceeds the pixel safety limit: ${error.message}`
    );
  }
  const options = typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null
    ? timeoutOrOptions
    : { timeoutMs: timeoutOrOptions };
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const id = String(nextRequestId++);
  const header = Buffer.from(JSON.stringify({
    id,
    formLayout: 'acadcheck-50-v1',
    numQuestions: 50,
    useCnn: options.useCnn !== false,
    includeDiagnostics: options.includeDiagnostics === true,
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
  }), 'utf8');
  const frame = Buffer.allocUnsafe(8 + header.length + imageBuffer.length);
  frame.writeUInt32BE(header.length, 0);
  header.copy(frame, 4);
  frame.writeUInt32BE(imageBuffer.length, 4 + header.length);
  imageBuffer.copy(frame, 8 + header.length);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = ensureWorker();
    } catch (error) {
      console.warn(`[FAST-OMR] ${error.message}`);
      resolve(workerFailure(
        error.omrStage || 'worker-start',
        error.message
      ));
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
      stopWorker(error);
    }, timeoutMs);
    pending.set(id, {
      timer,
      resolve,
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
      stopWorker(writeError);
    });
  }).catch(error => {
    console.warn(`[FAST-OMR] ${error.message}`);
    return workerFailure(error.omrStage || 'worker-runtime', error.message);
  });
}

function shutdownAdaptiveWorker() {
  stopWorker();
}

module.exports = { detectAdaptiveForm, shutdownAdaptiveWorker };
