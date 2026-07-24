import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { 
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonGrid, 
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton, 
  IonIcon, IonSearchbar, IonSelect, IonSelectOption, IonList, IonItem, IonLabel, 
  IonBadge, IonMenuButton, IonModal, IonNote, IonToast
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
  peopleOutline, searchOutline, filterOutline, documentTextOutline,
  checkmarkCircleOutline, closeCircleOutline, timeOutline, 
  analyticsOutline, schoolOutline, downloadOutline, bulbOutline
} from 'ionicons/icons';
import { Chart, registerables } from 'chart.js';
import { ExamScanService, ExamResponse, QuestionAnalytics } from '../../services/exam-scan.service';
import { ClassroomService } from '../../services/classroom.service';

Chart.register(...registerables);

interface ResultItem {
  id: number;
  studentId: number;
  studentNumber: string;
  studentName: string;
  examTitle: string;
  score: number;
  percentage: number;
  status: string;
  date: string;
  grade: string;
}

interface ActivityItem {
  id: number;
  examTitle?: string;
  action: string;
  description: string;
  createdAt: string;
  performedByName?: string;
}

@Component({
  selector: 'app-results',
  templateUrl: './results.page.html',
  styleUrls: ['./results.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonMenuButton, IonSearchbar, IonSelect, IonSelectOption, IonGrid,
    IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonList,
    IonItem, IonLabel, IonBadge, IonButton, IonIcon, IonModal, IonNote, IonToast
  ],
})
export class ResultsPage implements OnInit, OnDestroy {
  showGuidance: boolean = false;

  searchQuery: string = '';
  selectedExam: string = '';
  selectedClassroom: string = '';
  selectedStatus: string = '';

  // Data
  studentResults: ResultItem[] = [];
  filteredResults: ResultItem[] = [];
  recentActivity: ActivityItem[] = [];

  // Filter options
  exams = ['All Exams'];
  classrooms = ['All Classrooms'];
  statuses = ['All Status', 'Passed', 'Failed'];

  // Loading states
  isLoadingResults = false;
  isLoadingExams = false;
  isLoadingClassrooms = false;
  isLoadingAnalytics = false;
  questionAnalytics: QuestionAnalytics | null = null;
  private performanceChart?: Chart;
  private difficultyChart?: Chart;

  // Toast
  toastMessage: string = '';
  showToast: boolean = false;

  constructor(
    private router: Router,
    private examScanService: ExamScanService,
    private classroomService: ClassroomService
  ) {
    addIcons({
      peopleOutline, searchOutline, filterOutline, documentTextOutline,
      checkmarkCircleOutline, closeCircleOutline, timeOutline,
      analyticsOutline, schoolOutline, downloadOutline, bulbOutline
    });
  }

  ngOnInit() {
    this.loadData();
    this.loadQuestionAnalytics();
  }

  ngOnDestroy() {
    this.destroyAnalyticsCharts();
  }

  loadData() {
    this.isLoadingResults = true;
    this.isLoadingExams = true;
    this.isLoadingClassrooms = true;

    // Load exam results from API
    this.examScanService.getExamResponses({ limit: 100 }).subscribe({
      next: (responses: ExamResponse[]) => {
        this.studentResults = responses.map(r => this.mapToResultItem(r));
        this.filteredResults = [...this.studentResults];
        this.isLoadingResults = false;

        // Extract unique exam titles for filter dropdown
        const uniqueExams = [...new Set(responses.map(r => r.examTitle).filter(Boolean))] as string[];
        this.exams = ['All Exams', ...uniqueExams.sort()];
        this.isLoadingExams = false;
      },
      error: (err) => {
        console.error('Failed to load results:', err);
        this.studentResults = [];
        this.filteredResults = [];
        this.isLoadingResults = false;
        this.isLoadingExams = false;
      }
    });

    // Load classrooms for filter
    this.classroomService.getClassrooms().subscribe({
      next: (classrooms) => {
        this.classrooms = ['All Classrooms', ...classrooms.map(c => `${c.name} ${c.section || ''}`.trim()).sort()];
        this.isLoadingClassrooms = false;
      },
      error: (err) => {
        console.error('Failed to load classrooms:', err);
        this.isLoadingClassrooms = false;
      }
    });

    // Load recent activity
    this.examScanService.getRecentActivity(10).subscribe((activity: any[]) => {
      this.recentActivity = activity.map((a: any) => ({
        id: a.id,
        examTitle: a.examTitle || 'System',
        action: a.action,
        description: a.description,
        createdAt: a.createdAt,
        performedByName: a.performedByName || 'System'
      }));
    });
  }

