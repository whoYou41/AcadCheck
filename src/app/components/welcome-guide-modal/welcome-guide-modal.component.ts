import { Component, Input, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonContent, IonButton, IonIcon, IonModal } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { 
  documentTextOutline, 
  keyOutline, 
  calculatorOutline, 
  peopleOutline,
  checkmarkCircleOutline,
  informationCircleOutline,
  arrowForwardOutline,
  arrowBackOutline
} from 'ionicons/icons';

interface GuideStep {
  step: number;
  title: string;
  description: string;
  icon: string;
  page: string;
}

@Component({
  selector: 'app-welcome-guide-modal',
  template: `
    <ion-modal [isOpen]="isOpen" (didDismiss)="closeModal()" class="welcome-guide-modal">
      <ng-template>
        <ion-content class="guide-content">
          <!-- Header -->
          <div class="guide-header">
            <div class="guide-icon">
              <ion-icon name="information-circle-outline"></ion-icon>
            </div>
            <h2>Welcome to AcadCheck!</h2>
            <p>Here's how to scan and score exam papers</p>
          </div>

          <!-- Progress Dots -->
          <div class="progress-dots">
            <span 
              *ngFor="let step of guideSteps; let i = index" 
              class="dot" 
              [class.active]="i === currentStep"
              [class.completed]="i < currentStep">
            </span>
          </div>

          <!-- Current Step -->
          <div class="step-content" *ngIf="currentGuide">
            <div class="step-icon">
              <ion-icon [name]="currentGuide.icon"></ion-icon>
            </div>
            <h3>Step {{ currentGuide.step }}: {{ currentGuide.title }}</h3>
            <p>{{ currentGuide.description }}</p>
          </div>

          <!-- Navigation Buttons -->
          <div class="navigation-buttons">
            <ion-button 
              fill="outline" 
              (click)="prevStep()" 
              [disabled]="isFirstStep"
              class="nav-btn prev-btn">
              <ion-icon slot="start" name="arrow-back-outline"></ion-icon>
              Previous
            </ion-button>
            
            <ion-button 
              (click)="isLastStep ? closeModal() : nextStep()"
              class="nav-btn next-btn">
              {{ isLastStep ? 'Get Started' : 'Next' }}
              <ion-icon slot="end" [name]="isLastStep ? 'checkmark-circle-outline' : 'arrow-forward-outline'"></ion-icon>
            </ion-button>
          </div>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styleUrls: ['./welcome-guide-modal.component.scss'],
  standalone: true,
  imports: [
    CommonModule,
    IonContent,
    IonButton,
    IonIcon,
    IonModal
  ]
})
export class WelcomeGuideModalComponent {
  @Input() isOpen: boolean = false;
  @Output() closed = new EventEmitter<void>();

  currentStep: number = 0;

  guideSteps: GuideStep[] = [
    {
      step: 1,
      title: 'Upload Exam Paper',
      description: 'Start by scanning or uploading the exam paper using the camera or file upload option.',
      icon: 'document-text-outline',
      page: '/exam-upload'
    },
    {
      step: 2,
      title: 'Create Answer Key',
      description: 'Create or verify the answer key that will be used to grade the exam papers.',
      icon: 'key-outline',
      page: '/answer-key'
    },
    {
      step: 3,
      title: 'Start Scoring',
      description: 'Select the exam paper and answer key, then run the automated scoring process.',
      icon: 'calculator-outline',
      page: '/scoring'
    },
    {
      step: 4,
      title: 'View Results',
      description: 'Access the results page to view, record, export, and manage all student scores.',
      icon: 'people-outline',
      page: '/results'
    }
  ];

  constructor() {
    addIcons({
      documentTextOutline,
      keyOutline,
      calculatorOutline,
      peopleOutline,
      checkmarkCircleOutline,
      informationCircleOutline,
      arrowForwardOutline,
      arrowBackOutline
    });
  }

  nextStep() {
    if (this.currentStep < this.guideSteps.length - 1) {
      this.currentStep++;
    }
  }

  prevStep() {
    if (this.currentStep > 0) {
      this.currentStep--;
    }
  }

  closeModal() {
    this.currentStep = 0;
    this.closed.emit();
  }

  get currentGuide(): GuideStep {
    return this.guideSteps[this.currentStep];
  }

  get isLastStep(): boolean {
    return this.currentStep === this.guideSteps.length - 1;
  }

  get isFirstStep(): boolean {
    return this.currentStep === 0;
  }
}
