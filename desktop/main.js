'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const {
  DESKTOP_SHELL_HOST,
  DESKTOP_SHELL_PORT,
  OFFLINE_DATABASE_KEY,
  createShellServer,
  desktopOrigin,
  extractLegacyShellPorts,
  parseEnv,
  selectBestStorageSnapshot,
  storageSnapshotScore,
} = require('./runtime');

if (process.env.ACADCHECK_DESKTOP_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.ACADCHECK_DESKTOP_USER_DATA));
}
const smokeTestMs = Math.max(0, Number.parseInt(process.env.ACADCHECK_DESKTOP_SMOKE_MS, 10) || 0);
const LEGACY_STORAGE_MIGRATION_KEY = 'acadcheck.desktop.storage-origin-migration.v1';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const { assertScannerSender, createOfflineOmr } = require('./offline-omr');
let offlineWorker = null;
const offlineOmr = createOfflineOmr(() => {
  if (!offlineWorker) {
    const root = runtimeRoot();
    process.env.ACADCHECK_ROOT_DIR = root;
    // Packaging stores backend dependencies in backend-vendor. The backend
    // child gets NODE_PATH at launch; this in-process reader must refresh
    // Node's module search paths before loading the same scanner adapter.
    if (app.isPackaged) {
      process.env.NODE_PATH = [path.join(root, 'backend-vendor'), process.env.NODE_PATH || '']
        .filter(Boolean).join(path.delimiter);
      require('module').Module._initPaths();
    }
    process.env.OMR_OPENCV_THREADS ||= '2';
    const executable = path.join(root, 'desktop-runtime', 'acadcheck-omr-worker.exe');
    if (fs.existsSync(executable)) process.env.OMR_WORKER_EXECUTABLE = executable;
    offlineWorker = require(path.join(root, 'backend', 'adaptive-form-omr.js'));
  }
  return offlineWorker;
});

let mainWindow = null;
let shellServer = null;
let shellPort = null;
let backendProcess = null;
let backendPort = null;
let bootstrapToken = '';
let quitting = false;
let healthTimer = null;
const backendState = {
  phase: 'not-started',
  ready: false,
  detail: 'Waiting for desktop startup',
  exitCode: null,
};

function runtimeRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
}

function userPaths() {
  const root = app.getPath('userData');
  return {
    root,
    configDir: path.join(root, 'config'),
    configFile: path.join(root, 'config', 'backend.env'),
    dataDir: path.join(root, 'data'),
    logDir: path.join(root, 'logs'),
    logFile: path.join(root, 'logs', 'backend.log'),
  };
}

function defaultConfig() {
  const secret = crypto.randomBytes(48).toString('base64url');
  const initialToken = crypto.randomBytes(24).toString('base64url');
  return `# AcadCheck Desktop configuration
# Close AcadCheck before editing this file, then reopen it.
NODE_ENV=production
HOST=127.0.0.1
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=acadcheck_db
DB_USER=root
DB_PASSWORD=
JWT_SECRET=${secret}
BOOTSTRAP_ADMIN_TOKEN=${initialToken}
PUBLIC_REGISTRATION=false
CORS_ORIGINS=
TRUST_PROXY=false
REQUIRE_PI_CAMERA=false
PI_CAMERA_URL=
ACADCAM_IPS=192.168.254.104
OMR_OPENCV_THREADS=1
OMR_MAX_PENDING_REQUESTS=2
TESSERACT_POOL_SIZE=1
`;
}

