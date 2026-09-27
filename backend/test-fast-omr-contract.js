const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const sharp = require('sharp');

// A cold development worker can include Python/OpenCV initialization. The
// deployed server prewarms it, while this one-shot contract test does not.
process.env.OMR_FAST_TIMEOUT_MS ||= '15000';
process.env.ACADCHECK_SERVER_UNIT_TEST = '1';
process.env.BOOTSTRAP_ADMIN_TOKEN = 'test-bootstrap-token-32-characters';
process.env.NODE_ENV = 'test';
process.env.CORS_ORIGINS = 'http://localhost:8100';
process.env.PUBLIC_REGISTRATION = 'false';

const EnhancedScanner = require('./enhanced-scanner');
const {
  detectAdaptiveForm,
  shutdownAdaptiveWorker,
  __adaptiveWorkerTest,
} = require('./adaptive-form-omr');
const { checkCameraTunnel } = require('./deployment-preflight');

const fixtureRoot = path.join(__dirname, '..', 'ml-training', 'real_scans');
const truths = {
  'allA.jpg': 'A'.repeat(50),
  'allB.jpg': 'B'.repeat(50),
  'allC.jpg': 'C'.repeat(50),
  'allD.jpg': 'D'.repeat(50),
  'random.jpg': 'DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB',
};

function assertFiniteRange(value, minimum, maximum, label) {
  assert.ok(Number.isFinite(Number(value)), `${label} must be finite`);
  assert.ok(Number(value) >= minimum && Number(value) <= maximum,
    `${label} must be between ${minimum} and ${maximum}; received ${value}`);
}

