import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonGrid,
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton,
  IonIcon, IonSelect, IonSelectOption, IonList, IonItem, IonLabel,
  IonBadge, IonMenuButton, IonModal, IonNote, IonToast, IonInput, IonCardSubtitle,
  IonCheckbox
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  peopleOutline, schoolOutline, documentTextOutline,
  checkmarkCircleOutline, closeCircleOutline, timeOutline,
  createOutline, trashOutline, downloadOutline, saveOutline,
  analyticsOutline, bulbOutline, closeOutline
} from 'ionicons/icons';
import { RecordsService, RecordRow } from '../../services/records.service';
import { ClassroomService } from '../../services/classroom.service';
import { ExamResponse, ExamScanService } from '../../services/exam-scan.service';

interface StudentAnalysis {
  attempts: number;
  averageAccuracy: number;
  bestAccuracy: number;
  latestAccuracy: number;
  correctAnswers: number;
  totalAnswers: number;
  trend: 'improving' | 'declining' | 'steady' | 'insufficient';
  strengths: string[];
  reviewAreas: string[];
  feedback: string;
  recommendations: string[];
}

@Component({
  selector: 'app-records',
  templateUrl: './records.page.html',
  styleUrls: ['./records.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonMenuButton, IonSelect, IonSelectOption, IonGrid,
    IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonList,
    IonItem, IonLabel, IonBadge, IonButton, IonIcon, IonModal, IonNote, IonToast, IonInput, IonCardSubtitle,
    IonCheckbox
  ],
})
export class RecordsPage implements OnInit {
  records: RecordRow[] = [];
  filteredRecords: RecordRow[] = [];
  classrooms: any[] = [];
  exams: any[] = [];

  searchQuery: string = '';
  selectedClassroomId: number | null = null;
  selectedExamTitle: string = '';
  sortMode: 'date_desc' | 'date_asc' | 'name_asc' | 'name_desc' | 'gender_male_first' | 'rank_desc' = 'date_desc';

  isLoading = false;
  deletingResponseIds = new Set<number>();
  selectedResponseIds = new Set<number>();
  isBulkDeleting = false;

  // Toast
  toastMessage: string = '';
  showToast: boolean = false;

  // Edit modal
  showEditModal = false;
  editingRecord: RecordRow | null = null;
  editScore: number | null = null;
  editPercentage: number | null = null;

  // Export modal
  showExportModal = false;
  exportClassroomId: number | null = null;

  // Student analysis modal
  showStudentModal = false;
  selectedStudent: RecordRow | null = null;
  studentAnalysis: StudentAnalysis | null = null;
  isStudentAnalysisLoading = false;

  constructor(
    private router: Router,
    private recordsService: RecordsService,
    private classroomService: ClassroomService,
    private examScanService: ExamScanService
  ) {
    addIcons({
      peopleOutline, schoolOutline, documentTextOutline,
      checkmarkCircleOutline, closeCircleOutline, timeOutline,
      createOutline, trashOutline, downloadOutline, saveOutline,
      analyticsOutline, bulbOutline, closeOutline
    });
  }

  ngOnInit() {
    this.loadClassrooms();
    this.loadRecords();
  }

  loadClassrooms() {
    this.classroomService.getClassrooms().subscribe({
      next: (data) => {
        this.classrooms = data;
      },
      error: () => { this.classrooms = []; }
    });
  }

  loadRecords() {
    this.isLoading = true;
    this.recordsService.getRecords({
      classroom_id: this.selectedClassroomId || undefined
    }).subscribe({
      next: (records) => {
        this.records = records;
        this.exams = [...new Set(records.map(r => r.exam_title).filter((title): title is string => !!title))]
          .sort((a, b) => a.localeCompare(b));
        this.selectedResponseIds.clear();
        this.applyFilters();
        this.isLoading = false;
      },
      error: () => {
        this.records = [];
        this.filteredRecords = [];
        this.isLoading = false;
        this.showToastMessage('Failed to load records');
      }
    });
  }

  onClassroomChange() {
    this.loadRecords();
  }

  applyFilters() {
    const filtered = this.records.filter(r => {
      const matchesSearch = !this.searchQuery ||
        `${r.first_name} ${r.last_name}`.toLowerCase().includes(this.searchQuery.toLowerCase()) ||
        r.student_number.toLowerCase().includes(this.searchQuery.toLowerCase());

      const matchesExam = !this.selectedExamTitle || this.selectedExamTitle === 'All Exams' || r.exam_title === this.selectedExamTitle;

      return matchesSearch && matchesExam;
    });

    this.filteredRecords = [...filtered].sort((a, b) => this.compareRecords(a, b));
    const visibleIds = new Set(this.getSelectableRecords().map(r => r.response_id as number));
    this.selectedResponseIds = new Set([...this.selectedResponseIds].filter(id => visibleIds.has(id)));
  }

