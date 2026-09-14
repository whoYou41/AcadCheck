import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { CameraHttpService, CAMERA_NATIVE_HTTP, normalizedDirectPiUrl } from './camera-http.service';

describe('Offline camera transport', () => {
  let service: CameraHttpService;
  let http: HttpTestingController;
  let native: { request: jasmine.Spy; cancel: jasmine.Spy; setActive: jasmine.Spy };
  let auth: { isOfflineMode: jasmine.Spy };

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    localStorage.removeItem('token');
    native = { request: jasmine.createSpy('native request'), cancel: jasmine.createSpy('cancel').and.resolveTo(), setActive: jasmine.createSpy('active').and.resolveTo() };
    auth = { isOfflineMode: jasmine.createSpy('offline').and.returnValue(true) };
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(), provideHttpClientTesting(), CameraHttpService,
      { provide: AuthService, useValue: auth }, { provide: CAMERA_NATIVE_HTTP, useValue: native },
    ] });
    service = TestBed.inject(CameraHttpService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => { http.verify(); localStorage.removeItem('token'); });

  it('creates one credentialed session before concurrent capture and health requests', () => {
    localStorage.setItem('token', 'stale-online-token');
    service.get('/api/camera/capture', { responseType: 'blob' }).subscribe();
    service.get('/api/camera/status').subscribe();
    const session = http.expectOne('/api/camera/offline-session');
    expect(session.request.withCredentials).toBeTrue();
    expect(session.request.headers.has('Authorization')).toBeFalse();
    http.expectNone('/api/camera/capture');
    session.flush({ success: true });
    for (const url of ['/api/camera/capture', '/api/camera/status']) {
      const request = http.expectOne(url);
      expect(request.request.withCredentials).toBeTrue();
      expect(request.request.headers.has('Authorization')).toBeFalse();
      request.flush(url.endsWith('capture') ? new Blob(['jpeg']) : { camera_initialized: true });
    }
    service.get('/api/camera/status').subscribe();
    http.expectNone('/api/camera/offline-session');
    http.expectOne('/api/camera/status').flush({ camera_initialized: true });
  });

  it('renews a lost or expired cookie once and does not loop on repeated denial', () => {
    const errors: number[] = [];
    service.get('/api/camera/status').subscribe({ error: error => errors.push(error.status) });
    http.expectOne('/api/camera/offline-session').flush({ success: true });
    http.expectOne('/api/camera/status').flush({}, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/camera/offline-session').flush({ success: true });
    http.expectOne('/api/camera/status').flush({}, { status: 403, statusText: 'Forbidden' });
    expect(errors).toEqual([403]);
    http.expectNone('/api/camera/offline-session');
  });

  it('shares renewal when capture and status both reject the old cookie', () => {
    const captureReady = jasmine.createSpy('capture ready');
    const statusReady = jasmine.createSpy('status ready');
    service.get('/api/camera/capture', { responseType: 'blob' }).subscribe(captureReady);
    service.get('/api/camera/status').subscribe(statusReady);
    http.expectOne('/api/camera/offline-session').flush({ success: true });
    const capture = http.expectOne('/api/camera/capture');
    const status = http.expectOne('/api/camera/status');
    capture.flush(new Blob([]), { status: 401, statusText: 'Unauthorized' });
    status.flush({}, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/camera/offline-session').flush({ success: true });
    http.expectOne('/api/camera/capture').flush(new Blob(['jpeg']));
    http.expectOne('/api/camera/status').flush({ camera_initialized: true });
    expect(captureReady).toHaveBeenCalledTimes(1);
    expect(statusReady).toHaveBeenCalledOnceWith({ camera_initialized: true });
  });

  it('can establish a new session after a failed discovery attempt', () => {
    const discoveryError = jasmine.createSpy('discovery error');
    service.get('/api/camera/discover').subscribe({ error: discoveryError });
    http.expectOne('/api/camera/offline-session').flush({}, { status: 403, statusText: 'Forbidden' });
    http.expectNone('/api/camera/discover');
    expect(discoveryError).toHaveBeenCalledTimes(1);
    service.get('/api/camera/status').subscribe();
    http.expectOne('/api/camera/offline-session').flush({ success: true });
    http.expectOne('/api/camera/status').flush({ camera_initialized: true });
  });

  it('keeps online camera authentication and does not create an offline session', () => {
    auth.isOfflineMode.and.returnValue(false);
    localStorage.setItem('token', 'online-token');
    service.get('/api/camera/status').subscribe();
    const request = http.expectOne('/api/camera/status');
    expect(request.request.headers.get('Authorization')).toBe('Bearer online-token');
    request.flush({ camera_initialized: true });
    http.expectNone('/api/camera/offline-session');
  });

  it('uses browser HTTP directly for a private Pi URL without a backend session', () => {
    service.get('http://192.168.1.137:5000/status').subscribe();
    const request = http.expectOne('http://192.168.1.137:5000/status');
    expect(request.request.withCredentials).toBeFalse();
    expect(request.request.headers.has('Authorization')).toBeFalse();
    request.flush({ camera_initialized: true, frame_available: true });
    http.expectNone('/api/camera/offline-session');
  });
  it('uses native Android HTTP for direct Pi status and decodes JPEG bytes', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    localStorage.setItem('token', 'never-send-to-pi');
    native.request.and.resolveTo({ status: 200, data: { camera_initialized: true }, headers: {} });
    const status = await firstValueFrom(service.get('http://192.168.254.104:5000/status'));
    expect(status.camera_initialized).toBeTrue();
    native.request.and.resolveTo({ status: 200, data: btoa('jpeg-frame'), headers: { 'Content-Type': 'image/jpeg' } });
    const frame = await firstValueFrom(service.get('http://192.168.254.104:5000/capture', {
      responseType: 'blob', headers: { Authorization: 'must-be-stripped' },
    }));
    expect(await frame.text()).toBe('jpeg-frame');
    expect(frame.type).toBe('image/jpeg');
    const captureRequest = native.request.calls.mostRecent().args[0];
    expect(captureRequest.headers).toEqual({});
    expect(captureRequest.connectTimeout).toBe(4000);
    expect(captureRequest.readTimeout).toBe(12000);
    expect(captureRequest.disableRedirects).toBeTrue();
    http.expectNone(() => true);
  });

  it('cancels the native request when a preview is stopped and ignores its late result', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    let finish!: (value: any) => void;
    native.request.and.returnValue(new Promise(resolve => { finish = resolve; }));
    const received = jasmine.createSpy('received');
    const request = service.get('http://192.168.1.2:5000/capture', { responseType: 'blob' }).subscribe(received);
    const requestId = native.request.calls.mostRecent().args[0].requestId;
    request.unsubscribe();
    expect(native.cancel).toHaveBeenCalledOnceWith({ requestId });
    finish({ status: 200, data: btoa('jpeg'), headers: {} });
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();
  });

  it('keeps the Android screen awake only while camera use is active', () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    service.setCameraActive(true);
    service.setCameraActive(false);
    expect(native.setActive.calls.allArgs()).toEqual([[{ active: true }], [{ active: false }]]);
  });

  it('preserves native camera HTTP failures and never sends the APK to localhost API', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    native.request.and.resolveTo({ status: 401, data: { message: 'Denied by Pi' }, headers: {} });
    await expectAsync(firstValueFrom(service.get('http://acadacam.local:5000/status')))
      .toBeRejectedWith(jasmine.objectContaining({ status: 401 }));
    await expectAsync(firstValueFrom(service.get('/api/camera/status'))).toBeRejected();
    expect(native.request).toHaveBeenCalledTimes(1);
    http.expectNone(() => true);
  });

  it('accepts local Pi addresses and rejects public hosts and embedded credentials', () => {
    expect(normalizedDirectPiUrl('192.168.254.104')).toBe('http://192.168.254.104:5000');
    expect(normalizedDirectPiUrl('http://acadacam.local:5000/capture')).toBe('http://acadacam.local:5000');
    for (const url of ['https://example.com', 'http://localhost:8100/api', 'http://user:pass@192.168.1.2']) {
      expect(normalizedDirectPiUrl(url)).toBeNull();
    }
  });
});
