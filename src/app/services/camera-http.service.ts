import { Inject, Injectable, InjectionToken } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { Observable, defer, of, throwError } from 'rxjs';
import { catchError, finalize, map, shareReplay, switchMap, tap, timeout } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { environment } from '../../environments/environment';

interface CameraNativeTransport {
  request(options: Parameters<typeof CapacitorHttp.request>[0] & { requestId?: string }): ReturnType<typeof CapacitorHttp.request>;
  cancel?(options: { requestId: string }): Promise<void>;
  setActive?(options: { active: boolean }): Promise<void>;
}
const localCamera = registerPlugin<CameraNativeTransport>('LocalCamera');
export const CAMERA_NATIVE_HTTP = new InjectionToken<CameraNativeTransport>(
  'Camera native HTTP', { providedIn: 'root', factory: () => localCamera }
);

export function normalizedDirectPiUrl(value: string | null | undefined): string | null {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase();
    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    const privateIpv4 = !!ipv4 && ipv4.slice(1).map(Number).every(part => part >= 0 && part <= 255) && (
      Number(ipv4[1]) === 10
      || (Number(ipv4[1]) === 172 && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31)
      || (Number(ipv4[1]) === 192 && Number(ipv4[2]) === 168)
      || (Number(ipv4[1]) === 169 && Number(ipv4[2]) === 254)
    );
    const localName = hostname === 'acadacam' || hostname === 'acadcam' || hostname.endsWith('.local');
    if (!privateIpv4 && !localName) return null;
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    if (!parsed.port) parsed.port = '5000';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

interface CameraRequestOptions {
  headers?: Record<string, string>;
  responseType?: 'json' | 'blob';
}

/** Shared by discovery, preview, capture, health checks, and camera restart. */
@Injectable({ providedIn: 'root' })
export class CameraHttpService {
  private readonly proxyBase = `${String(environment.apiUrl || '/api').replace(/\/$/, '')}/camera`;
  private sessionExpiresAt = 0;
  private sessionVersion = 0;
  private sessionRequest$: Observable<void> | null = null;
  private requestSequence = 0;

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    @Inject(CAMERA_NATIVE_HTTP) private native: CameraNativeTransport
  ) {}

  setCameraActive(active: boolean): void {
    if (Capacitor.isNativePlatform()) {
      void this.native.setActive?.({ active }).catch(error => console.warn('Camera display state:', error));
    }
  }

  get(url: string, options: CameraRequestOptions & { responseType: 'blob' }): Observable<Blob>;
  get<T = any>(url: string, options?: CameraRequestOptions): Observable<T>;
  get(url: string, options: CameraRequestOptions = {}): Observable<any> {
    return this.request('GET', url, undefined, options);
  }

  post<T = any>(url: string, body: unknown, options: CameraRequestOptions = {}): Observable<T> {
    return this.request('POST', url, body, options);
  }

  private isProxyUrl(url: string): boolean {
    const target = new URL(url, window.location.origin);
    const proxy = new URL(this.proxyBase, window.location.origin);
    return target.origin === proxy.origin
      && (target.pathname === proxy.pathname || target.pathname.startsWith(`${proxy.pathname}/`));
  }

  private ensureSession(): Observable<void> {
    if (Date.now() < this.sessionExpiresAt) return of(undefined);
    if (!this.sessionRequest$) {
      this.sessionRequest$ = this.http.post<{ success: boolean }>(
        `${this.proxyBase}/offline-session`, {}, { withCredentials: true }
      ).pipe(
        timeout(7000),
        tap(result => {
          if (!result?.success) throw new Error('The local camera session could not be established.');
          // Renew well inside the server's eight-hour cookie lifetime.
          this.sessionExpiresAt = Date.now() + 5 * 60 * 1000;
          this.sessionVersion++;
        }),
        map(() => undefined),
        finalize(() => { this.sessionRequest$ = null; }),
        shareReplay({ bufferSize: 1, refCount: false })
      );
    }
    return this.sessionRequest$;
  }

  private request(method: string, url: string, body: unknown, options: CameraRequestOptions): Observable<any> {
    return defer(() => {
      const proxy = this.isProxyUrl(url);
      const offline = this.auth.isOfflineMode();
      if (Capacitor.isNativePlatform() && offline) {
        if (proxy || !normalizedDirectPiUrl(url)) {
          return throwError(() => new Error('Enter the Raspberry Pi local address to connect from the Android app.'));
        }
        // The plugin selects Wi-Fi per request, without changing internet traffic
        // for the rest of the app. Unsubscription cancels the native connection.
        const readTimeout = options.responseType === 'blob' ? 12000 : 3000;
        return new Observable<Awaited<ReturnType<typeof CapacitorHttp.request>>>(subscriber => {
          const requestId = `camera-${Date.now()}-${++this.requestSequence}`;
          let settled = false;
          this.native.request({
            requestId, method, url, data: body, headers: {}, responseType: options.responseType || 'json',
            connectTimeout: options.responseType === 'blob' ? 4000 : 2000,
            readTimeout, disableRedirects: true,
          }).then(response => {
            settled = true;
            subscriber.next(response);
            subscriber.complete();
          }, error => { settled = true; subscriber.error(error); });
          return () => {
            if (!settled) void this.native.cancel?.({ requestId }).catch(() => undefined);
          };
        }).pipe(map(response => {
          if (response.status < 200 || response.status >= 300) {
            throw new HttpErrorResponse({ status: response.status, error: response.data, url });
          }
          if (options.responseType !== 'blob') return response.data;
          const contentType = Object.entries(response.headers || {})
            .find(([key]) => key.toLowerCase() === 'content-type')?.[1] || 'image/jpeg';
          const binary = atob(String(response.data));
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
          return new Blob([bytes], { type: contentType });
        }));
      }

      const token = !offline && proxy ? localStorage.getItem('token') : null;
      const headers = proxy && !offline
        ? { ...options.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }
        : {};
      const send = () => this.http.request(method, url, {
        body, headers, withCredentials: proxy,
        responseType: options.responseType || 'json',
      });
      if (!offline || !proxy) return send();
      // Starting the camera must work even if discovery has not completed.
      return this.ensureSession().pipe(switchMap(() => {
        const requestVersion = this.sessionVersion;
        return send().pipe(catchError(error => {
          if (![401, 403].includes(error?.status)) return throwError(() => error);
          // Concurrent failed capture/status calls share one renewal. A second
          // rejection is returned to the UI, never retried indefinitely.
          if (requestVersion === this.sessionVersion) this.sessionExpiresAt = 0;
          return this.ensureSession().pipe(switchMap(() => send()));
        }));
      }));
    });
  }
}
