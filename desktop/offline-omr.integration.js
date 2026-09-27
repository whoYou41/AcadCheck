'use strict';
// Exercise the actual isolated renderer -> IPC -> compiled worker path with
// an unavailable database and isolated application storage.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { desktopOrigin } = require('./runtime');

const root = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function openPort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function command(url, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => { socket.close(); reject(new Error('Renderer command timed out')); }, 25000);
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('Renderer connection failed')); });
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timeout); socket.close();
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      else resolve(message.result);
    });
  });
}
async function main() {
  const packaged = process.argv[2];
  const executable = packaged ? path.resolve(packaged) : path.join(root, 'node_modules/electron/dist/electron.exe');
  const userData = fs.mkdtempSync(path.join(root, '.tmp/offline-native-'));
  fs.mkdirSync(path.join(userData, 'config'));
  fs.writeFileSync(path.join(userData, 'config/backend.env'), 'DB_HOST=127.0.0.1\nDB_PORT=1\nDB_NAME=offline_test\nJWT_SECRET=isolated-offline-scanner-test-secret-1234567890\n');
  const port = await openPort();
  const env = { ...process.env, ACADCHECK_DESKTOP_USER_DATA: userData, ACADCHECK_DESKTOP_SMOKE_MS: '120000' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [...(packaged ? [] : [root]), `--remote-debugging-port=${port}`], {
    cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-12000); });
  let target;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode != null) throw new Error(`Application exited: ${child.exitCode}\n${logs}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(500) });
        target = (await response.json()).find(item => item.type === 'page' && item.url.startsWith(desktopOrigin()));
        if (target?.webSocketDebuggerUrl) break;
      } catch (_) {}
      await delay(100);
    }
    assert.ok(target?.webSocketDebuggerUrl, logs);
    const evaluate = async expression => (await command(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    })).result.value;
    // DevTools publishes the navigation URL before the new page's preload
    // and execution context are ready. Wait for the actual application page.
    let bridgeReady = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        bridgeReady = await evaluate("document.readyState !== 'loading' && typeof window.acadcheckOmr?.scan === 'function'");
        if (bridgeReady) break;
      } catch (_) {}
      await delay(100);
    }
    assert.equal(bridgeReady, true, 'Native preload did not initialize: ' + logs);
    assert.equal(await evaluate('typeof window.require'), 'undefined');
    const ready = await evaluate('window.acadcheckOmr.prewarm()');
    assert.equal(ready.ready, true);
    const truths = { 'allA.jpg': 'A'.repeat(50), 'allB.jpg': 'B'.repeat(50),
      'allC.jpg': 'C'.repeat(50), 'allD.jpg': 'D'.repeat(50),
      'random.jpg': 'DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB' };
    const cases = [];
    const fixtures = Object.entries(truths).map(([name, truth]) => ({ name, truth,
      image: fs.readFileSync(path.join(root, 'ml-training/real_scans', name)) }));
    const sharp = require(path.join(root, 'backend/node_modules/sharp'));
    // Exercise the formerly failing diagonal geometry through the packaged IPC path.
    for (const [name, angle] of [['allA.jpg', 315], ['random.jpg', 45], ['allA.jpg', 90], ['allD.jpg', 270]]) {
      const image = await sharp(path.join(root, 'ml-training/real_scans', name))
        .resize(1440, 810).rotate(angle, { background: { r: 40, g: 40, b: 40 } })
        .jpeg({ quality: 92 }).toBuffer();
      fixtures.push({ name: `${name}-rotation-${angle}`, truth: truths[name], image });
    }
    for (const { name, truth, image } of fixtures) {
      const imageBase64 = image.toString('base64');
      for (const frameId of ['1', '2']) {
        const result = await evaluate(`window.acadcheckOmr.scan(${JSON.stringify({ imageBase64, questionCount: 50, trackingSessionId: name, frameId })})`);
        assert.equal(result.gradeable, true, `${name}: ${result.reason}`);
        assert.equal(result.answers.join(''), truth, name);
        assert.equal(result.geometryVerified, true);
        assert.deepEqual(result.qualityMetrics.criticalFailures, []);
        cases.push({ name, frameId, gradeable: result.gradeable, processingMs: result.processingMs });
      }
    }
    const invalid = await evaluate(`window.acadcheckOmr.scan(${JSON.stringify({ imageBase64: Buffer.from('not an image').toString('base64'), questionCount: 50 })})`);
    assert.equal(invalid.success, false);
    assert.notEqual(invalid.gradeable, true);
    console.log(JSON.stringify({ passed: true, packaged: !!packaged, noDatabaseRequired: true, cases }, null, 2));
  } finally {
    if (target?.webSocketDebuggerUrl) {
      try { await command(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression: 'window.close()' }); } catch (_) {}
    }
    if (child.exitCode == null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
    if (child.exitCode == null) child.kill();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
