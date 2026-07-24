import { Component, OnInit, OnDestroy, ViewChild, ElementRef, AfterViewChecked } from '@angular/core';
import { CommonModule } from '@angular/common';
import {
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
  IonGrid, IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent,
  IonCardSubtitle, IonButton, IonIcon, IonBadge, IonMenuButton, IonList, IonItem, IonLabel,
  IonSpinner, IonToast
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  refreshOutline, schoolOutline, documentTextOutline,
  peopleOutline, checkmarkCircleOutline, timeOutline, closeCircleOutline,
  schoolSharp, analyticsOutline, scanOutline, warningOutline
} from 'ionicons/icons';
import { DashboardService, DashboardStats, RealtimeEvent, QuestionerRankingItem } from '../../services/dashboard.service';
import { QuestionerChartComponent } from '../../components/questioner-chart/questioner-chart.component';

declare const Chart: any;

@Component({
  selector: 'page-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonGrid,
    IonRow,
    IonCol,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonCardSubtitle,
    IonButton,
    IonIcon,
    IonBadge,
    IonMenuButton,
    IonList,
    IonItem,
    IonLabel,
    IonSpinner,
    IonToast,
    QuestionerChartComponent
  ],
})
export class DashboardPage implements OnInit, OnDestroy {
  stats: DashboardStats | null = null;
  isLoading = true;
  showRealtimeStatus = true;
  isRealtimeConnected = false;
  lastUpdated = new Date();
  toastMessage = '';
  showToast = false;

  loadStats() {
    this.isLoading = true;
    this.dashboardService.loadDashboardStats().subscribe({
      next: (stats: DashboardStats) => {
        this.stats = stats;
        this.lastUpdated = new Date();
        this.isLoading = false;
        this.renderCharts(stats);
      },
      error: () => {
        this.isLoading = false;
        this.showToastMessage('Failed to load dashboard data');
      }
    });
  }

  @ViewChild('scanChart', { static: false }) scanChartRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('scanDistribution', { static: false }) scanDistributionRef!: ElementRef<HTMLCanvasElement>;

  charts: any[] = [];

  constructor(private dashboardService: DashboardService) {
    addIcons({
      refreshOutline, schoolOutline, documentTextOutline,
      peopleOutline, checkmarkCircleOutline, timeOutline, closeCircleOutline,
      schoolSharp, analyticsOutline, scanOutline, warningOutline
    });
  }

  ngOnInit() {
    this.loadStats();
    this.setupRealtime();
  }

  ngOnDestroy() {
    this.dashboardService.disconnectRealtime();
    this.charts.forEach((chart) => {
      try {
        chart.destroy();
      } catch {
        // ignore chart destroy errors
      }
    });
    this.charts = [];
  }

  ngAfterViewChecked() {
    if (this.stats) {
      this.updateChartsLater(this.stats);
    }
  }

  refresh() {
    this.loadStats();
  }

  private renderCharts(stats: DashboardStats) {
    this.charts.forEach((chart) => {
      try {
        chart.destroy();
      } catch {
        // ignore chart destroy errors
      }
    });
    this.charts = [];

    const scansCtx = this.scanChartRef?.nativeElement;
    const distCtx = this.scanDistributionRef?.nativeElement;

    const colorTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? {
          text: '#e6e6e6',
          grid: '#333'
        }
      : {
          text: '#222',
          grid: '#e6e6e6'
        };

    if (scansCtx) {
      this.charts.push(
        (Chart as any)
          ? new (Chart as any)(scansCtx, {
              type: 'bar',
              data: {
                labels: ['Total', 'Completed', 'Pending', 'Failed'],
                datasets: [
                  {
                    label: 'Total Scans',
                    data: [
                      stats.scans.total_scans,
                      stats.scans.completed_scans,
                      stats.scans.pending_scans,
                      stats.scans.failed_scans
                    ],
                    backgroundColor: [
                      'rgba(54, 162, 235, 0.7)',
                      'rgba(75, 192, 192, 0.7)',
                      'rgba(255, 205, 86, 0.7)',
                      'rgba(255, 99, 132, 0.7)'
                    ],
                    borderColor: [
                      'rgb(54, 162, 235)',
                      'rgb(75, 192, 192)',
                      'rgb(255, 205, 86)',
                      'rgb(255, 99, 132)'
                    ],
                    borderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: colorTheme.text } } },
                scales: {
                  y: { ticks: { color: colorTheme.text }, grid: { color: colorTheme.grid } },
                  x: { ticks: { color: colorTheme.text }, grid: { color: colorTheme.grid } }
                }
              }
            })
          : null
      );
    }