  private compareRecords(a: RecordRow, b: RecordRow): number {
    const byName = () => this.getStudentName(a).localeCompare(this.getStudentName(b), undefined, { sensitivity: 'base' });
    const aDate = a.graded_at ? new Date(a.graded_at).getTime() : Number.NaN;
    const bDate = b.graded_at ? new Date(b.graded_at).getTime() : Number.NaN;

    switch (this.sortMode) {
      case 'date_asc':
        if (Number.isNaN(aDate)) return Number.isNaN(bDate) ? byName() : 1;
        if (Number.isNaN(bDate)) return -1;
        return aDate - bDate || byName();
      case 'name_asc':
        return byName();
      case 'name_desc':
        return -byName();
      case 'gender_male_first': {
        const order = { male: 0, female: 1 } as const;
        const aGender = a.gender ? order[a.gender] : 2;
        const bGender = b.gender ? order[b.gender] : 2;
        return aGender - bGender || byName();
      }
      case 'rank_desc': {
        const aPercentage = a.percentage == null ? -1 : Number(a.percentage);
        const bPercentage = b.percentage == null ? -1 : Number(b.percentage);
        const aScore = a.total_score == null ? -1 : Number(a.total_score);
        const bScore = b.total_score == null ? -1 : Number(b.total_score);
        return bPercentage - aPercentage || bScore - aScore || byName();
      }
      case 'date_desc':
      default:
        if (Number.isNaN(aDate)) return Number.isNaN(bDate) ? byName() : 1;
        if (Number.isNaN(bDate)) return -1;
        return bDate - aDate || byName();
    }
  }

  onSearchChange(event: any) {
    this.searchQuery = event.detail.value || '';
    this.applyFilters();
  }

  onExamChange(event: any) {
    this.selectedExamTitle = event.detail.value || '';
    this.applyFilters();
  }

  onSortChange() {
    this.applyFilters();
  }

  getSelectableRecords(): RecordRow[] {
    return this.filteredRecords.filter(r => r.response_id != null);
  }

  get selectedCount(): number {
    return this.selectedResponseIds.size;
  }

  isRecordSelected(record: RecordRow): boolean {
    return record.response_id != null && this.selectedResponseIds.has(record.response_id);
  }

  toggleRecordSelection(record: RecordRow, event: CustomEvent) {
    if (record.response_id == null) return;
    const next = new Set(this.selectedResponseIds);
    if (event.detail.checked) next.add(record.response_id);
    else next.delete(record.response_id);
    this.selectedResponseIds = next;
  }

  toggleSelectAll(event: CustomEvent) {
    this.selectedResponseIds = event.detail.checked
      ? new Set(this.getSelectableRecords().map(r => r.response_id as number))
      : new Set<number>();
  }

  areAllVisibleSelected(): boolean {
    const records = this.getSelectableRecords();
    return records.length > 0 && records.every(r => this.selectedResponseIds.has(r.response_id as number));
  }

  areSomeVisibleSelected(): boolean {
    return this.selectedCount > 0 && !this.areAllVisibleSelected();
  }

