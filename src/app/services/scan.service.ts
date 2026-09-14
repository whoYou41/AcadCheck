import { Injectable } from '@angular/core';
import { HttpClient, HttpEvent, HttpEventType } from '@angular/common/http';
import { Observable, Subject, of, throwError, timeout, TimeoutError } from 'rxjs';
import { catchError, filter, map, tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { AuthService } from './auth.service';
import { CameraHttpService } from './camera-http.service';
import { OfflineDataService } from './offline-data.service';

function extractBackendMessage(error: any): string {
  const err = error || {};
  const body = err.error || err.body || err.response || {};
  if (typeof body.message === 'string' && body.message.trim().length > 0) {
    return body.message;
  }
  if (typeof body === 'string' && body.trim().length > 0) {
    return body;
  }
  if (typeof err.message === 'string' && err.message.trim().length > 0) {
    return err.message;
  }
  if (typeof err.statusText === 'string' && err.statusText.trim().length > 0) {
    return err.statusText;
  }
  if (typeof err.error === 'string' && err.error.trim().length > 0) {
    return err.error;
  }
  return 'Detection failed';
}

export interface Scan {
  id: number;
  filename: string;
  file_path: string;
  file_size: number;
  mime_type: string;
  classroom_id: number | null;
  answer_key_id: number | null;
  student_id: number | null;
  student_number_detected: string;
  student_name_detected: string;
  sequential_number_detected: number | null;
  answer_key_date_detected: string | null;
  student_name?: string;
  student_full_name?: string;
  ocr_confidence: number;
  scan_status: 'pending' | 'processing' | 'completed' | 'failed';
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
  exam_title?: string;
  subject?: string;
  answer_key_date?: string;
  omrResults?: OMRResult[];
  examResponse?: ExamResponse;
  omrAnalysis?: OmrStructuredSignals;
}

export interface OMRResult {
  id: number;
  scanned_test_id: number;
  question_number: number;
  detected_answer: string;
  correct_answer: string;
  is_correct: boolean;
  confidence: number;
  bubble_region_json: string;
  raw_pixel_intensity: number;
  marked_letters?: string[];
}

export interface ExamResponse {
  id: number;
  student_id: number;
  scanned_test_id: number;
  answer_key_id: number;
  answers_json: string;
  score_per_question_json: string;
  total_score: number;
  percentage: number;
  is_graded: boolean;
}

export interface ScanUploadResponse {
  success: boolean;
  message: string;
  scanId: number;
  scan: Partial<Scan>;
}

export interface OmrStructuredSignals {
  sheetPresence?: 'present' | 'absent' | 'unknown' | string;
  answerContentDetected?: boolean | null;
  presenceConfidence?: number;
  registrationConfidence?: number;
  requiredRegistrationConfidence?: number;
  templateAlignmentError?: number;
  bubbleLocalizationConfidence?: number;
  registrationAttempts?: Array<Record<string, unknown>>;
  registrationMetrics?: Record<string, unknown>;
}

export interface ScanProcessResponse extends OmrStructuredSignals {
  success: boolean;
  message: string;
  committed?: boolean;
  retrySafe?: boolean;
  fastPath?: boolean;
  processingTimings?: Record<string, number>;
  failure?: OmrStructuredSignals & {
    stage: string;
    reason: string;
    recommendation: string;
    diagnosticPath?: string | null;
    diagnosticArtifacts?: string[];
    stageTrace?: Array<{
      stage: string;
      status: string;
      reason?: string;
    }>;
    metrics?: Record<string, unknown>;
  };
  quality?: Record<string, unknown>;
  scan: {
    id: number;
    status: string;
    studentId: number | null;
    studentNumber: string;
    studentName: string;
    grading: {
      results: Array<{
        questionNumber: number;
        detectedAnswer: string;
        correctAnswer: string;
        isCorrect: boolean;
        score: number;
      }>;
      totalScore: number;
      totalQuestions: number;
      percentage: number;
    } | null;
  };
}

export interface DetectFrameRequest {
  imageBuffer: string;
  answerKeyId: number;
  /** Stable for one live camera session so the backend can track the sheet. */
  trackingSessionId?: string;
  /** Monotonically increasing identifier for a frame within that session. */
  frameId?: string;
  /** Live preview skips OCR metadata that is not needed to accept a sheet. */
  previewOnly?: boolean;
}

export interface CameraDiscoveryResponse {
  success: boolean;
  message: string;
  hostname: string;
  ipAddress: string;
  port: number;
  cameraUrl: string;
  cameraInitialized?: boolean;
  frameAvailable?: boolean;
}

export interface DetectFrameResponse extends OmrStructuredSignals {
  success: boolean;
  message?: string;
  detectedAnswers: string[];
  confidenceScores: number[];
  markedLetters?: string[][];
  averageConfidence: number;
  answerKeyId?: number;
  classroomId?: number;
  sequence?: string | null;
  sequenceConfidence?: number;
  /** Single-use token for persisting this exact accepted frame without rerunning OMR. */
  detectionToken?: string | null;
  detectionExpiresInMs?: number;
  processingTimings?: Record<string, number>;
  details: any;
  qualityGate?: {
    recommendation: 'accept' | 'watch' | 'reject';
    confidence: number;
    filledCount: number;
    totalCount: number;
    fillRatio: number;
    reason: string;
  };
}

export interface DetectSequenceResponse {
  success: boolean;
  message?: string;
  sequence: string | null;
  confidence: number;
  rawText: string;
  cropRegion: any;
}

export interface DetectExamSheetResponse {
  success: boolean;
  isExamSheet: boolean;
  confidence: number;
  placement?: { acceptable?: boolean; confidence?: number; reason?: string };
  recommendation: 'accept' | 'watch' | 'reject';
  reason: string;
  rectified: boolean;
  cornersDetected: boolean;
  ocrText: string;
  imageInfo: { width: number; height: number; aspectRatio: number };
}

export interface ReadTextResponse {
  success: boolean;
  text: string;
  documentType: 'general_text' | 'exam_document' | 'student_document' | 'financial_document' | string;
  fields: Record<string, string>;
  entities: {
    names: string[];
    studentIds: string[];
    dates: string[];
    emails: string[];
    phones: string[];
  };
  lineCount: number;
  wordCount: number;
  engine: string;
  language: string;
  requiresTraining: false;
  image: { width: number; height: number };
}

@Injectable({
  providedIn: 'root'
})
export class ScanService {
  private apiBase = environment.apiUrl || '/api';
  private uploadProgress$ = new Subject<number>();

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private offline: OfflineDataService,
    private cameraHttp: CameraHttpService
  ) {}

  resolveBackendAssetUrl(resourcePath: string): string {
    if (!resourcePath) return '';
    if (/^https?:\/\//i.test(resourcePath)) return resourcePath;
    try {
      const apiUrl = new URL(this.apiBase, window.location.origin);
      return new URL(resourcePath, apiUrl.origin).toString();
    } catch {
      return resourcePath;
    }
  }

  getUploadProgress(): Observable<number> {
    return this.uploadProgress$.asObservable();
  }

  private getAuthHeaders(): { [header: string]: string | string[] } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  uploadScan(file: File, classroomId?: number, answerKeyId?: number, studentId?: number, sequentialNumber?: number, answerKeyDate?: string): Observable<ScanUploadResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('Offline scans use the on-device answer grid below the captured image.'));
    }
    const formData = new FormData();
    formData.append('scanImage', file);
    if (classroomId) formData.append('classroom_id', classroomId.toString());
    if (answerKeyId) formData.append('answer_key_id', answerKeyId.toString());
    if (studentId) formData.append('student_id', studentId.toString());
    if (sequentialNumber) formData.append('sequential_number', sequentialNumber.toString());
    if (answerKeyDate) formData.append('answer_key_date', answerKeyDate);

    return this.http.post<any>(`${this.apiBase}/scans/upload`, formData, {
      headers: this.getAuthHeaders(),
      reportProgress: true,
      observe: 'events'
    }).pipe(
      tap(event => {
        if (event.type === HttpEventType.UploadProgress && event.total) {
          const percent = Math.round(100 * event.loaded / event.total);
          this.uploadProgress$.next(percent);
        } else if (event.type === HttpEventType.Response) {
          this.uploadProgress$.next(100);
          setTimeout(() => this.uploadProgress$.next(0), 300);
        }
      }),
      filter(ev => ev.type === HttpEventType.Response),
      map((event: any) => event.body as ScanUploadResponse),
      catchError((error) => {
        this.uploadProgress$.next(0);
        return throwError(() => error);
      })
    );
  }

   processScan(scanId: number, liveCapture = false): Observable<ScanProcessResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('Use the on-device scanner in Offline Mode.'));
    }
    return this.http.post<ScanProcessResponse>(
      `${this.apiBase}/scans/${scanId}/process`,
      { liveCapture },
      {
        headers: this.getAuthHeaders()
      }
    ).pipe(
      timeout(180000),
      catchError((error) => {
        console.error('Process scan error:', error);
        if (error instanceof TimeoutError) {
          return throwError(() => new Error('Processing timed out. The scan is taking too long. Please try again.'));
        }
        throw error;
      })
    );
  }

  getScan(scanId: number): Observable<{ success: boolean; scan: Scan }> {
    if (this.auth.isOfflineMode()) {
      const scan = this.offline.getScan(scanId);
      return scan
        ? of({ success: true, scan })
        : throwError(() => new Error('Offline scan not found'));
    }
    return this.http.get<{ success: boolean; scan: Scan }>(`${this.apiBase}/scans/${scanId}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Get scan error:', error);
        throw error;
      })
    );
  }

  getScans(filter?: { classroom_id?: number; status?: string; limit?: number; offset?: number }): Observable<{ success: boolean; scans: Scan[]; total: number }> {
    if (this.auth.isOfflineMode()) {
      const scans = this.offline.getScans(filter);
      return of({ success: true, scans, total: scans.length });
    }
    let params: string[] = [];
    if (filter?.classroom_id) params.push(`classroom_id=${filter.classroom_id}`);
    if (filter?.status) params.push(`status=${filter.status}`);
    if (filter?.limit) params.push(`limit=${filter.limit}`);
    if (filter?.offset) params.push(`offset=${filter.offset}`);
    const queryString = params.length > 0 ? '?' + params.join('&') : '';

    return this.http.get<{ success: boolean; scans: Scan[]; total: number }>(`${this.apiBase}/scans${queryString}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Get scans error:', error);
        throw error;
      })
    );
  }

  detectFrame(request: DetectFrameRequest): Observable<DetectFrameResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('Capture a photo and use the on-device scanner in Offline Mode.'));
    }
    return this.http.post<DetectFrameResponse>(`${this.apiBase}/omr/detect-frame`, request, {
      headers: this.getAuthHeaders()
    }).pipe(
      // A lost connection must not leave ScannerPage.autoDetectionInFlight
      // latched forever. The backend worker has its own shorter processing
      // deadline; this outer bound also covers stalled network responses.
      // Keep this above OMR_FAST_TIMEOUT_MS so the API can return a definite
      // fail-closed worker response before the browser abandons the request.
      timeout(12000),
      catchError((error) => {
        console.error('Detect frame error:', error);
        const msg = extractBackendMessage(error);
        const wrapped: any = new Error(msg);
        wrapped.status = error?.status;
        wrapped.error = error?.error;
        return throwError(() => wrapped);
      })
    );
  }

  finalizeDetection(detectionToken: string, studentId?: number, classroomId?: number): Observable<ScanProcessResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('There is no online detection to finalize in Offline Mode.'));
    }
    return this.http.post<ScanProcessResponse>(
      `${this.apiBase}/omr/finalize-detection`,
      { detectionToken, studentId, classroomId },
      { headers: this.getAuthHeaders() }
    ).pipe(
      timeout(15000),
      catchError(error => {
        console.error('Finalize live detection error:', error);
        const wrapped: any = new Error(extractBackendMessage(error));
        wrapped.status = error?.status;
        wrapped.error = error?.error;
        return throwError(() => wrapped);
      })
    );
  }

  getDiagnosticResource(resourcePath: string): Observable<Blob> {
    let resourceUrl: URL;
    let backendUrl: URL;
    try {
      backendUrl = new URL(this.apiBase, window.location.origin);
      resourceUrl = new URL(resourcePath, backendUrl.origin);
    } catch {
      return throwError(() => new Error('The diagnostic link is invalid.'));
    }
    const allowedPath = /^\/api\/omr\/diagnostics\/[a-f0-9]{32}(?:\/artifacts\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.png)?$/i;
    if (
      resourceUrl.origin !== backendUrl.origin
      || resourceUrl.search.length > 0
      || resourceUrl.hash.length > 0
      || !allowedPath.test(resourceUrl.pathname)
    ) {
      return throwError(() => new Error('The diagnostic link is not a protected AcadCheck resource.'));
    }
    return this.http.get(resourceUrl.toString(), {
      headers: this.getAuthHeaders(),
      responseType: 'blob'
    }).pipe(
      catchError(error => {
        console.error('Diagnostic resource error:', error);
        const status = Number(error?.status || 0);
        const message = status === 410
          ? 'This diagnostic session has expired.'
          : status === 404
            ? 'These diagnostics are unavailable or belong to another account.'
            : 'Could not open the protected diagnostics.';
        return throwError(() => new Error(message));
      })
    );
  }

  detectSequence(imageBuffer: string, options?: { bottomRegionHeight?: number; cropLeft?: number; cropWidth?: number; cropRight?: number }): Observable<DetectSequenceResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('Sequence OCR is unavailable offline. Select the student manually.'));
    }
    return this.http.post<DetectSequenceResponse>(`${this.apiBase}/omr/detect-sequence`, { imageBuffer, ...options }, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Detect sequence error:', error);
        throw error;
      })
    );
  }

  detectExamSheet(imageBuffer: string, fast = false): Observable<DetectExamSheetResponse> {
    if (this.auth.isOfflineMode()) {
      return throwError(() => new Error('Exam-sheet OCR is unavailable offline.'));
    }
    return this.http.post<DetectExamSheetResponse>(`${this.apiBase}/omr/detect-exam-sheet`, { imageBuffer, fast }, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Detect exam sheet error:', error);
        throw error;
      })
    );
  }

  readText(imageBuffer: string, singleBlock = false): Observable<ReadTextResponse> {
    if (this.auth.isOfflineMode()) return throwError(() => new Error('OCR is unavailable offline.'));
    return this.http.post<ReadTextResponse>(`${this.apiBase}/ocr/read-text`, { imageBuffer, singleBlock }, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError(error => throwError(() => new Error(extractBackendMessage(error))))
    );
  }

  printScoreOnExamSheet(scanId: number, directPrint = false): Observable<any> {
    if (this.auth.isOfflineMode()) return of({ success: false, message: 'Direct printing requires the desktop backend.' });
    return this.http.post<any>(`${this.apiBase}/scans/${scanId}/print-score`, { directPrint }, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Print score error:', error);
        throw error;
      })
    );
  }

  discoverAcadcam(): Observable<CameraDiscoveryResponse> {
    return this.cameraHttp.get<CameraDiscoveryResponse>(`${this.apiBase}/camera/discover`).pipe(
      catchError((error) => {
        console.error('Camera discovery error:', error);
        throw error;
      })
    );
  }

  deleteScan(scanId: number): Observable<{ success: boolean; message: string }> {
    if (this.auth.isOfflineMode()) {
      this.offline.deleteScan(scanId);
      return of({ success: true, message: 'Offline scan deleted from this device' });
    }
    return this.http.delete<{ success: boolean; message: string }>(`${this.apiBase}/scans/${scanId}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError((error) => {
        console.error('Delete scan error:', error);
        throw error;
      })
    );
  }

  saveOfflineManualGrade(input: {
    filename: string;
    classroomId: number;
    answerKeyId: number;
    studentId: number;
    answers: string[];
    confidences?: number[];
    markedLetters?: string[][];
    verifiedOmr?: boolean;
    fingerprint?: string;
    processingMs?: number;
    overallConfidence?: number;
    anchorMethod?: string;
    qrData?: string;
  }): Observable<ScanProcessResponse> {
    if (!this.auth.isOfflineMode()) {
      return throwError(() => new Error('On-device grading is available only in Offline Mode.'));
    }
    try {
      const stored = this.offline.saveManualGrade(input);
      return of({
        success: true,
        message: 'Grade saved on this device',
        fastPath: true,
        scan: {
          id: stored.id,
          status: 'completed',
          studentId: stored.student_id,
          studentNumber: stored.student_number_detected,
          studentName: stored.student_name_detected,
          grading: {
            results: (stored.omrResults || []).map((row: any) => ({
              questionNumber: row.question_number,
              detectedAnswer: row.detected_answer,
              correctAnswer: row.correct_answer,
              isCorrect: row.is_correct,
              score: row.is_correct ? 1 : 0,
            })),
            totalScore: stored.examResponse.total_score,
            totalQuestions: (stored.omrResults || []).length,
            percentage: stored.examResponse.percentage,
          },
        },
      });
    } catch (error: any) {
      return throwError(() => new Error(error?.message || 'Could not save offline grade'));
    }
  }
}