    if (distCtx) {
      this.charts.push(
        (Chart as any)
          ? new (Chart as any)(distCtx, {
              type: 'bar',
              data: {
                labels: ['Passed', 'Failed'],
                datasets: [
                  {
                    label: 'Exam Results',
                    data: [stats.exams.passed_count, stats.exams.failed_count],
                    backgroundColor: [
                      'rgba(75, 192, 192, 0.7)',
                      'rgba(255, 99, 132, 0.7)'
                    ],
                    borderColor: ['rgb(75, 192, 192)', 'rgb(255, 99, 132)'],
                    borderWidth: 1
                  }
                ]
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { labels: { color: colorTheme.text } } },
                scales: {
                  y: { ticks: { color: colorTheme.text }, grid: { color: colorTheme.grid } },
                  x: { ticks: { color: colorTheme.text }, grid: { color: colorTheme.grid } }
                }
              }
            })
          : null
      );
    }
  }

  private updateChartsLater(stats: DashboardStats) {
    if (this.charts.length === 0) {
      this.renderCharts(stats);
      return;
    }

    if (this.charts[0]) {
      this.charts[0].data.datasets[0].data = [
        stats.scans.total_scans,
        stats.scans.completed_scans,
        stats.scans.pending_scans,
        stats.scans.failed_scans
      ];
      try {
        this.charts[0].update('none');
      } catch {
        // ignore chart update errors
      }
    }

    if (this.charts[1]) {
      this.charts[1].data.datasets[0].data = [stats.exams.passed_count, stats.exams.failed_count];
      try {
        this.charts[1].update('none');
      } catch {
        // ignore chart update errors
      }
    }
  }

  setupRealtime() {
    this.dashboardService.events$.subscribe((event: RealtimeEvent) => {
      if (event.type === 'connected') {
        this.isRealtimeConnected = true;
      } else if (event.type === 'scan_event' || event.type === 'activity_event') {
        this.showRealtimeStatus = true;
        this.stats = this.dashboardService.stats();
        this.lastUpdated = new Date();
        if (this.stats) {
          this.updateChartsLater(this.stats);
        }
      }
    });
    setTimeout(() => this.dashboardService.connectRealtime(), 500);
  }

  getPassRate(): number {
    if (!this.stats || !this.stats.exams?.total_exam_responses) {
      return 0;
    }
    return Math.round((this.stats.exams.passed_count / this.stats.exams.total_exam_responses) * 100);
  }

  formatDate(dateString: string): string {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    return date.toLocaleDateString();
  }

  getStatusBadgeColor(status: string): string {
    switch (status) {
      case 'completed':
        return 'success';
      case 'processing':
        return 'warning';
      case 'pending':
        return 'medium';
      case 'failed':
        return 'danger';
      default:
        return 'medium';
    }
  }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => (this.showToast = false), 5000);
  }

  getTotalScans(): number {
    return this.stats?.scans?.total_scans ?? 0;
  }

  getPendingScans(): number {
    return this.stats?.scans?.pending_scans ?? 0;
  }

  getCompletedScans(): number {
    return this.stats?.scans?.completed_scans ?? 0;
  }

  getFailedScans(): number {
    return this.stats?.scans?.failed_scans ?? 0;
  }

  getTotalStudents(): number {
    return this.stats?.students?.total_students ?? 0;
  }

  getTotalClassrooms(): number {
    return this.stats?.classrooms?.total_classrooms ?? 0;
  }

  getTotalAnswerKeys(): number {
    return this.stats?.answerKeys?.total_answer_keys ?? 0;
  }

  getTotalExamResponses(): number {
    return this.stats?.exams?.total_exam_responses ?? 0;
  }

  formatActionTitle(action: string): string {
    if (!action) {
      return '';
    }
    return action
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (char: string) => char.toUpperCase());
  }

  getQuestionerRanking(): QuestionerRankingItem[] {
    if (!this.stats?.questionerRanking) {
      return [];
    }
    // Convert accuracyRate from DB (percentage 0-100) to 0-1 for the chart component
    return this.stats.questionerRanking.map(item => ({
      ...item,
      accuracyRate: item.accuracyRate / 100
    }));
  }
}
