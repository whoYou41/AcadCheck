import { of, throwError, Subject } from 'rxjs';
import { fakeAsync, tick } from '@angular/core/testing';
import { ScannerPage } from './scanner.page';

describe('Scanner sequence recovery', () => {
  let page: any;

  beforeEach(() => {
    page = Object.create(ScannerPage.prototype);
    Object.defineProperty(page, 'isOfflineMode', { value: false, writable: true });
    Object.assign(page, {
      selectedStudentId: null,
      selectedClassroomId: 1,
      autoCapturedScan: true,
      pendingCapturedSignature: 'answers',
      pendingCapturedFingerprint: 'abcdef0123456789',
      awaitingSheetRemoval: false,
      isProcessing: true,
      showToastMessage: jasmine.createSpy('toast'),
      resumeAutoScanAfterProcessing: jasmine.createSpy('resume'),
      processCapturedImage: jasmine.createSpy('fallback'),
      beginAutoScanCooldown: jasmine.createSpy('cooldown'),
      rememberPendingCapturedSheet: jasmine.createSpy('remember'),
    });
  });

  it('keeps an offline local HTTP browser on the entered Pi address', () => {
    page.isOfflineMode = true;
    page.isStandaloneAndroid = false;
    page.cameraBaseUrl = 'http://192.168.1.137:5000';
    expect(window.location.protocol).toBe('http:');
    expect(page.usesDirectPiConnection).toBeTrue();
    page.updateCameraUrls();
    expect(page.cameraBaseUrl).toBe('http://192.168.1.137:5000');
    expect(page.cameraCaptureUrl).toBe('http://192.168.1.137:5000/capture');
  });

  it('uses a small first preview while retaining higher resolution for grading captures', () => {
    Object.assign(page, {
      isOfflineMode: true,
      isStandaloneAndroid: true,
      cameraCaptureUrl: 'http://192.168.254.104:5000/capture',
    });
    expect(page.cameraCaptureRequestUrl(true)).toContain('max_width=960&quality=80');
    expect(page.cameraCaptureRequestUrl()).toContain('max_width=1440&quality=86');
  });

  it('selects the unique offline student whose classroom sequence was detected', async () => {
    Object.assign(page, {
      students: [
        { id: 7, classroomId: 1, sequentialNumber: 1 },
        { id: 8, classroomId: 1, sequentialNumber: '2' },
      ],
      selectedStudentId: null,
      autoSelectedStudentId: null,
      studentSequenceReviewRequired: true,
    });
    await page.autoPickAnswerKeyAndStudent('2');
    expect(page.selectedStudentId).toBe(8);
    expect(page.autoSelectedStudentId).toBe(8);
    expect(page.studentSequenceReviewRequired).toBeFalse();
  });

  it('uses a unique sequence to select its classroom and student automatically', async () => {
    const roster = [{ id: 41, classroomId: 9, sequentialNumber: 3 }];
    Object.assign(page, {
      students: [], selectedClassroomId: null, selectedStudentId: null, autoSelectedStudentId: null,
      studentService: { getStudents: () => of(roster) },
      onClassroomChange: async () => { page.students = roster; },
    });
    await page.autoPickAnswerKeyAndStudent('03');
    expect(page.selectedClassroomId).toBe(9);
    expect(page.selectedStudentId).toBe(41);
    expect(page.autoSelectedStudentId).toBe(41);
  });
  it('refreshes a stale roster before resolving a sequence without a classroom', async () => {
    const roster = [{ id: 55, classroomId: 12, sequentialNumber: 4 }];
    Object.assign(page, {
      students: [{ id: 10, classroomId: 2, sequentialNumber: 4 }],
      selectedClassroomId: null, selectedStudentId: null, autoSelectedStudentId: null,
      studentService: { getStudents: () => of(roster) },
      onClassroomChange: async () => { page.students = roster; },
    });

    await page.autoPickAnswerKeyAndStudent('04');

    expect(page.selectedClassroomId).toBe(12);
    expect(page.selectedStudentId).toBe(55);
  });

  it('maps current two-box sequence 01 to roster student 1', async () => {
    Object.assign(page, {
      students: [
        { id: 31, classroomId: 1, sequentialNumber: 1 },
        { id: 32, classroomId: 1, sequentialNumber: 2 },
      ],
      selectedStudentId: null,
      autoSelectedStudentId: null,
      studentSequenceReviewRequired: true,
    });

    await page.autoPickAnswerKeyAndStudent('01');

    expect(page.selectedStudentId).toBe(31);
    expect(page.autoSelectedStudentId).toBe(31);
    expect(page.studentSequenceReviewRequired).toBeFalse();
  });
  it('loads current offline classroom students before matching a zero-padded sequence', async () => {
    Object.assign(page, {
      students: [],
      studentsLoaded: true,
      loadedStudentClassroomId: null,
      selectedClassroomId: 4,
      studentService: {
        getStudentsByClassroom: jasmine.createSpy('students').and.returnValue(of([
          { id: 21, classroomId: 4, sequentialNumber: 2, firstName: 'Local', lastName: 'Student' },
        ])),
      },
    });

    await page.autoPickAnswerKeyAndStudent('0002');

    expect(page.studentService.getStudentsByClassroom).toHaveBeenCalledWith(4);
    expect(page.selectedStudentId).toBe(21);
    expect(page.autoSelectedStudentId).toBe(21);
  });
  it('pauses an unmatched sequence without uploading again or consuming the sheet', async () => {
    page.scanService = { finalizeDetection: () => throwError(() => ({
      status: 422, error: { retrySafe: false, message: 'Select the student' },
    })) };
    await page.finalizeAcceptedDetection('token');
    expect(page.studentSequenceReviewRequired).toBeTrue();
    expect(page.awaitingSheetRemoval).toBeFalse();
    expect(page.pendingCapturedFingerprint).toBe('');
    expect(page.autoCapturedScan).toBeFalse();
    expect(page.processCapturedImage).not.toHaveBeenCalled();
    expect(page.beginAutoScanCooldown).not.toHaveBeenCalled();
    expect(page.rememberPendingCapturedSheet).not.toHaveBeenCalled();
    expect(page.resumeAutoScanAfterProcessing).toHaveBeenCalled();
    expect(page.isProcessing).toBeFalse();
    page.selectedStudentId = 12;
    page.onStudentSelectionChange();
    expect(page.studentSequenceReviewRequired).toBeFalse();
  });

  it('keeps the normal fallback for an expired token', async () => {
    page.scanService = { finalizeDetection: () => throwError(() => ({
      status: 410, error: { committed: false, retrySafe: true },
    })) };
    await page.finalizeAcceptedDetection('expired');
    expect(page.processCapturedImage).toHaveBeenCalled();
    expect(page.studentSequenceReviewRequired).toBeUndefined();
  });

  it('handles sequence review from normal processing without setting the sheet barrier', async () => {
    page.scanService = { processScan: () => throwError(() => ({
      status: 422, error: { requiresReview: true, code: 'STUDENT_SEQUENCE_REVIEW_REQUIRED', message: 'Unmatched sequence' },
    })) };
    await page.processScan(437);
    expect(page.studentSequenceReviewRequired).toBeTrue();
    expect(page.beginAutoScanCooldown).not.toHaveBeenCalled();
    expect(page.rememberPendingCapturedSheet).not.toHaveBeenCalled();
  });

  it('accepts an authoritative replacement with identical answer pixels', () => {
    Object.assign(page, {
      awaitingSheetRemoval: true, lastCapturedFingerprint: 'abcdef0123456789',
      replacementSheetFingerprint: '', replacementSheetFrames: 0,
      REQUIRED_REPLACEMENT_SHEET_FRAMES: 2, SAME_SHEET_FINGERPRINT_DISTANCE: 7,
      NEW_SHEET_IDENTITY_DISTANCE: 6, resetTrackingSession: jasmine.createSpy('tracking'),
    });
    expect(page.observeSheetChangeBarrier({
      confirmedNoSheet: false, recommendation: 'accept', completeRowMap: true,
      trustedGeometry: true, detectionSignature: 'answers',
      sheetFingerprint: 'abcdef0123456789', sheetFingerprintVersion: 2,
      duplicateSheet: false, removalRequired: false, backendSheetChanged: true,
      backendNewSheetFrames: 2, backendRequiredNewSheetFrames: 2,
    })).toBeTrue();
    expect(page.awaitingSheetRemoval).toBeFalse();
    expect(page.lastCapturedFingerprint).toBe('');
  });

  it('accepts a stable unscanned sheet when the short identity prefix collides', () => {
    Object.assign(page, {
      awaitingSheetRemoval: true,
      lastCapturedSignature: 'AAAAAAAAAA',
      lastCapturedFingerprint: 'abcdef0123456789',
      lastCapturedStudentId: 7,
      selectedStudentId: 8,
      replacementSheetFingerprint: '', replacementSheetFrames: 0,
      REQUIRED_REPLACEMENT_SHEET_FRAMES: 2, SAME_SHEET_FINGERPRINT_DISTANCE: 7,
      NEW_SHEET_IDENTITY_DISTANCE: 6, resetTrackingSession: jasmine.createSpy('tracking'),
    });
    const replacement = {
      confirmedNoSheet: false, recommendation: 'accept', completeRowMap: true,
      trustedGeometry: true, detectionSignature: 'BBBBBBBBBB',
      sheetFingerprint: 'abcdeffedcba9876', sheetFingerprintVersion: 2,
      duplicateSheet: false, removalRequired: false, backendSheetChanged: false,
      backendNewSheetFrames: 0, backendRequiredNewSheetFrames: 2,
    };

    expect(page.observeSheetChangeBarrier(replacement)).toBeFalse();
    expect(page.observeSheetChangeBarrier(replacement)).toBeTrue();
    expect(page.awaitingSheetRemoval).toBeFalse();
  });

  it('confirms the same weak sequence on two browser frames without a fingerprint', () => {
    Object.assign(page, {
      offlineSequenceCandidate: '', offlineSequenceCandidateFrames: 0,
      offlineSequenceCandidateFingerprint: '', offlineSequenceCandidateAt: 0,
      REQUIRED_SEQUENCE_CANDIDATE_FRAMES: 2, MIN_SEQUENCE_CANDIDATE_CONFIDENCE: 35,
      SAME_SHEET_FINGERPRINT_DISTANCE: 7,
    });
    const result = {
      sequenceCandidate: '1', sequenceConfidence: 51, geometryVerified: true,
      sheetPresence: 'present', sheetFingerprint: '', sheetFingerprintVersion: 0,
    };
    expect(page.resolveOfflineSequence(result, 1000)).toBeNull();
    expect(page.resolveOfflineSequence(result, 1200)).toBe('1');
  });

  it('recognizes a stable boxed sequence while answer rows are still unresolved', () => {
    Object.assign(page, {
      offlineSequenceCandidate: '', offlineSequenceCandidateFrames: 0,
      offlineSequenceCandidateFingerprint: '', offlineSequenceCandidateAt: 0,
      REQUIRED_SEQUENCE_CANDIDATE_FRAMES: 2, MIN_SEQUENCE_CANDIDATE_CONFIDENCE: 35,
      SAME_SHEET_FINGERPRINT_DISTANCE: 7,
    });
    const result = {
      sequenceCandidate: '2', sequenceConfidence: 84, geometryVerified: false,
      sheetPresence: 'present', sheetFingerprint: '', sheetFingerprintVersion: 0,
    };
    expect(page.resolveOfflineSequence(result, 1000)).toBeNull();
    expect(page.resolveOfflineSequence(result, 1200)).toBe('2');
  });

  it('releases a replacement with changed stable answers even when its fingerprint is close', () => {
    Object.assign(page, {
      awaitingSheetRemoval: true,
      lastCapturedSignature: 'A,A,A|student:3',
      lastCapturedFingerprint: '',
      replacementSheetFingerprint: '', replacementSheetFrames: 0,
      REQUIRED_REPLACEMENT_SHEET_FRAMES: 2, SAME_SHEET_FINGERPRINT_DISTANCE: 7,
      NEW_SHEET_IDENTITY_DISTANCE: 6, resetTrackingSession: jasmine.createSpy('tracking'),
      clearOfflineSequenceCandidate: jasmine.createSpy('clear sequence'),
    });
    const replacement = {
      confirmedNoSheet: false, recommendation: 'accept', completeRowMap: true,
      trustedGeometry: true, detectionSignature: 'B,B,B|sequence:none',
      sheetFingerprint: '', sheetFingerprintVersion: 0,
      duplicateSheet: false, removalRequired: false, backendSheetChanged: false,
      backendNewSheetFrames: 0, backendRequiredNewSheetFrames: 2,
    };
    expect(page.observeSheetChangeBarrier(replacement)).toBeFalse();
    expect(page.observeSheetChangeBarrier(replacement)).toBeTrue();
  });

  it('releases identical answers when the confirmed sequence changes', () => {
    Object.assign(page, {
      awaitingSheetRemoval: true,
      lastCapturedSignature: 'A,A,A|student:3', lastCapturedSequence: '3',
      lastCapturedFingerprint: '',
      replacementSheetFingerprint: '', replacementSheetFrames: 0,
      REQUIRED_REPLACEMENT_SHEET_FRAMES: 2, SAME_SHEET_FINGERPRINT_DISTANCE: 7,
      NEW_SHEET_IDENTITY_DISTANCE: 6, resetTrackingSession: jasmine.createSpy('tracking'),
      clearOfflineSequenceCandidate: jasmine.createSpy('clear sequence'),
    });
    const replacement = {
      confirmedNoSheet: false, recommendation: 'accept', completeRowMap: true,
      trustedGeometry: true, detectionSignature: 'A,A,A|student:1',
      detectedSequence: '1',
      sheetFingerprint: '', sheetFingerprintVersion: 0,
      duplicateSheet: false, removalRequired: false, backendSheetChanged: false,
      backendNewSheetFrames: 0, backendRequiredNewSheetFrames: 2,
    };
    expect(page.observeSheetChangeBarrier(replacement)).toBeFalse();
    expect(page.observeSheetChangeBarrier(replacement)).toBeTrue();
  });

  it('releases the old-sheet barrier after two confirmed empty camera frames', () => {
    Object.assign(page, {
      awaitingSheetRemoval: true, noSheetFrames: 0, REQUIRED_NO_SHEET_FRAMES: 2,
      replacementSheetFingerprint: '', replacementSheetFrames: 0,
      resetTrackingSession: jasmine.createSpy('tracking'),
      clearOfflineSequenceCandidate: jasmine.createSpy('clear sequence'),
    });
    const emptyFrame = {
      confirmedNoSheet: true, recommendation: 'reject', completeRowMap: false,
      trustedGeometry: false, detectionSignature: '', sheetFingerprint: '',
      sheetFingerprintVersion: 0, duplicateSheet: false, removalRequired: false,
      backendSheetChanged: false, backendNewSheetFrames: 0,
      backendRequiredNewSheetFrames: 2,
    };

    expect(page.observeSheetChangeBarrier(emptyFrame)).toBeFalse();
    expect(page.awaitingSheetRemoval).toBeTrue();
    expect(page.observeSheetChangeBarrier(emptyFrame)).toBeFalse();
    expect(page.awaitingSheetRemoval).toBeFalse();
  });
});

