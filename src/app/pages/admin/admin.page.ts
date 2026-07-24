import { Component, OnInit, AfterViewChecked, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonGrid, IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton, IonIcon, IonInput, IonSelect, IonSelectOption, IonList, IonItem, IonLabel, IonModal, IonBadge, IonMenuButton, IonSearchbar, IonSegment, IonSegmentButton, IonSpinner, IonCardSubtitle, IonToast } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { peopleOutline, peopleSharp, personAddOutline, personCircleOutline, createOutline, trashOutline, saveOutline, closeCircleOutline, searchOutline, analyticsOutline, analyticsSharp, shieldCheckmarkOutline, schoolOutline, schoolSharp, documentTextOutline, documentTextSharp, checkmarkCircleOutline, mailOutline, callOutline, personOutline, lockClosedOutline, addCircleOutline, barcodeOutline, albumsOutline, logOutOutline, refreshOutline } from 'ionicons/icons';
import { AdminService, AdminUser, AdminClassroom, AdminStudent, AdminStats } from '../../services/admin.service';
import { AuthService } from '../../services/auth.service';

declare const Chart: any;

@Component({
  selector: 'page-admin',
  templateUrl: './admin.page.html',
  styleUrls: ['./admin.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonMenuButton,
    IonGrid,
    IonRow,
    IonCol,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonButton,
    IonIcon,
    IonInput,
    IonSelect,
    IonSelectOption,
    IonList,
    IonItem,
    IonLabel,
    IonModal,
    IonBadge,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonCardSubtitle,
    IonToast
  ],
})
export class AdminPage implements OnInit, AfterViewChecked {
  @ViewChild('passFailChart') passFailChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('usersChart') usersChartRef!: ElementRef<HTMLCanvasElement>;

  selectedTab = 'overview';
  charts: any[] = [];
  stats: AdminStats | null = null;
  users: AdminUser[] = [];
  classrooms: AdminClassroom[] = [];
  students: AdminStudent[] = [];
  isLoading = true;
  isTrainingScanner = false;
  scannerStatus: any = null;
  showToast = false;
  toastMessage = '';
  toastColor = 'primary';

  public showToastMessage(message: string, color: string = 'primary') {
    this.toastMessage = message;
    this.toastColor = color;
    this.showToast = true;
    setTimeout(() => { this.showToast = false; }, 3000);
  }

  searchQuery = '';
  userSearchQuery = '';

  get filteredUsers(): AdminUser[] {
    const query = this.userSearchQuery.trim().toLowerCase();
    if (!query) return this.users;

    return this.users.filter((user) =>
      [user.first_name, user.last_name, user.username, user.email, user.role]
        .some((value) => value?.toLowerCase().includes(query))
    );
  }

  showUserModal = false;
  showClassroomModal = false;
  showStudentModal = false;
  isEditingUser = false;
  isEditingClassroom = false;
  isEditingStudent = false;

  userIdForm = { id: 0, first_name: '', last_name: '', email: '', phone: '', username: '', password: '', role: 'teacher' };
  classroomForm = { id: 0, name: '', section: '', teacher: '' };
  studentForm = { id: 0, studentNumber: '', firstName: '', middleName: '', lastName: '', email: '', phone: '', classroomId: null as number | null };

  constructor(
    private adminService: AdminService,
    private authService: AuthService,
    private router: Router
  ) {
    const icons = { peopleOutline, peopleSharp, personAddOutline, personCircleOutline, createOutline, trashOutline, saveOutline, closeCircleOutline, searchOutline, analyticsOutline, analyticsSharp, shieldCheckmarkOutline, schoolOutline, schoolSharp, documentTextOutline, documentTextSharp, checkmarkCircleOutline, mailOutline, callOutline, personOutline, lockClosedOutline, addCircleOutline, barcodeOutline, albumsOutline, logOutOutline, refreshOutline };

    addIcons(icons);

    // Static `name` attributes are normalized to lowercase by ion-icon. Keep
    // aliases for the admin template's existing camelCase names so every icon
    // resolves locally instead of attempting to fetch a missing SVG asset.
    const lowercaseAliases = Object.entries(icons).reduce<Record<string, string>>(
      (aliases, [name, icon]) => {
        aliases[name.toLowerCase()] = icon;
        return aliases;
      },
      {}
    );
    addIcons(lowercaseAliases);
  }

