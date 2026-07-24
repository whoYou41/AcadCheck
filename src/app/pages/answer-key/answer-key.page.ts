import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { 
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonGrid, 
  IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton, 
  IonIcon, IonInput, IonSelect, IonSelectOption, IonList, IonItem, IonLabel, 
  IonModal, IonBadge, IonMenuButton, IonNote, IonToast, IonTextarea
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
  keyOutline, addCircleOutline, createOutline, trashOutline, checkmarkCircleOutline, 
  closeCircleOutline, helpCircleOutline, saveOutline, eyeOutline, listOutline,
  alertCircleOutline, chevronForwardOutline, printOutline, qrCodeOutline, timeOutline, downloadOutline
} from 'ionicons/icons';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular';
import { AnswerKeyService, QuestionAnswer, AnswerKey } from '../../services/answer-key.service';
import { ClassroomService, Classroom } from '../../services/classroom.service';

@Component({
  selector: 'app-answer-key',
  templateUrl: './answer-key.page.html',
  styleUrls: ['./answer-key.page.scss'],
  standalone: true,
  imports: [
    CommonModule, FormsModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonBackButton, IonMenuButton, IonGrid, IonRow, IonCol, IonCard, IonCardHeader,
    IonCardTitle, IonCardContent, IonButton, IonIcon, IonInput, IonSelect, IonSelectOption,
    IonList, IonItem, IonLabel, IonModal, IonBadge, IonNote, IonToast, IonTextarea
  ],
})
export class AnswerKeyPage implements OnInit {
  showGuidance: boolean = false;

  // Modal controls
  showModal: boolean = false;
  showQuickEntryModal: boolean = false;
  isEditing: boolean = false;

   // Form fields
   selectedClassroomId: number | null = null;
   examTitle: string = '';
   numQuestions: number = 50;
   questions: QuestionAnswer[] = [];
   examId: number = 0;

  // Quick entry
  quickAnswers: string[] = [];
  quickAnswersString: string = '';
  quickInvalidCharacters: string[] = [];
  quickEntryTouched: boolean = false;

  // Choice options
  answerOptions = ['A', 'B', 'C', 'D'];

  // Saved answer keys
  answerKeys: AnswerKey[] = [];

  // Classrooms list
  classrooms: Classroom[] = [];

  // Toast
  toastMessage: string = '';
  showToast: boolean = false;

  constructor(
    private router: Router,
    private answerKeyService: AnswerKeyService,
    private classroomService: ClassroomService,
    private alertCtrl: AlertController
  ) {
    addIcons({
      keyOutline, addCircleOutline, createOutline, trashOutline, checkmarkCircleOutline,
      closeCircleOutline, helpCircleOutline, saveOutline, eyeOutline, listOutline,
      alertCircleOutline, chevronForwardOutline, printOutline, qrCodeOutline, timeOutline, downloadOutline
    });
  }

  ngOnInit() {
    this.loadAnswerKeys();
    this.loadClassrooms();
    this.initializeQuestions();
  }

  loadClassrooms() {
    this.classroomService.getClassrooms().subscribe({
      next: (classrooms) => {
        this.classrooms = classrooms;
      },
      error: (err) => {
        console.error('Failed to load classrooms:', err);
        this.classrooms = [];
      }
    });
  }

  loadAnswerKeys() {
    this.answerKeyService.getAnswerKeys().subscribe({
      next: (keys) => {
        this.answerKeys = keys.map(key => ({
          ...key,
          date: key.createdAt ? key.createdAt.split('T')[0] : new Date().toISOString().split('T')[0]
        }));
      },
      error: (err) => {
        console.error('Failed to load answer keys:', err);
        this.answerKeys = [];
      }
    });
  }

  initializeQuestions() {
    this.questions = Array.from({ length: 50 }, (_, i) => ({
      questionNumber: i + 1,
      choices: ['A', 'B', 'C', 'D'],
      correctAnswer: 'A'
    }));
    this.quickAnswers = [];
  }

  openModal() {
    this.resetForm();
    this.initializeQuestions();
    this.isEditing = false;
    this.showModal = true;
  }

