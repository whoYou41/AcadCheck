import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { OfflineDataService } from './offline-data.service';

export interface AnswerKey {
  id: number;
  subject: string;
  examTitle: string;
  numQuestions: number;
  answerKey: string;
  answerKeyDate: string;
  date: string;
  totalUsed: number;
  createdAt?: string;
  createdByName?: string;
  isActive?: boolean;
  createdBy?: number;
  classroomId?: number | null;
  classroomName?: string;
  printStatus?: 'pending' | 'printed';
}

export interface QuestionAnswer {
  questionNumber: number;
  choices: string[];
  correctAnswer: string;
}

export interface AnswerKeyCreate {
  subject: string;
  exam_title: string;
  num_questions: number;
  answer_key_json: string;
  answer_key_date?: string;
  classroom_id?: number;
}

export interface AnswerKeyUpdate {
  subject?: string;
  exam_title?: string;
  num_questions?: number;
  answer_key_json?: string;
  is_active?: boolean;
  answer_key_date?: string;
  classroom_id?: number;
}

@Injectable({
  providedIn: 'root'
})
export class AnswerKeyService {
  private apiUrl = '/api/answer-keys';

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private offline: OfflineDataService
  ) { }

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  generateAnswerKey(examTitle: string, subject: string, questions: QuestionAnswer[]): Partial<AnswerKey> {
    const answerString = questions.map(q => q.correctAnswer).join('');
    return {
      examTitle,
      subject,
      numQuestions: questions.length,
      answerKey: answerString,
      date: new Date().toISOString().split('T')[0],
      totalUsed: 0
    };
  }

  parseAnswerKeyToQuestions(answerKeyStr: string, numQuestions: number): QuestionAnswer[] {
    const answers = answerKeyStr.replace(/,/g, '').split('');
    return answers.map((ans, idx) => ({
      questionNumber: idx + 1,
      choices: ['A', 'B', 'C', 'D'],
      correctAnswer: ans || 'A'
    }));
  }

  getAnswerKeys(): Observable<AnswerKey[]> {
    if (this.auth.isOfflineMode()) return of(this.offline.getAnswerKeys());
    return this.http.get<any>(this.apiUrl, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && Array.isArray(response.answerKeys)) {
          return response.answerKeys.map((k: any) => ({
            id: k.id,
            subject: k.subject,
            examTitle: k.exam_title,
            numQuestions: k.num_questions,
            answerKey: k.answer_key_json,
            answerKeyDate: k.answer_key_date || new Date().toISOString().split('T')[0],
            date: k.created_at ? k.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            totalUsed: k.total_used || 0,
            createdAt: k.created_at,
            createdByName: k.created_by_name,
            isActive: k.is_active,
            classroomId: k.classroom_id,
            classroomName: `${k.classroom_name || ''}${k.classroom_section ? ' ' + k.classroom_section : ''}`.trim(),
            printStatus: k.print_status || 'pending'
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  getAnswerKeyById(id: number): Observable<AnswerKey | null> {
    if (this.auth.isOfflineMode()) return of(this.offline.getAnswerKey(id));
    return this.http.get<any>(`${this.apiUrl}/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.answerKey) {
          const k = response.answerKey;
          return {
            id: k.id,
            subject: k.subject,
            examTitle: k.exam_title,
            numQuestions: k.num_questions,
            answerKey: k.answer_key_json,
            answerKeyDate: k.answer_key_date || new Date().toISOString().split('T')[0],
            date: k.created_at ? k.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            totalUsed: k.total_used || 0,
            createdAt: k.created_at,
            isActive: k.is_active,
            createdBy: k.created_by,
            classroomId: k.classroom_id,
            classroomName: `${k.classroom_name || ''}${k.classroom_section ? ' ' + k.classroom_section : ''}`.trim(),
            printStatus: k.print_status || 'pending'
          };
        }
        return null;
      }),
      catchError(this.handleError)
    );
  }

  createAnswerKey(data: Omit<AnswerKey, 'id' | 'date' | 'totalUsed' | 'createdAt' | 'createdByName'>): Observable<AnswerKey> {
    if (this.auth.isOfflineMode()) return of(this.offline.createAnswerKey(data));
    const payload: AnswerKeyCreate = {
      subject: data.subject,
      exam_title: data.examTitle,
      num_questions: data.numQuestions,
      answer_key_json: data.answerKey,
      answer_key_date: data.answerKeyDate,
      classroom_id: data.classroomId || Number(data.subject)
    };

    return this.http.post<any>(this.apiUrl, payload, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.answerKey) {
          const k = response.answerKey;
          return {
            id: k.id,
            subject: k.subject,
            examTitle: k.exam_title,
            numQuestions: k.num_questions,
            answerKey: k.answer_key_json,
            answerKeyDate: k.answer_key_date || new Date().toISOString().split('T')[0],
            date: k.created_at ? k.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            totalUsed: 0,
            createdAt: k.created_at,
            classroomId: k.classroom_id,
            classroomName: `${k.classroom_name || ''}${k.classroom_section ? ' ' + k.classroom_section : ''}`.trim(),
            printStatus: k.print_status || 'pending'
          };
        }
        throw new Error('Failed to create answer key');
      }),
      catchError(this.handleError)
    );
  }

  updateAnswerKey(id: number, updates: Partial<AnswerKey>): Observable<AnswerKey | null> {
    if (this.auth.isOfflineMode()) return of(this.offline.updateAnswerKey(id, updates));
    const payload: AnswerKeyUpdate = {};
    if (updates.subject !== undefined) payload.subject = updates.subject;
    if (updates.examTitle !== undefined) payload.exam_title = updates.examTitle;
    if (updates.numQuestions !== undefined) payload.num_questions = updates.numQuestions;
    if (updates.answerKey !== undefined) payload.answer_key_json = updates.answerKey;
    if (updates.isActive !== undefined) payload.is_active = updates.isActive;
    if (updates.answerKeyDate !== undefined) payload.answer_key_date = updates.answerKeyDate;
    if (updates.classroomId !== undefined && updates.classroomId !== null) payload.classroom_id = updates.classroomId;

    return this.http.put<any>(`${this.apiUrl}/${id}`, payload, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.answerKey) {
          const k = response.answerKey;
          return {
            id: k.id,
            subject: k.subject,
            examTitle: k.exam_title,
            numQuestions: k.num_questions,
            answerKey: k.answer_key_json,
            answerKeyDate: k.answer_key_date || new Date().toISOString().split('T')[0],
            date: k.created_at ? k.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            totalUsed: k.total_used || 0,
            createdAt: k.created_at,
            isActive: k.is_active,
            classroomId: k.classroom_id,
            classroomName: `${k.classroom_name || ''}${k.classroom_section ? ' ' + k.classroom_section : ''}`.trim(),
            printStatus: k.print_status || 'pending'
          };
        }
        return null;
      }),
      catchError(this.handleError)
    );
  }

  deleteAnswerKey(id: number): Observable<{ success: boolean; message: string }> {
    if (this.auth.isOfflineMode()) {
      this.offline.deleteAnswerKey(id);
      return of({ success: true, message: 'Answer key deleted from this device' });
    }
    return this.http.delete<any>(`${this.apiUrl}/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError(this.handleError)
    );
  }

  downloadAnswerSheet(id: number): Observable<Blob> {
    if (this.auth.isOfflineMode()) {
      const key = this.offline.getAnswerKey(id);
      if (!key) return throwError(() => new Error('Answer key not found on this device'));
      const rows = String(key.answerKey || '').split('').map((answer: string, index: number) =>
        `<tr><td>${index + 1}</td><td>${['A', 'B', 'C', 'D'].map(choice =>
          `<span style="display:inline-block;margin:3px;padding:5px 8px;border:1px solid #222;border-radius:50%;${answer === choice ? 'background:#222;color:#fff' : ''}">${choice}</span>`
        ).join('')}</td></tr>`).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${key.examTitle}</title></head><body style="font-family:Arial;max-width:720px;margin:auto"><h1>${key.examTitle}</h1><h2>${key.subject}</h2><p>Name: ____________________ &nbsp; Student #: ______</p><p><strong>Student sequence:</strong> <span style="display:inline-block;width:28px;height:32px;border:2px solid #222;vertical-align:middle"></span> <span style="display:inline-block;width:28px;height:32px;border:2px solid #222;vertical-align:middle"></span> <small>(write 01, or leave the first box blank for 1-9)</small></p><table>${rows}</table><p>Generated offline by AcadCheck</p></body></html>`;
      return of(new Blob([html], { type: 'text/html;charset=utf-8' }));
    }
    return this.http.get(`${this.apiUrl}/${id}/answer-sheet`, {
      headers: this.getAuthHeaders(),
      responseType: 'blob'
    }).pipe(catchError(this.handleError));
  }

  updatePrintStatus(id: number, status: 'pending' | 'printed'): Observable<any> {
    if (this.auth.isOfflineMode()) return of(this.offline.updateAnswerKey(id, { printStatus: status }));
    return this.http.post<any>(`${this.apiUrl}/${id}/print-status`, { status }, {
      headers: this.getAuthHeaders()
    }).pipe(catchError(this.handleError));
  }

  private handleError(error: any): Observable<never> {
    console.error('AnswerKeyService Error:', error);
    return throwError(() => error);
  }
}
