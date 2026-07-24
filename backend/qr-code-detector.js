const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'ml-training', 'detect_qr.py');
const PYTHON = process.env.QR_PYTHON || process.env.OMR_PYTHON || 'python3';
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.QR_DETECTION_TIMEOUT_MS, 10) || 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

let worker = null;
let stdoutBuffer = Buffer.alloc(0);
let nextRequestId = 1;
const pending = new Map();

function rejectPending(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.resolve({ detected: false, payload: null, reason: error.message });
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
      stopWorker(new Error(`QR worker returned an invalid ${responseLength}-byte frame`));
      return;
    }
    if (stdoutBuffer.length < responseLength + 4) return;
    const payload = stdoutBuffer.subarray(4, responseLength + 4);
    stdoutBuffer = stdoutBuffer.subarray(responseLength + 4);
    let response;
    try {
      response = JSON.parse(payload.toString('utf8'));
    } catch (error) {
      stopWorker(new Error(`QR worker returned invalid JSON: ${error.message}`));
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
    throw new Error(`QR worker is missing: ${SCRIPT}`);
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
    if (message) console.warn(`[QR] ${message}`);
  });
  child.on('error', error => {
    if (worker === child) stopWorker(new Error(`Could not start ${PYTHON}: ${error.message}`));
  });
  child.on('close', code => {
    if (worker === child) {
      stopWorker(new Error(`QR worker exited with code ${code}`));
    }
  });
  child.unref();
  if (typeof child.stdin.unref === 'function') child.stdin.unref();
  if (typeof child.stdout.unref === 'function') child.stdout.unref();
  if (typeof child.stderr.unref === 'function') child.stderr.unref();
  return child;
}

async function detectQrCode(imageBuffer, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!Buffer.isBuffer(imageBuffer)) {
    return { detected: false, payload: null, reason: 'QR detector unavailable' };
  }
  const id = String(nextRequestId++);
  const header = Buffer.from(JSON.stringify({ id }), 'utf8');
  const frame = Buffer.allocUnsafe(8 + header.length + imageBuffer.length);
  frame.writeUInt32BE(header.length, 0);
  header.copy(frame, 4);
  frame.writeUInt32BE(imageBuffer.length, 4 + header.length);
  imageBuffer.copy(frame, 8 + header.length);

  return new Promise(resolve => {
    let child;
    try {
      child = ensureWorker();
    } catch (error) {
      resolve({ detected: false, payload: null, reason: error.message });
      return;
    }
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      const error = new Error(`QR detection timed out after ${timeoutMs} ms`);
      resolve({ detected: false, payload: null, reason: error.message });
      stopWorker(error);
    }, timeoutMs);
    pending.set(id, { timer, resolve });
    child.stdin.write(frame, error => {
      if (!error) return;
      const request = pending.get(id);
      if (!request) return;
      pending.delete(id);
      clearTimeout(timer);
      request.resolve({ detected: false, payload: null, reason: error.message });
      stopWorker(error);
    });
  });
}

function shutdownQrWorker() {
  stopWorker();
}

function parseAnswerKeyQr(payload) {
  const value = String(payload || '').trim();
  const versioned = value.match(/^ACADCHECK:ANSWER_KEY:V1:50:4:(\d+):([a-f0-9]{32,64})$/i);
  if (versioned) {
    return {
      answerKeyId: Number(versioned[1]),
      qrToken: versioned[2].toLowerCase(),
      formLayout: 'acadcheck-50-v1',
      numQuestions: 50,
      numChoices: 4,
      legacy: false,
    };
  }
  const legacy = value.match(/^ACADCHECK:ANSWER_KEY:(\d+):([a-f0-9]{32,64})$/i);
  if (!legacy) return null;
  return {
    answerKeyId: Number(legacy[1]),
    qrToken: legacy[2].toLowerCase(),
    formLayout: null,
    numQuestions: null,
    numChoices: null,
    legacy: true,
  };
}

module.exports = { detectQrCode, parseAnswerKeyQr, shutdownQrWorker };
