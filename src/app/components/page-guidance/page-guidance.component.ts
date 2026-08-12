import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { bulbOutline, chevronDownOutline, chevronUpOutline, closeOutline, sparklesOutline } from 'ionicons/icons';
import { filter } from 'rxjs';

interface LiveLesson {
  title: string;
  purpose: string;
  action: string;
  tip: string;
}

@Component({
  selector: 'app-page-guidance',
  standalone: true,
  imports: [CommonModule, IonButton, IonIcon],
  styleUrls: ['./page-guidance.component.scss'],
  template: `
    <aside *ngIf="lesson && visible" class="live-coach" aria-live="polite">
      <button class="coach-summary" type="button" (click)="expanded = !expanded" [attr.aria-expanded]="expanded">
        <span class="coach-avatar"><ion-icon name="sparkles-outline"></ion-icon></span>
        <span class="coach-heading"><small>LIVE LEARNING COACH</small><strong>{{ lesson.title }}</strong></span>
        <ion-icon [name]="expanded ? 'chevron-down-outline' : 'chevron-up-outline'"></ion-icon>
      </button>
      <div class="coach-body" *ngIf="expanded">
        <p>{{ lesson.purpose }}</p>
        <div class="coach-challenge"><strong>Try it now</strong><span>{{ lesson.action }}</span></div>
        <div class="coach-tip"><ion-icon name="bulb-outline"></ion-icon><span>{{ lesson.tip }}</span></div>
        <ion-button fill="clear" size="small" (click)="dismiss()">
          <ion-icon slot="start" name="close-outline"></ion-icon>Got it, hide this tip
        </ion-button>
      </div>
    </aside>
  `
})
export class PageGuidanceComponent {
  visible = true;
  expanded = true;
  lesson?: LiveLesson;
  private pageKey = '';

  private readonly lessons: Record<string, LiveLesson> = {
    students: { title: 'Build your learning community', purpose: 'This is where classrooms and student identities are organized before assessment.', action: 'Open a classroom, or add a learner to a class.', tip: 'Accurate student details help AcadCheck attach every result to the right learner.' },
    'answer-key': { title: 'Teach AcadCheck the correct answers', purpose: 'Answer keys are the reference AcadCheck uses to turn detected marks into scores.', action: 'Create a short key and watch its preview update.', tip: 'Double-check the question count before scanning—the sheet and key should match.' },
    scanner: { title: 'From paper to score', purpose: 'The scanner finds marked bubbles, reads the student response, and scores it using your selected key.', action: 'Select an answer key, then keep the entire sheet inside the on-screen guide.', tip: 'Flat paper, even light, and a steady camera improve detection.' },
    results: { title: 'Turn scores into teaching clues', purpose: 'Results summarize performance and help you spot class-wide patterns.', action: 'Filter the list, then look for high- and low-performing questions.', tip: 'A frequently missed item may signal a topic to reteach—or a question worth reviewing.' },
    records: { title: 'See growth over time', purpose: 'Records connect individual assessments into a longer learning story for each student.', action: 'Open a student and compare their recent assessments.', tip: 'Look for a trend across several scores before drawing a conclusion.' },
    profile: { title: 'Make AcadCheck yours', purpose: 'Your profile and preferences keep the workspace recognizable and comfortable.', action: 'Review your details or try the light/dark theme in the menu.', tip: 'The Learning Quest is always available again under System Guide.' },
    dashboard: { title: 'Read the big picture', purpose: 'The dashboard condenses important AcadCheck activity into an at-a-glance overview.', action: 'Compare the summary cards and identify what needs attention.', tip: 'Use summaries to find a question, then visit the detailed feature to investigate.' },
    admin: { title: 'Keep the system healthy', purpose: 'Admin tools help authorized users oversee accounts and platform activity.', action: 'Review the current users and their roles.', tip: 'Give people only the access they need to keep student data safer.' }
  };

  constructor(private router: Router) {
    addIcons({ bulbOutline, chevronDownOutline, chevronUpOutline, closeOutline, sparklesOutline });
    this.updateLesson(this.router.url);
    this.router.events.pipe(filter(event => event instanceof NavigationEnd)).subscribe(event => this.updateLesson((event as NavigationEnd).urlAfterRedirects));
  }

  dismiss() {
    this.visible = false;
    localStorage.setItem(`acadcheck_live_lesson_${this.pageKey}`, 'seen');
  }

  private updateLesson(url: string) {
    this.pageKey = url.split('?')[0].split('/').filter(Boolean)[0] || '';
    this.lesson = this.lessons[this.pageKey];
    this.visible = !!this.lesson && localStorage.getItem(`acadcheck_live_lesson_${this.pageKey}`) !== 'seen';
    this.expanded = true;
  }
}