   // Map ExamResponse to ResultItem for display
   private mapToResultItem(response: ExamResponse): ResultItem {
     const middleInitial = response.middleName ? response.middleName + ' ' : '';
     const studentName = `${response.firstName || ''} ${middleInitial}${response.lastName || ''}`.trim() || 'Unknown Student';
     const grade = this.calculateGrade(response.percentage);
     const status = response.isGraded ? (response.percentage >= 20 ? 'Passed' : 'Failed') : 'Pending';
     const date = response.createdAt ? response.createdAt.split('T')[0] : '';

     return {
       id: response.id,
       studentId: response.studentId,
       studentNumber: response.studentNumberScanned || '',
       studentName,
       examTitle: response.examTitle || '',
       score: response.totalScore || 0,
       percentage: response.percentage || 0,
       status,
       date,
       grade
     };
   }

  // Grade bands for the 40-point grading contribution.
  private calculateGrade(percentage: number): string {
    if (percentage >= 36) return 'A';
    if (percentage >= 32) return 'B';
    if (percentage >= 24) return 'C';
    if (percentage >= 20) return 'D';
    return 'F';
  }

  // Filters
  applyFilters() {
    this.filteredResults = this.studentResults.filter(result => {
      const matchesSearch = !this.searchQuery || 
        result.studentName.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        result.studentId.toString().includes(this.searchQuery.toLowerCase());
      
      const matchesExam = !this.selectedExam || this.selectedExam === 'All Exams' || result.examTitle === this.selectedExam;
      
      const matchesClassroom = !this.selectedClassroom || this.selectedClassroom === 'All Classrooms';
      // Classroom filtering requires additional lookup - could be added if needed
      
      const matchesStatus = !this.selectedStatus || this.selectedStatus === 'All Status' || result.status === this.selectedStatus;

      return matchesSearch && matchesExam && matchesStatus;
    });
  }

  onSearchChange(event: any) {
    this.searchQuery = event.detail.value || '';
    this.applyFilters();
  }

  onExamChange(event: any) {
    this.selectedExam = event.detail.value || '';
    this.applyFilters();
    this.loadQuestionAnalytics();
  }

  onClassroomChange(event: any) {
    this.selectedClassroom = event.detail.value || '';
    this.applyFilters();
    this.loadQuestionAnalytics();
  }

  onStatusChange(event: any) {
    this.selectedStatus = event.detail.value || '';
    this.applyFilters();
  }

  // Statistics
  get totalStudents() { return this.filteredResults.length; }
  get passedCount() { return this.filteredResults.filter(r => r.status === 'Passed').length; }
  get failedCount() { return this.filteredResults.filter(r => r.status === 'Failed').length; }
  get averageScore() {
    const total = this.filteredResults.reduce((sum, r) => sum + r.percentage, 0);
    return this.totalStudents > 0 ? Math.round(total / this.totalStudents) : 0;
  }