function ensureUserFiles() {
  const paths = userPaths();
  for (const directory of [paths.configDir, paths.dataDir, paths.logDir]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  try {
    fs.writeFileSync(paths.configFile, defaultConfig(), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  return paths;
}

function readConfiguration(configFile) {
  try {
    return parseEnv(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    backendState.phase = 'configuration-error';
    backendState.detail = `Could not read ${configFile}: ${error.message}`;
    return {};
  }
}

function appendLog(message) {
  try {
    const paths = userPaths();
    fs.mkdirSync(paths.logDir, { recursive: true });
    fs.appendFileSync(paths.logFile, `[${new Date().toISOString()}] ${String(message).trimEnd()}\n`);
  } catch (_) {}
}

function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function checkBackend() {
  if (!backendPort || !backendProcess) return;
  try {
    const response = await fetch(`http://127.0.0.1:${backendPort}/api/ready`, {
      signal: AbortSignal.timeout(2500),
    });
    const status = await response.json();
    backendState.ready = response.ok && status.success === true;
    backendState.phase = backendState.ready ? 'ready' : 'starting';
    backendState.detail = backendState.ready
      ? 'Database and scanner are ready'
      : `Waiting for readiness: ${JSON.stringify(status.checks || {})}`;
  } catch (_) {
    if (backendProcess) {
      backendState.ready = false;
      backendState.phase = 'starting';
    }
  }
}

function stopBackend() {
  clearInterval(healthTimer);
  healthTimer = null;
  const child = backendProcess;
  backendProcess = null;
  backendPort = null;
  if (!child || child.killed) return Promise.resolve();
  return new Promise(resolve => {
    const timeout = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve();
    }, 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    try { child.kill('SIGTERM'); } catch (_) { clearTimeout(timeout); resolve(); }
  });
}

async function startBackend() {
  await stopBackend();
  const paths = ensureUserFiles();
  const root = runtimeRoot();
  const config = readConfiguration(paths.configFile);
  bootstrapToken = config.BOOTSTRAP_ADMIN_TOKEN || '';
  backendPort = await findOpenPort();
  const serverScript = path.join(root, 'backend', 'server.js');
  const bundledWorker = path.join(root, 'desktop-runtime', 'acadcheck-omr-worker.exe');
  const env = {
    ...process.env,
    ...config,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(backendPort),
    ACADCHECK_ROOT_DIR: root,
    ACADCHECK_WWW_DIR: path.join(root, 'www'),
    ACADCHECK_DATA_DIR: paths.dataDir,
    NODE_PATH: [
      path.join(root, 'backend-vendor'),
      process.env.NODE_PATH || '',
    ].filter(Boolean).join(path.delimiter),
    ELECTRON_RUN_AS_NODE: '1',
  };
  if (fs.existsSync(bundledWorker)) env.OMR_WORKER_EXECUTABLE = bundledWorker;

  backendState.phase = 'starting';
  backendState.ready = false;
  backendState.exitCode = null;
  backendState.detail = 'Starting database and scanner services';
  appendLog('--- Starting AcadCheck backend ---');
  const child = spawn(process.execPath, [serverScript], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendProcess = child;
  child.stdout.on('data', chunk => appendLog(chunk));
  child.stderr.on('data', chunk => {
    const message = chunk.toString();
    appendLog(message);
    backendState.detail = message.trim().split(/\r?\n/).slice(-1)[0] || backendState.detail;
  });
  child.once('error', error => {
    if (backendProcess !== child) return;
    backendState.phase = 'failed';
    backendState.detail = error.message;
    backendProcess = null;
    backendPort = null;
  });
  child.once('exit', code => {
    if (backendProcess !== child) return;
    backendState.phase = quitting ? 'stopped' : 'failed';
    backendState.ready = false;
    backendState.exitCode = code;
    if (!quitting) backendState.detail = `Backend stopped with exit code ${code}. Open Desktop Diagnostics for help.`;
    backendProcess = null;
    backendPort = null;
  });
  healthTimer = setInterval(checkBackend, 2000);
  healthTimer.unref();
}

function showDiagnostics() {
  const paths = userPaths();
  const message = backendState.ready
    ? 'AcadCheck desktop services are ready.'
    : 'The desktop interface remains available in Offline Mode. Full account and database features need MySQL configured and running.';
  dialog.showMessageBox(mainWindow, {
    type: backendState.ready ? 'info' : 'warning',
    title: 'AcadCheck Desktop Diagnostics',
    message,
    detail: `Status: ${backendState.phase}\n${backendState.detail}\n\nConfiguration: ${paths.configFile}\nLog: ${paths.logFile}`,
    buttons: ['OK'],
  });
}

function installMenu() {
  Menu.setApplicationMenu(null);
}

function readLocalStorage(webContents) {
  return webContents.executeJavaScript(`(() => {
    const result = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key != null) result[key] = localStorage.getItem(key);
    }
    return result;
  })()`);
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  return new Promise(resolve => server.close(resolve));
}

async function readLegacyOriginStorage(port) {
  const probeServer = http.createServer((_request, response) => {
    const body = Buffer.from('<!doctype html><meta charset="utf-8"><title>AcadCheck storage recovery</title>');
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
    });
    response.end(body);
  });
  let probeWindow = null;
  try {
    await new Promise((resolve, reject) => {
      probeServer.once('error', reject);
      probeServer.listen(port, DESKTOP_SHELL_HOST, resolve);
    });
    probeWindow = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    await probeWindow.loadURL(desktopOrigin(port));
    return await readLocalStorage(probeWindow.webContents);
  } finally {
    if (probeWindow && !probeWindow.isDestroyed()) probeWindow.destroy();
    await closeServer(probeServer);
  }
}

async function recoverLegacyLocalStorage(targetWindow, logFile) {
  let logContents = '';
  try {
    const logBuffer = fs.readFileSync(logFile);
    logContents = logBuffer.subarray(Math.max(0, logBuffer.length - 2_000_000)).toString('utf8');
  } catch (_) {}

  const current = await readLocalStorage(targetWindow.webContents);
  if (current[LEGACY_STORAGE_MIGRATION_KEY] === '1') return false;
  const legacyPorts = extractLegacyShellPorts(logContents).slice(0, 12);
  const snapshots = [];
  let successfulProbes = 0;
  // A bounded scan keeps startup fast even if a long-lived installation has
  // accumulated many historic random ports.
  for (const port of legacyPorts) {
    try {
      const snapshot = await readLegacyOriginStorage(port);
      successfulProbes += 1;
      if (storageSnapshotScore(snapshot) > 0) snapshots.push(snapshot);
    } catch (error) {
      appendLog(`Skipped legacy storage origin ${desktopOrigin(port)}: ${error.message}`);
    }
  }
  const recovered = selectBestStorageSnapshot(snapshots);
  if (!recovered.snapshot || recovered.score <= storageSnapshotScore(current)) {
    // If all known origins were temporarily unavailable, retry next launch.
    if (legacyPorts.length > 0 && successfulProbes === 0) return false;
    await targetWindow.webContents.executeJavaScript(
      `localStorage.setItem(${JSON.stringify(LEGACY_STORAGE_MIGRATION_KEY)}, '1')`,
    );
    return false;
  }

  const migration = JSON.stringify({
    incoming: recovered.snapshot,
    databaseKey: OFFLINE_DATABASE_KEY,
    migrationKey: LEGACY_STORAGE_MIGRATION_KEY,
  });
  await targetWindow.webContents.executeJavaScript(`(({ incoming, databaseKey, migrationKey }) => {
    for (const [key, value] of Object.entries(incoming)) {
      if (localStorage.getItem(key) == null) localStorage.setItem(key, value);
    }
    if (typeof incoming[databaseKey] === 'string') {
      localStorage.setItem(databaseKey, incoming[databaseKey]);
    }
    localStorage.setItem(migrationKey, '1');
  })(${migration})`);
  appendLog(`Recovered offline browser storage (${recovered.score} weighted records) into ${desktopOrigin()}`);
  return true;
}

async function createWindow() {
  const root = runtimeRoot();
  shellServer = createShellServer({
    wwwRoot: path.join(root, 'www'),
    getBackendPort: () => backendPort,
    getBootstrapToken: () => bootstrapToken,
    getStatus: () => ({ ...backendState, backendPort }),
  });
  await new Promise((resolve, reject) => {
    shellServer.once('error', reject);
    shellServer.listen(DESKTOP_SHELL_PORT, DESKTOP_SHELL_HOST, () => {
      shellPort = DESKTOP_SHELL_PORT;
      resolve();
    });
  });

  const appOrigin = desktopOrigin();
  for (const operation of ['prewarm', 'scan']) {
    ipcMain.handle(`acadcheck:omr:${operation}`, (event, options) => {
      assertScannerSender(event, mainWindow, appOrigin);
      return offlineOmr[operation](options);
    });
  }
  const iconPath = app.isPackaged
    ? path.join(root, 'desktop', 'icon.png')
    : path.join(root, 'desktop', 'icon.png');
  mainWindow = new BrowserWindow({
    title: 'AcadCheck',
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f7fb',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${appOrigin}/`)) event.preventDefault();
  });
  await mainWindow.loadURL(appOrigin);
  const migrated = await recoverLegacyLocalStorage(mainWindow, userPaths().logFile);
  if (migrated) await mainWindow.loadURL(appOrigin);
  if (!smokeTestMs) mainWindow.show();
}

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  ensureUserFiles();
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const origin = new URL(webContents.getURL()).origin;
    callback(permission === 'media' && origin === desktopOrigin());
  });
  installMenu();
  await createWindow();
  appendLog(`Desktop shell started at ${desktopOrigin()}`);
  startBackend().catch(error => {
    backendState.phase = 'failed';
    backendState.detail = error.message;
    appendLog(error.stack || error.message);
  });
  if (smokeTestMs) setTimeout(() => app.quit(), smokeTestMs);
}).catch(error => {
  dialog.showErrorBox('AcadCheck could not start', error.stack || error.message);
  app.quit();
});

app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  if (offlineWorker) offlineWorker.shutdownAdaptiveWorker();
  stopBackend().finally(() => {
    if (shellServer) shellServer.close();
    app.quit();
  });
});

app.on('window-all-closed', () => app.quit());
