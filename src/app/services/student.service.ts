import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable, throwError, forkJoin } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export interface Student {
  id: number;
  studentNumber: string;
  firstName: string;
  middleName: string;
  lastName: string;
  gender?: 'male' | 'female' | null;
  email: string;
  phone: string | null;
  classroomId: number | null;
  sequentialNumber: number;
  createdAt?: string;
  classroomName?: string;
  classroomSection?: string;
}

export interface StudentCreate {
  student_number: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  gender?: 'male' | 'female' | null;
  email?: string;
  phone?: string;
  classroom_id?: number | null;
  sequential_number?: number;
}

export interface StudentUpdate {
  student_number?: string;
  first_name?: string;
  middle_name?: string;
  last_name?: string;
  gender?: 'male' | 'female' | null;
  email?: string;
  phone?: string;
  classroom_id?: number | null;
  sequential_number?: number;
}

@Injectable({
  providedIn: 'root'
})
export class StudentService {
  private apiUrl = '/api/students';

  constructor(private http: HttpClient) { }

  private getAuthHeaders(): { [header: string]: string } {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  private handleError<T>(operation: string, result?: T): (error: any) => Observable<never> {
    return (error: any): Observable<never> => {
      console.error(`${operation} failed:`, error);
      return throwError(() => error);
    };
  }

  getStudents(params?: {
    classroom_id?: number;
    student_number?: string;
    q?: string;
  }): Observable<Student[]> {
    let httpParams = new HttpParams();
    if (params?.classroom_id) httpParams = httpParams.set('classroom_id', params.classroom_id.toString());
    if (params?.student_number) httpParams = httpParams.set('student_number', params.student_number);
    if (params?.q) httpParams = httpParams.set('q', params.q);

    return this.http.get<any>(this.apiUrl, {
      headers: this.getAuthHeaders(),
      params: httpParams
    }).pipe(
      map(response => {
        if (response.success && Array.isArray(response.students)) {
          return response.students.map((s: any) => ({
            id: s.id,
            studentNumber: s.student_number,
            firstName: s.first_name,
            middleName: s.middle_name || '',
            lastName: s.last_name,
            gender: s.gender || null,
            email: s.email,
            phone: s.phone || null,
            classroomId: s.classroom_id,
            sequentialNumber: s.sequential_number || 1,
            createdAt: s.created_at,
            classroomName: s.classroom_name,
            classroomSection: s.classroom_section
          }));
        }
        return [];
      }),
      catchError(this.handleError('getStudents', []))
    );
  }

   getStudentById(id: number): Observable<Student | null> {
     return this.http.get<any>(`${this.apiUrl}/${id}`, {
       headers: this.getAuthHeaders()
     }).pipe(
       map(response => {
         if (response.success && response.student) {
           const s = response.student;
           return {
             id: s.id,
             studentNumber: s.student_number,
             firstName: s.first_name,
             middleName: s.middle_name || '',
             lastName: s.last_name,
             gender: s.gender || null,
             email: s.email,
             phone: s.phone || null,
             classroomId: s.classroom_id,
             sequentialNumber: s.sequential_number || 1,
             createdAt: s.created_at
           };
         }
         return null;
       }),
       catchError(this.handleError('getStudentById', null))
     );
   }

  getStudentByNumber(studentNumber: string): Observable<Student | null> {
    return this.getStudents({ student_number: studentNumber }).pipe(
      map(students => students[0] || null)
    );
  }

  createStudent(student: Omit<Student, 'id' | 'createdAt'>): Observable<Student | null> {
    const payload: StudentCreate = {
      student_number: student.studentNumber,
      first_name: student.firstName,
      middle_name: student.middleName || '',
      last_name: student.lastName,
      gender: student.gender || null,
      email: student.email,
      phone: student.phone === null ? undefined : student.phone,
      classroom_id: student.classroomId,
      sequential_number: student.sequentialNumber
    };

    return this.http.post<any>(this.apiUrl, payload, {
      headers: this.getAuthHeaders()
    }).pipe(
        map(response => {
          if (response.success && response.student) {
            const s = response.student;
            return {
              id: s.id,
              studentNumber: s.student_number,
              firstName: s.first_name,
              middleName: s.middle_name || '',
              lastName: s.last_name,
              gender: s.gender || null,
              email: s.email,
              phone: s.phone || null,
              classroomId: s.classroom_id,
              sequentialNumber: s.sequential_number || 1,
              createdAt: s.created_at
            };
          }
          return null;
        }),
      catchError(this.handleError('createStudent'))
    );
  }

  bulkCreateStudents(students: Omit<Student, 'id' | 'createdAt'>[]): Observable<Student[]> {
    const observables = students.map(s => this.createStudent(s));
    return forkJoin(observables).pipe(
      map(results => results.filter((r): r is Student => r !== null))
    );
  }

   updateStudent(id: number, updates: Partial<Student>): Observable<Student | null> {
     const payload: StudentUpdate = {};
     if (updates.studentNumber !== undefined) payload.student_number = updates.studentNumber;
     if (updates.firstName !== undefined) payload.first_name = updates.firstName;
     if (updates.middleName != null) payload.middle_name = updates.middleName;
     if (updates.lastName !== undefined) payload.last_name = updates.lastName;
     if (updates.gender !== undefined) payload.gender = updates.gender;
     if (updates.email !== undefined) payload.email = updates.email;
     if (updates.phone !== undefined) payload.phone = updates.phone === null ? undefined : updates.phone;
     if (updates.classroomId !== undefined) payload.classroom_id = updates.classroomId;
     if (updates.sequentialNumber !== undefined) payload.sequential_number = updates.sequentialNumber;

      return this.http.put<any>(`${this.apiUrl}/${id}`, payload, {
        headers: this.getAuthHeaders()
      }).pipe(
        map(response => {
          if (response.success && response.student) {
            const s = response.student;
            return {
              id: s.id,
              studentNumber: s.student_number,
              firstName: s.first_name,
              middleName: s.middle_name || '',
              lastName: s.last_name,
              gender: s.gender || null,
              email: s.email,
              phone: s.phone || null,
              classroomId: s.classroom_id,
              sequentialNumber: s.sequential_number || 1,
              createdAt: s.created_at
            };
          }
          return null;
        }),
        catchError(this.handleError('updateStudent', null))
      );
    }

  deleteStudent(id: number): Observable<{ success: boolean; message: string }> {
    return this.http.delete<any>(`${this.apiUrl}/${id}`, {
      headers: this.getAuthHeaders()
    }).pipe(
      catchError(this.handleError('deleteStudent', { success: false, message: 'Failed to delete student' }))
    );
  }

  searchStudents(query: string): Observable<Student[]> {
    return this.getStudents({ q: query });
  }

  getStudentsByClassroom(classroomId: number): Observable<Student[]> {
    return this.getStudents({ classroom_id: classroomId });
  }
}