  openQuickEntryModal() {
    this.quickAnswers = [];
    this.quickAnswersString = '';
    this.quickInvalidCharacters = [];
    this.quickEntryTouched = false;
    this.showQuickEntryModal = true;
  }

  closeModal() {
    this.showModal = false;
    this.showQuickEntryModal = false;
    this.resetForm();
  }

  onQuickEntryDismiss() {
    this.showQuickEntryModal = false;
    if (!this.showModal) {
      this.resetForm();
    }
  }

  editKey(key: AnswerKey) {
    this.examId = key.id;
    // Parse the subject field which stores classroom ID as string
    const classroomId = parseInt(key.subject);
    this.selectedClassroomId = isNaN(classroomId) ? null : classroomId;
    this.examTitle = key.examTitle;
    this.numQuestions = key.numQuestions;
    this.questions = this.answerKeyService.parseAnswerKeyToQuestions(key.answerKey, key.numQuestions);
    this.quickAnswers = this.questions.map(q => q.correctAnswer);
    this.isEditing = true;
    this.showModal = true;
  }

  deleteKey(id: number) {
    if (confirm('Delete this answer key?')) {
      this.answerKeyService.deleteAnswerKey(id).subscribe({
        next: () => {
          this.answerKeys = this.answerKeys.filter(k => k.id !== id);
          this.showToastMessage('Answer key deleted');
        },
        error: (err) => {
          console.error('Failed to delete answer key:', err);
          this.showToastMessage('Failed to delete answer key');
        }
      });
    }
  }

  setQuestionAnswer(questionNum: number, answer: string) {
    const q = this.questions.find(q => q.questionNumber === questionNum);
    if (q) q.correctAnswer = answer;
  }

  onAnswerChange(question: QuestionAnswer, event: any) {
    question.correctAnswer = event.detail.value;
  }

  getQuestionAnswer(questionNum: number): string {
    const q = this.questions.find(q => q.questionNumber === questionNum);
    return q ? q.correctAnswer : 'A';
  }

  parseQuickAnswers() {
    const raw = (this.quickAnswersString || '').toUpperCase();
    const matches = raw.match(/[A-D]/g) || [];
    const invalid = raw.match(/[^A-D0-9\s,;|/\\\-.:()[\]]/g) || [];
    this.quickAnswers = matches;
    this.quickInvalidCharacters = [...new Set(invalid)];
    this.quickEntryTouched = true;
  }

  get quickAnswerCount(): number {
    return this.quickAnswers.length;
  }

  get quickEntryProgress(): number {
    return Math.min(100, (this.quickAnswerCount / 50) * 100);
  }

  get quickEntryIsValid(): boolean {
    return this.quickAnswerCount === 50 && this.quickInvalidCharacters.length === 0;
  }

  get quickPreviewSlots(): Array<string | null> {
    return Array.from({ length: 50 }, (_, index) => this.quickAnswers[index] || null);
  }

  get quickEntryStatus(): string {
    if (!this.quickEntryTouched || !this.quickAnswersString.trim()) return 'Paste or type 50 answer letters to begin';
    if (this.quickInvalidCharacters.length > 0) {
      return `Remove unsupported character${this.quickInvalidCharacters.length === 1 ? '' : 's'}: ${this.quickInvalidCharacters.join(' ')}`;
    }
    if (this.quickAnswerCount < 50) return `${50 - this.quickAnswerCount} answer${50 - this.quickAnswerCount === 1 ? '' : 's'} remaining`;
    if (this.quickAnswerCount > 50) return `Remove ${this.quickAnswerCount - 50} extra answer${this.quickAnswerCount - 50 === 1 ? '' : 's'}`;
    return 'All 50 answers are ready';
  }

  clearQuickEntry() {
    this.quickAnswersString = '';
    this.quickAnswers = [];
    this.quickInvalidCharacters = [];
    this.quickEntryTouched = false;
  }

  useQuickEntryExample() {
    this.quickAnswersString = `${'ABCD'.repeat(12)}AB`;
    this.parseQuickAnswers();
  }

