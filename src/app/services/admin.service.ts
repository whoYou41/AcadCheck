import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface AdminUser {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone?: string;
  username: string;
  role: string;
  is_active: boolean;
  created_at: string;
}

export interface AdminClassroom {
  id: number;
  name: string;
  section: string;
  teacher: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  user_id: number;
  owner_name?: string;
  owner_username?: string;
  student_count: number;
}

export interface AdminStudent {
  id: number;
  student_number: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  classroom_id: number | null;
  classroom_name?: string;
  classroom_section?: string;
  owner_name?: string;
  owner_username?: string;
  created_at: string;
}

export interface AdminStats {
  users: {
    total_users: number;
    admin_count: number;
    teacher_count: number;
    staff_count: number;
    active_users: number;
  };
  exams: {
    total_exam_responses: number;
    total_passed: number;
    total_failed: number;
    average_score: number;
  };
  classrooms: { total_classrooms: number };
  students: { total_students: number };
  answerKeys: { total_answer_keys: number };
  recentUsers: AdminUser[];
  updated_at?: string;
}

@Injectable({ providedIn: 'root' })
export class AdminService {
  private apiUrl = '/api/admin';

  constructor(private http: HttpClient) {}

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private handleError(error: any): Observable<never> {
    console.error('AdminService Error:', error);
    return throwError(() => error);
  }

  getUsers(): Observable<{ users: AdminUser[]; stats: any }> {
    return this.http.get<any>(`${this.apiUrl}/users`, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success) {
          return {
            users: Array.isArray(response.users) ? response.users : [],
            stats: response.stats || {}
          };
        }
        throw new Error(response.message || 'Failed to load users');
      }),
      catchError(this.handleError)
    );
  }

  createUser(userData: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    username: string;
    password: string;
    role?: string;
  }): Observable<AdminUser> {
    return this.http.post<any>(`${this.apiUrl}/users`, userData, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.user) return response.user;
        throw new Error(response.message || 'Failed to create user');
      }),
      catchError(this.handleError)
    );
  }

  deleteUser(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.apiUrl}/users/${id}`, { headers: this.getAuthHeaders() }).pipe(
      catchError(this.handleError)
    );
  }

  updateUser(id: number, userData: {
    first_name: string;
    last_name: string;
    email: string;
    phone?: string;
    username: string;
    password?: string;
    role?: string;
  }): Observable<AdminUser> {
    return this.http.put<any>(`${this.apiUrl}/users/${id}`, userData, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.user) return response.user;
        throw new Error(response.message || 'Failed to update user');
      }),
      catchError(this.handleError)
    );
  }

  getClassrooms(): Observable<AdminClassroom[]> {
    return this.http.get<any>(`${this.apiUrl}/classrooms`, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success) {
          return response.classrooms.map((c: any) => ({
            id: c.id,
            name: c.name,
            section: c.section,
            teacher: c.teacher,
            is_active: c.is_active,
            created_at: c.created_at,
            updated_at: c.updated_at,
            user_id: c.user_id,
            owner_name: c.owner_name,
            owner_username: c.owner_username,
            student_count: c.student_count
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  deleteClassroom(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.apiUrl}/classrooms/${id}`, { headers: this.getAuthHeaders() }).pipe(
      catchError(this.handleError)
    );
  }

  createClassroom(classroom: { name: string; section?: string; teacher?: string; user_id?: number }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/classrooms`, classroom, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.classroom) return response.classroom;
        throw new Error(response.message || 'Failed to create classroom');
      }),
      catchError(this.handleError)
    );
  }

  updateClassroom(id: number, classroom: { name?: string; section?: string; teacher?: string }): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/classrooms/${id}`, classroom, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.classroom) return response.classroom;
        throw new Error(response.message || 'Failed to update classroom');
      }),
      catchError(this.handleError)
    );
  }

  getStudents(params?: { classroom_id?: number; q?: string }): Observable<AdminStudent[]> {
    let httpParams = new URLSearchParams();
    if (params?.classroom_id) httpParams.set('classroom_id', String(params.classroom_id));
    if (params?.q) httpParams.set('q', params.q);

    const url = httpParams.toString() ? `${this.apiUrl}/students?${httpParams.toString()}` : `${this.apiUrl}/students`;
    return this.http.get<any>(url, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success) {
          return response.students.map((s: any) => ({
            id: s.id,
            student_number: s.student_number,
            first_name: s.first_name,
            middle_name: s.middle_name || '',
            last_name: s.last_name,
            email: s.email,
            phone: s.phone || null,
            classroom_id: s.classroom_id,
            classroom_name: s.classroom_name,
            classroom_section: s.classroom_section,
            owner_name: s.owner_name,
            owner_username: s.owner_username,
            created_at: s.created_at
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  deleteStudent(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.apiUrl}/students/${id}`, { headers: this.getAuthHeaders() }).pipe(
      catchError(this.handleError)
    );
  }

  createStudent(student: {
    student_number: string;
    first_name: string;
    middle_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    classroom_id?: number | null;
    user_id?: number;
  }): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/students`, student, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.student) return response.student;
        throw new Error(response.message || 'Failed to create student');
      }),
      catchError(this.handleError)
    );
  }

  updateStudent(id: number, student: {
    student_number?: string;
    first_name?: string;
    middle_name?: string;
    last_name?: string;
    email?: string;
    phone?: string;
    classroom_id?: number | null;
  }): Observable<any> {
    return this.http.put<any>(`${this.apiUrl}/students/${id}`, student, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success && response.student) return response.student;
        throw new Error(response.message || 'Failed to update student');
      }),
      catchError(this.handleError)
    );
  }

  getStats(): Observable<AdminStats> {
    return this.http.get<any>(`${this.apiUrl}/stats`, { headers: this.getAuthHeaders() }).pipe(
      map(response => {
        if (response.success) return response.stats;
        throw new Error(response.message || 'Failed to load admin stats');
      }),
      catchError(this.handleError)
    );
  }

  getScannerStatus(): Observable<any> {
    return this.http.get<any>(`${this.apiUrl}/training/status`, { headers: this.getAuthHeaders() }).pipe(catchError(this.handleError));
  }

  trainScanner(): Observable<any> {
    return this.http.post<any>(`${this.apiUrl}/scanner/train`, {}, { headers: this.getAuthHeaders() }).pipe(catchError(this.handleError));
  }
}
