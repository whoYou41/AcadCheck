import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Observable, Subject, of } from 'rxjs';
import { catchError, filter, map, tap } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { OfflineDataService } from './offline-data.service';

export interface ScanStats {
  total_scans: number;
  completed_scans: number;
  processing_scans: number;
  pending_scans: number;
  failed_scans: number;
}

export interface StudentStats {
  total_students: number;
}

export interface ClassroomStats {
  total_classrooms: number;
}

export interface AnswerKeyStats {
  total_answer_keys: number;
}

export interface ExamStats {
  total_exam_responses: number;
  passed_count: number;
  failed_count: number;
  average_score: number;
}

export interface RecentActivity {
  id: number;
  scanned_test_id: number;
  action: string;
  description: string;
  performed_by: number;
  performedByName?: string;
  user_name?: string;
  created_at: string;
}

export interface RecentScan {
  id: number;
  filename: string;
  scan_status: string;
  created_at: string;
  exam_title?: string;
  subject?: string;
  student_name?: string;
}

export interface RecentResponse {
  id: number;
  total_score: number;
  percentage: number;
  created_at: string;
  student_name: string;
  exam_title: string;
  subject?: string;
}

export interface ClassroomPerformance {
  id: number;
  name: string;
  section: string;
  student_count: number;
  avg_score: number;
  passed_count: number;
  failed_count: number;
}

export interface QuestionerRankingItem {
  questionNumber: number;
  totalResponses: number;
  correctCount: number;
  accuracyRate: number;
}

export interface DashboardStats {
  scans: ScanStats;
  students: StudentStats;
  classrooms: ClassroomStats;
  answerKeys: AnswerKeyStats;
  exams: ExamStats;
  recentActivity: RecentActivity[];
  recentScans: RecentScan[];
  recentResponses: RecentResponse[];
  classroomPerformance: ClassroomPerformance[];
  questionerRanking: QuestionerRankingItem[];
}

export type RealtimeEvent =
  | { type: 'connected'; clientId: number }
  | { type: 'scan_event'; data: any; timestamp: string }
  | { type: 'activity_event'; data: any; timestamp: string };

export type DashboardSignal = {
  stats: DashboardStats | null;
  loading: boolean;
  error: string | null;
  events: RealtimeEvent[];
};

@Injectable({
  providedIn: 'root'
})
export class DashboardService {
  private apiUrl = '/api';
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private offline = inject(OfflineDataService);

  readonly stats = signal<DashboardStats | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  private currentUserId: number | null = null;

  private readonly eventSubject = new Subject<RealtimeEvent>();
  readonly events$ = this.eventSubject.asObservable();

  private eventSource: EventSource | null = null;
  private pollTimer: any = null;
  private realtimeConnecting = false;
  private realtimeGeneration = 0;

  loadDashboardStats(): Observable<DashboardStats> {
    this.loading.set(true);
    this.error.set(null);
    this.currentUserId = this.getCurrentUserId();
    if (this.auth.isOfflineMode()) {
      const stats = this.offline.getDashboardStats() as DashboardStats;
      this.stats.set(stats);
      this.loading.set(false);
      return of(stats);
    }
    return this.http
      .get<{ success: boolean; stats?: DashboardStats; message?: string }>(`${this.apiUrl}/dashboard/stats`, {
        headers: this.getAuthHeaders()
      })
      .pipe(
        map(response => {
          if (!response.success) {
            throw new Error(response.message || 'Failed to load dashboard stats');
          }
          return response.stats as DashboardStats;
        }),
        tap(stats => {
          this.stats.set(stats);
          this.loading.set(false);
        }),
        catchError(err => {
          this.error.set(err.message ?? 'Failed to load dashboard stats');
          this.loading.set(false);
          throw err;
        })
      );
  }

  connectRealtime(): void {
    if (this.auth.isOfflineMode()) return;
    if (typeof window === 'undefined') {
      return;
    }

    this.currentUserId = this.getCurrentUserId();

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.realtimeConnecting) return;
    const generation = ++this.realtimeGeneration;
    this.realtimeConnecting = true;

