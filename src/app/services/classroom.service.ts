import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AuthService } from './auth.service';
import { OfflineDataService } from './offline-data.service';

export interface Classroom {
  id: number;
  name: string;
  section: string;
  teacher: string;
  isActive?: boolean;
  studentCount?: number;
}

export interface ClassroomCreate {
  name: string;
  section?: string;
  teacher?: string;
}

export interface ClassroomUpdate {
  name?: string;
  section?: string;
  teacher?: string;
}

@Injectable({
  providedIn: 'root'
})
export class ClassroomService {
  private apiUrl = '/api/classrooms';

  constructor(
    private http: HttpClient,
    private auth: AuthService,
    private offline: OfflineDataService
  ) { }

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  getClassrooms(): Observable<Classroom[]> {
    if (this.auth.isOfflineMode()) return of(this.offline.getClassrooms());
    console.log('Fetching classrooms from API');
    return this.http.get<any>(this.apiUrl, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        console.log('Get classrooms response:', response);
        if (response.success && Array.isArray(response.classrooms)) {
          return response.classrooms.map((c: any) => ({
            id: c.id,
            name: c.name,
            section: c.section,
            teacher: c.teacher,
            isActive: c.is_active,
            studentCount: c.student_count
          }));
        }
        return [];
      }),
      catchError(this.handleError)
    );
  }

  getClassroomById(id: number): Observable<Classroom | null> {
    if (this.auth.isOfflineMode()) return of(this.offline.getClassroom(id));
    return this.http.get<any>(`${this.apiUrl}/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.classroom) {
          const c = response.classroom;
          return {
            id: c.id,
            name: c.name,
            section: c.section,
            teacher: c.teacher,
            isActive: c.is_active
          };
        }
        return null;
      }),
      catchError(this.handleError)
    );
  }

  createClassroom(classroom: Omit<Classroom, 'id' | 'studentCount'>): Observable<Classroom> {
    const payload: ClassroomCreate = {
      name: classroom.name,
      section: classroom.section,
      teacher: classroom.teacher
    };
    console.log('Creating classroom:', payload);
    if (this.auth.isOfflineMode()) return of(this.offline.createClassroom(classroom));

    return this.http.post<any>(this.apiUrl, payload, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        console.log('Create classroom response:', response);
        if (response.success && response.classroom) {
          const c = response.classroom;
          return {
            id: c.id,
            name: c.name,
            section: c.section,
            teacher: c.teacher,
            isActive: c.is_active
          };
        }
        throw new Error('Failed to create classroom');
      }),
      catchError(this.handleError)
    );
  }

  updateClassroom(id: number, updates: Partial<Classroom>): Observable<Classroom | null> {
    if (this.auth.isOfflineMode()) return of(this.offline.updateClassroom(id, updates));
    const payload: ClassroomUpdate = {};
    if (updates.name !== undefined) payload.name = updates.name;
    if (updates.section !== undefined) payload.section = updates.section;
    if (updates.teacher !== undefined) payload.teacher = updates.teacher;

    return this.http.put<any>(`${this.apiUrl}/${id}`, payload, {
      headers: this.getAuthHeaders()
    }).pipe(
      map(response => {
        if (response.success && response.classroom) {
          const c = response.classroom;
          return {
            id: c.id,
            name: c.name,
            section: c.section,
            teacher: c.teacher,
            isActive: c.is_active
          };
        }
        return null;
      }),
      catchError(this.handleError)
    );
  }

  deleteClassroom(id: number): Observable<{ success: boolean; message: string }> {
    if (this.auth.isOfflineMode()) {
      this.offline.deleteClassroom(id);
      return of({ success: true, message: 'Classroom deleted from this device' });
    }
    return this.http.delete<any>(`${this.apiUrl}/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError(this.handleError)
    );
  }

  private handleError(error: any): Observable<never> {
    console.error('ClassroomService Error:', error);
    return throwError(() => error);
  }
}
