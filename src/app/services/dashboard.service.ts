import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpEventType } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { catchError, filter, map, tap } from 'rxjs/operators';

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

  readonly stats = signal<DashboardStats | null>(null);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);
  private currentUserId: number | null = null;

  private readonly eventSubject = new Subject<RealtimeEvent>();
  readonly events$ = this.eventSubject.asObservable();

  private eventSource: EventSource | null = null;
  private pollTimer: any = null;

  loadDashboardStats(): Observable<DashboardStats> {
    this.loading.set(true);
    this.error.set(null);
    this.currentUserId = this.getCurrentUserId();
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
    if (typeof window === 'undefined') {
      return;
    }

    this.currentUserId = this.getCurrentUserId();

    const token = localStorage.getItem('token');
    if (!token) {
      return;
    }

    if (this.eventSource) {
      this.eventSource.close();
    }

    const url = new URL(`${this.apiUrl.replace(/\/$/, '')}/events`);
    url.searchParams.set('token', token);

    this.eventSource = new EventSource(url.toString());

    this.eventSource.onmessage = (event: MessageEvent) => {
      try {
        const parsed: RealtimeEvent = JSON.parse(event.data);
        this.eventSubject.next(parsed);
        this.handleRealtimeEvent(parsed);
      } catch {
        // ignore malformed SSE payloads
      }
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.scheduleReconnect();
    };
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
      if (this.eventSource) {
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