    // Native EventSource cannot set an Authorization header. Exchange the JWT
    // once over an authenticated POST for a short-lived, one-use ticket so the
    // long-lived URL never contains the account bearer token.
    this.http.post<{ success: boolean; ticket?: string }>(
      `${this.apiUrl.replace(/\/$/, '')}/events/ticket`,
      {},
      { headers: this.getAuthHeaders() }
    ).subscribe({
      next: response => {
        if (generation !== this.realtimeGeneration) return;
        this.realtimeConnecting = false;
        if (!response.success || !response.ticket) {
          this.scheduleReconnect();
          return;
        }
        const url = new URL(`${this.apiUrl.replace(/\/$/, '')}/events`, window.location.origin);
        url.searchParams.set('ticket', response.ticket);
        const source = new EventSource(url.toString());
        this.eventSource = source;

        source.onmessage = (event: MessageEvent) => {
          try {
            const parsed: RealtimeEvent = JSON.parse(event.data);
            this.eventSubject.next(parsed);
            this.handleRealtimeEvent(parsed);
          } catch {
            // ignore malformed SSE payloads
          }
        };

        source.onerror = () => {
          if (this.eventSource === source) {
            source.close();
            this.eventSource = null;
          }
          if (generation === this.realtimeGeneration) this.scheduleReconnect();
        };
      },
      error: () => {
        if (generation !== this.realtimeGeneration) return;
        this.realtimeConnecting = false;
        this.scheduleReconnect();
      }
    });
  }

  private handleRealtimeEvent(event: RealtimeEvent): void {
    const current = this.stats();
    if (!current) {
      return;
    }

    if ((event.type === 'scan_event' || event.type === 'activity_event') && event.data?.user_id && this.currentUserId && event.data.user_id !== this.currentUserId) {
      return;
    }

    if (event.type === 'scan_event') {
      const scan = event.data?.scan;
      if (scan) {
        const scanIndex = current.recentScans.findIndex(item => item.id === scan.id);
        const nextRecentScans = [...current.recentScans];
        if (scanIndex === -1) {
          nextRecentScans.unshift({
            id: scan.id,
            filename: scan.filename,
            scan_status: scan.scan_status,
            created_at: scan.created_at,
            exam_title: scan.exam_title,
            subject: scan.subject,
            student_name:
              scan.student_full_name ??
              (scan.student_name_detected && scan.student_name_detected !== 'Unknown'
                ? scan.student_name_detected
                : undefined)
          });
          if (nextRecentScans.length > 20) {
            nextRecentScans.length = 20;
          }
        } else {
          nextRecentScans[scanIndex] = {
            ...nextRecentScans[scanIndex],
            ...scan
          } as RecentScan;
        }

        const scanStats = {
          total_scans: current.scans.total_scans + (scanIndex === -1 ? 1 : 0),
          completed_scans: current.scans.completed_scans + (scan.scan_status === 'completed' && scanIndex === -1 ? 1 : 0),
          processing_scans: current.scans.processing_scans + (scan.scan_status === 'processing' ? 1 : 0),
          pending_scans: current.scans.pending_scans - (scan.scan_status === 'pending' && scanIndex === -1 ? 1 : 0),
          failed_scans: current.scans.failed_scans + (scan.scan_status === 'failed' ? 1 : 0)
        } satisfies DashboardStats['scans'];

        this.stats.set({
          ...current,
          scans: scanStats,
          recentScans: nextRecentScans
        });
      }
    }

    if (event.type === 'activity_event') {
      const data = event.data;
      const nextRecentActivity: RecentActivity[] = [
        {
          id: data.id,
          scanned_test_id: data.scanned_test_id,
          action: data.action,
          description: data.description,
          performed_by: data.performed_by,
          performedByName: data.performedByName ?? data.user_name,
          created_at: data.created_at
        },
        ...(current.recentActivity ?? []).slice(0, 19)
      ];

      this.stats.set({
        ...current,
        recentActivity: nextRecentActivity
      });
    }
  }

  disconnectRealtime(): void {
    this.realtimeGeneration++;
    this.realtimeConnecting = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
  }

  private scheduleReconnect(): void {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.connectRealtime();
      if (this.eventSource || this.realtimeConnecting) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
    }, 5000);
  }

  private getCurrentUserId(): number | null {
    const token = localStorage.getItem('token');
    if (!token) return null;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.userId ?? null;
    } catch {
      return null;
    }
  }

  private getAuthHeaders(): { [header: string]: string | string[] } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
