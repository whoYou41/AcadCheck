import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';

export interface User {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  username: string;
  created_at: string;
  is_active: boolean;
  role: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface RegisterRequest {
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  username: string;
  password: string;
}

export interface AuthResponse {
  success: boolean;
  message: string;
  user?: User;
  token?: string;
}

export const AUTH_CONNECTION_MESSAGE =
  'No internet connection or AcadCheck server access. Check your network and make sure the server or localhost is running, then try again. You can continue in Offline Mode below.';

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private apiUrl = '/api';
  private http = inject(HttpClient);
  private readonly offlineKey = 'acadcheck.offlineMode';

  login(credentials: LoginRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/auth/login`, credentials)
      .pipe(
        tap(response => {
          if (!response.success) return;
          if (!response.user || !response.token) throw new Error('Sign-in did not return a valid session. Please sign in again.');
          localStorage.setItem('currentUser', JSON.stringify(response.user));
          localStorage.setItem('token', response.token);
          localStorage.removeItem(this.offlineKey);
        }),
        catchError(this.handleError)
      );
  }

  register(userData: RegisterRequest): Observable<AuthResponse> {
    return this.http.post<AuthResponse>(`${this.apiUrl}/auth/register`, userData)
      .pipe(
        catchError(this.handleError)
      );
  }

  logout(): void {
    // Clear any stored tokens/session data
    localStorage.removeItem('currentUser');
    localStorage.removeItem('token');
    localStorage.removeItem(this.offlineKey);
  }

  isLoggedIn(): boolean {
    return this.isOfflineMode() || !!localStorage.getItem('token');
  }

  enterOfflineMode(): User {
    const user: User = {
      id: -1,
      first_name: 'Offline',
      last_name: 'User',
      email: '',
      username: 'device',
      created_at: new Date().toISOString(),
      is_active: true,
      role: 'offline',
    };
    localStorage.removeItem('token');
    localStorage.setItem(this.offlineKey, 'true');
    localStorage.setItem('currentUser', JSON.stringify(user));
    return user;
  }

  isOfflineMode(): boolean {
    return localStorage.getItem(this.offlineKey) === 'true';
  }

  getCurrentUser(): User | null {
    try {
      const userJson = localStorage.getItem('currentUser');
      return userJson ? JSON.parse(userJson) : null;
    } catch {
      return null;
    }
  }

  isAdmin(): boolean {
    if (this.isOfflineMode()) return false;
    const user = this.getCurrentUser();
    if (user?.role) return user.role === 'admin';
    const token = localStorage.getItem('token');
    if (!token) return false;
    try {
      const payload = JSON.parse(atob(token.split('.')[1] || ''));
      return payload.role === 'admin';
    } catch {
      return false;
    }
  }

  getRoleFromToken(): string | null {
    if (this.isOfflineMode()) return 'offline';
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1] || ''));
      return payload.role || null;
    } catch {
      return null;
    }
  }

  private handleError(error: HttpErrorResponse | Error): Observable<never> {
    let errorMessage = 'An unknown error occurred';

    if (error instanceof HttpErrorResponse && [0, 404, 408, 502, 503, 504].includes(error.status)) {
      errorMessage = AUTH_CONNECTION_MESSAGE;
    } else if (error instanceof HttpErrorResponse && error.error instanceof ErrorEvent) {
      // Client-side error
      errorMessage = error.error.message;
    } else if (error instanceof HttpErrorResponse) {
      // Server-side error
      errorMessage = error.error?.message || error.message || `Server returned code: ${error.status}`;
    } else {
      errorMessage = error.message || errorMessage;
    }

    console.error('AuthService Error:', errorMessage);
    return throwError(() => new Error(errorMessage));
  }
}
