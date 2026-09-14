'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const DESKTOP_SHELL_HOST = '127.0.0.1';
// Keep this outside Windows' default dynamic port range (49152-65535). The
// origin must stay identical between launches because Chromium localStorage is
// isolated by scheme, host, and port.
const DESKTOP_SHELL_PORT = 43127;
const OFFLINE_DATABASE_KEY = 'acadcheck.offline.database.v1';

const MIME_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

function parseEnv(contents) {
  const values = {};
  for (const rawLine of String(contents || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value.replace(/\\n/g, '\n');
  }
  return values;
}

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
  });
  response.end(body);
}

function proxyRequest(request, response, backendPort, bootstrapToken) {
  const headers = { ...request.headers };
  delete headers['content-length'];
  if (
    request.method === 'POST'
    && request.url.split('?')[0] === '/api/auth/register'
    && bootstrapToken
  ) {
    headers['x-bootstrap-token'] = bootstrapToken;
  }
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: backendPort,
    path: request.url,
    method: request.method,
    headers,
  }, upstream => {
    response.writeHead(upstream.statusCode || 502, upstream.headers);
    upstream.pipe(response);
  });
  proxy.setTimeout(190_000, () => proxy.destroy(new Error('Backend request timed out')));
  proxy.on('error', error => {
    if (response.headersSent) {
      response.destroy(error);
      return;
    }
    sendJson(response, 503, {
      success: false,
      desktop: true,
      message: 'AcadCheck services are still starting or need configuration.',
    });
  });
  request.pipe(proxy);
}

function safeStaticPath(wwwRoot, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^[/\\]+/, '');
  const resolved = path.resolve(wwwRoot, relative || 'index.html');
  const prefix = `${path.resolve(wwwRoot)}${path.sep}`;
  if (resolved !== path.join(path.resolve(wwwRoot), 'index.html') && !resolved.startsWith(prefix)) {
    return null;
  }
  return resolved;
}

function serveStatic(request, response, wwwRoot) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { success: false, message: 'Method not allowed' });
    return;
  }
  const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
  let filePath = safeStaticPath(wwwRoot, pathname);
  if (!filePath) {
    sendJson(response, 400, { success: false, message: 'Invalid path' });
    return;
  }
  let stat = null;
  try { stat = fs.statSync(filePath); } catch (_) {}
  if (!stat?.isFile()) {
    filePath = path.join(wwwRoot, 'index.html');
    try { stat = fs.statSync(filePath); } catch (_) { stat = null; }
  }
  if (!stat?.isFile()) {
    sendJson(response, 503, { success: false, message: 'The desktop web build is missing.' });
    return;
  }
  response.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(filePath).pipe(response);
}

function createShellServer({ wwwRoot, getBackendPort, getBootstrapToken, getStatus }) {
  return http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/__desktop/status') {
      sendJson(response, 200, getStatus());
      return;
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      const backendPort = getBackendPort();
      if (!backendPort) {
        sendJson(response, 503, {
          success: false,
          desktop: true,
          message: 'AcadCheck services are still starting or need configuration.',
        });
        return;
      }
      proxyRequest(request, response, backendPort, getBootstrapToken());
      return;
    }
    serveStatic(request, response, wwwRoot);
  });
}

function desktopOrigin(port = DESKTOP_SHELL_PORT) {
  return `http://${DESKTOP_SHELL_HOST}:${port}`;
}

function extractLegacyShellPorts(contents, currentPort = DESKTOP_SHELL_PORT) {
  const ports = [];
  const seen = new Set();
  const matches = [...String(contents || '').matchAll(/Desktop shell started at http:\/\/127\.0\.0\.1:(\d+)/g)];
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const port = Number.parseInt(matches[index][1], 10);
    if (port < 1 || port > 65535 || port === currentPort || seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}

function storageSnapshotScore(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  let score = Object.keys(snapshot).length;
  try {
    const database = JSON.parse(snapshot[OFFLINE_DATABASE_KEY] || '{}');
    for (const key of ['classrooms', 'students', 'answerKeys', 'scans', 'responses', 'activity']) {
      if (Array.isArray(database[key])) score += database[key].length * 100;
    }
  } catch (_) {}
  return score;
}

function selectBestStorageSnapshot(snapshots) {
  let best = null;
  let bestScore = 0;
  for (const snapshot of snapshots || []) {
    const score = storageSnapshotScore(snapshot);
    if (score > bestScore) {
      best = snapshot;
      bestScore = score;
    }
  }
  return { snapshot: best, score: bestScore };
}

module.exports = {
  DESKTOP_SHELL_HOST,
  DESKTOP_SHELL_PORT,
  OFFLINE_DATABASE_KEY,
  createShellServer,
  desktopOrigin,
  extractLegacyShellPorts,
  parseEnv,
  safeStaticPath,
  selectBestStorageSnapshot,
  storageSnapshotScore,
};
