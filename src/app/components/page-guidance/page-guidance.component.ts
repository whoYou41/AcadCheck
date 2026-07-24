import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { informationCircleOutline, closeOutline } from 'ionicons/icons';

interface PageGuidance {
  title: string;
  description: string;
  steps: string[];
}

@Component({
  selector: 'app-page-guidance',
  template: `
    <div class="guidance-container" *ngIf="isVisible">
      <div class="guidance-header" (click)="toggle()">
        <div class="guidance-icon">
          <ion-icon name="information-circle-outline"></ion-icon>
        </div>
        <span class="guidance-title">{{ pageData.title }}</span>
        <ion-button fill="clear" class="close-btn" (click)="dismiss($event)">
          <ion-icon slot="icon-only" name="close-outline"></ion-icon>
        </ion-button>
      </div>
      <div class="guidance-content" *ngIf="isExpanded">
        <p>{{ pageData.description }}</p>
        <ol class="steps-list">
          <li *ngFor="let step of pageData.steps">{{ step }}</li>
        </ol>
      </div>
    </div>
  `,
  styleUrls: ['./page-guidance.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonButton,
    IonIcon
  ]
})
export class PageGuidanceComponent {
  @Input() pageKey: string = '';

  isVisible: boolean = true;
  isExpanded: boolean = false;

  // Page-specific guidance data
  pageGuidanceData: { [key: string]: PageGuidance } = {
    'exam-upload': {
      title: 'How to Upload Exam Papers',
      description: 'Follow these steps to scan and upload exam papers for scoring:',
      steps: [
        'Tap the camera icon (top right) to use ESP32-CAM scanner, OR',
        'Tap the upload area to select a file from your device',
        'Fill in the exam details (title, subject, type, grade level)',
        'Tap "Upload Exam Paper" to save the exam'
      ]
    },
    'answer-key': {
      title: 'Creating Answer Keys',
      description: 'An answer key is required to score exam papers. Here\'s how to create one:',
      steps: [
        'Tap "Create New Answer Key" button',
        'Select the subject and enter exam title',
        'Enter the number of questions',
        'Enter the answer key as a continuous string (e.g., AABBCDDBAC...)',
        'Review the preview and save'
      ]
    },
    'scoring': {
      title: 'Automated Scoring Process',
      description: 'Compare exam papers with answer keys to get instant scores:',
      steps: [
        'Select the exam paper from the dropdown',
        'Select the matching answer key',
        'Tap "Start Scoring" to begin the process',
        'Wait for scoring to complete',
        'View the results summary (average, highest, lowest scores, pass rate)'
      ]
    },
    'results': {
      title: 'Viewing & Recording Scores',
      description: 'Access and manage all student scores:',
      steps: [
        'View the list of all student results with scores',
        'Use search to find a specific student',
        'Filter by exam type or pass/fail status',
        'Tap export button to download results',
        'Tap print button to print results'
      ]
    }
  };

  constructor() {
    addIcons({
      informationCircleOutline,
      closeOutline
    });
  }

  get pageData(): PageGuidance {
    return this.pageGuidanceData[this.pageKey] || {
      title: 'Guidance',
      description: '',
      steps: []
    };
  }

  toggle() {
    this.isExpanded = !this.isExpanded;
  }

  dismiss(event: Event) {
    event.stopPropagation();
    this.isVisible = false;
  }
}