  loadQuestionAnalytics() {
    this.isLoadingAnalytics = true;
    this.examScanService.getQuestionAnalytics({
      exam_title: this.selectedExam,
      classroom_name: this.selectedClassroom
    }).subscribe({
      next: analytics => {
        this.questionAnalytics = analytics;
        this.isLoadingAnalytics = false;
        window.setTimeout(() => this.renderAnalyticsCharts());
      },
      error: err => {
        console.error('Failed to load question analytics:', err);
        this.questionAnalytics = null;
        this.isLoadingAnalytics = false;
        this.destroyAnalyticsCharts();
      }
    });
  }

  private renderAnalyticsCharts() {
    const stats = this.questionAnalytics?.questionStats || [];
    const performanceCanvas = document.getElementById('question-performance-chart') as HTMLCanvasElement | null;
    const difficultyCanvas = document.getElementById('question-difficulty-chart') as HTMLCanvasElement | null;
    this.destroyAnalyticsCharts();

    if (!stats.length || !performanceCanvas || !difficultyCanvas) return;

    this.performanceChart = new Chart(performanceCanvas, {
      type: 'bar',
      data: {
        labels: stats.map(q => `Q${q.questionNumber}`),
        datasets: [
          {
            label: 'Correct',
            data: stats.map(q => q.correct),
            backgroundColor: '#2e7d32',
            borderRadius: 4
          },
          {
            label: 'Wrong',
            data: stats.map(q => q.wrong),
            backgroundColor: '#d32f2f',
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: false, ticks: { autoSkip: stats.length > 20, maxRotation: 0 } },
          y: { beginAtZero: true, ticks: { precision: 0 } }
        },
        plugins: {
          legend: { position: 'bottom' },
          tooltip: {
            callbacks: {
              footer: items => {
                const q = stats[items[0]?.dataIndex];
                return q ? `${q.correctRate}% correct · ${q.wrongRate}% wrong` : '';
              }
            }
          }
        }
      }
    });

    const hardest = [...stats]
      .filter(q => q.attempts > 0)
      .sort((a, b) => b.wrongRate - a.wrongRate || b.wrong - a.wrong)
      .slice(0, 10);

    this.difficultyChart = new Chart(difficultyCanvas, {
      type: 'bar',
      data: {
        labels: hardest.map(q => `Q${q.questionNumber}`),
        datasets: [{
          label: 'Wrong answer rate',
          data: hardest.map(q => q.wrongRate),
          backgroundColor: hardest.map(q => q.wrongRate >= 50 ? '#d32f2f' : '#f9a825'),
          borderRadius: 5
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        scales: {
          x: { beginAtZero: true, max: 100, ticks: { callback: value => `${value}%` } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: item => `${item.parsed.x}% wrong`
            }
          }
        }
      }
    });
  }

  private destroyAnalyticsCharts() {
    this.performanceChart?.destroy();
    this.difficultyChart?.destroy();
    this.performanceChart = undefined;
    this.difficultyChart = undefined;
  }

  exportToPdf() {
     const printWindow = window.open('', '_blank');
     if (printWindow) {
       const classroomFilter = this.selectedClassroom || 'All Classrooms';
       const examFilter = this.selectedExam || 'All Exams';

       printWindow.document.write(`
         <!DOCTYPE html>
         <html>
           <head>
             <title>AcadCheck - Grade Report (PDF)</title>
             <style>
               body { font-family: Arial, sans-serif; padding: 20px; margin: 0; }
               h1 { color: #2e7d32; border-bottom: 2px solid #2e7d32; padding-bottom: 10px; }
               .report-info { margin-bottom: 20px; font-size: 14px; color: #666; }
               .stats { display: flex; gap: 20px; margin: 20px 0; flex-wrap: wrap; }
               .stat-box { border: 1px solid #ddd; padding: 15px; border-radius: 8px; min-width: 100px; text-align: center; }
               .stat-value { font-size: 24px; font-weight: bold; color: #2e7d32; }
               .stat-label { font-size: 12px; color: #666; text-transform: uppercase; }
               table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
               th { background: #f5f5f5; padding: 12px; text-align: left; font-weight: bold; border-bottom: 2px solid #ddd; }
               td { padding: 12px; border-bottom: 1px solid #ddd; }
               tr:nth-child(even) { background: #f9f9f9; }
               .grade-A { color: #2e7d32; font-weight: bold; }
               .grade-B { color: #1976d2; font-weight: bold; }
               .grade-C { color: #f57c00; font-weight: bold; }
               .grade-D { color: #d32f2f; font-weight: bold; }
               .grade-F { color: #000; font-weight: bold; }
               .status-passed { color: #2e7d32; }
               .status-failed { color: #d32f2f; }
               .footer { margin-top: 30px; font-size: 12px; color: #999; text-align: center; border-top: 1px solid #ddd; padding-top: 10px; }
               @media print {
                 .no-print { display: none; }
               }
             </style>
             <script>
               function triggerPrint() {
                 setTimeout(function() {
                   window.print();
                 }, 250);
               }
               window.onload = triggerPrint;
             </script>
           </head>
           <body onload="triggerPrint()">
             <h1>AcadCheck - Grade Report</h1>
             <div class="report-info">
               <p><strong>Classroom:</strong> ${classroomFilter}</p>
               <p><strong>Exam:</strong> ${examFilter}</p>
               <p><strong>Generated:</strong> ${new Date().toLocaleString()}</p>
             </div>

             <div class="stats">
               <div class="stat-box">
                 <div class="stat-value">${this.totalStudents}</div>
                 <div class="stat-label">Students</div>
               </div>
               <div class="stat-box">
                 <div class="stat-value">${this.passedCount}</div>
                 <div class="stat-label">Passed</div>
               </div>
               <div class="stat-box">
                 <div class="stat-value">${this.failedCount}</div>
                 <div class="stat-label">Failed</div>
               </div>
               <div class="stat-box">
                 <div class="stat-value">${this.averageScore}%</div>
                 <div class="stat-label">Average</div>
               </div>
             </div>

             <table>
               <thead>
                 <tr>
                   <th>#</th>
                   <th>Student ID</th>
                   <th>Name</th>
                   <th>Score</th>
                   <th>%</th>
                   <th>Grade</th>
                   <th>Status</th>
                   <th>Date</th>
                 </tr>
               </thead>
               <tbody>
                 ${this.filteredResults.map((r, i) => `
                   <tr>
                     <td>${i+1}</td>
                     <td>${r.studentId}</td>
                     <td>${r.studentName}</td>
                     <td>${r.score}</td>
                     <td><strong>${r.percentage}%</strong></td>
                     <td class="grade-${r.grade}">${r.grade}</td>
                     <td class="${r.status === 'Passed' ? 'status-passed' : 'status-failed'}">${r.status}</td>
                     <td>${r.date}</td>
                   </tr>
                 `).join('')}
               </tbody>
             </table>

             <div class="footer">
               <p>Generated by AcadCheck Exam Grading System</p>
             </div>
           </body>
         </html>
       `);
       printWindow.document.close();
       printWindow.focus();
       setTimeout(() => printWindow.print(), 500);
     }
   }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => this.showToast = false, 3000);
  }

  // Activity helpers
  formatAction(action: string): string {
    return action.replace(/_/g, ' ');
  }

  getActivityColor(action: string): string {
    if (action.includes('completed') || action.includes('success')) return 'success';
    if (action.includes('started')) return 'primary';
    if (action.includes('failed') || action.includes('error')) return 'danger';
    return 'medium';
  }

  getActivityIcon(action: string): string {
    if (action.includes('completed') || action.includes('success')) return 'checkmark-circle-outline';
    if (action.includes('started')) return 'play-circle-outline';
    if (action.includes('failed') || action.includes('error')) return 'alert-circle-outline';
    return 'information-circle-outline';
  }

  getTimeAgo(dateStr: string): string {
    const now = new Date();
    const d = new Date(dateStr);
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
  }
}