  ngOnInit() {
    this.loadAllData();
  }

  ngAfterViewChecked() {
    if (this.stats) {
      this.renderChartsLater();
    }
  }

  loadAllData() {
    this.isLoading = true;
    this.loadStats();
    this.loadUsers();
    this.loadClassrooms();
    this.loadStudents();
    this.loadScannerStatus();
  }

  loadStats() {
    this.adminService.getStats().subscribe({
      next: (data: AdminStats) => {
        this.stats = data;
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToastMessage('Failed to load stats', 'danger');
      }
    });
  }

  loadUsers() {
    this.adminService.getUsers().subscribe({
      next: (data) => {
        this.users = Array.isArray(data.users) ? data.users : [];
      },
      error: () => {
        this.users = [];
        this.showToastMessage('Failed to load registered users', 'danger');
      }
    });
  }

  loadClassrooms() {
    this.adminService.getClassrooms().subscribe({
      next: (data) => {
        this.classrooms = data;
      },
      error: () => { this.classrooms = []; }
    });
  }

  loadStudents() {
    this.adminService.getStudents({ q: this.searchQuery }).subscribe({
      next: (data) => {
        this.students = data;
      },
      error: () => { this.students = []; }
    });
  }

  loadScannerStatus() {
    this.adminService.getScannerStatus().subscribe({ next: data => this.scannerStatus = data, error: () => this.scannerStatus = null });
  }

  trainScanner() {
    if (this.isTrainingScanner || !confirm('Run scanner training now? This may take several minutes.')) return;
    this.isTrainingScanner = true;
    this.adminService.trainScanner().subscribe({
      next: () => { this.isTrainingScanner = false; this.loadScannerStatus(); this.showToastMessage('Scanner training completed', 'success'); },
      error: (err) => { this.isTrainingScanner = false; this.showToastMessage(err?.error?.message || 'Scanner training failed', 'danger'); }
    });
  }

  renderChartsLater() {
    if (this.charts.length === 0) {
      this.renderCharts();
      return;
    }
    if (this.charts[0] && this.stats) {
      this.charts[0].data.datasets[0].data = [this.stats.exams.total_passed, this.stats.exams.total_failed];
      try { this.charts[0].update('none'); } catch {}
    }
    if (this.charts[1] && this.stats) {
      this.charts[1].data.datasets[0].data = [this.stats.users.admin_count, this.stats.users.teacher_count, this.stats.users.staff_count];
      try { this.charts[1].update('none'); } catch {}
    }
  }

