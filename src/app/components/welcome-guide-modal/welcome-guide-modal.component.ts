import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonButton, IonContent, IonIcon, IonModal } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  analyticsOutline,
  arrowBackOutline,
  arrowForwardOutline,
  checkmarkCircleOutline,
  documentTextOutline,
  keyOutline,
  peopleOutline,
  personCircleOutline,
  scanOutline,
  schoolOutline
} from 'ionicons/icons';

interface GuideStep {
  label: string;
  title: string;
  description: string;
  detail: string;
  icon: string;
}

@Component({
  selector: 'app-welcome-guide-modal',
  template: `
    <ion-modal [isOpen]="isOpen" [backdropDismiss]="false" class="welcome-guide-modal">
      <ng-template>
        <ion-content class="guide-content">
          <div class="guide-header">
            <div class="guide-topline">
              <span>AcadCheck feature tour</span>
              <ion-button fill="clear" size="small" (click)="skipAll()">Skip all</ion-button>
            </div>
            <div class="guide-icon"><ion-icon name="school-outline"></ion-icon></div>
            <h2>{{ currentStep === 0 ? 'Welcome to AcadCheck' : currentGuide.title }}</h2>
            <p>{{ currentStep === 0
              ? 'A quick tour of the tools that help you manage classes and assess students.'
              : currentGuide.description }}</p>
          </div>

          <div class="guide-progress" role="progressbar"
            [attr.aria-valuenow]="currentStep + 1"
            [attr.aria-valuemax]="guideSteps.length">
            <div class="progress-copy">
              <span>Step {{ currentStep + 1 }} of {{ guideSteps.length }}</span>
              <span>{{ progressPercent }}%</span>
            </div>
            <div class="progress-track"><span [style.width.%]="progressPercent"></span></div>
          </div>

          <div class="step-content">
            <div class="step-icon"><ion-icon [name]="currentGuide.icon"></ion-icon></div>
            <div>
              <span class="feature-label">{{ currentGuide.label }}</span>
              <h3>{{ currentGuide.title }}</h3>
              <p>{{ currentGuide.detail }}</p>
            </div>
          </div>

          <div class="navigation-buttons">
            <ion-button fill="outline" (click)="prevStep()" [class.invisible]="isFirstStep" class="nav-btn prev-btn">
              <ion-icon slot="start" name="arrow-back-outline"></ion-icon>
              Previous
            </ion-button>
            <ion-button (click)="isLastStep ? finishGuide() : nextStep()" class="nav-btn next-btn">
              {{ isLastStep ? 'Start using AcadCheck' : 'Next feature' }}
              <ion-icon slot="end" [name]="isLastStep ? 'checkmark-circle-outline' : 'arrow-forward-outline'"></ion-icon>
            </ion-button>
          </div>
        </ion-content>
      </ng-template>
    </ion-modal>
  `,
  styleUrls: ['./welcome-guide-modal.component.scss'],
  standalone: true,
  imports: [CommonModule, IonContent, IonButton, IonIcon, IonModal]
})
export class WelcomeGuideModalComponent {
  @Input() isOpen = false;
  @Output() closed = new EventEmitter<void>();

  currentStep = 0;

  guideSteps: GuideStep[] = [
    {
      label: 'Organize',
      title: 'Students and classrooms',
      description: 'Build your class lists before grading.',
      detail: 'Create classrooms, add students individually, or import student lists so every scanned response is matched to the correct learner.',
      icon: 'people-outline'
    },
    {
      label: 'Prepare',
      title: 'Create answer keys',
      description: 'Define the correct answers for each assessment.',
      detail: 'Create reusable answer keys, enter answers quickly, and select the matching key before scanning student sheets.',
      icon: 'key-outline'
    },
    {
      label: 'Automate',
      title: 'Scan and score',
      description: 'Turn completed answer sheets into results.',
      detail: 'Use the camera or upload an image. AcadCheck detects the sheet, reads marked answers, and calculates the score automatically.',
      icon: 'scan-outline'
    },
    {
      label: 'Understand',
      title: 'Results and analysis',
      description: 'See class performance at a glance.',
      detail: 'Filter results, review question-level analytics, identify difficult topics, and use automated recommendations to guide instruction.',
      icon: 'analytics-outline'
    },
    {
      label: 'Review',
      title: 'Student records and insights',
      description: 'Keep a clear history for every learner.',
      detail: 'Open a student from Records to see assessment history, accuracy trends, personalized feedback, strengths, and areas needing review.',
      icon: 'document-text-outline'
    },
    {
      label: 'Manage',
      title: 'Profile, exports, and support',
      description: 'Keep your workspace useful and accessible.',
      detail: 'Manage your account, export reports, switch themes, and reopen this guide anytime from the navigation menu.',
      icon: 'person-circle-outline'
    }
  ];

  constructor() {
    addIcons({
      analyticsOutline,
      arrowBackOutline,
      arrowForwardOutline,
      checkmarkCircleOutline,
      documentTextOutline,
      keyOutline,
      peopleOutline,
      personCircleOutline,
      scanOutline,
      schoolOutline
    });
  }

  nextStep() {
    if (!this.isLastStep) this.currentStep++;
  }

  prevStep() {
    if (!this.isFirstStep) this.currentStep--;
  }

  finishGuide() {
    this.dismiss();
  }

  skipAll() {
    this.dismiss();
  }

  private dismiss() {
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

  get progressPercent(): number {
    return Math.round(((this.currentStep + 1) / this.guideSteps.length) * 100);
  }
}
