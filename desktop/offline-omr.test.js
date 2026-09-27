'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { assertScannerSender, createOfflineOmr } = require('./offline-omr');

test('only the main AcadCheck frame can invoke the native scanner', () => {
  const origin = 'http://127.0.0.1:43127';
  const mainFrame = { url: origin + '/scanner' };
  const webContents = { mainFrame };
  const window = { isDestroyed: () => false, webContents };
  assert.doesNotThrow(() => assertScannerSender({ sender: webContents, senderFrame: mainFrame }, window, origin));
  for (const event of [
    { sender: {}, senderFrame: mainFrame },
    { sender: webContents, senderFrame: { url: origin + '/scanner' } },
    { sender: webContents, senderFrame: null },
  ]) assert.throws(() => assertScannerSender(event, window, origin));
  mainFrame.url = 'https://untrusted.example/';
  assert.throws(() => assertScannerSender({ sender: webContents, senderFrame: mainFrame }, window, origin));
});

const request = { imageBase64: Buffer.from('image').toString('base64'), questionCount: 50 };

test('passes images and tracking to the worker and preserves rejection and sequence evidence', async () => {
  const bridge = createOfflineOmr(() => ({
    async detectAdaptiveForm(bytes, options) {
      assert.equal(bytes.toString(), 'image');
      assert.equal(options.trackingSessionId, 'desktop:camera');
      assert.equal(options.frameId, 7);
      assert.equal(options.useCnn, true);
      assert.equal(options.detectSequence, true);
      assert.equal(options.includeOverlayGeometry, true);
      assert.equal(options.debugDir, undefined);
      return { success: true, gradeable: false, answers: ['A'], reason: 'Uncertain row',
        qualityMetrics: { sequence: '3', sequenceConfidence: 96 }, centers: ['internal'] };
    },
  }));
  const result = await bridge.scan({ ...request, trackingSessionId: 'camera', frameId: '7', debugDir: 'ignored' });
  assert.equal(result.gradeable, false);
  assert.equal(result.reason, 'Uncertain row');
  assert.equal(result.sequence, '3');
  assert.equal(result.sequenceConfidence, 96);
  assert.equal(result.centers, undefined);
});

test('rejects invalid input before starting a worker', async () => {
  let started = false;
  const bridge = createOfflineOmr(() => { started = true; throw new Error('Unexpected worker'); });
  for (const changes of [
    { imageBase64: '' }, { imageBase64: '%%%%' }, { imageBase64: 'YQ' },
    { questionCount: 0 }, { questionCount: 51 }, { questionCount: 1.5 },
    { trackingSessionId: 'camera', frameId: '-1' },
    { trackingSessionId: 'camera', frameId: '9007199254740992' },
  ]) await assert.rejects(bridge.scan({ ...request, ...changes }));
  assert.equal(started, false);
});

test('does not queue concurrent frames and releases the worker after errors', async () => {
  let finish;
  const bridge = createOfflineOmr(() => ({
    detectAdaptiveForm: () => new Promise((resolve, reject) => { finish = reject; }),
  }));
  const first = bridge.scan(request);
  await assert.rejects(bridge.scan(request), /already reading/);
  finish(new Error('Worker exited'));
  await assert.rejects(first, /Worker exited/);
  const next = bridge.scan(request);
  finish(new Error('Next frame attempted'));
  await assert.rejects(next, /Next frame attempted/);
});

test('shares warmup, retries initialization failures and waits before scanning', async () => {
  let finish;
  let reads = 0;
  let warmups = 0;
  const bridge = createOfflineOmr(() => ({
    prewarmAdaptiveWorker: () => { warmups++; return new Promise(resolve => { finish = resolve; }); },
    detectAdaptiveForm: async () => { reads++; return { success: true }; },
  }));
  const failed = bridge.prewarm();
  finish({ success: false });
  await assert.rejects(failed, /could not initialize/);
  const first = bridge.prewarm();
  const second = bridge.prewarm();
  const reading = bridge.scan(request);
  assert.equal(reads, 0);
  finish({ success: true });
  await Promise.all([first, second, reading]);
  assert.equal(warmups, 2);
  assert.equal(reads, 1);
});
