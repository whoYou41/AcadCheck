import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { 
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonGrid, 
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton, 
  IonIcon, IonInput, IonSelect, IonSelectOption, IonList, IonItem, IonLabel, 
  IonModal, IonAvatar, IonBadge, IonMenuButton, IonCheckbox, IonTextarea, 
  IonSearchbar, IonNote, IonSegment, IonSegmentButton, IonToast 
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
  schoolOutline, schoolSharp, personAddOutline, createOutline, trashOutline, 
  saveOutline, closeCircleOutline, searchOutline, peopleOutline, peopleSharp, 
  listOutline, ellipsisVerticalOutline, checkmarkCircleOutline, alertCircleOutline 
} from 'ionicons/icons';
import { Router } from '@angular/router';
import { ClassroomService } from '../../services/classroom.service';
import { StudentService } from '../../services/student.service';
import { Classroom } from '../../services/classroom.service';
import { Student } from '../../services/student.service';

interface BulkStudentPreview {
  raw: string;
  firstName: string;
  middleName: string;
  lastName: string;
  gender: 'male' | 'female' | null;
  valid: boolean;
  error: string;
}

@Component({
  selector: 'app-students',
  templateUrl: './students.page.html',
  styleUrls: ['./students.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonMenuButton, IonGrid, IonRow, IonCol, IonCard, IonCardHeader,
    IonCardTitle, IonCardContent, IonButton, IonIcon, IonInput, IonSelect, IonSelectOption,
    IonList, IonItem, IonLabel, IonModal, IonAvatar, IonBadge, IonCheckbox, IonTextarea,
    IonSearchbar, IonNote, IonSegment, IonSegmentButton, IonToast
  ],
})
export class StudentsPage implements OnInit {
  showGuidance: boolean = false;

  // Modal controls
  showClassroomModal: boolean = false;
  showStudentModal: boolean = false;
  showBulkModal: boolean = false;
  isEditingClassroom: boolean = false;
  isEditingStudent: boolean = false;

  // Toast
  toastMessage: string = '';
  showToast: boolean = false;

  // Classrooms
  classrooms: Classroom[] = [];
  selectedClassroomId: number | null = null;
  selectedClassroomIdString: string = 'all';

  // Students
  allStudents: Student[] = [];
  filteredStudents: Student[] = [];
  searchQuery: string = '';

  // Form - Classroom
  classroomForm = {
    id: 0,
    name: '',
    section: '',
    teacher: ''
  };

   // Form - Student
   studentForm = {
     id: 0,
     studentNumber: '',
     sequentialNumber: 0,
     firstName: '',
     middleName: '',
     lastName: '',
     gender: null as 'male' | 'female' | null,
     email: '',
     phone: '',
     classroomId: null as number | null
   };

  // Bulk import
  bulkStudentNames: string[] = [];
  bulkStudentPreviews: BulkStudentPreview[] = [];
  bulkClassroomId: number | null = null;
  bulkDefaultGender: 'male' | 'female' | null = null;
  bulkText: string = '';
  isBulkImporting: boolean = false;

  constructor(
    private router: Router,
    private classroomService: ClassroomService,
    private studentService: StudentService
  ) {
    addIcons({
      schoolOutline, schoolSharp, personAddOutline, createOutline, trashOutline,
      saveOutline, closeCircleOutline, searchOutline, peopleOutline, peopleSharp,
      listOutline, ellipsisVerticalOutline, checkmarkCircleOutline, alertCircleOutline
    });
  }

  ngOnInit() {
    this.loadData();
  }

  loadData() {
    this.classroomService.getClassrooms().subscribe({
      next: (data: Classroom[]) => {
        this.classrooms = data;
      },
      error: (err) => {
        console.error('Failed to load classrooms:', err);
      }
    });

    this.studentService.getStudents().subscribe({
      next: (data: Student[]) => {
        this.allStudents = data;
        this.filterStudents();
      },
      error: (err) => {
        console.error('Failed to load students:', err);
        this.allStudents = [];
        this.filteredStudents = [];
      }
    });
  }

  filterStudents() {
    let result = this.allStudents;

    // Filter by classroom
    if (this.selectedClassroomId) {
      result = result.filter(s => s.classroomId === this.selectedClassroomId);
    }

    // Filter by search query
    if (this.searchQuery) {
      const q = this.searchQuery.toLowerCase();
      result = result.filter(s =>
        (s.firstName && s.firstName.toLowerCase().includes(q)) ||
        (s.middleName && s.middleName.toLowerCase().includes(q)) ||
        (s.lastName && s.lastName.toLowerCase().includes(q)) ||
        s.studentNumber.toLowerCase().includes(q)
      );
    }

    this.filteredStudents = result;
  }

  onSearchChange() {
    this.filterStudents();
  }

  selectClassroom() {
    this.selectedClassroomId = this.selectedClassroomIdString === 'all' 
      ? null 
      : Number(this.selectedClassroomIdString);
    this.filterStudents();
  }

