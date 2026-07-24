import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface ExamResponse {
  id: number;
  studentId: number;
  studentNumberScanned: string;
  studentName?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  answersJson: { [key: number]: string };
  scorePerQuestion: { [key: number]: number };
  totalScore: number;
  percentage: number;
  isGraded: boolean;
  gradedBy: number;
  gradedAt: string;
  examUploadId: number;
  createdAt: string;
  examTitle?: string;
  subject?: string;
}

export interface ActivityLog {
  id: number;
  examUploadId?: number;
  action: string;
  description: string;
  performedBy: number;
  performedByName?: string;
  createdAt: string;
}

export interface QuestionPerformance {
  questionNumber: number;
  attempts: number;
  correct: number;
  wrong: number;
  correctRate: number;
  wrongRate: number;
}

export interface QuestionAnalytics {
  overview: {
    totalResponses: number;
    overallCorrectRate: number;
    questionsAnalyzed: number;
  };
  mostCorrect: QuestionPerformance | null;
  mostWrong: QuestionPerformance | null;
  difficultQuestions: QuestionPerformance[];
  recommendations: string[];
  questionStats: QuestionPerformance[];
}

@Injectable({
  providedIn: 'root'
})
export class ExamScanService {
  private apiUrl = '/api';

  constructor(private http: HttpClient) { }

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  getExamResponses(params?: {
    student_id?: number;
    classroom_id?: number;
    limit?: number;
  }): Observable<ExamResponse[]> {
    let httpParams = new HttpParams();
    if (params?.student_id) httpParams = httpParams.set('student_id', params.student_id.toString());
    if (params?.classroom_id) httpParams = httpParams.set('classroom_id', params.classroom_id.toString());
    if (params?.limit) httpParams = httpParams.set('limit', params.limit.toString());

    return this.http.get<any>(`${this.apiUrl}/exam-responses`, {
      headers: this.getAuthHeaders(),
      params: httpParams
    }).pipe(
      map(response => {
        if (response.success && Array.isArray(response.responses)) {
          return response.responses.map((r: any) => {
            const fallbackName = r.student_name_detected || r.student_number_detected || '';
            return {
              id: r.id,
              studentId: r.student_id,
              studentNumberScanned: r.student_number_detected || r.student_number || '',
              firstName: r.first_name || fallbackName,
              middleName: r.middle_name,
              lastName: r.last_name,
              answersJson: JSON.parse(r.answers_json || '{}'),
              scorePerQuestion: JSON.parse(r.score_per_question_json || '{}'),
              totalScore: r.total_score,
              percentage: r.percentage,
              isGraded: r.is_graded,
              gradedBy: r.graded_by,
              gradedAt: r.graded_at,
              examUploadId: r.scanned_test_id,
              createdAt: r.created_at,
              examTitle: r.exam_title,
              subject: r.subject
            };
          });
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  getExamResponse(id: number): Observable<ExamResponse | null> {
    return this.http.get<any>(`${this.apiUrl}/exam-responses/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.response) {
          const r = response.response;
          return {
            id: r.id,
            studentId: r.student_id,
            studentNumberScanned: r.student_number,
            firstName: r.first_name,
            middleName: r.middle_name,
            lastName: r.last_name,
            answersJson: r.answers, // already parsed by backend
            scorePerQuestion: r.scorePerQuestion,
            totalScore: r.total_score,
            percentage: r.percentage,
            isGraded: r.is_graded,
            gradedBy: r.graded_by,
            gradedAt: r.graded_at,
            examUploadId: r.scanned_test_id,
            createdAt: r.created_at,
            examTitle: r.exam_title,
            subject: r.subject
          };
        }
        return null;
      }),
      catchError(this.handleError)
    );
  }

  getStudentResults(studentId: number): Observable<ExamResponse[]> {
    return this.getExamResponses({ student_id: studentId });
  }

  getExamResultsByClassroom(classroomId: number): Observable<ExamResponse[]> {
    return this.getExamResponses({ classroom_id: classroomId });
  }

  getRecentActivity(limit: number = 10): Observable<ActivityLog[]> {
    let httpParams = new HttpParams();
    httpParams = httpParams.set('limit', limit.toString());

    return this.http.get<any>(`${this.apiUrl}/activity-logs`, {
      headers: this.getAuthHeaders(),
      params: httpParams
    }).pipe(
      map(response => {
        if (response.success && Array.isArray(response.logs)) {
          return response.logs.map((l: any) => ({
            id: l.id,
            examUploadId: l.scanned_test_id,
            action: l.action,
            description: l.description,
            performedBy: l.performed_by,
            performedByName: l.user_first ? `${l.user_first} ${l.user_last}` : 'System',
            createdAt: l.created_at
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  getQuestionAnalytics(params?: { exam_title?: string; classroom_name?: string }): Observable<QuestionAnalytics> {
    let httpParams = new HttpParams();
    if (params?.exam_title && params.exam_title !== 'All Exams') {
      httpParams = httpParams.set('exam_title', params.exam_title);
    }
    if (params?.classroom_name && params.classroom_name !== 'All Classrooms') {
      httpParams = httpParams.set('classroom_name', params.classroom_name);
    }
    return this.http.get<any>(`${this.apiUrl}/analytics/questions`, {
      headers: this.getAuthHeaders(),
      params: httpParams
    }).pipe(
      map(response => ({
        overview: response.overview,
        mostCorrect: response.mostCorrect,
        mostWrong: response.mostWrong,
        difficultQuestions: response.difficultQuestions || [],
        recommendations: response.recommendations || [],
        questionStats: response.questionStats || []
      })),
      catchError(this.handleError)
    );
  }

  private handleError(error: any): Observable<never> {
    console.error('ExamScanService Error:', error);
    return throwError(() => error);
  }
}