  applyQuickAnswers() {
    if (!this.quickEntryIsValid) {
      this.showToastMessage('Quick Entry requires exactly 50 valid answers');
      return;
    }
    this.questions = this.quickAnswers.map((ans, idx) => ({
      questionNumber: idx + 1,
      choices: ['A', 'B', 'C', 'D'],
      correctAnswer: ans
    }));
    this.showQuickEntryModal = false;
    this.showModal = true;
  }

  saveAnswerKey() {
    if (!this.selectedClassroomId || !this.examTitle || this.questions.length === 0) {
      this.showToastMessage('Please fill all required fields');
      return;
    }

    // Use classroom ID as the "subject" field to link answer key to classroom
    const answerKeyData = this.answerKeyService.generateAnswerKey(
      this.examTitle, 
      this.selectedClassroomId.toString(), 
      this.questions
    );
    answerKeyData.classroomId = this.selectedClassroomId;

    if (this.isEditing) {
      this.answerKeyService.updateAnswerKey(this.examId, {
        ...answerKeyData,
        id: this.examId
      } as any).subscribe({
        next: () => {
          this.loadAnswerKeys();
          this.closeModal();
          this.showToastMessage('Answer key updated');
        },
        error: (err) => {
          console.error('Failed to update answer key:', err);
          this.showToastMessage('Failed to update answer key');
        }
      });
    } else {
      this.answerKeyService.createAnswerKey({
        ...answerKeyData,
        isActive: true
      } as any).subscribe({
        next: async (createdKey) => {
          this.loadAnswerKeys();
          this.closeModal();
          this.showToastMessage('Answer key created with QR code');
          await this.askToPrintAnswerSheet(createdKey);
        },
        error: (err) => {
          console.error('Failed to create answer key:', err);
          this.showToastMessage('Failed to create answer key');
        }
      });
    }
  }

  getPreview(key: any): string {
    if (!key.answerKey) return '';
    return key.answerKey.length > 30 ? key.answerKey.substring(0, 30) + '...' : key.answerKey;
  }

  getClassroomName(classroomId: number): string {
    const classroom = this.classrooms.find(c => c.id === classroomId);
    return classroom ? `${classroom.name} ${classroom.section || ''}` : 'Unknown Classroom';
  }

  resetForm() {
    this.selectedClassroomId = null;
    this.examTitle = '';
    this.numQuestions = 50;
    this.questions = [];
    this.examId = 0;
    this.quickAnswers = [];
    this.quickAnswersString = '';
  }

  private async askToPrintAnswerSheet(key: AnswerKey) {
    const alert = await this.alertCtrl.create({
      header: 'Print QR Answer Sheet?',
      message: `The answer sheet for <strong>${key.examTitle}</strong> is ready with its QR code. Print now or keep it pending for later.`,
      buttons: [
        {
          text: 'Print Later',
          role: 'cancel',
          handler: () => this.setPrintPending(key)
        },
        {
          text: 'Prepare & Print',
          role: 'confirm',
          handler: () => this.printAnswerSheet(key)
        }
      ]
    });
    await alert.present();
  }

  printAnswerSheet(key: AnswerKey) {
    this.showToastMessage('Preparing QR answer sheet...');
    this.answerKeyService.downloadAnswerSheet(key.id).subscribe({
      next: (blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${key.examTitle.replace(/[^a-z0-9_-]+/gi, '-')}-answer-sheet.docx`;
        link.click();
        URL.revokeObjectURL(url);
        this.answerKeyService.updatePrintStatus(key.id, 'printed').subscribe({
          next: () => {
            key.printStatus = 'printed';
            this.showToastMessage('Answer sheet downloaded. Open it in Word and print.');
          },
          error: () => this.showToastMessage('Answer sheet downloaded; print status could not be updated')
        });
      },
      error: (error) => this.showToastMessage(error?.error?.message || 'Failed to prepare answer sheet')
    });
  }

  setPrintPending(key: AnswerKey) {
    this.answerKeyService.updatePrintStatus(key.id, 'pending').subscribe({
      next: () => {
        key.printStatus = 'pending';
        this.showToastMessage('Answer sheet kept pending');
      },
      error: () => this.showToastMessage('Failed to save pending status')
    });
  }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => this.showToast = false, 3000);
  }

  getAnswerLetter(qNum: number): string {
    return this.getQuestionAnswer(qNum);
  }
}