describe('Scanner offline camera recovery', () => {
  let page: any;

  beforeEach(() => {
    page = Object.create(ScannerPage.prototype);
    Object.defineProperty(page, 'isOfflineMode', { value: true, writable: true });
    Object.assign(page, {
      isOfflineMode: true,
      isStandaloneAndroid: false,
      cameraBaseUrl: 'http://192.168.1.137:5000',
      cameraCaptureUrl: 'http://192.168.1.137:5000/capture',
      cameraDiscoveryGeneration: 1,
      cameraViewActive: true,
      cameraSessionGeneration: 1,
      autoDetectionGeneration: 1,
      autoDetectionInFlight: false,
      detectionActive: true,
      isScannerActive: true,
      autoScanEnabled: true,
      isProcessing: false,
      capturedImage: null,
      destroyed: false,
      selectedAnswerKeyId: 1,
      answerKeys: [{ id: 1, numQuestions: 50 }],
      lastProcessedTime: 0,
      DEBOUNCE_MS: 100,
      MAX_SHARED_OMR_FRAME_AGE_MS: 2000,
      latestOmrFrameBlob: null,
      latestOmrFrameReceivedAt: 0,
      lastAutoDetectionBlob: null,
      streamRequestSubscription: null,
      isPolling: false,
      streamErrorCount: 0,
      cameraFrameVisible: false,
      lastCameraFrameAt: 0,
      lastCameraDiscoveryAt: 0,
      MAX_STREAM_ERRORS: 5,
      TRANSIENT_STREAM_ERROR_LIMIT: 3,
      MAX_STREAM_RETRY_DELAY_MS: 8000,
      cameraHealthRetryAttempt: 0,
      cameraHealthRetryTimer: null,
      lastCameraErrorToastAt: 0,
      liveAnswerMarkers: [],
      liveOverlayFrameBlobUrl: null,
      awaitingSheetRemoval: true,
      lastCapturedFingerprint: 'previous-sheet',
      showToastMessage: jasmine.createSpy('toast'),
      discoverAcadcam: jasmine.createSpy('discover'),
      http: { get: jasmine.createSpy('camera get'), setCameraActive: jasmine.createSpy('active') },
    });
  });

  it('discovers on first use before the default URL can be mistaken for a saved address', () => {
    const keys = ['scanner.directPiUrl', 'scanner.cameraUrl'];
    const originals = keys.map(key => localStorage.getItem(key));
    keys.forEach(key => localStorage.removeItem(key));
    Object.assign(page, {
      authService: { isOfflineMode: () => true },
      loadReferenceData: () => {}, loadScanHistory: () => {}, loadStats: () => {},
    });
    try {
      page.ngOnInit();
      expect(page.discoverAcadcam).toHaveBeenCalledWith(true);
    } finally {
      keys.forEach((key, index) => originals[index] == null ? localStorage.removeItem(key) : localStorage.setItem(key, originals[index]!));
    }
  });

  it('starts recovery promptly when no first camera image arrives', fakeAsync(() => {
    page.scheduleStartupDiscovery();
    tick(1499);
    expect(page.discoverAcadcam).not.toHaveBeenCalled();
    tick(1);
    expect(page.discoverAcadcam).toHaveBeenCalledWith(true);
    expect(page.cameraConnectionLabel).toBe('Connecting');
    page.noteCameraFrameFailure('No camera image', { status: 503 });
    expect(page.streamError).toBeTrue();
    expect(page.liveQualityMessage).not.toContain('last preview');
  }));

  it('uses a healthy discovery result without waiting for another hostname timeout', async () => {
    let finishSlow!: (value: any) => void;
    page.directPiCandidates = () => ['http://acadacam.local:5000', 'http://192.168.1.137:5000'];
    page.probeDirectPi = jasmine.createSpy('probe').and.callFake((url: string) => url.includes('.local')
      ? new Promise(resolve => { finishSlow = resolve; })
      : Promise.resolve({ cameraUrl: url, cameraInitialized: true, frameAvailable: true }));
    page.startStreamPoll = jasmine.createSpy('poll');
    await page.discoverDirectPi(1, true);
    expect(page.startStreamPoll).toHaveBeenCalledTimes(1);
    expect(page.cameraBaseUrl).toBe('http://192.168.1.137:5000');
    finishSlow(null);
    await Promise.resolve();
  });

  it('does not cancel an in-flight capture when a health check asks for preview polling', () => {
    const pending = new Subject<Blob>();
    page.streamRequestSubscription = pending.subscribe();
    const existing = page.streamRequestSubscription;
    page.startStreamPoll();
    expect(existing.closed).toBeFalse();
    expect(page.http.get).not.toHaveBeenCalled();
    existing.unsubscribe();
  });

  it('does not let an old failed health probe override a newer camera frame', () => {
    const status = new Subject<any>();
    page.http.get.and.returnValue(status);
    page.checkCameraHealth(true);
    page.lastCameraFrameAt = Date.now() + 1;
    page.cameraFrameVisible = true;
    page.streamError = false;
    status.error({ status: 503 });
    expect(page.streamError).toBeFalse();
    expect(page.cameraConnectionLabel).toBe('Scanning');
  });

  it('keeps a small preview when automatic scanning is disabled', fakeAsync(() => {
    page.autoScanEnabled = false;
    const frame = new Blob(['jpeg'], { type: 'image/jpeg' });
    page.http.get.and.returnValue(of(frame));
    page.streamPollGeneration = 1;
    page.streamFrameBlobUrl = null;
    page.scheduleNextPoll = jasmine.createSpy('next poll');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:test');
    spyOn(URL, 'revokeObjectURL');
    page.pollFrame(1);
    expect(page.latestOmrFrameBlob).toBeNull();
    expect(page.streamFrameBlobUrl).toBe('blob:test');
    expect(page.http.get.calls.mostRecent().args[0]).toContain('max_width=960');
    page.pollFrame(1);
    expect(page.latestOmrFrameBlob).toBe(frame);
    expect(page.http.get.calls.mostRecent().args[0]).toContain('max_width=1440');
    tick(1000);
  }));

  it('uses the first camera capture for detection when an answer key is selected', fakeAsync(() => {
    const frame = new Blob(['first full frame'], { type: 'image/jpeg' });
    page.http.get.and.returnValue(of(frame));
    page.streamPollGeneration = 1;
    page.scheduleNextPoll = jasmine.createSpy('next poll');
    spyOn(URL, 'createObjectURL').and.returnValue('blob:first');
    spyOn(page, 'performAutoDetection').and.resolveTo();
    page.pollFrame(1);
    expect(page.http.get.calls.mostRecent().args[0]).toContain('max_width=1440');
    expect(page.latestOmrFrameBlob).toBe(frame);
    tick(0);
    expect(page.performAutoDetection).toHaveBeenCalledTimes(1);
  }));

  it('starts on frame arrival, keeps only the newest waiting frame, and never rereads a frame', fakeAsync(() => {
    let finish!: () => void;
    const read = spyOn(page, 'performOfflineLiveDetection').and.callFake(() =>
      new Promise<void>(resolve => { finish = resolve; }));
    const frames = ['first', 'intermediate', 'newest'].map(value => new Blob([value]));
    page.rememberOmrFrame(frames[0]);
    tick(0);
    expect(read.calls.count()).toBe(1);
    expect(read.calls.first().args[0]).toBe(frames[0]);
    page.rememberOmrFrame(frames[1]);
    page.rememberOmrFrame(frames[2]);
    tick(0);
    expect(read.calls.count()).toBe(1);
    finish();
    tick(0);
    expect(read.calls.count()).toBe(2);
    expect(read.calls.mostRecent().args[0]).toBe(frames[2]);
    finish();
    tick(1000);
    expect(read.calls.count()).toBe(2);
    expect(page.liveDetectionBusy).toBeFalse();
  }));

  it('does not overlap reads across a stop and restart, then promptly resumes', fakeAsync(() => {
    let finish!: () => void;
    const read = spyOn(page, 'performOfflineLiveDetection').and.callFake(() =>
      new Promise<void>(resolve => { finish = resolve; }));
    page.rememberOmrFrame(new Blob(['old session']));
    tick(0);
    page.stopAutoDetection();
    page.detectionActive = true;
    page.rememberOmrFrame(new Blob(['new session']));
    void page.performAutoDetection();
    tick(0);
    expect(read.calls.count()).toBe(1);
    finish();
    tick(0);
    expect(read.calls.count()).toBe(2);
    expect(read.calls.mostRecent().args[1]).toBe(2);
    finish();
    tick(0);
  }));

  it('cancels queued detection when stopped or hidden', fakeAsync(() => {
    const read = spyOn(page, 'performOfflineLiveDetection').and.resolveTo();
    page.rememberOmrFrame(new Blob(['queued']));
    page.stopAutoDetection();
    tick(0);
    expect(read).not.toHaveBeenCalled();
    page.detectionActive = true;
    spyOnProperty(document, 'hidden', 'get').and.returnValue(true);
    page.rememberOmrFrame(new Blob(['hidden']));
    void page.performAutoDetection();
    tick(0);
    expect(read).not.toHaveBeenCalled();
  }));

  it('retains high detail for unresolved marks in both camera routes until removal', () => {
    for (const offline of [false, true]) {
      page.isOfflineMode = offline;
      page.offlineNeedsDetailFrame = false;
      page.updateLiveDetailRequirement('present', true);
      expect(page.cameraCaptureRequestUrl()).toContain('max_width=1920&quality=92');
      page.updateLiveDetailRequirement('present', false);
      expect(page.cameraCaptureRequestUrl()).toContain('max_width=1920&quality=92');
      page.updateLiveDetailRequirement('absent', true);
      expect(page.cameraCaptureRequestUrl()).toContain('max_width=1440');
    }
  });

  it('keeps an online request serialized across stop/restart and releases it after failure', fakeAsync(() => {
    page.isOfflineMode = false;
    const responses = new Subject<any>();
    page.scanService = { detectFrame: jasmine.createSpy('detect').and.returnValue(responses) };
    page.preprocessImage = jasmine.createSpy('preprocess').and.resolveTo('data:image/jpeg;base64,anBlZw==');
    page.nextTrackingFrame = () => ({ trackingSessionId: 'test', frameId: '1' });
    page.recordLiveFrame = () => {};
    page.clearLiveAnswerOverlay = () => {};
    spyOn(URL, 'createObjectURL').and.returnValue('blob:online');
    spyOn(URL, 'revokeObjectURL');
    page.rememberOmrFrame(new Blob(['first']));
    tick(0);
    expect(page.scanService.detectFrame).toHaveBeenCalledTimes(1);
    page.stopAutoDetection();
    page.detectionActive = true;
    page.rememberOmrFrame(new Blob(['new session']));
    void page.performAutoDetection();
    tick(0);
    expect(page.scanService.detectFrame).toHaveBeenCalledTimes(1);
    responses.complete();
    tick(0);
    expect(page.scanService.detectFrame).toHaveBeenCalledTimes(2);
    expect(page.liveDetectionBusy).toBeFalse();
    expect(page.autoDetectionInFlight).toBeFalse();
  }));

  it('preserves answer consensus across a single preview timeout', () => {
    Object.assign(page, {
      cameraFrameVisible: true, stableDetectionSignature: 'A,B', stableDetectionFrames: 1,
      autoDetectionInFlight: true, nativeDetectionBusy: true,
    });
    page.noteCameraFrameFailure('Slow frame', { name: 'TimeoutError' });
    expect(page.stableDetectionSignature).toBe('A,B');
    expect(page.stableDetectionFrames).toBe(1);
    expect(page.autoDetectionInFlight).toBeTrue();
    expect(page.nativeDetectionBusy).toBeTrue();
    expect(page.autoDetectionGeneration).toBe(1);
  });

  it('does not queue native scans after a failed preview invalidates an unfinished scan', async () => {
    page.nativeDetectionBusy = true;
    page.autoDetectionInFlight = false;
    page.startStreamPoll = jasmine.createSpy('poll');
    await page.performAutoDetection();
    expect(page.http.get).not.toHaveBeenCalled();
    expect(page.startStreamPoll).not.toHaveBeenCalled();
  });

  it('resumes the requested camera after returning from the Android background', () => {
    const visibility = spyOnProperty(document, 'hidden', 'get').and.returnValue(true);
    Object.assign(page, {
      cameraRequestedActive: true,
      stopAutoDetection: jasmine.createSpy('stop detection'),
      stopStreamPoll: jasmine.createSpy('stop poll'),
      startStreamPoll: jasmine.createSpy('start poll'),
      startAutoDetection: jasmine.createSpy('start detection'),
    });
    page.onCameraVisibilityChanged();
    expect(page.stopStreamPoll).toHaveBeenCalledTimes(1);
    expect(page.cameraRequestedActive).toBeTrue();
    visibility.and.returnValue(false);
    page.onCameraVisibilityChanged();
    expect(page.startStreamPoll).toHaveBeenCalledTimes(1);
    expect(page.startAutoDetection).toHaveBeenCalledTimes(1);
  });

  it('retains a committed grade when reloading its details fails', async () => {
    Object.assign(page, {
      selectedClassroomId: 1, selectedStudentId: 8, offlineAnswers: Array(50).fill('A'),
      offlineConfidences: Array(50).fill(98), offlineGradeable: true,
      scanService: {
        saveOfflineManualGrade: () => of({ success: true, scan: { id: 9, grading: { totalScore: 50 } } }),
        getScan: () => throwError(() => new Error('Refresh failed')),
      },
      loadScanHistory: () => {}, loadStats: () => {},
      rememberPendingCapturedSheet: jasmine.createSpy('remember saved sheet'),
      beginAutoScanCooldown: () => {}, resetOfflineDetectionResult: () => {}, resumeAutoScanAfterProcessing: () => {},
    });
    const saved = await page.saveOfflineManualGrade(new File(['photo'], 'sheet.jpg'), true);
    expect(saved).toBeTrue();
    expect(page.currentScan.id).toBe(9);
    expect(page.rememberPendingCapturedSheet).toHaveBeenCalledTimes(1);
  });

  it('preserves the new auto-selected student when a replacement sheet is confirmed', () => {
    Object.assign(page, { selectedStudentId: 8, autoSelectedStudentId: 8, resetTrackingSession: () => {} });
    page.releaseSheetChangeBarrier('Ready', true);
    expect(page.selectedStudentId).toBe(8);
    expect(page.autoSelectedStudentId).toBe(8);
  });

  it('requests more image detail for unresolved marks and drops a previous sheet student', async () => {
    Object.assign(page, {
      selectedStudentId: 8, autoSelectedStudentId: 8,
      offlineAutoStudentFingerprint: '0000000000000000', offlineAutoStudentAt: Date.now(),
      SAME_SHEET_FINGERPRINT_DISTANCE: 7,
      awaitingSheetRemoval: false, REQUIRED_STABLE_FRAMES: 2,
      recordLiveFrame: () => {}, clearLiveAnswerOverlay: () => {},
      nextTrackingFrame: () => ({}),
      detectOfflineFrame: async () => ({
        gradeable: false, temporalEligible: false, geometryVerified: true,
        sheetFingerprint: 'ffffffffffffffff', sheetPresence: 'present',
        answers: Array(50).fill(''), markedLetters: Array.from({ length: 50 }, () => []),
        rowStates: Array(50).fill('uncertain'), confidences: Array(50).fill(0),
        overallConfidence: 40, uncertainCount: 50,
      }),
    });
    await page.performOfflineLiveDetection(new Blob(['photo']), 1);
    expect(page.selectedStudentId).toBeNull();
    expect(page.autoSelectedStudentId).toBeNull();
    expect(page.cameraCaptureRequestUrl()).toContain('max_width=1920&quality=92');
  });

  it('shows resolved rows independently of confidence and retains detail until the sheet leaves', async () => {
    const result: any = {
      gradeable: false, temporalEligible: false, geometryVerified: true,
      sheetPresence: 'present', answers: Array(50).fill('A'),
      markedLetters: Array.from({ length: 50 }, () => ['A']),
      rowStates: [...Array(45).fill('single'), 'blank', 'blank', 'multiple', 'uncertain', 'uncertain'],
      confidences: Array(50).fill(90), overallConfidence: 69, uncertainCount: 2,
    };
    Object.assign(page, {
      awaitingSheetRemoval: false, REQUIRED_STABLE_FRAMES: 2,
      recordLiveFrame: () => {}, clearLiveAnswerOverlay: () => {},
      autoPickAnswerKeyAndStudent: async () => {}, nextTrackingFrame: () => ({}),
      detectOfflineFrame: async () => result,
    });
    await page.performOfflineLiveDetection(new Blob(['small sheet']), 1);
    expect(page.liveResolvedRows).toBe(48);
    expect(page.liveScanProgress).toBe(96);
    expect(page.cameraCaptureRequestUrl()).toContain('max_width=1920&quality=92');
    result.temporalEligible = true;
    await page.performOfflineLiveDetection(new Blob(['clear detail']), 1);
    expect(page.cameraCaptureRequestUrl()).toContain('max_width=1920&quality=92');
    result.sheetPresence = 'absent';
    result.geometryVerified = false;
    await page.performOfflineLiveDetection(new Blob(['empty view']), 1);
    expect(page.liveResolvedRows).toBe(0);
    expect(page.cameraCaptureRequestUrl()).toContain('max_width=1440&quality=86');
  });

  it('preserves the completed display while waiting for the saved sheet to leave', async () => {
    const completed = { success: true, detectedAnswers: Array(50).fill('A') };
    Object.assign(page, {
      liveDetection: completed, liveResolvedRows: 50, liveConfidence: 96,
      awaitingSheetRemoval: true, REQUIRED_STABLE_FRAMES: 2,
      recordLiveFrame: jasmine.createSpy('replace live reading'),
      clearLiveAnswerOverlay: jasmine.createSpy('clear confirmed overlay'),
      autoPickAnswerKeyAndStudent: async () => {}, nextTrackingFrame: () => ({}),
      observeSheetChangeBarrier: jasmine.createSpy('observe current sheet').and.returnValue(false),
      detectOfflineFrame: async () => ({
        gradeable: false, temporalEligible: false, geometryVerified: true,
        sheetPresence: 'present', answers: Array(50).fill(''),
        markedLetters: Array.from({ length: 50 }, () => []), rowStates: Array(50).fill('uncertain'),
        confidences: Array(50).fill(0), overallConfidence: 49, uncertainCount: 50,
      }),
    });
    await page.performOfflineLiveDetection(new Blob(['blurred saved sheet']), 1);
    expect(page.observeSheetChangeBarrier).toHaveBeenCalled();
    expect(page.liveDetection).toBe(completed);
    expect(page.liveResolvedRows).toBe(50);
    expect(page.liveConfidence).toBe(96);
    expect(page.recordLiveFrame).not.toHaveBeenCalled();
    expect(page.clearLiveAnswerOverlay).not.toHaveBeenCalled();
    page.detectOfflineFrame = async () => { throw new Error('Temporary camera read failure'); };
    await page.performOfflineLiveDetection(new Blob(['failed read']), 1);
    expect(page.liveDetection).toBe(completed);
    expect(page.liveResolvedRows).toBe(50);
    expect(page.clearLiveAnswerOverlay).not.toHaveBeenCalled();
  });

  it('waits for the preview retry instead of issuing detection captures during backoff', async () => {
    page.isPolling = true;
    page.startStreamPoll = jasmine.createSpy('start preview');
    await page.performAutoDetection();
    await page.performAutoDetection();
    expect(page.http.get).not.toHaveBeenCalled();
    expect(page.startStreamPoll).not.toHaveBeenCalled();
    expect(page.autoDetectionInFlight).toBeFalse();
  });

  it('starts preview polling when detection has no fresh frame and no poll is running', async () => {
    page.startStreamPoll = jasmine.createSpy('start preview');
    await page.performAutoDetection();
    expect(page.startStreamPoll).toHaveBeenCalledTimes(1);
    expect(page.http.get).not.toHaveBeenCalled();
    expect(page.autoDetectionInFlight).toBeFalse();
  });

  it('resumes the live preview after processing even when auto-scan is disabled', () => {
    Object.assign(page, {
      cameraRequestedActive: true,
      cameraViewActive: true,
      isScannerActive: true,
      isProcessing: false,
      autoScanEnabled: false,
      scanMode: 'camera',
      capturedImage: 'captured-frame',
      trackingSessionId: 'session',
      updateCameraUrls: jasmine.createSpy('update camera URLs'),
      startStreamPoll: jasmine.createSpy('start preview'),
      startAutoDetection: jasmine.createSpy('start detection'),
    });

    page.resumeAutoScanAfterProcessing();

    expect(page.capturedImage).toBeNull();
    expect(page.startStreamPoll).toHaveBeenCalled();
    expect(page.startAutoDetection).not.toHaveBeenCalled();
    expect(page.isScannerActive).toBeTrue();
  });

  it('clears stale confidence and frames on camera failure while preserving the sheet barrier', () => {
    const frame = new Blob(['previous frame'], { type: 'image/jpeg' });
    Object.assign(page, {
      liveConfidence: 49,
      liveDetection: { detectedAnswers: Array(39).fill('A') },
      liveQualityMessage: 'Keep the full sheet still - verified 39/50 rows locally',
      liveAnswerMarkers: [{ label: '1' }],
      latestOmrFrameBlob: frame,
      latestOmrFrameReceivedAt: Date.now(),
      lastAutoDetectionBlob: frame,
      stableDetectionSignature: 'previous answers',
      stableDetectionFrames: 2,
      autoDetectionInFlight: true,
      scheduleCameraHealthRetry: jasmine.createSpy('retry health'),
    });
    page.noteCameraFrameFailure('Camera unavailable; reconnecting...');
    expect(page.streamError).toBeTrue();
    expect(page.liveConfidence).toBe(0);
    expect(page.liveDetection).toBeNull();
    expect(page.liveQualityMessage).not.toContain('39/50');
    expect(page.liveAnswerMarkers).toEqual([]);
    expect(page.latestOmrFrameBlob).toBeNull();
    expect(page.lastAutoDetectionBlob).toBeNull();
    expect(page.stableDetectionSignature).toBe('');
    expect(page.stableDetectionFrames).toBe(0);
    expect(page.autoDetectionInFlight).toBeFalse();
    expect(page.awaitingSheetRemoval).toBeTrue();
    expect(page.lastCapturedFingerprint).toBe('previous-sheet');
  });

  it('keeps the last good preview through repeated native capture timeouts', () => {
    const frameUrl = 'blob:last-good-frame';
    Object.assign(page, {
      streamFrameBlobUrl: frameUrl,
      cameraFrameVisible: true,
      liveDetection: { detectedAnswers: Array(50).fill('A') },
      liveConfidence: 99,
      scheduleCameraHealthRetry: jasmine.createSpy('retry health'),
    });
    const timeoutError = { name: 'TimeoutError', message: 'Timeout has occurred' };

    page.noteCameraFrameFailure('Camera took too long', timeoutError);
    expect(page.streamError).toBeFalse();
    expect(page.streamFrameBlobUrl).toBe(frameUrl);
    expect(page.liveDetectionStatus).toBe('scanning');

    page.noteCameraFrameFailure('Camera took too long', timeoutError);
    expect(page.streamError).toBeFalse();
    expect(page.streamFrameBlobUrl).toBe(frameUrl);

    page.noteCameraFrameFailure('Camera took too long', timeoutError);
    expect(page.streamError).toBeTrue();
    expect(page.streamFrameBlobUrl).toBe(frameUrl);
    expect(page.liveDetectionStatus).toBe('reject');
  });

  it('ignores an offline result that completes after its camera frame becomes unavailable', async () => {
    let finishDetection!: (result: any) => void;
    page.detectOfflineFrame = jasmine.createSpy('detect offline').and.returnValue(
      new Promise(resolve => { finishDetection = resolve; })
    );
    page.nextTrackingFrame = jasmine.createSpy('tracking frame').and.returnValue({});
    page.recordLiveFrame = jasmine.createSpy('record live result');
    page.scheduleCameraHealthRetry = jasmine.createSpy('retry health');
    page.autoDetectionInFlight = true;
    const detection = page.performOfflineLiveDetection(
      new Blob(['frame'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );
    page.noteCameraFrameFailure('Camera disconnected');
    finishDetection({
      gradeable: true,
      answers: Array(50).fill('A'),
      confidences: Array(50).fill(99),
      overallConfidence: 99,
      detectedCount: 50,
      rowMapComplete: true,
    });
    await detection;
    expect(page.recordLiveFrame).not.toHaveBeenCalled();
    expect(page.liveDetection).toBeNull();
    expect(page.liveConfidence).toBe(0);
    expect(page.streamError).toBeTrue();
  });

  it('grades an accepted native result after two matching frames without stopping or recapturing the Pi stream', async () => {
    Object.assign(page, {
      awaitingSheetRemoval: false,
      selectedClassroomId: 1,
      selectedStudentId: 7,
      autoRecordEnabled: true,
      stableDetectionSignature: '',
      stableDetectionFrames: 0,
      REQUIRED_STABLE_FRAMES: 2,
      autoScanCooldownUntil: 0,
      offlineAnswers: [],
      offlineConfidences: [],
      offlineMarkedLetters: [],
      offlineReviewed: [],
    });
    const result = {
      gradeable: true,
      answers: Array(50).fill('A'),
      confidences: Array(50).fill(99),
      markedLetters: Array.from({ length: 50 }, () => ['A']),
      overallConfidence: 99,
      detectedCount: 50,
      uncertainCount: 0,
      rowMapComplete: true,
      geometryVerified: true,
      source: 'device-native-verified',
      sequence: '2',
      sequenceConfidence: 96,
      sheetFingerprint: 'new-sheet',
      sheetFingerprintVersion: 2,
      processingMs: 640,
      anchorMethod: 'answer-grid',
    };
    page.detectOfflineFrame = jasmine.createSpy('detect offline').and.resolveTo(result);
    page.nextTrackingFrame = jasmine.createSpy('tracking frame').and.returnValue({});
    page.autoPickAnswerKeyAndStudent = jasmine.createSpy('student').and.resolveTo();
    page.recordLiveFrame = jasmine.createSpy('record live result');
    page.clearLiveAnswerOverlay = jasmine.createSpy('clear overlay');
    page.applyOfflineDetectionResult = jasmine.createSpy('apply accepted result').and.callFake(() => {
      page.offlineAnswers = result.answers;
      page.offlineConfidences = result.confidences;
      page.offlineMarkedLetters = result.markedLetters;
      page.offlineReviewed = Array(50).fill(true);
      page.offlineGradeable = true;
    });
    page.saveOfflineManualGrade = jasmine.createSpy('save direct').and.resolveTo(true);
    page.useOfflineCameraFrame = jasmine.createSpy('review capture');

    await page.performOfflineLiveDetection(
      new Blob(['frame'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );
    expect(page.saveOfflineManualGrade).not.toHaveBeenCalled();

    await page.performOfflineLiveDetection(
      new Blob(['matching frame'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );

    expect(page.autoPickAnswerKeyAndStudent).toHaveBeenCalledWith('2');
    expect(page.saveOfflineManualGrade).toHaveBeenCalledWith(jasmine.any(File), true);
    expect(page.useOfflineCameraFrame).not.toHaveBeenCalled();
    expect(page.pendingCapturedFingerprint).toBe('new-sheet');
  });


  it('preserves one matching frame through a temporarily unreadable ring without counting a vote', () => {
    const marks = [['A'], ['B']];
    const result = {
      geometryVerified: true, sheetFingerprintVersion: 2,
      sheetFingerprint: '0123456789abcdef', qualityMetrics: { criticalFailures: [] },
      rowStates: ['single', 'single'],
    };
    page.updateOfflineConfirmation('A,B|student:7', result, marks, 'student:7', 1000);
    page.updateOfflineConfirmation('', { ...result, rowStates: ['single', 'uncertain'] },
      [['A'], []], 'student:7', 2000);
    expect(page.stableDetectionFrames).toBe(1);
    page.updateOfflineConfirmation('A,B|student:7', result, marks, 'student:7', 3000);
    expect(page.stableDetectionFrames).toBe(2);
  });

  it('keeps confirmation when delayed sequence OCR promotes the same sheet to a student', () => {
    const marks = [['A'], ['B']];
    const result = {
      geometryVerified: true,
      sheetFingerprintVersion: 2,
      sheetFingerprint: '0123456789abcdef',
      qualityMetrics: { criticalFailures: [] },
      rowStates: ['single', 'single'],
    };

    page.updateOfflineConfirmation(
      'A,B|sequence:none', result, marks, 'sequence:none', 1000
    );
    page.updateOfflineConfirmation(
      'A,B|student:7', result, marks, 'student:7', 2000
    );

    expect(page.stableDetectionFrames).toBe(2);
    expect(page.stableDetectionSignature).toBe('A,B|student:7');
    expect(page.offlineConfirmationIdentity).toBe('student:7');
  });

  it('holds a first vote through an alignment miss but expires it without a fresh read', () => {
    Object.assign(page, {
      stableDetectionSignature: 'A,B|student:7', stableDetectionFrames: 1,
      offlineConfirmationAt: 1000, offlineConfirmationIdentity: 'student:7',
      offlineConfirmationFingerprint: '', REQUIRED_STABLE_FRAMES: 2,
      OFFLINE_CONFIRMATION_MAX_AGE_MS: 20000,
    });
    const missed = {
      geometryVerified: false, sheetPresence: 'present', sheetFingerprint: '',
      qualityMetrics: { criticalFailures: ['registration'] }, rowStates: [],
    };
    expect(page.updateOfflineConfirmation('', missed, [], 'student:7', 19000)).toBe('held');
    expect(page.stableDetectionFrames).toBe(1);
    expect(page.offlineConfirmationAt).toBe(1000);
    expect(page.updateOfflineConfirmation('', missed, [], 'student:7', 22000)).toBe('reset');
    expect(page.stableDetectionFrames).toBe(0);
  });

  it('invalidates even a ready vote for removed sheets, changed fingerprints or conflicting rows', () => {
    const result = {
      geometryVerified: true, sheetPresence: 'present', sheetFingerprintVersion: 2,
      sheetFingerprint: '0000000000000000', qualityMetrics: { criticalFailures: [] },
      rowStates: ['single', 'single'],
    };
    for (const change of [
      { result: { ...result, sheetPresence: 'absent' }, marks: [] },
      { result: { ...result, sheetFingerprint: 'ffffffffffffffff' }, marks: [['A'], ['B']] },
      { result, marks: [['A'], ['C']] },
    ]) {
      page.updateOfflineConfirmation('A,B|student:7', result, [['A'], ['B']], 'student:7', 1000);
      page.updateOfflineConfirmation('A,B|student:7', result, [['A'], ['B']], 'student:7', 2000);
      expect(page.updateOfflineConfirmation('', change.result, change.marks, 'student:7', 3000)).toBe('reset');
      expect(page.stableDetectionFrames).toBe(0);
    }
  });

  it('holds a recent verified vote through one native processing error', async () => {
    const completed = { success: true, detectedAnswers: Array(50).fill('A') };
    Object.assign(page, {
      liveDetection: completed,
      liveResolvedRows: 50,
      stableDetectionSignature: 'A|student:7',
      stableDetectionFrames: 1,
      offlineConfirmationAt: Date.now(),
      awaitingSheetRemoval: false,
      clearLiveAnswerOverlay: jasmine.createSpy('clear confirmed overlay'),
      nextTrackingFrame: () => ({}),
      detectOfflineFrame: async () => { throw new Error('Temporary native read failure'); },
    });

    await page.performOfflineLiveDetection(
      new Blob(['failed confirmation frame']), page.autoDetectionGeneration
    );

    expect(page.stableDetectionFrames).toBe(1);
    expect(page.stableDetectionSignature).toBe('A|student:7');
    expect(page.liveDetection).toBe(completed);
    expect(page.liveResolvedRows).toBe(50);
    expect(page.liveDetectionStatus).toBe('scanning');
    expect(page.liveQualityMessage).toContain('holding stable scan 1/2');
    expect(page.clearLiveAnswerOverlay).not.toHaveBeenCalled();
  });

  it('discards confirmation for conflicting marks, changed students, lost geometry and expired evidence', () => {
    const result = {
      geometryVerified: true, sheetFingerprintVersion: 2,
      sheetFingerprint: '0123456789abcdef', qualityMetrics: { criticalFailures: [] },
      rowStates: ['single', 'single'],
    };
    for (const change of [
      { marks: [['A'], ['C']] },
      { identity: 'student:8' },
      { result: { ...result, geometryVerified: false } },
      { time: 22001 },
      { result: { ...result, qualityMetrics: { criticalFailures: ['blur'] } } },
      { result: { ...result, sheetFingerprint: 'ffffffffffffffff' } },
    ] as any[]) {
      page.stableDetectionSignature = '';
      page.stableDetectionFrames = 0;
      page.updateOfflineConfirmation('A,B|student:7', result, [['A'], ['B']], 'student:7', 1000);
      page.updateOfflineConfirmation('', change.result || result, change.marks || [['A'], ['B']],
        change.identity || 'student:7', change.time || 2000);
      expect(page.stableDetectionFrames).toBe(0);
    }
  });

  it('accepts one stable borderline row after two identical native frames', async () => {
    Object.assign(page, {
      awaitingSheetRemoval: false,
      selectedClassroomId: 1,
      selectedStudentId: 7,
      autoRecordEnabled: true,
      stableDetectionSignature: '',
      stableDetectionFrames: 0,
      REQUIRED_STABLE_FRAMES: 2,
      autoScanCooldownUntil: 0,
      offlineAnswers: [],
      offlineConfidences: [],
      offlineMarkedLetters: [],
      offlineReviewed: [],
    });
    const answers = Array(50).fill('A');
    answers[0] = '';
    const markedLetters = Array.from({ length: 50 }, () => ['A']);
    const result = {
      gradeable: false,
      answers,
      confidences: Array(50).fill(91),
      markedLetters,
      rowStates: Array.from({ length: 50 }, (_, index) => index === 0 ? 'uncertain' : 'single'),
      overallConfidence: 69,
      detectedCount: 49,
      uncertainCount: 1,
      rowMapComplete: false,
      geometryVerified: true,
      qualityMetrics: { criticalFailures: [] },
      temporalEligible: true,
      source: 'device-native-verified',
      sequence: '2',
      sequenceConfidence: 96,
      sheetFingerprint: 'borderline-sheet',
      sheetFingerprintVersion: 2,
      processingMs: 640,
      anchorMethod: 'answer-grid',
      reason: '1 answer row needs another matching frame.',
    };
    page.detectOfflineFrame = jasmine.createSpy('detect offline').and.resolveTo(result);
    page.nextTrackingFrame = jasmine.createSpy('tracking frame').and.returnValue({});
    page.autoPickAnswerKeyAndStudent = jasmine.createSpy('student').and.resolveTo();
    page.recordLiveFrame = jasmine.createSpy('record live result');
    page.clearLiveAnswerOverlay = jasmine.createSpy('clear overlay');
    page.applyOfflineDetectionResult = jasmine.createSpy('apply accepted result').and.callFake((accepted: any) => {
      page.offlineAnswers = accepted.answers;
      page.offlineConfidences = accepted.confidences;
      page.offlineMarkedLetters = accepted.markedLetters;
      page.offlineReviewed = Array(50).fill(true);
      page.offlineGradeable = accepted.gradeable;
    });
    page.saveOfflineManualGrade = jasmine.createSpy('save direct').and.resolveTo(true);

    await page.performOfflineLiveDetection(
      new Blob(['frame 1'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );
    expect(page.saveOfflineManualGrade).not.toHaveBeenCalled();
    expect(page.liveQualityMessage).toContain('1/2');

    await page.performOfflineLiveDetection(
      new Blob(['frame 2'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );

    expect(page.saveOfflineManualGrade).toHaveBeenCalledTimes(1);
    const accepted = page.applyOfflineDetectionResult.calls.mostRecent().args[0];
    expect(accepted.answers[0]).toBe('A');
    expect(accepted.rowStates[0]).toBe('single');
    expect(accepted.gradeable).toBeTrue();
    expect(accepted.overallConfidence).toBe(69);
  });

  it('keeps an auto-selected student when one current-sheet frame misses sequence OCR', async () => {
    Object.assign(page, { selectedStudentId: 8, autoSelectedStudentId: 8 });
    await page.autoPickAnswerKeyAndStudent(null);
    expect(page.selectedStudentId).toBe(8);
    expect(page.autoSelectedStudentId).toBe(8);
  });

  it('clears the auto-selected student only after the sheet-removal boundary is verified', () => {
    Object.assign(page, {
      selectedStudentId: 8,
      autoSelectedStudentId: 8,
      awaitingSheetRemoval: true,
      noSheetFrames: 2,
      replacementSheetFingerprint: 'replacement',
      replacementSheetFrames: 2,
      lastCapturedSignature: 'answers',
      lastCapturedFingerprint: 'sheet',
      lastCapturedStudentId: 8,
      stableDetectionSignature: 'answers',
      stableDetectionFrames: 2,
      resetTrackingSession: jasmine.createSpy('reset tracking'),
    });
    page.releaseSheetChangeBarrier('Ready');
    expect(page.selectedStudentId).toBeNull();
    expect(page.autoSelectedStudentId).toBeNull();
    expect(page.awaitingSheetRemoval).toBeFalse();
  });

  it('never promotes a borderline row when the native quality checks have a critical failure', async () => {
    Object.assign(page, {
      awaitingSheetRemoval: false,
      selectedClassroomId: 1,
      selectedStudentId: 7,
      autoRecordEnabled: true,
      stableDetectionSignature: '',
      stableDetectionFrames: 0,
      REQUIRED_STABLE_FRAMES: 2,
      autoScanCooldownUntil: 0,
    });
    const answers = Array(50).fill('A');
    answers[0] = '';
    const result = {
      gradeable: false,
      answers,
      confidences: Array(50).fill(91),
      markedLetters: Array.from({ length: 50 }, () => ['A']),
      rowStates: Array.from({ length: 50 }, (_, index) => index === 0 ? 'uncertain' : 'single'),
      overallConfidence: 45,
      detectedCount: 49,
      uncertainCount: 1,
      rowMapComplete: false,
      geometryVerified: true,
      qualityMetrics: { criticalFailures: ['sharpness'] },
      source: 'device-native-verified',
      sequence: '2',
      sheetFingerprint: 'blurred-sheet',
      processingMs: 640,
      anchorMethod: 'answer-grid',
      reason: 'Improve sharpness and keep the complete sheet steady.',
    };
    page.detectOfflineFrame = jasmine.createSpy('detect offline').and.resolveTo(result);
    page.nextTrackingFrame = jasmine.createSpy('tracking frame').and.returnValue({});
    page.autoPickAnswerKeyAndStudent = jasmine.createSpy('student').and.resolveTo();
    page.recordLiveFrame = jasmine.createSpy('record live result');
    page.clearLiveAnswerOverlay = jasmine.createSpy('clear overlay');
    page.saveOfflineManualGrade = jasmine.createSpy('save direct').and.resolveTo(true);

    for (let frame = 1; frame <= 3; frame++) {
      await page.performOfflineLiveDetection(
        new Blob([`blurred ${frame}`], { type: 'image/jpeg' }), page.autoDetectionGeneration
      );
    }

    expect(page.stableDetectionFrames).toBe(0);
    expect(page.saveOfflineManualGrade).not.toHaveBeenCalled();
    expect(page.liveQualityMessage).toContain('sharpness');
  });

  it('requires two identical native frames before auto-grading any blank row', async () => {
    Object.assign(page, {
      awaitingSheetRemoval: false,
      selectedClassroomId: 1,
      selectedStudentId: 7,
      autoRecordEnabled: true,
      stableDetectionSignature: '',
      stableDetectionFrames: 0,
      autoScanCooldownUntil: 0,
      REQUIRED_STABLE_FRAMES: 2,
      offlineAnswers: [],
      offlineConfidences: [],
      offlineMarkedLetters: [],
      offlineReviewed: [],
    });
    const answers = Array(50).fill('A');
    answers[39] = '';
    const markedLetters = Array.from({ length: 50 }, (_, index) => index === 39 ? [] : ['A']);
    const result = {
      gradeable: true,
      answers,
      confidences: Array(50).fill(99),
      markedLetters,
      overallConfidence: 99,
      detectedCount: 49,
      uncertainCount: 0,
      rowMapComplete: true,
      geometryVerified: true,
      source: 'device-native-verified',
      sequence: '2',
      sequenceConfidence: 96,
      sheetFingerprint: 'blank-sheet',
      sheetFingerprintVersion: 2,
      processingMs: 640,
      anchorMethod: 'answer-grid',
    };
    page.detectOfflineFrame = jasmine.createSpy('detect offline').and.resolveTo(result);
    page.nextTrackingFrame = jasmine.createSpy('tracking frame').and.returnValue({});
    page.autoPickAnswerKeyAndStudent = jasmine.createSpy('student').and.resolveTo();
    page.recordLiveFrame = jasmine.createSpy('record live result');
    page.clearLiveAnswerOverlay = jasmine.createSpy('clear overlay');
    page.applyOfflineDetectionResult = jasmine.createSpy('apply accepted result').and.callFake(() => {
      page.offlineAnswers = answers;
      page.offlineConfidences = result.confidences;
      page.offlineMarkedLetters = markedLetters;
      page.offlineReviewed = Array(50).fill(true);
      page.offlineGradeable = true;
    });
    page.saveOfflineManualGrade = jasmine.createSpy('save direct').and.resolveTo(true);

    await page.performOfflineLiveDetection(
      new Blob(['frame one'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );
    expect(page.stableDetectionFrames).toBe(1);
    expect(page.saveOfflineManualGrade).not.toHaveBeenCalled();

    await page.performOfflineLiveDetection(
      new Blob(['frame two'], { type: 'image/jpeg' }), page.autoDetectionGeneration
    );
    expect(page.stableDetectionFrames).toBe(2);
    expect(page.saveOfflineManualGrade).toHaveBeenCalledTimes(1);
  });

  it('auto-prints and resumes only after an automatic local grade is saved', async () => {
    const file = new File(['sheet'], 'sheet.jpg', { type: 'image/jpeg' });
    Object.assign(page, {
      selectedClassroomId: 1,
      selectedStudentId: 7,
      selectedAnswerKeyId: 4,
      answerKeys: [{ id: 4, numQuestions: 2 }],
      offlineAnswers: ['A', 'B'],
      offlineConfidences: [99, 98],
      offlineMarkedLetters: [['A'], ['B']],
      offlineReviewed: [true, true],
      offlineGradeable: true,
      offlineFingerprint: 'sheet-fingerprint',
      offlineProcessingMs: 620,
      offlineOverallConfidence: 98,
      offlineAnchorMethod: 'answer-grid',
      offlineQrData: '',
      autoPrintEnabled: true,
      scanService: {
        saveOfflineManualGrade: jasmine.createSpy('save').and.returnValue(of({
          success: true,
          scan: { id: 9, grading: { totalScore: 2 } },
        })),
        getScan: jasmine.createSpy('get scan').and.returnValue(of({
          success: true,
          scan: { id: 9, examResponse: { total_score: 2 }, omrResults: [{}, {}] },
        })),
      },
      printOfflineScore: jasmine.createSpy('print').and.resolveTo(),
      loadScanHistory: jasmine.createSpy('history'),
      loadStats: jasmine.createSpy('stats'),
      resetOfflineDetectionResult: jasmine.createSpy('reset result'),
      rememberPendingCapturedSheet: jasmine.createSpy('remember sheet'),
      beginAutoScanCooldown: jasmine.createSpy('cooldown'),
      resumeAutoScanAfterProcessing: jasmine.createSpy('resume'),
    });

    const saved = await page.saveOfflineManualGrade(file, true);

    expect(saved).toBeTrue();
    expect(page.printOfflineScore).toHaveBeenCalled();
    expect(page.rememberPendingCapturedSheet).toHaveBeenCalled();
    expect(page.beginAutoScanCooldown).toHaveBeenCalled();
    expect(page.resumeAutoScanAfterProcessing).toHaveBeenCalled();
  });

  it('submits an offline desktop score through the protected local print route', async () => {
    Object.assign(page, {
      isStandaloneAndroid: false,
      backendCameraBaseUrl: '/api/camera',
      http: {
        post: jasmine.createSpy('post').and.returnValue(of({
          success: true,
          printedDirectly: true,
          printerName: 'Test Printer',
        })),
      },
      printScoreInFrame: jasmine.createSpy('browser print').and.resolveTo(),
      showToastMessage: jasmine.createSpy('toast'),
    });

    await page.printOfflineScore({
      student_name_detected: 'Student',
      examResponse: { total_score: 39 },
      omrResults: Array.from({ length: 50 }, (_, index) => ({ question_number: index + 1, is_correct: index % 2 === 0 })),
    });

    expect(page.http.post).toHaveBeenCalledWith('/api/camera/print-score', { scoreText: '39/50' });
    expect(page.printScoreInFrame).not.toHaveBeenCalled();
    expect(page.showToastMessage).toHaveBeenCalledWith('Score 39/50 sent to Test Printer');
  });

  it('keeps an existing health retry deadline when more failures arrive', fakeAsync(() => {
    page.checkCameraHealth = jasmine.createSpy('check health');
    page.scheduleCameraHealthRetry(1000);
    tick(600);
    page.scheduleCameraHealthRetry(1000);
    tick(400);
    expect(page.checkCameraHealth).toHaveBeenCalledTimes(1);
    expect(page.checkCameraHealth).toHaveBeenCalledWith(true);
    expect(page.cameraHealthRetryTimer).toBeNull();
  }));

  for (const recoveryInProgress of [false, true]) {
    it(`recovers a newly discovered warming camera (recovery running: ${recoveryInProgress})`, async () => {
      page.isDiscoveringCamera = true;
      page.directPiCandidates = () => ['http://192.168.1.200:5000'];
      page.probeDirectPi = async () => ({
        cameraUrl: 'http://192.168.1.200:5000',
        cameraInitialized: false,
        frameAvailable: false,
        recoveryInProgress,
      });
      page.updateCameraUrls = jasmine.createSpy('update URL');
      page.stopStreamPoll = jasmine.createSpy('stop preview');
      page.stopAutoDetection = jasmine.createSpy('stop detection');
      page.resetTrackingSession = jasmine.createSpy('reset tracking');
      page.requestCameraRestart = jasmine.createSpy('restart camera');
      page.scheduleCameraHealthRetry = jasmine.createSpy('retry health');
      await page.discoverDirectPi(1, true);
      expect(page.cameraBaseUrl).toBe('http://192.168.1.200:5000');
      expect(page.stopStreamPoll).toHaveBeenCalled();
      expect(page.stopAutoDetection).toHaveBeenCalled();
      expect(page.streamError).toBeTrue();
      expect(page.isDiscoveringCamera).toBeFalse();
      if (recoveryInProgress) {
        expect(page.scheduleCameraHealthRetry).toHaveBeenCalled();
        expect(page.requestCameraRestart).not.toHaveBeenCalled();
      } else {
        expect(page.requestCameraRestart).toHaveBeenCalled();
      }
    });
  }
});

describe('Upload detection isolation', () => {
  it('does not detect or assign a fingerprint after the selected image changes', async () => {
    const page: any = Object.create(ScannerPage.prototype);
    Object.defineProperty(page, 'isOfflineMode', { value: true });
    let finishFingerprint!: (value: string) => void;
    Object.assign(page, {
      selectedFile: new File(['first'], 'first.png'),
      selectedAnswerKeyId: 1,
      answerKeys: [{ id: 1, numQuestions: 50 }],
      offlineDetectionRun: 0,
      offlineFingerprint: '',
      fingerprintFile: () => new Promise<string>(resolve => { finishFingerprint = resolve; }),
      detectOfflineFrame: jasmine.createSpy('detect'),
    });
    const detection = page.detectOfflineAnswers();
    page.offlineDetectionRun++;
    page.selectedFile = new File(['second'], 'second.png');
    finishFingerprint('first-fingerprint');
    await detection;
    expect(page.offlineFingerprint).toBe('');
    expect(page.detectOfflineFrame).not.toHaveBeenCalled();
  });

  it('does not send another upload while processing', async () => {
    const page: any = Object.create(ScannerPage.prototype);
    page.isProcessing = true;
    page.synchronizeScannerMode = jasmine.createSpy('mode');
    await page.uploadAndProcess();
    expect(page.synchronizeScannerMode).not.toHaveBeenCalled();
  });
});