  renderCharts() {
    if (this.charts.length > 0) {
      this.charts.forEach(c => { try { c.destroy(); } catch {} });
      this.charts = [];
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark' ||
                   window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const colorTheme = {
      text: isDark ? '#e0e0e0' : '#555',
      grid: isDark ? '#333' : '#e0e0e0'
    };

    if (this.passFailChartRef?.nativeElement && this.stats) {
      this.charts.push(
        new (Chart as any)(this.passFailChartRef.nativeElement, {
          type: 'doughnut',
          data: {
            labels: ['Passed', 'Failed'],
            datasets: [{
              data: [this.stats.exams.total_passed, this.stats.exams.total_failed],
              backgroundColor: [
                'rgba(46, 125, 50, 0.85)',
                'rgba(244, 67, 54, 0.85)'
              ],
              borderColor: ['#2e7d32', '#f44336'],
              borderWidth: 2,
              hoverOffset: 8
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: colorTheme.text,
                  padding: 16,
                  usePointStyle: true,
                  pointStyleWidth: 12,
                  font: { size: 12, weight: '600' }
                }
              }
            }
          }
        })
      );
    }

    if (this.usersChartRef?.nativeElement && this.stats) {
      this.charts.push(
        new (Chart as any)(this.usersChartRef.nativeElement, {
          type: 'doughnut',
          data: {
            labels: ['Admins', 'Teachers', 'Staff'],
            datasets: [{
              data: [this.stats.users.admin_count, this.stats.users.teacher_count, this.stats.users.staff_count],
              backgroundColor: [
                'rgba(244, 67, 54, 0.85)',
                'rgba(33, 150, 243, 0.85)',
                'rgba(255, 193, 7, 0.85)'
              ],
              borderColor: ['#f44336', '#2196f3', '#ffc107'],
              borderWidth: 2,
              hoverOffset: 8
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: colorTheme.text,
                  padding: 16,
                  usePointStyle: true,
                  pointStyleWidth: 12,
                  font: { size: 12, weight: '600' }
                }
              }
            }
          }
        })
      );
    }
  }

  // Users
  openAddUserModal() {
    this.resetUserForm();
    this.isEditingUser = false;
    this.showUserModal = true;
  }

  openEditUserModal(user: AdminUser) {
    this.userIdForm = {
      id: user.id,
      first_name: user.first_name,
      last_name: user.last_name,
      email: user.email,
      phone: user.phone || '',
      username: user.username,
      password: '',
      role: user.role
    };
    this.isEditingUser = true;
    this.showUserModal = true;
  }

  saveUser() {
    if (!this.userIdForm.first_name || !this.userIdForm.last_name || !this.userIdForm.email || !this.userIdForm.username) {
      this.showToastMessage('Please fill all required fields', 'warning');
      return;
    }

    if (this.isEditingUser) {
      this.adminService.updateUser(this.userIdForm.id, {
        first_name: this.userIdForm.first_name,
        last_name: this.userIdForm.last_name,
        email: this.userIdForm.email,
        phone: this.userIdForm.phone,
        username: this.userIdForm.username,
        password: this.userIdForm.password,
        role: this.userIdForm.role
      }).subscribe({
        next: () => {
          this.closeUserModal();
          this.loadAllData();
          this.showToastMessage('User updated', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to update user', 'danger');
        }
      });
    } else {
      if (!this.userIdForm.password) {
        this.showToastMessage('Password is required for new users', 'warning');
        return;
      }
      this.adminService.createUser({
        first_name: this.userIdForm.first_name,
        last_name: this.userIdForm.last_name,
        email: this.userIdForm.email,
        phone: this.userIdForm.phone,
        username: this.userIdForm.username,
        password: this.userIdForm.password,
        role: this.userIdForm.role
      }).subscribe({
        next: () => {
          this.closeUserModal();
          this.loadAllData();
          this.showToastMessage('User created', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to create user', 'danger');
        }
      });
    }
  }

  deleteUser(id: number) {
    if (!confirm('Deactivate this user? This will prevent them from logging in.')) return;
    this.adminService.deleteUser(id).subscribe({
      next: () => {
        this.users = this.users.filter(u => u.id !== id);
        this.showToastMessage('User deactivated', 'success');
      },
      error: () => this.showToastMessage('Failed to deactivate user', 'danger')
    });
  }

  closeUserModal() {
    this.showUserModal = false;
    this.resetUserForm();
  }

  resetUserForm() {
    this.userIdForm = { id: 0, first_name: '', last_name: '', email: '', phone: '', username: '', password: '', role: 'teacher' };
  }

  // Classrooms
  openAddClassroomModal() {
    this.resetClassroomForm();
    this.isEditingClassroom = false;
    this.showClassroomModal = true;
  }

  openEditClassroomModal(classroom: AdminClassroom) {
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
      this.showToastMessage('Classroom name is required', 'warning');
      return;
    }

    if (this.isEditingClassroom) {
      this.adminService.updateClassroom(this.classroomForm.id, {
        name: this.classroomForm.name,
        section: this.classroomForm.section,
        teacher: this.classroomForm.teacher
      }).subscribe({
        next: () => {
          this.closeClassroomModal();
          this.loadAllData();
          this.showToastMessage('Classroom updated', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to update classroom', 'danger');
        }
      });
    } else {
      this.adminService.createClassroom({
        name: this.classroomForm.name,
        section: this.classroomForm.section,
        teacher: this.classroomForm.teacher
      }).subscribe({
        next: () => {
          this.closeClassroomModal();
          this.loadAllData();
          this.showToastMessage('Classroom created', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to create classroom', 'danger');
        }
      });
    }
  }

  deleteClassroom(id: number) {
    if (!confirm('Delete this classroom? All students in this classroom will also be deleted.')) return;
    this.adminService.deleteClassroom(id).subscribe({
      next: () => {
        this.classrooms = this.classrooms.filter(c => c.id !== id);
        this.showToastMessage('Classroom deleted', 'success');
      },
      error: () => this.showToastMessage('Failed to delete classroom', 'danger')
    });
  }

  closeClassroomModal() {
    this.showClassroomModal = false;
    this.resetClassroomForm();
  }

  resetClassroomForm() {
    this.classroomForm = { id: 0, name: '', section: '', teacher: '' };
  }

  // Students
  openAddStudentModal() {
    this.resetStudentForm();
    this.isEditingStudent = false;
    this.showStudentModal = true;
  }

  openEditStudentModal(student: AdminStudent) {
    this.studentForm = {
      id: student.id,
      studentNumber: student.student_number,
      firstName: student.first_name,
      middleName: student.middle_name || '',
      lastName: student.last_name,
      email: student.email || '',
      phone: student.phone || '',
      classroomId: student.classroom_id
    };
    this.isEditingStudent = true;
    this.showStudentModal = true;
  }

  saveStudent() {
    if (!this.studentForm.firstName || !this.studentForm.middleName || !this.studentForm.lastName || !this.studentForm.studentNumber) {
      this.showToastMessage('Please fill all required fields', 'warning');
      return;
    }

    if (this.isEditingStudent) {
      this.adminService.updateStudent(this.studentForm.id, {
        student_number: this.studentForm.studentNumber,
        first_name: this.studentForm.firstName,
        middle_name: this.studentForm.middleName,
        last_name: this.studentForm.lastName,
        email: this.studentForm.email,
        phone: this.studentForm.phone,
        classroom_id: this.studentForm.classroomId
      }).subscribe({
        next: () => {
          this.closeStudentModal();
          this.loadStudents();
          this.showToastMessage('Student updated', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to update student', 'danger');
        }
      });
    } else {
      this.adminService.createStudent({
        student_number: this.studentForm.studentNumber,
        first_name: this.studentForm.firstName,
        middle_name: this.studentForm.middleName,
        last_name: this.studentForm.lastName,
        email: this.studentForm.email,
        phone: this.studentForm.phone,
        classroom_id: this.studentForm.classroomId
      }).subscribe({
        next: () => {
          this.closeStudentModal();
          this.loadStudents();
          this.showToastMessage('Student created', 'success');
        },
        error: (err) => {
          this.showToastMessage(err.message || 'Failed to create student', 'danger');
        }
      });
    }
  }

  deleteStudent(id: number) {
    if (!confirm('Delete this student?')) return;
    this.adminService.deleteStudent(id).subscribe({
      next: () => {
        this.students = this.students.filter(s => s.id !== id);
        this.showToastMessage('Student deleted', 'success');
      },
      error: () => this.showToastMessage('Failed to delete student', 'danger')
    });
  }

  closeStudentModal() {
    this.showStudentModal = false;
    this.resetStudentForm();
  }

  resetStudentForm() {
    this.studentForm = { id: 0, studentNumber: '', firstName: '', middleName: '', lastName: '', email: '', phone: '', classroomId: null };
  }

  onStudentSearch() {
    this.adminService.getStudents({ q: this.searchQuery }).subscribe({
      next: (data) => { this.students = data; },
      error: () => { this.students = []; }
    });
  }

  getPassRate(): number {
    if (!this.stats || !this.stats.exams?.total_exam_responses) return 0;
    return Math.round((this.stats.exams.total_passed / this.stats.exams.total_exam_responses) * 100);
  }

  getRoleLabel(role: string): string {
    return role ? role.toUpperCase() : 'TEACHER';
  }

  getRoleColor(role: string): string {
    switch (role) {
      case 'admin': return 'danger';
      case 'teacher': return 'primary';
      case 'staff': return 'warning';
      default: return 'medium';
    }
  }

  formatDate(dateString: string): string {
    return dateString ? new Date(dateString).toLocaleDateString() : 'N/A';
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
