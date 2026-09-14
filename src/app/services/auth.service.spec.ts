import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting, HttpTestingController } from '@angular/common/http/testing';
import { AUTH_CONNECTION_MESSAGE, AuthService } from './auth.service';

describe('Authentication storage mode', () => {
  let auth: AuthService;
  let http: HttpTestingController;
  const keys = ['acadcheck.offlineMode', 'currentUser', 'token', 'acadcheck.offline.database.v1'];
  let saved: Array<string | null>;
  beforeEach(() => {
    saved = keys.map(key => localStorage.getItem(key));
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthService);
    http = TestBed.inject(HttpTestingController);
    auth.enterOfflineMode();
  });
  afterEach(() => {
    http.verify();
    keys.forEach((key, index) => saved[index] == null ? localStorage.removeItem(key) : localStorage.setItem(key, saved[index]!));
  });
  it('exits Offline Mode on login without erasing local grades', () => {
    localStorage.setItem('acadcheck.offline.database.v1', '{"savedGrades":[42]}');
    auth.login({ username: 'teacher', password: 'test' }).subscribe(() => {
      expect(auth.isOfflineMode()).toBeFalse();
      expect(localStorage.getItem('token')).toBe('online-session');
    });
    http.expectOne('/api/auth/login').flush({ success: true, token: 'online-session', user: { id: 9, role: 'teacher' } });
    expect(localStorage.getItem('acadcheck.offline.database.v1')).toBe('{"savedGrades":[42]}');
  });
  it('keeps Offline Mode when login returns no usable token', () => {
    const rejected = jasmine.createSpy('rejected');
    auth.login({ username: 'teacher', password: 'test' }).subscribe({ error: rejected });
    http.expectOne('/api/auth/login').flush({ success: true, user: { id: 9 } });
    expect(rejected).toHaveBeenCalled();
    expect(auth.isOfflineMode()).toBeTrue();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('explains how to recover when the login server cannot be reached', () => {
    let message = '';
    auth.login({ username: 'teacher', password: 'test' }).subscribe({
      error: error => message = error.message,
    });
    http.expectOne('/api/auth/login').error(new ProgressEvent('network error'));
    expect(message).toBe(AUTH_CONNECTION_MESSAGE);
    expect(auth.isOfflineMode()).toBeTrue();
  });

  it('uses the connection warning while the local server is unavailable', () => {
    let message = '';
    auth.login({ username: 'teacher', password: 'test' }).subscribe({
      error: error => message = error.message,
    });
    http.expectOne('/api/auth/login').flush(
      { message: 'Service unavailable' },
      { status: 503, statusText: 'Service Unavailable' }
    );
    expect(message).toBe(AUTH_CONNECTION_MESSAGE);
  });
});