  // Classroom actions
  openAddClassroomModal() {
    this.resetClassroomForm();
    this.isEditingClassroom = false;
    this.showClassroomModal = true;
  }

  editClassroom(classroom: Classroom) {
    this.classroomForm = {
      id: classroom.id,
      name: classroom.name,
      section: classroom.section || '',
      teacher: classroom.teacher || ''
    };
    this.isEditingClassroom = true;
    this.showClassroomModal = true;
  }

  saveClassroom() {
    if (!this.classroomForm.name) {
      this.showToastMessage('Classroom name is required');
      return;
    }

    const data = {
      name: this.classroomForm.name,
      section: this.classroomForm.section,
      teacher: this.classroomForm.teacher
    };

    if (this.isEditingClassroom) {
      this.classroomService.updateClassroom(this.classroomForm.id, data).subscribe({
        next: (updatedClassroom) => {
          if (updatedClassroom) {
            const index = this.classrooms.findIndex(c => c.id === updatedClassroom.id);
            if (index !== -1) this.classrooms[index] = updatedClassroom;
          }
          this.closeClassroomModal();
          this.showToastMessage('Classroom updated');
        },
        error: (err) => {
          console.error('Failed to update classroom:', err);
          this.showToastMessage('Failed to update classroom');
        }
      });
    } else {
      this.classroomService.createClassroom(data).subscribe({
        next: (newClassroom) => {
          this.classrooms.push(newClassroom);
          this.closeClassroomModal();
          this.showToastMessage('Classroom created');
        },
        error: (err) => {
          console.error('Failed to create classroom:', err);
          this.showToastMessage('Failed to create classroom');
        }
      });
    }
  }

  deleteClassroom(id: number) {
    if (confirm('Delete this classroom? All students in this classroom will also be deleted.')) {
      this.classroomService.deleteClassroom(id).subscribe({
        next: () => {
          this.classrooms = this.classrooms.filter(c => c.id !== id);
          // Reset filter if the deleted classroom was selected
          if (this.selectedClassroomId === id) {
            this.selectedClassroomId = null;
            this.selectedClassroomIdString = 'all';
          }
          if (this.classroomForm.id === id) {
            this.closeClassroomModal();
          }
          this.showToastMessage('Classroom deleted');
        },
        error: (err) => {
          console.error('Failed to delete classroom:', err);
          this.showToastMessage('Failed to delete classroom');
        }
      });
    }
  }

  closeClassroomModal() {
    this.showClassroomModal = false;
    this.resetClassroomForm();
  }

  resetClassroomForm() {
    this.classroomForm = { id: 0, name: '', section: '', teacher: '' };
  }

  // Student actions
  openAddStudentModal() {
    this.resetStudentForm();
    this.isEditingStudent = false;
    this.showStudentModal = true;
  }

  editStudent(student: Student) {
    this.studentForm = {
      id: student.id,
      studentNumber: student.studentNumber,
      sequentialNumber: student.sequentialNumber || 0,
      firstName: student.firstName,
      middleName: student.middleName || '',
      lastName: student.lastName,
      gender: student.gender || null,
      email: student.email,
      phone: student.phone || '',
      classroomId: student.classroomId
    };
    this.isEditingStudent = true;
    this.showStudentModal = true;
  }

  saveStudent() {
    if (!this.studentForm.firstName || !this.studentForm.middleName || !this.studentForm.lastName || !this.studentForm.gender) {
      this.showToastMessage('Please fill in the complete student name and gender');
      return;
    }

    // Auto-generate student number if not provided
    const studentNumber = this.studentForm.studentNumber || 
      `S${Date.now().toString().slice(-6)}-${(Math.random() * 1000).toFixed(0).padStart(3, '0')}`;

     // Prepare data with camelCase for StudentService
      const data = {
        studentNumber: studentNumber,
        sequentialNumber: this.isEditingStudent ? this.studentForm.sequentialNumber : 0,
        firstName: this.studentForm.firstName,
        middleName: this.studentForm.middleName,
        lastName: this.studentForm.lastName,
        gender: this.studentForm.gender,
        email: this.studentForm.email || '',
        phone: this.studentForm.phone || null,
        classroomId: this.studentForm.classroomId || null
      };

    if (this.isEditingStudent) {
      this.studentService.updateStudent(this.studentForm.id, data).subscribe({
        next: () => {
          this.loadData();
          this.closeStudentModal();
          this.showToastMessage('Student updated');
        },
        error: (err) => {
          console.error('Failed to update student:', err);
          this.showToastMessage(err?.error?.message || 'Failed to update student');
        }
      });
    } else {
      this.studentService.createStudent(data).subscribe({
        next: () => {
          this.loadData();
          this.closeStudentModal();
          this.showToastMessage('Student added');
        },
        error: (err) => {
          console.error('Failed to create student:', err);
          this.showToastMessage(err?.error?.message || 'Failed to create student');
        }
      });
    }
  }

