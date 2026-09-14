import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { ScanService } from './scan.service';
import { AuthService } from './auth.service';
import { OfflineDataService } from './offline-data.service';
import { CameraHttpService } from './camera-http.service';

describe('Scan persistence routing', () => {
  let service: ScanService;
  let http: HttpTestingController;
  let auth: { isOfflineMode: jasmine.Spy };
  let offline: { saveManualGrade: jasmine.Spy; getScan: jasmine.Spy };
  let savedToken: string | null;
  const input = { filename: 'sheet.jpg', classroomId: 4, answerKeyId: 5, studentId: 6, answers: ['A'] };
  beforeEach(() => {
    savedToken = localStorage.getItem('token');
    localStorage.setItem('token', 'test-online-token');
    auth = { isOfflineMode: jasmine.createSpy('offline mode').and.returnValue(false) };
    offline = { saveManualGrade: jasmine.createSpy('local save'), getScan: jasmine.createSpy('local read') };
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(),
      { provide: AuthService, useValue: auth }, { provide: OfflineDataService, useValue: offline },
      { provide: CameraHttpService, useValue: {} },
    ] });
    service = TestBed.inject(ScanService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    savedToken == null ? localStorage.removeItem('token') : localStorage.setItem('token', savedToken);
  });
  it('saves online live detections through the authenticated database endpoint', () => {
    service.finalizeDetection('verified-frame', 6, 4).subscribe();
    const request = http.expectOne('/api/omr/finalize-detection');
    expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('Authorization')).toBe('Bearer test-online-token');
    expect(request.request.body).toEqual({ detectionToken: 'verified-frame', studentId: 6, classroomId: 4 });
    request.flush({ success: true, scan: { id: 80 } });
    expect(offline.saveManualGrade).not.toHaveBeenCalled();
  });
  it('processes online uploads on the server and reads database results', () => {
    service.processScan(80).subscribe();
    http.expectOne('/api/scans/80/process').flush({ success: true, scan: { id: 80 } });
    service.getScan(80).subscribe();
    http.expectOne('/api/scans/80').flush({ success: true, scan: { id: 80 } });
    expect(offline.getScan).not.toHaveBeenCalled();
    expect(offline.saveManualGrade).not.toHaveBeenCalled();
  });
  it('saves offline grades locally without HTTP', async () => {
    auth.isOfflineMode.and.returnValue(true);
    offline.saveManualGrade.and.returnValue({ id: 12, omrResults: [], examResponse: { total_score: 1, percentage: 100 } });
    const response = await firstValueFrom(service.saveOfflineManualGrade(input));
    expect(response.success).toBeTrue();
    expect(offline.saveManualGrade).toHaveBeenCalledOnceWith(input);
    http.expectNone(() => true);
  });
  it('rejects the wrong save path instead of changing storage modes', async () => {
    await expectAsync(firstValueFrom(service.saveOfflineManualGrade(input))).toBeRejected();
    auth.isOfflineMode.and.returnValue(true);
    await expectAsync(firstValueFrom(service.finalizeDetection('online-frame'))).toBeRejected();
    await expectAsync(firstValueFrom(service.processScan(80))).toBeRejected();
    expect(offline.saveManualGrade).not.toHaveBeenCalled();
    http.expectNone(() => true);
  });
  it('never saves locally when an online database request fails', async () => {
    const response = firstValueFrom(service.finalizeDetection('verified-frame', 6, 4));
    http.expectOne('/api/omr/finalize-detection').flush({ message: 'Database unavailable' }, { status: 503, statusText: 'Unavailable' });
    await expectAsync(response).toBeRejected();
    expect(offline.saveManualGrade).not.toHaveBeenCalled();
  });
});
