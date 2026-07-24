const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'ml-training', 'fast_omr_worker.py');
const PYTHON = process.env.OMR_PYTHON || 'python3';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.OMR_FAST_TIMEOUT_MS, 10) || 5000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

let worker = null;
let stdoutBuffer = Buffer.alloc(0);
let nextRequestId = 1;
const pending = new Map();

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
      stopWorker(new Error(`Fast OMR returned an invalid ${responseLength}-byte frame`));
      return;
    }
    if (stdoutBuffer.length < responseLength + 4) return;
    const payload = stdoutBuffer.subarray(4, responseLength + 4);
    stdoutBuffer = stdoutBuffer.subarray(responseLength + 4);
    let response;
    try {
      response = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      stopWorker(new Error(`Fast OMR returned invalid JSON: ${error.message}`));
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
  child.on('error', error => {
    if (worker === child) stopWorker(new Error(`Could not start ${PYTHON}: ${error.message}`));
  });
  child.on('close', code => {
    if (worker === child) {
      stopWorker(new Error(`Fast OMR worker exited with code ${code}`));
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
 *   detectAdaptiveForm(buffer, { timeoutMs, useCnn, includeDiagnostics })
 */
async function detectAdaptiveForm(imageBuffer, timeoutOrOptions = DEFAULT_TIMEOUT_MS) {
  if (!Buffer.isBuffer(imageBuffer)) return null;
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
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      const error = new Error(`Fast OMR timed out after ${timeoutMs} ms`);
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
      request.reject(error);
      stopWorker(error);
    });
  }).catch(error => {
    console.warn(`[FAST-OMR] ${error.message}`);
    return null;
  });
}

function shutdownAdaptiveWorker() {
  stopWorker();
}

module.exports = { detectAdaptiveForm, shutdownAdaptiveWorker };