  deleteStudent(id: number) {
    if (confirm('Delete this student?')) {
      this.studentService.deleteStudent(id).subscribe({
        next: () => {
          this.loadData();
          this.showToastMessage('Student deleted');
        },
        error: (err) => {
          console.error('Failed to delete student:', err);
          this.showToastMessage('Failed to delete student');
        }
      });
    }
  }

  closeStudentModal() {
    this.showStudentModal = false;
    this.resetStudentForm();
  }

  resetStudentForm() {
    this.studentForm = {
      id: 0,
      studentNumber: '',
      sequentialNumber: 0,
      firstName: '',
      middleName: '',
      lastName: '',
      gender: null,
      email: '',
      phone: '',
      classroomId: null
    };
  }

  // Bulk import
  parseBulkText() {
    const lines = this.bulkText.split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const seen = new Set<string>();
    this.bulkStudentPreviews = lines.map(raw => {
      const genderSuffix = raw.match(/^(.*?)\s*[|,]\s*(male|female)\s*$/i);
      const name = (genderSuffix?.[1] || raw).trim().replace(/\s+/g, ' ');
      const gender = (genderSuffix?.[2]?.toLowerCase() || this.bulkDefaultGender) as 'male' | 'female' | null;
      const parts = name.split(' ').filter(Boolean);
      const firstName = parts[0] || '';
      const lastName = parts.length >= 2 ? parts[parts.length - 1] : '';
      const middleName = parts.length >= 3 ? parts.slice(1, -1).join(' ') : '';
      const identity = `${name.toLowerCase()}|${gender || ''}`;

      let error = '';
      if (parts.length < 3) error = 'Enter first, middle, and last name';
      else if (!gender) error = 'Choose a default gender or add “| Male/Female”';
      else if (seen.has(identity)) error = 'Duplicate entry';
      seen.add(identity);

      return {
        raw,
        firstName,
        middleName,
        lastName,
        gender,
        valid: !error,
        error
      };
    });

    this.bulkStudentNames = this.bulkStudentPreviews
      .filter(student => student.valid)
      .map(student => student.raw);
  }

  get validBulkStudents(): BulkStudentPreview[] {
    return this.bulkStudentPreviews.filter(student => student.valid);
  }

  get invalidBulkStudents(): BulkStudentPreview[] {
    return this.bulkStudentPreviews.filter(student => !student.valid);
  }

  get isBulkImportReady(): boolean {
    return !!this.bulkClassroomId
      && this.validBulkStudents.length > 0
      && this.invalidBulkStudents.length === 0
      && !this.isBulkImporting;
  }

  useBulkExample() {
    this.bulkText = 'Juan Santos Cruz | Male\nMaria Reyes Dela Cruz | Female\nPaolo Garcia Ramos | Male';
    this.parseBulkText();
  }

  closeBulkModal() {
    this.showBulkModal = false;
    this.bulkText = '';
    this.bulkStudentNames = [];
    this.bulkStudentPreviews = [];
    this.bulkClassroomId = null;
    this.bulkDefaultGender = null;
    this.isBulkImporting = false;
  }

   saveBulkStudents() {
     if (!this.isBulkImportReady) {
       this.showToastMessage('Fix the highlighted entries and select a classroom');
       return;
     }

      this.isBulkImporting = true;
      const batchId = Date.now().toString().slice(-6);
      const studentsToCreate = this.validBulkStudents.map((student, index) => {
        return {
          studentNumber: `S${batchId}-${String(index + 1).padStart(3, '0')}`,
          sequentialNumber: 0,
          firstName: student.firstName,
          middleName: student.middleName,
          lastName: student.lastName,
          gender: student.gender,
          email: '',
          phone: null,
          classroomId: this.bulkClassroomId
        };
      });

    this.studentService.bulkCreateStudents(studentsToCreate).subscribe({
      next: () => {
        this.loadData();
        this.closeBulkModal();
        this.showToastMessage(`Created ${studentsToCreate.length} students`);
      },
      error: (err) => {
        this.isBulkImporting = false;
        console.error('Failed to create bulk students:', err);
        this.showToastMessage(err?.error?.message || 'Failed to create students');
      }
    });
  }

  openBulkModal() {
    this.bulkText = '';
    this.bulkStudentNames = [];
    this.bulkStudentPreviews = [];
    this.bulkClassroomId = null;
    this.bulkDefaultGender = null;
    this.isBulkImporting = false;
    this.showBulkModal = true;
  }

  // Navigation
  navigateToAnswerKey() {
    this.router.navigate(['/answer-key']);
  }

  navigateToScanner() {
    this.router.navigate(['/scanner']);
  }

  // Get active classrooms for segment
  getActiveClassrooms(): Classroom[] {
    return this.classrooms.filter(c => c.isActive);
  }

  // Get classroom name for display
  getClassName(classroomId: number | null): string {
    if (!classroomId) return 'Unassigned';
    const classroom = this.classrooms.find(c => c.id === classroomId);
    return classroom ? `${classroom.name} ${classroom.section || ''}` : 'Unknown';
  }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => this.showToast = false, 3000);
  }
}
