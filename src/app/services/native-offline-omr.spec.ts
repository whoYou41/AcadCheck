import { Capacitor } from '@capacitor/core';
import { NativeOfflineOmrPlugin, NativeOmrPayload, OfflineOmrService } from './offline-omr.service';

describe('Android native offline OMR contract', () => {
  let native: jasmine.SpyObj<NativeOfflineOmrPlugin>;
  let service: OfflineOmrService;
  const file = new File(['camera-frame'], 'capture.jpg', { type: 'image/jpeg' });
  const valid = (): NativeOmrPayload => ({
    success: true, gradeable: true, geometryVerified: true,
    answers: ['A', '', '', 'D'],
    confidenceScores: [98, 92, 91, 97],
    markedLetters: [['A'], [], ['B', 'C'], ['D']],
    rowStates: ['single', 'blank', 'multiple', 'single'],
    processingMs: 432, averageConfidence: 94.5,
    qualityMetrics: { overall: 91, gradeable: true, criticalFailures: [] },
    sheetPresence: 'present', presenceConfidence: 100,
    sheetFingerprint: 'abc1230011223344', sheetFingerprintVersion: 2,
    overlayGeometry: { width: 1440, height: 900, centers: [] },
    sequence: '2', sequenceCandidate: '2', sequenceConfidence: 88, sequenceRawDigits: '0002',
    sequenceBoxCount: 4, sequenceDigitConfidences: [91, 86, 90, 85],
  });

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    native = jasmine.createSpyObj<NativeOfflineOmrPlugin>('OfflineOmr', ['scan', 'prewarm']);
    native.prewarm.and.resolveTo({ ready: true });
    native.scan.and.resolveTo(valid());
    service = new OfflineOmrService(native);
  });

  it('uses the same on-device reader for uploads and tracked camera frames', async () => {
    const upload = await service.detect(file, 4);
    const tracking = { trackingSessionId: 'camera-123', frameId: '2' };
    const live = await service.detect(file, 4, tracking);
    expect(upload).toEqual(live);
    expect(live.source).toBe('device-native-verified');
    expect(live.gradeable).toBeTrue();
    expect(live.markedLetters).toEqual([['A'], [], ['B', 'C'], ['D']]);
    expect(live.rowMapComplete).toBeTrue();
    expect(live.processingMs).toBe(432);
    expect(live.sheetFingerprint).toBe('abc1230011223344');
    expect(live.overlayGeometry).toEqual(valid().overlayGeometry);
    expect(live.sequence).toBe('2');
    expect(live.sequenceCandidate).toBe('2');
    expect(live.sequenceConfidence).toBe(88);
    expect(native.scan.calls.mostRecent().args[0]).toEqual({
      imageBase64: btoa('camera-frame'), questionCount: 4, ...tracking,
    });
  });

  for (const field of ['success', 'gradeable', 'geometryVerified'] as const) {
    it('rejects a frame when native ' + field + ' is false', async () => {
      native.scan.and.resolveTo({ ...valid(), [field]: false });
      const result = await service.detect(file, 4);
      expect(result.gradeable).toBeFalse();
      expect(result.confidences).toEqual([98, 92, 91, 97]);
    });
  }

  it('keeps honest per-row confidence while an uncertain row awaits temporal confirmation', async () => {
    native.scan.and.resolveTo({
      ...valid(),
      gradeable: false,
      answers: ['A', '', '', 'D'],
      markedLetters: [['A'], ['B'], ['B', 'C'], ['D']],
      rowStates: ['single', 'uncertain', 'multiple', 'single'],
      qualityMetrics: { overall: 69, criticalFailures: [] },
    });
    const result = await service.detect(file, 4);
    expect(result.gradeable).toBeFalse();
    expect(result.confidences).toEqual([98, 92, 91, 97]);
    expect(result.reason).toContain('needs another matching frame');
    expect(result.uncertainCount).toBe(1);
    expect(result.temporalEligible).toBeTrue();
  });

  it('does not promote sanitized, contradictory, or missing native evidence through temporal consensus', async () => {
    for (const changes of [
      { success: false }, { geometryVerified: false }, { qualityMetrics: undefined },
      { qualityMetrics: { criticalFailures: ['sharpness'] } },
      { markedLetters: [['A']] }, { answers: ['B', '', '', 'D'] },
      { markedLetters: [['A'], ['X'], ['B', 'C'], ['D']] },
      { rowStates: ['single', 'invalid', 'multiple', 'single'] },
    ]) {
      native.scan.and.resolveTo({ ...valid(), gradeable: false, ...changes });
      const result = await service.detect(file, 4);
      expect(result.temporalEligible).toBeFalse();
      expect(result.gradeable).toBeFalse();
    }
  });

  it('identifies ambiguous rows that cannot be resolved merely by repeating the same image', async () => {
    native.scan.and.resolveTo({ ...valid(), gradeable: false, rowStates: ['single', 'uncertain', 'multiple', 'single'] });
    const result = await service.detect(file, 4);
    expect(result.temporalEligible).toBeFalse();
    expect(result.reason).toContain('Check row 2');
  });

  it('preserves an explicit no-sheet result for the next-sheet camera barrier', async () => {
    native.scan.and.resolveTo({
      success: false, geometryVerified: false, sheetPresence: 'absent',
      reason: 'No answer sheet is visible', processingMs: 30,
    });
    const result = await service.detect(file, 4);
    expect(result.gradeable).toBeFalse();
    expect(result.rowMapComplete).toBeFalse();
    expect(result.sheetPresence).toBe('absent');
    expect(result.reason).toBe('No answer sheet is visible');
  });

  it('rejects malformed confidence evidence instead of coercing or clamping it into a verified read', async () => {
    for (const confidence of [null, '', '98', true, NaN, Infinity, -1, 101]) {
      native.scan.and.resolveTo({ ...valid(), confidenceScores: [confidence, 92, 91, 97] });
      const result = await service.detect(file, 4);
      expect(result.gradeable).withContext(String(confidence)).toBeFalse();
      expect(result.temporalEligible).withContext(String(confidence)).toBeFalse();
      expect(result.rowMapComplete).withContext(String(confidence)).toBeFalse();
    }
  });

  it('rejects an incomplete row map even if native flags claim success', async () => {
    native.scan.and.resolveTo({ ...valid(), markedLetters: [['A']] });
    const result = await service.detect(file, 4);
    expect(result.gradeable).toBeFalse();
    expect(result.rowMapComplete).toBeFalse();
  });

  it('rejects an answer which disagrees with its marks', async () => {
    native.scan.and.resolveTo({ ...valid(), answers: ['B', '', '', 'D'] });
    expect((await service.detect(file, 4)).gradeable).toBeFalse();
  });

  it('does not turn invalid marks into a gradeable blank row', async () => {
    native.scan.and.resolveTo({ ...valid(), markedLetters: [['A'], ['X'], ['B', 'C'], ['D']] });
    expect((await service.detect(file, 4)).gradeable).toBeFalse();
  });

  it('reports a native initialization failure without silently using another detector', async () => {
    native.scan.and.rejectWith(new Error('Native runtime failed'));
    await expectAsync(service.detect(file, 4)).toBeRejectedWithError('Native runtime failed');
    expect(native.scan).toHaveBeenCalledTimes(1);
  });

  it('uses the native contract in Windows Offline Mode without the Android plugin or browser fallback', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(false);
    const desktop = jasmine.createSpyObj<NativeOfflineOmrPlugin>('desktop', ['scan', 'prewarm']);
    desktop.prewarm.and.resolveTo({ ready: true });
    desktop.scan.and.resolveTo(valid());
    const scope = globalThis as typeof globalThis & { acadcheckOmr?: NativeOfflineOmrPlugin };
    scope.acadcheckOmr = desktop;
    try {
      const windowsService = new OfflineOmrService(native);
      const result = await windowsService.detect(file, 4, { trackingSessionId: 'windows', frameId: '1' });
      expect(result.gradeable).toBeTrue();
      expect(result.source).toBe('device-native-verified');
      expect(result.markedLetters).toEqual([['A'], [], ['B', 'C'], ['D']]);
      expect(desktop.prewarm).toHaveBeenCalled();
      expect(desktop.scan.calls.mostRecent().args[0].trackingSessionId).toBe('windows');
      expect(native.scan).not.toHaveBeenCalled();
      desktop.scan.and.rejectWith(new Error('Windows worker unavailable'));
      await expectAsync(windowsService.detect(file, 4)).toBeRejectedWithError('Windows worker unavailable');
    } finally {
      delete scope.acadcheckOmr;
    }
  });

  it('rejects non-integer and unsupported question counts before invoking the worker', async () => {
    for (const count of [0, 1.5, 51, NaN]) {
      await expectAsync(service.detect(file, count)).toBeRejected();
    }
    expect(native.scan).not.toHaveBeenCalled();
  });
});
