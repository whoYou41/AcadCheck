import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { OfflineDataService } from './offline-data.service';

export interface RecordRow {
  classroom_id: number;
  classroom_name: string;
  classroom_section: string;
  student_id: number;
  student_number: string;
  sequential_number: number;
  first_name: string;
  middle_name: string;
  last_name: string;
  gender: 'male' | 'female' | null;
  response_id: number | null;
  total_score: number | null;
  percentage: number | null;
  is_graded: boolean | null;
  graded_at: string | null;
  exam_title: string | null;
  subject: string | null;
}

@Injectable({
  providedIn: 'root'
})
export class RecordsService {
  private apiUrl = '/api';

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private offline: OfflineDataService
  ) {}

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  getRecords(params?: { classroom_id?: number; exam_id?: number }): Observable<RecordRow[]> {
    if (this.auth.isOfflineMode()) return of(this.offline.getRecords(params));
    let httpParams = new HttpParams();
    if (params?.classroom_id) httpParams = httpParams.set('classroom_id', params.classroom_id.toString());
    if (params?.exam_id) httpParams = httpParams.set('exam_id', params.exam_id.toString());

    return this.http.get<any>(`${this.apiUrl}/records`, {
      headers: this.getAuthHeaders(),
      params: httpParams
    }).pipe(
      map(response => {
        if (response.success && Array.isArray(response.records)) {
          return response.records.map((r: any) => ({
            classroom_id: r.classroom_id,
            classroom_name: r.classroom_name,
            classroom_section: r.classroom_section,
            student_id: r.student_id,
            student_number: r.student_number,
            sequential_number: r.sequential_number,
            first_name: r.first_name,
            middle_name: r.middle_name || '',
            last_name: r.last_name,
            gender: r.gender || null,
            response_id: r.response_id,
            total_score: r.total_score,
            percentage: r.percentage,
            is_graded: r.is_graded,
            graded_at: r.graded_at,
            exam_title: r.exam_title,
            subject: r.subject
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  updateScore(responseId: number, totalScore: number, percentage: number): Observable<any> {
    if (this.auth.isOfflineMode()) return of(this.offline.updateResponse(responseId, totalScore, percentage));
    return this.http.put<any>(`${this.apiUrl}/exam-responses/${responseId}`, { total_score: totalScore, percentage }, {
      headers: this.getAuthHeaders()
    }).pipe(catchError(this.handleError));
  }

  deleteResponse(responseId: number): Observable<any> {
    if (this.auth.isOfflineMode()) {
      this.offline.deleteResponse(responseId);
      return of({ success: true, message: 'Result deleted from this device' });
    }
    return this.http.delete<any>(`${this.apiUrl}/exam-responses/${responseId}`, {
      headers: this.getAuthHeaders()
    }).pipe(catchError(this.handleError));
  }

  deleteResponses(responseIds: number[]): Observable<{ success: boolean; deletedCount: number; message: string }> {
    if (this.auth.isOfflineMode()) {
      responseIds.forEach(id => this.offline.deleteResponse(id));
      return of({ success: true, deletedCount: responseIds.length, message: 'Results deleted from this device' });
    }
    return this.http.post<{ success: boolean; deletedCount: number; message: string }>(
      `${this.apiUrl}/exam-responses/bulk-delete`,
      { response_ids: responseIds },
      { headers: this.getAuthHeaders() }
    ).pipe(catchError(this.handleError));
  }

  deleteStudent(studentId: number): Observable<any> {
    if (this.auth.isOfflineMode()) {
      this.offline.deleteStudent(studentId);
      return of({ success: true, message: 'Student deleted from this device' });
    }
    return this.http.delete<any>(`${this.apiUrl}/students/${studentId}`, {
      headers: this.getAuthHeaders()
    }).pipe(catchError(this.handleError));
  }

  updateStudent(studentId: number, data: Partial<RecordRow>): Observable<any> {
    if (this.auth.isOfflineMode()) {
      const updates = {
        studentNumber: data.student_number,
        sequentialNumber: data.sequential_number,
        firstName: data.first_name,
        middleName: data.middle_name,
        lastName: data.last_name,
        gender: data.gender,
      };
      return of(this.offline.updateStudent(studentId, updates));
    }
    return this.http.put<any>(`${this.apiUrl}/students/${studentId}`, data, {
      headers: this.getAuthHeaders()
    }).pipe(catchError(this.handleError));
  }

  exportRecords(classroomId?: number): Observable<Blob> {
    if (this.auth.isOfflineMode()) return of(this.offline.exportRecordsCsv(classroomId));
    let httpParams = new HttpParams();
    if (classroomId) httpParams = httpParams.set('classroom_id', classroomId.toString());

    return this.http.get(`${this.apiUrl}/export/records/excel`, {
      headers: this.getAuthHeaders(),
      params: httpParams,
      responseType: 'blob'
    }).pipe(catchError(this.handleError));
  }

  private handleError(error: any): Observable<never> {
    console.error('RecordsService Error:', error);
    return throwError(() => error);
  }
}