  deleteSelectedResults() {
    const ids = [...this.selectedResponseIds];
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected exam result(s)? Student profiles will be kept.`)) return;
    this.bulkDeleteResults(ids);
  }

  deleteAllVisibleResults() {
    const ids = this.getSelectableRecords().map(r => r.response_id as number);
    if (ids.length === 0) return;
    if (!confirm(`Delete all ${ids.length} exam result(s) in the current view? Student profiles will be kept.`)) return;
    this.bulkDeleteResults(ids);
  }

  private bulkDeleteResults(ids: number[]) {
    this.isBulkDeleting = true;
    this.recordsService.deleteResponses(ids).subscribe({
      next: (response) => {
        this.isBulkDeleting = false;
        this.selectedResponseIds.clear();
        this.loadRecords();
        this.showToastMessage(response.message || `${ids.length} result(s) deleted`);
      },
      error: (error) => {
        this.isBulkDeleting = false;
        this.showToastMessage(error?.error?.message || 'Failed to delete selected results');
      }
    });
  }

  getGenderLabel(record: RecordRow): string {
    if (!record.gender) return 'Not set';
    return record.gender === 'male' ? 'Male' : 'Female';
  }

  getStudentName(r: RecordRow): string {
    return `${r.first_name} ${r.middle_name ? r.middle_name + ' ' : ''}${r.last_name}`.trim() || 'Unknown';
  }

  getClassroomName(r: RecordRow): string {
    const section = r.classroom_section ? ` ${r.classroom_section}` : '';
    return `${r.classroom_name}${section}`;
  }

  getStatus(r: RecordRow): string {
    if (!r.response_id) return 'No Result';
    return r.is_graded ? 'Graded' : 'Not Graded';
  }

  openStudentModal(record: RecordRow) {
    this.selectedStudent = record;
    this.studentAnalysis = null;
    this.showStudentModal = true;
    this.isStudentAnalysisLoading = true;

    this.examScanService.getStudentResults(record.student_id).subscribe({
      next: (responses) => {
        this.studentAnalysis = this.buildStudentAnalysis(responses);
        this.isStudentAnalysisLoading = false;
      },
      error: () => {
        this.isStudentAnalysisLoading = false;
        this.showToastMessage('Failed to load student analysis');
      }
    });
  }

  closeStudentModal() {
    this.showStudentModal = false;
    this.selectedStudent = null;
    this.studentAnalysis = null;
    this.isStudentAnalysisLoading = false;
  }

  private buildStudentAnalysis(responses: ExamResponse[]): StudentAnalysis {
    const graded = responses
      .filter(response => response.isGraded)
      .sort((a, b) => new Date(a.gradedAt || a.createdAt).getTime() - new Date(b.gradedAt || b.createdAt).getTime());
    const questionTotals = new Map<number, { correct: number; attempts: number }>();
    let correctAnswers = 0;
    let totalAnswers = 0;

    const accuracies = graded.map(response => {
      const scores = Object.entries(response.scorePerQuestion || {});
      let correct = 0;
      scores.forEach(([question, score]) => {
        const questionNumber = Number(question);
        const isCorrect = Number(score) > 0;
        const aggregate = questionTotals.get(questionNumber) || { correct: 0, attempts: 0 };
        aggregate.attempts++;
        if (isCorrect) {
          aggregate.correct++;
          correct++;
        }
        questionTotals.set(questionNumber, aggregate);
      });
      correctAnswers += correct;
      totalAnswers += scores.length;
      return scores.length ? (correct / scores.length) * 100 : 0;
    });

    const rankedQuestions = [...questionTotals.entries()].map(([question, value]) => ({
      question,
      rate: value.attempts ? (value.correct / value.attempts) * 100 : 0
    }));
    const strengths = rankedQuestions
      .filter(item => item.rate >= 75)
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 5)
      .map(item => `Question ${item.question}`);
    const reviewAreas = rankedQuestions
      .filter(item => item.rate < 60)
      .sort((a, b) => a.rate - b.rate)
      .slice(0, 5)
      .map(item => `Question ${item.question}`);

    const averageAccuracy = totalAnswers ? (correctAnswers / totalAnswers) * 100 : 0;
    const latestAccuracy = accuracies.length ? accuracies[accuracies.length - 1] : 0;
    const firstAccuracy = accuracies[0] || 0;
    const change = latestAccuracy - firstAccuracy;
    const trend: StudentAnalysis['trend'] = accuracies.length < 2
      ? 'insufficient'
      : change >= 5 ? 'improving' : change <= -5 ? 'declining' : 'steady';

    let feedback = 'No graded answers are available yet. Complete and grade an assessment to generate personalized feedback.';
    if (graded.length) {
      feedback = averageAccuracy >= 90
        ? 'Excellent mastery. The student consistently demonstrates a strong understanding of the assessed material.'
        : averageAccuracy >= 75
          ? 'Good progress. The student understands most concepts and would benefit from focused review of missed items.'
          : averageAccuracy >= 60
            ? 'Developing understanding. The student has a workable foundation but needs additional guided practice.'
            : 'The student needs targeted support to strengthen core concepts and improve assessment confidence.';
    }

    const recommendations: string[] = [];
    if (reviewAreas.length) recommendations.push(`Review ${reviewAreas.join(', ')} and discuss why the selected answers were incorrect.`);
    if (trend === 'declining') recommendations.push('Schedule a short check-in and revisit recent lessons before the next assessment.');
    if (trend === 'improving') recommendations.push('Continue the current study approach and reinforce progress with slightly more challenging practice.');
    if (graded.length && averageAccuracy < 75) recommendations.push('Use short, spaced practice sessions and provide immediate feedback after each attempt.');
    if (graded.length && !recommendations.length) recommendations.push('Maintain performance through enrichment tasks and periodic review.');
    if (!graded.length) recommendations.push('Grade at least one assessment to unlock question-level recommendations.');

    return {
      attempts: graded.length,
      averageAccuracy: Math.round(averageAccuracy),
      bestAccuracy: Math.round(accuracies.length ? Math.max(...accuracies) : 0),
      latestAccuracy: Math.round(latestAccuracy),
      correctAnswers,
      totalAnswers,
      trend,
      strengths,
      reviewAreas,
      feedback,
      recommendations
    };
  }

  calculateGradingPercentage(score: number | null): number {
    const validScore = Math.max(0, Math.min(50, Number(score) || 0));
    return Number(((validScore / 50) * 40).toFixed(2));
  }

  updateEditPercentage() {
    this.editPercentage = this.calculateGradingPercentage(this.editScore);
  }

  // Score editing
  openEditModal(record: RecordRow) {
    if (!record.response_id) return;
    this.editingRecord = record;
    this.editScore = record.total_score;
    this.editPercentage = this.calculateGradingPercentage(record.total_score);
    this.showEditModal = true;
  }

  closeEditModal() {
    this.showEditModal = false;
    this.editingRecord = null;
    this.editScore = null;
    this.editPercentage = null;
  }

  saveScore() {
    if (!this.editingRecord || !this.editingRecord.response_id) return;
    this.updateEditPercentage();
    this.recordsService.updateScore(this.editingRecord.response_id, this.editScore ?? 0, this.editPercentage ?? 0).subscribe({
      next: (response) => {
        const record = this.records.find(r => r.response_id === this.editingRecord!.response_id);
        if (record) {
          record.total_score = Number(response?.response?.total_score ?? this.editScore ?? 0);
          record.percentage = Number(response?.response?.percentage ?? this.editPercentage ?? 0);
        }
        this.applyFilters();
        this.closeEditModal();
        this.showToastMessage('Score updated');
      },
      error: () => {
        this.showToastMessage('Failed to update score');
      }
    });
  }

  deleteScore(record: RecordRow) {
    const responseId = record.response_id;
    if (!responseId || this.deletingResponseIds.has(responseId)) return;
    if (!confirm('Delete this exam result?')) return;
    this.deletingResponseIds.add(responseId);
    this.recordsService.deleteResponse(responseId).subscribe({
      next: () => {
        this.deletingResponseIds.delete(responseId);
        this.selectedResponseIds.delete(responseId);
        this.loadRecords();
        this.showToastMessage('Result deleted');
      },
      error: (error) => {
        this.deletingResponseIds.delete(responseId);
        this.showToastMessage(error?.error?.message || 'Failed to delete result');
      }
    });
  }

  isDeletingScore(record: RecordRow): boolean {
    return record.response_id != null && this.deletingResponseIds.has(record.response_id);
  }

  // Student editing
  openEditStudentModal(record: RecordRow) {
    // Navigate to students page for editing (reuse existing flow)
    this.router.navigate(['/students'], { queryParams: { edit: record.student_id } });
  }

  deleteStudent(record: RecordRow) {
    if (!confirm(`Delete student ${this.getStudentName(record)}? This will also remove all related scans and results.`)) return;
    this.recordsService.deleteStudent(record.student_id).subscribe({
      next: () => {
        this.records = this.records.filter(r => r.student_id !== record.student_id);
        this.applyFilters();
        this.showToastMessage('Student deleted');
      },
      error: () => {
        this.showToastMessage('Failed to delete student');
      }
    });
  }

  // Export
  openExportModal() {
    this.exportClassroomId = this.selectedClassroomId;
    this.showExportModal = true;
  }

  closeExportModal() {
    this.showExportModal = false;
  }

  confirmExport() {
    this.showExportModal = false;
    const classroomId = this.exportClassroomId || undefined;
    this.recordsService.exportRecords(classroomId).subscribe({
      next: (blob: Blob) => {
        const label = classroomId
          ? this.classrooms.find(c => c.id === classroomId)?.name || 'classroom'
          : 'all-classrooms';
        const fileName = `records-${label.replace(/\s+/g, '-').toLowerCase()}.xlsx`;
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        window.URL.revokeObjectURL(url);
        this.showToastMessage('Excel exported successfully');
      },
      error: () => {
        this.showToastMessage('Failed to export Excel');
      }
    });
  }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => (this.showToast = false), 3000);
  }
}
