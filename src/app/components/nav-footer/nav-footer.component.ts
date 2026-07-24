import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { IonTabBar, IonTabButton, IonIcon, IonLabel } from '@ionic/angular/standalone';
import { 
  homeOutline, 
  homeSharp,
  documentTextOutline,
  documentTextSharp,
  keyOutline,
  keySharp,
  peopleOutline,
  peopleSharp,
  analyticsOutline,
  analyticsSharp,
  settingsOutline,
  settingsSharp,
  personOutline,
  personSharp
} from 'ionicons/icons';

@Component({
  selector: 'app-nav-footer',
  template: `
    <ion-tab-bar slot="bottom" class="nav-footer">
      <ion-tab-button tab="students" (click)="navigateTo('/students')">
        <ion-icon [name]="isActive('/students') ? homeSharp : homeOutline"></ion-icon>
        <ion-label>Home</ion-label>
      </ion-tab-button>

      <ion-tab-button tab="results" (click)="navigateTo('/results')">
        <ion-icon [name]="isActive('/results') ? peopleSharp : peopleOutline"></ion-icon>
        <ion-label>Results</ion-label>
      </ion-tab-button>

      <ion-tab-button tab="profile" (click)="navigateTo('/profile')">
        <ion-icon [name]="isActive('/profile') ? personSharp : personOutline"></ion-icon>
        <ion-label>Profile</ion-label>
      </ion-tab-button>

      <ion-tab-button tab="reports" (click)="navigateTo('/reports')">
        <ion-icon [name]="isActive('/reports') ? analyticsSharp : analyticsOutline"></ion-icon>
        <ion-label>Reports</ion-label>
      </ion-tab-button>

      <ion-tab-button tab="admin" (click)="navigateTo('/admin')">
        <ion-icon [name]="isActive('/admin') ? settingsSharp : settingsOutline"></ion-icon>
        <ion-label>Admin</ion-label>
      </ion-tab-button>
    </ion-tab-bar>
  `,
  styles: [`
    :host {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      z-index: 1000;
      display: block;
    }

    .nav-footer {
      --background: #ffffff;
      --border: none;
      --box-shadow: 0 -2px 10px rgba(0, 0, 0, 0.1);
      border-top: 1px solid #e0e0e0;
      padding-bottom: env(safe-area-inset-bottom);
      height: 60px;
      max-height: 60px;
      width: 100%;
      display: flex;
      justify-content: space-around;
    }

    ion-tab-button {
      --color: #999999;
      --color-selected: #2e7d32;
      --background: transparent;
      --background-selected: #f5f5f5;
      flex: 1;
      min-width: 0;
      
      ion-icon {
        font-size: 22px;
      }

      ion-label {
        font-size: 10px;
        font-weight: 500;
        margin-top: 2px;
      }
    }
  `],
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonTabBar,
    IonTabButton,
    IonIcon,
    IonLabel
  ]
})
export class NavFooterComponent {
  homeOutline = homeOutline;
  homeSharp = homeSharp;
  peopleOutline = peopleOutline;
  peopleSharp = peopleSharp;
  personOutline = personOutline;
  personSharp = personSharp;
  analyticsOutline = analyticsOutline;
  analyticsSharp = analyticsSharp;
  settingsOutline = settingsOutline;
  settingsSharp = settingsSharp;

  currentRoute: string = '/students';

  constructor(private router: Router) {
    // Update current route on navigation
    this.router.events.subscribe(() => {
      this.currentRoute = this.router.url;
    });
  }

  isActive(route: string): boolean {
    return this.currentRoute === route;
  }

  navigateTo(route: string) {
    this.router.navigate([route]);
  }
}