async function testLiveSheetBarrierContract(referenceFingerprint, transformedFingerprint) {
  const state = require('./server').__liveSheetStateTest;
  assert.ok(state, 'server live-sheet test hooks must be available');
  assert.equal(state.isAllowedCorsOrigin('http://localhost:8100'), true,
    'the documented local development origin must be allowed');
  assert.equal(state.isAllowedCorsOrigin('https://untrusted.example'), false,
    'an unconfigured web origin must not receive CORS permission');
  assert.equal(state.isPrivateOrLoopbackAddress('192.168.254.20'), true,
    'a same-Wi-Fi private IPv4 client must be eligible for a camera-only session');
  assert.equal(state.isPrivateOrLoopbackAddress('::ffff:127.0.0.1'), true,
    'the local frontend proxy must be eligible for a camera-only session');
  assert.equal(state.isPrivateOrLoopbackAddress('8.8.8.8'), false,
    'a public client must never receive an offline camera session');
  const localCameraRequest = {
    ip: '192.168.254.20',
    headers: {},
    get(name) {
      return ({ origin: 'http://localhost:8100', host: 'localhost:3000', 'sec-fetch-site': 'same-origin' })[name];
    },
  };
  assert.equal(state.isTrustedOfflineCameraRequest(localCameraRequest), true,
    'the same-site Angular proxy request must be accepted from a private LAN');
  assert.equal(state.isTrustedOfflineCameraRequest({ ...localCameraRequest, ip: '8.8.8.8' }), false,
    'origin checks must not turn a public address into a local camera client');
  assert.equal(state.registrationRoleForUserCount(0, 'wrong-token'), null,
    'the first database account must reject an invalid bootstrap token');
  assert.equal(
    state.registrationRoleForUserCount(0, process.env.BOOTSTRAP_ADMIN_TOKEN),
    'admin',
    'the first database account must accept the configured bootstrap token'
  );
  assert.equal(state.registrationRoleForUserCount(1), null,
    'later public registrations must be disabled by default');
  assert.equal(state.validateRuntimeConfiguration().available, true,
    'deployment runtime validation must find OpenCV and NumPy');
  const qrRetryResult = (answers, overrides = {}) => ({
    detectedAnswers: answers.split(''),
    markedLetters: answers.split('').map(answer => answer ? [answer] : []),
    details: {
      source: 'fast-hybrid-grid',
      currentSheetGeometry: true,
      gradeable: true,
      uncertainRows: 0,
      geometryConfidence: overrides.geometryConfidence || 92,
      registrationConfidence: overrides.registrationConfidence || 74,
      bubbleLocalizationConfidence: overrides.bubbleLocalizationConfidence || 84,
      placement: { locator: overrides.locator || 'qr-grid-sift-usac' },
      grid: {
        confidence: overrides.geometryConfidence || 92,
        bubbleLocalizationConfidence: overrides.bubbleLocalizationConfidence || 84,
        absoluteRowPhaseAnchored: true,
        rowPhaseAnchorErrorRows: overrides.phaseError ?? 0.20,
      },
    },
  });
  const consensusTruth = 'ABABCDABBBCDAAAABCBCDABCDABABACBBBCBACBDDBACAABABD';
  const losslessA = qrRetryResult(consensusTruth, { geometryConfidence: 95 });
  const losslessB = qrRetryResult(consensusTruth, { geometryConfidence: 92 });
  const assessmentA = state.assessFastOmrRetry(losslessA);
  const assessmentB = state.assessFastOmrRetry(losslessB);
  assert.equal(assessmentA.trusted, true);
  assert.equal(assessmentA.semanticSignature, assessmentB.semanticSignature);
  let consensus = state.selectLosslessOmrConsensus([
    { result: losslessA, assessment: assessmentA },
    { result: losslessB, assessment: assessmentB },
  ], 2);
  assert.equal(consensus.verified, true,
    'two identical lossless QR-grid reads must form a recovery consensus');
  assert.equal(consensus.selected.result, losslessA,
    'consensus must retain the strongest independently verified read');
  consensus = state.selectLosslessOmrConsensus([
    { result: losslessA, assessment: assessmentA },
  ], 2);
  assert.equal(consensus.verified, false,
    'one gradeable scale must not override an untrusted raw preflight');
  const conflicting = qrRetryResult(`B${consensusTruth.slice(1)}`);
  consensus = state.selectLosslessOmrConsensus([
    { result: losslessA, assessment: assessmentA },
    { result: conflicting, assessment: state.assessFastOmrRetry(conflicting) },
  ], 2);
  assert.equal(consensus.verified, false,
    'lossless scales that disagree on any row must fail closed');
  const driftingQr = qrRetryResult(consensusTruth, {
    locator: 'qr-anchor-lattice',
    phaseError: 2.4396,
  });
  assert.equal(state.assessFastOmrRetry(driftingQr).trusted, false,
    'a first-row-looking QR warp with row-25 drift must never be trusted');
  const driftingSift = qrRetryResult(consensusTruth, {
    locator: 'sift-static-template-usac',
    phaseError: 0.75,
  });
  assert.equal(state.assessFastOmrRetry(driftingSift).trusted, false,
    'a static-template fallback with unstable row identity must never be trusted');
  assert.deepEqual(state.processingFailureDisposition(true), {
    committed: true,
    retrySafe: false,
    rollback: false,
    persistFailure: false,
    status: 503,
  }, 'post-commit response failures must never make a saved grade retryable');
  assert.equal(state.processingFailureDisposition(false).persistFailure, true);
  assert.equal(state.processingFailureDisposition(false).retrySafe, true);
  const eventTicket = state.issueSseTicket({ userId: 41, username: 'teacher', role: 'teacher' }, 1000);
  assert.equal(state.consumeSseTicket(eventTicket, 1001)?.userId, 41,
    'an authenticated SSE ticket must resolve to its issuing user');
  assert.equal(state.consumeSseTicket(eventTicket, 1002), null,
    'an SSE ticket must be single-use');
  const expiredTicket = state.issueSseTicket({ userId: 42 }, 2000);
  assert.equal(state.consumeSseTicket(expiredTicket, 32_001), null,
    'expired SSE tickets must be rejected');
  assert.equal(state.sseEventMatchesClient({ userId: '41' }, 41), true);
  assert.equal(state.sseEventMatchesClient({ userId: '41' }, 42), false,
    'realtime events must never cross account boundaries');
  const proxyUrl = state.cameraProxyRequestUrl(
    { cameraUrl: 'http://10.8.0.2:5000' },
    'capture',
    { max_width: 1440, quality: 92 }
  );
  assert.equal(proxyUrl.origin, 'http://10.8.0.2:5000');
  assert.equal(proxyUrl.pathname, '/capture');
  assert.equal(proxyUrl.searchParams.get('max_width'), '1440');
  let tunneledCaptureCount = 0;
  let tunneledRequestUrl = '';
  const mockCamera = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        camera_initialized: true,
        frame_available: true,
      }));
      return;
    }
    tunneledCaptureCount++;
    tunneledRequestUrl = req.url || '';
    setTimeout(() => {
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'X-Camera-Frame-Id': 'mock-frame-1',
      });
      const frame = Buffer.alloc(2048);
      frame[0] = 0xff;
      frame[1] = 0xd8;
      frame[frame.length - 2] = 0xff;
      frame[frame.length - 1] = 0xd9;
      res.end(frame);
    }, 20);
  });
  await new Promise((resolve, reject) => {
    mockCamera.once('error', reject);
    mockCamera.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = mockCamera.address();
    assert.ok(address && typeof address === 'object');
    state.setLastKnownCamera({
      cameraUrl: `http://127.0.0.1:${address.port}`,
      cameraInitialized: true,
      frameAvailable: true,
    });
    const captures = await Promise.all([
      state.fetchCameraCapture({ max_width: 1440, quality: 92 }),
      state.fetchCameraCapture({ max_width: 1440, quality: 92 }),
      state.fetchCameraCapture({ max_width: 1440, quality: 92 }),
    ]);
    assert.equal(tunneledCaptureCount, 1,
      'overlapping browser captures must share one private-tunnel transfer');
    assert.equal(captures[0].contentType, 'image/jpeg');
    assert.equal(captures[0].frameId, 'mock-frame-1');
    assert.equal(captures[0].body.length, 2048);
    const capturedUrl = new URL(tunneledRequestUrl, 'http://mock-camera');
    assert.equal(capturedUrl.pathname, '/capture');
    assert.equal(capturedUrl.searchParams.get('max_width'), '1440');
    assert.equal(capturedUrl.searchParams.get('quality'), '92');

    const previousCameraUrl = process.env.PI_CAMERA_URL;
    const previousRequireCamera = process.env.REQUIRE_PI_CAMERA;
    process.env.PI_CAMERA_URL = `http://127.0.0.1:${address.port}`;
    process.env.REQUIRE_PI_CAMERA = 'true';
    try {
      const preflightReport = { success: true, checks: [] };
      await checkCameraTunnel(preflightReport);
      assert.equal(preflightReport.success, true);
      assert.equal(preflightReport.checks[0]?.name, 'camera-tunnel');
      assert.equal(preflightReport.checks[0]?.ok, true,
        'deployment preflight must prove status and capture across the tunnel');
    } finally {
      if (previousCameraUrl === undefined) delete process.env.PI_CAMERA_URL;
      else process.env.PI_CAMERA_URL = previousCameraUrl;
      if (previousRequireCamera === undefined) delete process.env.REQUIRE_PI_CAMERA;
      else process.env.REQUIRE_PI_CAMERA = previousRequireCamera;
    }
  } finally {
    await new Promise(resolve => mockCamera.close(resolve));
    state.reset();
  }
  const recoveringCamera = { cameraInitialized: false, frameAvailable: false, cameraUrl: 'http://stale' };
  const healthyCamera = { cameraInitialized: true, frameAvailable: true, cameraUrl: 'http://healthy' };
  assert.equal(
    state.preferredCameraResult([recoveringCamera, healthyCamera]),
    healthyCamera,
    'discovery must prefer a frame-producing camera over a faster recovering host'
  );
  assert.equal(state.preferredCameraResult([recoveringCamera, null]), recoveringCamera);
  const preferredHealthy = await state.firstHealthyCameraOrFallback([
    Promise.resolve(recoveringCamera),
    new Promise(resolve => setTimeout(() => resolve(healthyCamera), 10)),
  ], 100);
  assert.equal(preferredHealthy, healthyCamera,
    'a fast recovering host must not mask a slightly later healthy camera');
  const boundedRecovery = await state.firstHealthyCameraOrFallback([
    Promise.resolve(recoveringCamera),
    new Promise(() => {}),
  ], 20);
  assert.equal(boundedRecovery, recoveringCamera,
    'discovery timeout must return a reachable recovery target');
  const present = (fingerprint, version = 2) => ({
    details: {
      sheetPresence: 'present',
      sheetFingerprint: fingerprint,
      sheetFingerprintVersion: version,
    },
  });
  const finalize = (userId, fingerprint, version = 2, sequence = null) => state.markLiveSheetFinalized(userId, {
    answerKeyId: 1,
    sequence,
    omrResult: present(fingerprint, version),
  });

  if (referenceFingerprint && transformedFingerprint) {
    assert.ok(state.sheetFingerprintDistance(referenceFingerprint, transformedFingerprint) <= 7,
      'tilt/lighting repeat must remain within the same-sheet fingerprint threshold');
    assert.ok(state.sheetIdentityDistance(referenceFingerprint, transformedFingerprint) < 6,
      'tilt/lighting repeat must not look like a new physical identity');
  }

  state.reset();
  finalize('same-v2', 'abcdef0123456789');
  let observation = state.observeLiveSheet('same-v2', present('abcdef0123456789'), 'same:1');
  assert.equal(observation.duplicateSheet, true);
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.sheetIdentityChanged, false);

  state.reset();
  finalize('answer-only', 'abcdef0000000000');
  observation = state.observeLiveSheet('answer-only', present('abcdefdeadbeef00'), 'answer:1');
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.newSheetFrames, 1,
    'different answer pixels must begin stable replacement confirmation');
  assert.equal(observation.identityFingerprintDistance, 0);
  observation = state.observeLiveSheet(
    'answer-only', present('abcdefdeadbeef00'), 'answer:1'
  );
  assert.equal(observation.newSheetFrames, 1,
    'one replayed image must not prove an answer-only replacement');
  observation = state.observeLiveSheet(
    'answer-only', present('abcdefdeadbeef00'), 'answer:2'
  );
  assert.equal(observation.removalRequired, false);
  assert.equal(observation.sheetIdentityChanged, true,
    'two distinct stable frames must release a changed complete answer sheet');

  state.reset();
  finalize('sequence-swap', 'abcdef0000000000', 2, '01');
  const sequenceReplacement = present('abcdefdeadbeef00');
  observation = state.observeLiveSheet(
    'sequence-swap', sequenceReplacement, 'sequence:1', '02'
  );
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.newSheetFrames, 1,
    'a different student sequence must start replacement confirmation');
  observation = state.observeLiveSheet(
    'sequence-swap', sequenceReplacement, 'sequence:1', '02'
  );
  assert.equal(observation.newSheetFrames, 1,
    'replaying one replacement image must not satisfy the two-frame gate');
  observation = state.observeLiveSheet(
    'sequence-swap', present('abcdef0000000000'), 'sequence:old'
  );
  assert.equal(observation.duplicateSheet, true,
    'a carried sequence hint must not unlock the previously finalized pixels');
  assert.equal(observation.removalRequired, true);
  observation = state.observeLiveSheet(
    'sequence-swap', sequenceReplacement, 'sequence:2', '02'
  );
  assert.equal(observation.newSheetFrames, 1);
  observation = state.observeLiveSheet(
    'sequence-swap', sequenceReplacement, 'sequence:3'
  );
  assert.equal(observation.removalRequired, false);
  assert.equal(observation.newSheetConfirmed, true);
  assert.equal(observation.sheetIdentityChanged, true,
    'a tracked confirmation frame may reuse the first frame sequence');
  // Different students may have identical answers and collide in the compact hash.
  finalize('identical-answers', 'abcdef0000000000', 2, '01');
  const identicalAnswers = present('abcdef0000000000');
  observation = state.observeLiveSheet('identical-answers', identicalAnswers, 'identity:1', '02');
  assert.equal(observation.newSheetFrames, 1);
  observation = state.observeLiveSheet('identical-answers', identicalAnswers, 'identity:1', '02');
  assert.equal(observation.newSheetFrames, 1, 'replayed sequence evidence must not confirm a swap');
  observation = state.observeLiveSheet('identical-answers', identicalAnswers, 'identity:2', '02');
  assert.equal(observation.sheetIdentityChanged, true,
    'two current sequence readings must distinguish students with identical answer fingerprints');
  observation = state.observeLiveSheet('identical-answers', identicalAnswers, 'identity:old', '01');
  assert.equal(observation.duplicateSheet, true, 'the old student must remain blocked');

  finalize('sequence-swap', 'abcdefdeadbeef00', 2, '02');
  observation = state.observeLiveSheet(
    'sequence-swap', sequenceReplacement, 'sequence:4', '02'
  );
  assert.equal(observation.duplicateSheet, true,
    'the newly finalized sequence must become the next duplicate barrier');
  assert.equal(observation.removalRequired, true);

  state.reset();
  finalize('identity-only', '0000000123456789');
  const changedIdentity = present('fc00000123456789'); // exactly six identity-prefix bits
  observation = state.observeLiveSheet('identity-only', changedIdentity, 'identity:1');
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.newSheetFrames, 1);
  assert.equal(observation.sheetIdentityChanged, false);
  observation = state.observeLiveSheet('identity-only', changedIdentity, 'identity:1');
  assert.equal(observation.removalRequired, true,
    'replaying one observation must not confirm a replacement sheet');
  assert.equal(observation.newSheetFrames, 1);
  observation = state.observeLiveSheet('identity-only', changedIdentity, 'identity:2');
  assert.equal(observation.removalRequired, false);
  assert.equal(observation.newSheetConfirmed, true);
  assert.equal(observation.sheetIdentityChanged, true);
  observation = state.observeLiveSheet('identity-only', changedIdentity, 'identity:3');
  assert.equal(observation.newSheetConfirmed, true,
    'confirmed replacement must remain retryable until its grade commits');
  assert.equal(observation.sheetIdentityChanged, true);
  finalize('identity-only', 'fc00000123456789');
  observation = state.observeLiveSheet('identity-only', changedIdentity, 'identity:4');
  assert.equal(observation.duplicateSheet, true,
    'committing the replacement must make that sheet the new duplicate identity');
  assert.equal(observation.removalRequired, true);

  state.reset();
  finalize('removal', 'abcdef0123456789');
  const absent = { details: { sheetPresence: 'absent' } };
  observation = state.observeLiveSheet('removal', absent, 'removal:1');
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.removalFrames, 1);
  observation = state.observeLiveSheet('removal', absent, 'removal:1');
  assert.equal(observation.removalRequired, true,
    'replaying one empty frame must not prove sheet removal');
  assert.equal(observation.removalFrames, 1);
  observation = state.observeLiveSheet('removal', absent, 'removal:2');
  assert.equal(observation.removalRequired, false);
  assert.equal(observation.removalConfirmed, true);
  assert.equal(observation.sheetIdentityChanged, true);

  state.reset();
  finalize('legacy-v1', '0000000123456789', 1);
  observation = state.observeLiveSheet('legacy-v1', present('ffffff0123456789', 1), 'legacy:1');
  assert.equal(observation.removalRequired, true);
  assert.equal(observation.sheetIdentityChanged, false);
  observation = state.observeLiveSheet('legacy-v1', present('ffffff0123456789', 1), 'legacy:2');
  assert.equal(observation.removalRequired, true,
    'v1 fingerprints must require explicit sheet removal');
  state.reset();
}

