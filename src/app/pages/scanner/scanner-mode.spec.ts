import { ScannerPage } from './scanner.page';
import { Subject } from 'rxjs';

describe('Scanner mode transitions', () => {
  let page: any;
  let offline: boolean;
  beforeEach(() => {
    offline = true;
    page = Object.create(ScannerPage.prototype);
    Object.assign(page, {
      authService: { isOfflineMode: () => offline },
      scannerSessionMode: true, cameraViewActive: true,
      cameraRequestedActive: true, isScannerActive: true, autoScanEnabled: true,
      autoDetectionGeneration: 1, detectionActive: true, destroyed: false,
      selectedAnswerKeyId: 1, selectedClassroomId: 2, selectedStudentId: 3,
      answerKeys: [{ id: 1 }], classrooms: [{ id: 2 }], students: [{ id: 3 }],
      capturedImage: 'offline-frame', currentScan: { id: 4 }, awaitingSheetRemoval: true,
      pendingCapturedFingerprint: 'offline-sheet',
      stopExternalCameraSession: jasmine.createSpy('stop old session').and.callFake(() => {
        page.autoDetectionGeneration++;
        page.isScannerActive = false;
      }),
      clearAutoScanCooldown: () => {}, clearSelection: () => {},
      updateCameraUrls: () => {}, loadAutomationPreferences: jasmine.createSpy('load preferences'),
      loadReferenceData: jasmine.createSpy('load references'),
      loadScanHistory: jasmine.createSpy('load history'), loadStats: jasmine.createSpy('load stats'),
      http: { setCameraActive: () => {} },
      startStreamPoll: jasmine.createSpy('start preview'), startAutoDetection: jasmine.createSpy('start detection'),
    });
  });
  it('reads the current auth mode even on a cached scanner page', () => {
    expect(page.isOfflineMode).toBeTrue();
    offline = false;
    expect(page.isOfflineMode).toBeFalse();
  });
  it('clears offline references, frames, and duplicate barriers before returning online', () => {
    offline = false;
    page.ionViewWillEnter();
    expect(page.isOfflineMode).toBeFalse();
    expect(page.scannerSessionMode).toBeFalse();
    expect(page.selectedAnswerKeyId).toBeNull();
    expect(page.selectedClassroomId).toBeNull();
    expect(page.selectedStudentId).toBeNull();
    expect(page.capturedImage).toBeNull();
    expect(page.currentScan).toBeNull();
    expect(page.awaitingSheetRemoval).toBeFalse();
    expect(page.pendingCapturedFingerprint).toBe('');
    expect(page.loadReferenceData).toHaveBeenCalledTimes(1);
    expect(page.loadScanHistory).toHaveBeenCalledTimes(1);
    expect(page.startStreamPoll).not.toHaveBeenCalled();
  });
  it('refreshes online references when switching into Offline Mode', () => {
    page.scannerSessionMode = false;
    page.ionViewWillEnter();
    expect(page.scannerSessionMode).toBeTrue();
    expect(page.selectedAnswerKeyId).toBeNull();
    expect(page.loadReferenceData).toHaveBeenCalledTimes(1);
  });
  it('rejects an old detection immediately when auth mode changes', () => {
    expect(page.isCurrentAutoDetection(1)).toBeTrue();
    offline = false;
    expect(page.isCurrentAutoDetection(1)).toBeFalse();
  });
  it('never invokes the local detector or saver in Online Mode', async () => {
    offline = false;
    page.detectOfflineFrame = jasmine.createSpy('local detector');
    page.scanService = { saveOfflineManualGrade: jasmine.createSpy('local save') };
    await page.performOfflineLiveDetection(new Blob(['frame']), 1);
    const saved = await page.saveOfflineManualGrade(new File(['frame'], 'photo.jpg'));
    expect(saved).toBeFalse();
    expect(page.detectOfflineFrame).not.toHaveBeenCalled();
    expect(page.scanService.saveOfflineManualGrade).not.toHaveBeenCalled();
  });
  it('does not apply an online save response to a newly opened offline session', async () => {
    offline = false;
    page.scannerSessionMode = false;
    const response = new Subject<any>();
    page.scanService = { finalizeDetection: () => response };
    page.handleSuccessfulScan = jasmine.createSpy('online result');
    page.resumeAutoScanAfterProcessing = () => {};
    const pending = page.finalizeAcceptedDetection('verified-frame');
    offline = true;
    response.next({ success: true, scan: { id: 88 } });
    response.complete();
    await pending;
    expect(page.handleSuccessfulScan).not.toHaveBeenCalled();
  });

  it('ignores reference data from requests started in the previous mode', () => {
    const keys = new Subject<any[]>();
    const rooms = new Subject<any[]>();
    page.answerKeyService = { getAnswerKeys: () => keys };
    page.classroomService = { getClassrooms: () => rooms };
    ScannerPage.prototype.loadReferenceData.call(page);
    offline = false;
    page.answerKeys = [];
    page.classrooms = [];
    keys.next([{ id: 99 }]);
    rooms.next([{ id: 99 }]);
    expect(page.answerKeys).toEqual([]);
    expect(page.classrooms).toEqual([]);
    keys.complete();
    rooms.complete();
  });
});
