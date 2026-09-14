'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { desktopOrigin, OFFLINE_DATABASE_KEY } = require('./runtime');

const root = path.resolve(__dirname, '..');
const electron = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForTarget(port, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Electron exited early with code ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
      const targets = await response.json();
      const target = targets.find(item => item.type === 'page' && item.url.startsWith(desktopOrigin()));
      if (target?.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for the AcadCheck Electron page');
}

function devToolsCommand(webSocketUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error('DevTools evaluation timed out'));
    }, 5_000);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method,
        params,
      }));
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error || message.result?.exceptionDetails) {
        reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      } else {
        resolve(message.result);
      }
    });
    socket.addEventListener('error', () => {
      clearTimeout(timeout);
      reject(new Error('DevTools WebSocket failed'));
    });
  });
}

function waitForExit(child) {
  if (child.exitCode != null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Electron did not close cleanly'));
    }, 12_000);
    child.once('exit', code => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function localStorageId(webSocketUrl) {
  const deadline = Date.now() + 5_000;
  let frameUrl = '';
  while (Date.now() < deadline) {
    const frameTree = await devToolsCommand(webSocketUrl, 'Page.getFrameTree');
    const frame = frameTree.frameTree.frame;
    frameUrl = frame.url;
    if (frameUrl.startsWith(desktopOrigin())) {
      try {
        const result = await devToolsCommand(
          webSocketUrl, 'Storage.getStorageKeyForFrame', { frameId: frame.id },
        );
        return { storageKey: result.storageKey, isLocalStorage: true };
      } catch (_) {}
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`AcadCheck frame did not commit to persistent origin; current URL: ${frameUrl}`);
}

async function launch(userData) {
  const debugPort = await findOpenPort();
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [`--remote-debugging-port=${debugPort}`, root], {
    cwd: root,
    windowsHide: true,
    env: {
      ...childEnvironment,
      ACADCHECK_DESKTOP_USER_DATA: userData,
      ACADCHECK_DESKTOP_SMOKE_MS: '10000',
    },
    stdio: 'ignore',
  });
  const webSocketUrl = await waitForTarget(debugPort, child);
  return { child, webSocketUrl };
}

async function closeApp(run) {
  const code = await waitForExit(run.child);
  assert.equal(code, 0);
}

async function main() {
  assert.ok(fs.existsSync(path.join(root, 'www', 'index.html')), 'Run the production web build first');
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'acadcheck-persistence-'));
  const marker = JSON.stringify({
    version: 1,
    counters: {},
    classrooms: [{ id: 901, name: 'Restart persistence', section: 'Test' }],
    students: [], answerKeys: [], scans: [], responses: [], activity: [],
  });
  try {
    const first = await launch(userData);
    const firstStorageId = await localStorageId(first.webSocketUrl);
    await devToolsCommand(first.webSocketUrl, 'DOMStorage.setDOMStorageItem', {
      storageId: firstStorageId, key: OFFLINE_DATABASE_KEY, value: marker,
    });
    await closeApp(first);

    const second = await launch(userData);
    const secondStorageId = await localStorageId(second.webSocketUrl);
    const storedItems = await devToolsCommand(
      second.webSocketUrl, 'DOMStorage.getDOMStorageItems', { storageId: secondStorageId },
    );
    const restored = storedItems.entries.find(([key]) => key === OFFLINE_DATABASE_KEY)?.[1];
    assert.equal(restored, marker);
    await closeApp(second);
    console.log(`Persistence verified across two Electron launches at ${desktopOrigin()}`);
  } finally {
    await new Promise(resolve => setTimeout(resolve, 750));
    try {
      fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch (error) {
      console.warn(`Temporary profile cleanup was deferred: ${error.message}`);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