async function main() {
  const summaries = [];
  let randomFingerprint = null;
  try {
    const invalid = await detectAdaptiveForm(Buffer.from('not-an-image'));
    assert.equal(invalid.success, false);
    assert.equal(invalid.stage, 'image-limits');
    assertFiniteRange(invalid.bridgeMs, 0, 15000, 'invalid-input bridgeMs');

    // A shared worker failure rejects every request on that generation. Their
    // concurrent retries must share one replacement without either stale
    // callback killing it again.
    const concurrentImage = await fs.promises.readFile(path.join(fixtureRoot, 'allA.jpg'));
    const concurrentRequests = [
      detectAdaptiveForm(concurrentImage, {
        timeoutMs: 15000,
        useCnn: false,
      }),
      detectAdaptiveForm(concurrentImage, {
        timeoutMs: 15000,
        useCnn: false,
      }),
    ];
    const pendingDeadline = Date.now() + 5000;
    while (__adaptiveWorkerTest.pendingCount() < 2 && Date.now() < pendingDeadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(__adaptiveWorkerTest.pendingCount(), 2,
      'both requests must be pending before the simulated worker failure');
    assert.equal(__adaptiveWorkerTest.restart(), true);
    const recoveredRequests = await Promise.all(concurrentRequests);
    for (const recoveredRequest of recoveredRequests) {
      assert.equal(recoveredRequest.success, true,
        'each concurrent request must recover on the replacement worker');
      assert.equal(recoveredRequest.workerAttempts, 2,
        'each concurrent request must report exactly one recovery attempt');
    }
    const workerPidBeforeAssetChange = __adaptiveWorkerTest.workerPid();
    assert.ok(workerPidBeforeAssetChange,
      'the recovered persistent worker must expose its process generation');
    assert.equal(__adaptiveWorkerTest.markAssetVersionStale(), true);
    const afterAssetChange = await detectAdaptiveForm(concurrentImage, {
      timeoutMs: 15000,
      useCnn: false,
    });
    assert.equal(afterAssetChange.success, true,
      'the first scan after a detector asset change must succeed');
    assert.notEqual(__adaptiveWorkerTest.workerPid(), workerPidBeforeAssetChange,
      'an idle persistent worker must reload before scanning with changed assets');

    assert.equal(__adaptiveWorkerTest.maxPendingRequests, 4,
      'the worker must retain a bounded default queue for live camera bursts');
    const burstResults = await Promise.all(Array.from(
      { length: __adaptiveWorkerTest.maxPendingRequests + 1 },
      () => detectAdaptiveForm(concurrentImage, {
        timeoutMs: 15000,
        useCnn: false,
      })
    ));
    assert.equal(burstResults.filter(result => result.success === true).length, 4,
      'the bounded worker queue must finish every admitted request');
    const busyResults = burstResults.filter(result => result.stage === 'worker-busy');
    assert.equal(busyResults.length, 1,
      'an excess burst frame must fail fast instead of entering the stale queue');
    assertFiniteRange(busyResults[0].bridgeMs, 0, 250,
      'worker-busy bridgeMs');

    for (const [filename, truth] of Object.entries(truths)) {
      const image = await fs.promises.readFile(path.join(fixtureRoot, filename));
      const wallStarted = process.hrtime.bigint();
      const result = await EnhancedScanner.hybridDetectAnswers(image, truth, 50, {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
      });
      const wallMs = Number(process.hrtime.bigint() - wallStarted) / 1e6;

      assert.equal(result.details?.source, 'fast-hybrid-grid',
        `${filename} must use the authoritative fast grid`);
      assert.equal(result.details?.currentSheetGeometry, true);
      assert.deepEqual(result.detectedAnswers, truth.split(''),
        `${filename} answer mismatch`);
      assert.equal(result.confidenceScores.length, 50);
      assert.equal(result.markedLetters.length, 50);
      result.confidenceScores.forEach((score, index) =>
        assertFiniteRange(score, 0, 100, `${filename} confidence row ${index + 1}`));

      assert.match(String(result.details.sheetFingerprint || ''), /^[a-f0-9]{16,128}$/);
      assert.equal(result.details.sheetFingerprintVersion, 2);
      assertFiniteRange(result.details.averageConfidence, 0, 100,
        `${filename} average confidence`);
      assertFiniteRange(result.details.qualityMetrics?.overall, 0, 100,
        `${filename} overall quality`);
      assert.equal(result.details.qualityMetrics?.gradeable, true);
      assert.ok(result.details.stagesMs && typeof result.details.stagesMs === 'object');
      assertFiniteRange(result.details.processingMs, 0, 15000,
        `${filename} worker processingMs`);
      assertFiniteRange(result.details.totalBridgeMs, 0, 20000,
        `${filename} total bridgeMs`);
      assertFiniteRange(result.details.timingMetrics?.workerRoundTripMs, 0, 20000,
        `${filename} worker round trip`);
      if (filename === 'random.jpg') randomFingerprint = result.details.sheetFingerprint;

      summaries.push({
        fixture: filename,
        confidence: result.details.averageConfidence,
        quality: result.details.qualityMetrics.overall,
        fingerprint: result.details.sheetFingerprint,
        processingMs: result.details.processingMs,
        bridgeMs: result.details.totalBridgeMs,
        wallMs: Number(wallMs.toFixed(3)),
        stagesMs: result.details.stagesMs,
      });

      // Match the browser's normalized live-preview frame produced from the
      // existing Raspberry Pi /capture response. This protects the q92
      // resize/grayscale setting from changes that make valid rows uncertain.
      const livePreviewFrame = await sharp(image)
        .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
        .grayscale()
        .jpeg({ quality: 92 })
        .toBuffer();
      const livePreviewResult = await EnhancedScanner.hybridDetectAnswers(
        livePreviewFrame,
        truth,
        50,
        {
          formLayout: 'acadcheck-50',
          fastMode: true,
          trustedOnly: true,
          verifyWithAi: true,
        }
      );
      assert.equal(livePreviewResult.details?.source, 'fast-hybrid-grid',
        `${filename} live preview must use the authoritative fast grid`);
      assert.deepEqual(livePreviewResult.detectedAnswers, truth.split(''),
        `${filename} live preview answer mismatch`);
      assert.equal(livePreviewResult.details.qualityMetrics?.gradeable, true,
        `${filename} live preview must remain safely gradeable`);
      summaries.push({
        fixture: `${filename}:browser-live-1440-q92`,
        confidence: livePreviewResult.details.averageConfidence,
        quality: livePreviewResult.details.qualityMetrics.overall,
        fingerprint: livePreviewResult.details.sheetFingerprint,
        processingMs: livePreviewResult.details.processingMs,
        bridgeMs: livePreviewResult.details.totalBridgeMs,
        stagesMs: livePreviewResult.details.stagesMs,
      });
    }

    // Match the live browser path: a smaller frame, mild camera tilt, and a
    // horizontal illumination falloff. This catches regressions where the
    // JS bridge accidentally preprocesses away page geometry or the worker
    // only succeeds on the original fixture exposure.
    const liveTruth = truths['random.jpg'];
    const liveSource = await fs.promises.readFile(path.join(fixtureRoot, 'random.jpg'));
    const metadata = await sharp(liveSource).metadata();
    const width = Number(metadata.width);
    const height = Number(metadata.height);

    // Match a freely placed older QR-format sheet in a wide camera frame.
    // The page fills the frame height but only a narrow center strip, so its
    // top and bottom paper edges are unavailable and registration must come
    // entirely from the printed answer area. No QR anchor is supplied.
    const insetWidth = Math.round(width * 0.82);
    const insetHeight = Math.round(height * 0.82);
    const insetLeft = Math.floor((width - insetWidth) / 2);
    const insetTop = Math.floor((height - insetHeight) / 2);
    const distantLiveVariant = await sharp(liveSource)
      .resize({ width: insetWidth, height: insetHeight, fit: 'fill' })
      .extend({
        left: insetLeft,
        right: width - insetWidth - insetLeft,
        top: insetTop,
        bottom: height - insetHeight - insetTop,
        extendWith: 'mirror',
      })
      .resize({ width: 1440, height: 1440, fit: 'inside' })
      .grayscale()
      .jpeg({ quality: 92 })
      .toBuffer();
    const distantLiveResult = await EnhancedScanner.hybridDetectAnswers(
      distantLiveVariant,
      liveTruth,
      50,
      {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
      }
    );
    assert.deepEqual(
      distantLiveResult.detectedAnswers,
      liveTruth.split(''),
      'narrow freely placed 1440px sheet answer mismatch'
    );
    assert.equal(
      distantLiveResult.details?.placement?.locator,
      'sift-static-template-usac',
      'distant sheet must register from fixed answer-sheet print'
    );
    assert.ok(
      ['bright-visible-content-roi', 'oriented-paper-content'].includes(
        distantLiveResult.details?.placement?.provisionalContent?.method),
      'distant sheet must use the QR-independent paper-content crop'
    );
    summaries.push({
      fixture: 'random-live-1440-distant-no-qr-anchor',
      confidence: distantLiveResult.details.averageConfidence,
      quality: distantLiveResult.details.qualityMetrics.overall,
      fingerprint: distantLiveResult.details.sheetFingerprint,
      processingMs: distantLiveResult.details.processingMs,
      bridgeMs: distantLiveResult.details.totalBridgeMs,
      stagesMs: distantLiveResult.details.stagesMs,
    });

    // A reflection can join the white page to the desk in the binary contour
    // mask. The fallback must recover the portrait paper band from column
    // consistency and still prove every answer row without a QR anchor.
    const sheetLeft = Math.round(width * 0.339);
    const sheetWidth = Math.round(width * 0.33);
    const narrowSheet = await sharp(liveSource)
      .extract({ left: sheetLeft, top: 0, width: sheetWidth, height })
      .resize({ width: 476, height: 810, fit: 'fill' })
      .toBuffer();
    const glareBridge = await sharp({
      create: {
        width: 1440,
        height: 25,
        channels: 3,
        background: { r: 235, g: 235, b: 235 },
      },
    }).png().toBuffer();
    const connectedGlareVariant = await sharp({
      create: {
        width: 1440,
        height: 810,
        channels: 3,
        background: { r: 45, g: 45, b: 45 },
      },
    })
      .composite([
        { input: narrowSheet, left: 482, top: 0 },
        { input: glareBridge, left: 0, top: 30 },
      ])
      .grayscale()
      .jpeg({ quality: 92 })
      .toBuffer();
    const connectedGlareResult = await EnhancedScanner.hybridDetectAnswers(
      connectedGlareVariant,
      liveTruth,
      50,
      {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
      }
    );
    assert.deepEqual(
      connectedGlareResult.detectedAnswers,
      liveTruth.split(''),
      'connected-glare paper-band fallback answer mismatch'
    );
    assert.equal(
      connectedGlareResult.details?.placement?.provisionalContent?.method,
      'vertical-paper-band-roi',
      'connected glare must use the projection-based paper-band fallback'
    );
    summaries.push({
      fixture: 'random-live-1440-connected-glare-no-qr-anchor',
      confidence: connectedGlareResult.details.averageConfidence,
      quality: connectedGlareResult.details.qualityMetrics.overall,
      fingerprint: connectedGlareResult.details.sheetFingerprint,
      processingMs: connectedGlareResult.details.processingMs,
      bridgeMs: connectedGlareResult.details.totalBridgeMs,
      stagesMs: connectedGlareResult.details.stagesMs,
    });

    // A narrow sheet rotated inside the landscape Pi frame used to alternate
    // between a 0-row homography rejection and a false missing-right-block
    // result. Both tilt directions must survive the bounded crop ensemble.
    for (const angle of [-8, 8]) {
      const tiltedPaperBandVariant = await sharp(connectedGlareVariant)
        .rotate(angle, { background: { r: 45, g: 45, b: 45 } })
        .resize({ width: 1440, height: 810, fit: 'cover' })
        .grayscale()
        .jpeg({ quality: 92 })
        .toBuffer();
      const tiltedPaperBandResult = await EnhancedScanner.hybridDetectAnswers(
        tiltedPaperBandVariant,
        liveTruth,
        50,
        {
          formLayout: 'acadcheck-50',
          fastMode: true,
          trustedOnly: true,
          verifyWithAi: true,
        }
      );
      assert.equal(
        tiltedPaperBandResult.details?.source,
        'fast-hybrid-grid',
        `${angle} degree narrow live sheet must use the authoritative grid`
      );
      assert.deepEqual(
        tiltedPaperBandResult.detectedAnswers,
        liveTruth.split(''),
        `${angle} degree narrow live sheet answer mismatch`
      );
      assert.equal(
        tiltedPaperBandResult.details.qualityMetrics?.gradeable,
        true,
        `${angle} degree narrow live sheet must remain gradeable`
      );
      summaries.push({
        fixture: `random-live-1440-paper-band-tilt-${angle}`,
        confidence: tiltedPaperBandResult.details.averageConfidence,
        quality: tiltedPaperBandResult.details.qualityMetrics.overall,
        fingerprint: tiltedPaperBandResult.details.sheetFingerprint,
        processingMs: tiltedPaperBandResult.details.processingMs,
        bridgeMs: tiltedPaperBandResult.details.totalBridgeMs,
        stagesMs: tiltedPaperBandResult.details.stagesMs,
      });
    }

    const gradient = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`
      + '<defs><linearGradient id="g"><stop stop-color="#a8a8a8"/><stop offset="1" stop-color="#ffffff"/></linearGradient></defs>'
      + `<rect width="${width}" height="${height}" fill="url(#g)"/></svg>`
    );
    const gradientImage = await sharp(gradient)
      .resize({ width, height, fit: 'fill' })
      .png()
      .toBuffer();
    const litSource = await sharp(liveSource)
      .composite([{ input: gradientImage, blend: 'multiply' }])
      .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const liveVariant = await sharp(litSource)
      .rotate(3, { background: { r: 28, g: 28, b: 28 } })
      .resize({ width: 1440, height: 1440, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .toBuffer();
    const liveStarted = process.hrtime.bigint();
    const liveResult = await EnhancedScanner.hybridDetectAnswers(liveVariant, liveTruth, 50, {
      formLayout: 'acadcheck-50',
      fastMode: true,
      trustedOnly: true,
      verifyWithAi: true,
      includeOverlayGeometry: true,
      trackingSessionId: 'contract-live-tracking',
      frameId: '1',
    });
    const liveWallMs = Number(process.hrtime.bigint() - liveStarted) / 1e6;
    assert.equal(liveResult.details?.source, 'fast-hybrid-grid');
    assert.deepEqual(liveResult.detectedAnswers, liveTruth.split(''),
      '1440px tilted/uneven-lighting live fixture answer mismatch');
    assert.equal(liveResult.details.qualityMetrics?.gradeable, true);
    assertFiniteRange(liveResult.details.qualityMetrics?.overall, 55, 100,
      'live transformed overall quality');
    const overlay = liveResult.details?.overlayGeometry;
    assert.ok(Number(overlay?.width) > 0 && Number(overlay?.height) > 0,
      'live overlay must describe the exact source-frame coordinate space');
    assert.equal(overlay?.centers?.length, 50,
      'live overlay must include all 50 verified answer rows');
    assert.ok(overlay.centers.every(row =>
      Array.isArray(row)
      && row.length === 4
      && row.every(point =>
        Number(point?.[0]) >= 0
        && Number(point?.[0]) <= Number(overlay.width)
        && Number(point?.[1]) >= 0
        && Number(point?.[1]) <= Number(overlay.height)
      )),
    'every live overlay bubble center must remain inside the displayed frame');
    summaries.push({
      fixture: 'random-live-1440-tilt-lighting',
      confidence: liveResult.details.averageConfidence,
      quality: liveResult.details.qualityMetrics.overall,
      fingerprint: liveResult.details.sheetFingerprint,
      processingMs: liveResult.details.processingMs,
      bridgeMs: liveResult.details.totalBridgeMs,
      wallMs: Number(liveWallMs.toFixed(3)),
      stagesMs: liveResult.details.stagesMs,
    });

    // A live session must reuse its already verified homography on the next
    // frame while still rerunning current-frame bubble/grid validation. This
    // protects the fast temporal route from silently falling back to SIFT.
    const trackedResult = await EnhancedScanner.hybridDetectAnswers(
      liveVariant, liveTruth, 50, {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
        includeOverlayGeometry: true,
        trackingSessionId: 'contract-live-tracking',
        frameId: '2',
      }
    );
    assert.deepEqual(trackedResult.detectedAnswers, liveTruth.split(''),
      'tracked live fixture answer mismatch');
    assert.equal(trackedResult.details?.placement?.locator, 'temporal-lk-usac',
      'the next live frame must use the verified temporal registration route');
    assert.equal(trackedResult.details.qualityMetrics?.gradeable, true);
    assert.equal(trackedResult.details?.overlayGeometry?.centers?.length, 50,
      'temporal tracking must refresh overlay coordinates for the current frame');
    assertFiniteRange(trackedResult.details.processingMs, 0, 1000,
      'tracked live worker processingMs');
    summaries.push({
      fixture: 'random-live-1440-tracked',
      confidence: trackedResult.details.averageConfidence,
      quality: trackedResult.details.qualityMetrics.overall,
      fingerprint: trackedResult.details.sheetFingerprint,
      processingMs: trackedResult.details.processingMs,
      bridgeMs: trackedResult.details.totalBridgeMs,
      stagesMs: trackedResult.details.stagesMs,
    });

    // A larger camera/paper movement can exceed pyramidal optical flow even
    // though the complete sheet remains visible. The last accepted frame's
    // masked immutable print must recover that movement before the repetitive
    // canonical-template matcher, then pass the normal 200-cell/50-row gates.
    const referenceTrackingSessionId = 'contract-reference-frame-recovery';
    const referenceSeed = await EnhancedScanner.hybridDetectAnswers(
      liveVariant, liveTruth, 50, {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
        trackingSessionId: referenceTrackingSessionId,
        frameId: '1',
      }
    );
    assert.equal(referenceSeed.details?.source, 'fast-hybrid-grid',
      'reference recovery seed must be a fully verified current frame');
    const referenceSeedMetadata = await sharp(liveVariant).metadata();
    const referenceRecoveryVariant = await sharp(liveVariant)
      .rotate(12, { background: { r: 28, g: 28, b: 28 } })
      .resize({
        width: referenceSeedMetadata.width,
        height: referenceSeedMetadata.height,
        fit: 'cover',
      })
      .grayscale()
      .jpeg({ quality: 88 })
      .toBuffer();
    const referenceRecoveryResult = await EnhancedScanner.hybridDetectAnswers(
      referenceRecoveryVariant, liveTruth, 50, {
        formLayout: 'acadcheck-50',
        fastMode: true,
        trustedOnly: true,
        verifyWithAi: true,
        trackingSessionId: referenceTrackingSessionId,
        frameId: '2',
      }
    );
    assert.equal(referenceRecoveryResult.details?.source, 'fast-hybrid-grid');
    assert.equal(
      referenceRecoveryResult.details?.placement?.locator,
      'reference-frame-sift-usac',
      'large live movement must use the accepted-frame reference registrar'
    );
    assert.deepEqual(
      referenceRecoveryResult.detectedAnswers,
      liveTruth.split(''),
      'accepted-frame reference recovery answer mismatch'
    );
    assert.equal(referenceRecoveryResult.details?.grid?.rowSupport, 50,
      'accepted-frame reference recovery must verify all 50 physical rows');
    assert.equal(referenceRecoveryResult.details.qualityMetrics?.gradeable, true);
    summaries.push({
      fixture: 'random-live-1440-reference-frame-recovery',
      confidence: referenceRecoveryResult.details.averageConfidence,
      quality: referenceRecoveryResult.details.qualityMetrics.overall,
      fingerprint: referenceRecoveryResult.details.sheetFingerprint,
      processingMs: referenceRecoveryResult.details.processingMs,
      bridgeMs: referenceRecoveryResult.details.totalBridgeMs,
      stagesMs: referenceRecoveryResult.details.stagesMs,
    });
    await testLiveSheetBarrierContract(randomFingerprint, liveResult.details.sheetFingerprint);
  } finally {
    shutdownAdaptiveWorker();
  }
  console.log(JSON.stringify({
    success: true,
    liveSheetBarrierContract: true,
    fixtures: summaries,
  }, null, 2));
}

main().catch(error => {
  shutdownAdaptiveWorker();
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
