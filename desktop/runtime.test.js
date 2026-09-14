'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DESKTOP_SHELL_PORT,
  createShellServer,
  desktopOrigin,
  extractLegacyShellPorts,
  parseEnv,
  safeStaticPath,
  selectBestStorageSnapshot,
  storageSnapshotScore,
} = require('./runtime');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, ...options }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        headers: response.headers,
      }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('parseEnv handles comments, exports, and quoted values', () => {
  assert.deepEqual(parseEnv(`
    # comment
    DB_HOST=127.0.0.1 # local
    export DB_USER="school user"
    DB_PASSWORD='a # value'
  `), {
    DB_HOST: '127.0.0.1',
    DB_USER: 'school user',
    DB_PASSWORD: 'a # value',
  });
});

test('safeStaticPath prevents traversal outside the web root', () => {
  const root = path.resolve('www');
  assert.equal(safeStaticPath(root, '/assets/app.js'), path.join(root, 'assets', 'app.js'));
  assert.equal(safeStaticPath(root, '/../secret.txt'), null);
});

test('desktop browser origin remains stable across application launches', () => {
  assert.equal(desktopOrigin(), `http://127.0.0.1:${DESKTOP_SHELL_PORT}`);
  assert.equal(desktopOrigin(), desktopOrigin());
  assert.ok(DESKTOP_SHELL_PORT < 49152);
});

test('legacy storage recovery finds recent random origins and prefers saved records', () => {
  const log = [
    'Desktop shell started at http://127.0.0.1:55111',
    'Desktop shell started at http://127.0.0.1:55222',
    'Desktop shell started at http://127.0.0.1:55111',
    `Desktop shell started at ${desktopOrigin()}`,
  ].join('\n');
  assert.deepEqual(extractLegacyShellPorts(log), [55111, 55222]);

  const small = { 'acadcheck.offline.database.v1': JSON.stringify({ classrooms: [{}] }) };
  const larger = {
    currentUser: '{"id":1}',
    'acadcheck.offline.database.v1': JSON.stringify({ classrooms: [{}], students: [{}, {}] }),
  };
  assert.ok(storageSnapshotScore(larger) > storageSnapshotScore(small));
  assert.equal(selectBestStorageSnapshot([small, larger]).snapshot, larger);
});

test('desktop shell serves the SPA and reports an unavailable backend', async t => {
  const wwwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acadcheck-desktop-test-'));
  fs.writeFileSync(path.join(wwwRoot, 'index.html'), '<h1>AcadCheck</h1>');
  t.after(() => fs.rmSync(wwwRoot, { recursive: true, force: true }));
  const server = createShellServer({
    wwwRoot,
    getBackendPort: () => null,
    getBootstrapToken: () => '',
    getStatus: () => ({ phase: 'starting' }),
  });
  const port = await listen(server);
  t.after(() => server.close());

  const page = await request(port, '/classrooms');
  assert.equal(page.status, 200);
  assert.match(page.body, /AcadCheck/);
  const api = await request(port, '/api/ready');
  assert.equal(api.status, 503);
  assert.equal(JSON.parse(api.body).desktop, true);
});

test('desktop proxy adds the bootstrap token only to local registration', async t => {
  let observedToken = null;
  const backend = http.createServer((req, res) => {
    observedToken = req.headers['x-bootstrap-token'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"success":true}');
  });
  const backendPort = await listen(backend);
  t.after(() => backend.close());
  const wwwRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acadcheck-desktop-proxy-'));
  fs.writeFileSync(path.join(wwwRoot, 'index.html'), 'ok');
  t.after(() => fs.rmSync(wwwRoot, { recursive: true, force: true }));
  const shellServer = createShellServer({
    wwwRoot,
    getBackendPort: () => backendPort,
    getBootstrapToken: () => 'one-time-token',
    getStatus: () => ({}),
  });
  const shellPort = await listen(shellServer);
  t.after(() => shellServer.close());

  const response = await request(shellPort, '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(observedToken, 'one-time-token');
});
