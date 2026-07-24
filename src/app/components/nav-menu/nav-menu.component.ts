import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule, NavigationEnd } from '@angular/router';
import {
  IonMenu,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
  IonList,
  IonItem,
  IonIcon,
  IonLabel,
  IonMenuToggle,
  IonAvatar,
  IonNote
} from '@ionic/angular/standalone';
import {
  keyOutline,
  keySharp,
  peopleOutline,
  peopleSharp,
  personOutline,
  personSharp,
  schoolOutline,
  schoolSharp,
  scanOutline,
  scanSharp,
  logOutOutline,
  moonOutline,
  moonSharp,
  sunnyOutline,
  sunnySharp,
  helpCircleOutline,
  helpCircleSharp,
  analyticsOutline,
  analyticsSharp,
  documentTextOutline,
  documentTextSharp,
  shieldCheckmarkOutline,
  shieldCheckmarkSharp
} from 'ionicons/icons';
import { ThemeService } from '../../services/theme.service';
import { AuthService } from '../../services/auth.service';

interface MenuItem {
  title: string;
  path: string;
  iconOutline: any;
  iconSharp: any;
  isActive?: boolean;
}

@Component({
  selector: 'app-nav-menu',
  template: `
    <ion-menu contentId="main-content" type="overlay" class="nav-menu">
      <ion-header>
        <ion-toolbar color="primary">
          <ion-title>Menu</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content class="menu-content">
        <div class="user-section">
          <ion-avatar class="user-avatar">
            <ion-icon name="person-circle-outline"></ion-icon>
          </ion-avatar>
          <div class="user-info">
            <ion-label class="user-name">{{ user?.first_name ? user.first_name + ' ' + user.last_name : 'User' }}</ion-label>
            <ion-note class="user-role">{{ user?.username ? '@' + user.username : 'guest' }}</ion-note>
          </div>
        </div>

        <ion-list lines="none" class="menu-list">
          <ion-menu-toggle *ngFor="let item of menuItems" [autoHide]="false">
            <ion-item
              [routerLink]="item.path"
              routerDirection="root"
              [class.active-item]="isActive(item.path)"
              (click)="setActive(item.path)">
              <ion-icon slot="start" [name]="isActive(item.path) ? item.iconSharp : item.iconOutline"></ion-icon>
              <ion-label>{{ item.title }}</ion-label>
            </ion-item>
          </ion-menu-toggle>
        </ion-list>

        <div class="theme-toggle-section">
          <div class="theme-toggle-label">Appearance</div>
          <ion-menu-toggle [autoHide]="false">
            <ion-item
              class="theme-toggle-button"
              button
              (click)="toggleTheme()">
              <ion-icon
                slot="start"
                [name]="themeService.currentTheme === 'dark' ? sunnyOutline : moonOutline">
              </ion-icon>
              <ion-label>{{ themeService.currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode' }}</ion-label>
            </ion-item>
          </ion-menu-toggle>
        </div>

        <div class="menu-footer">
          <ion-menu-toggle [autoHide]="false">
            <ion-item button (click)="logout()">
              <ion-icon slot="start" name="log-out-outline"></ion-icon>
              <ion-label>Logout</ion-label>
            </ion-item>
          </ion-menu-toggle>
        </div>
      </ion-content>
    </ion-menu>
  `,
  styles: [`
    .nav-menu {
      --background: var(--app-card-bg);
      --width: 280px;
    }

    .menu-content {
      --background: var(--app-bg-color);
    }

    .user-section {
      display: flex;
      align-items: center;
      padding: 20px 16px;
      background: linear-gradient(135deg, #2e7d32 0%, #1b5e20 100%);
      color: white;
      margin-bottom: 8px;
    }

    .user-avatar {
      width: 56px;
      height: 56px;
      background: rgba(255, 255, 255, 0.2);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-right: 12px;
    }

    .user-avatar ion-icon {
      font-size: 40px;
      color: white;
    }

    .user-info {
      display: flex;
      flex-direction: column;
    }

    .user-name {
      font-size: 16px;
      font-weight: 600;
      color: white;
    }

    .user-role {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.8);
    }

    .menu-list {
      padding: 0 8px;
    }

    .menu-list ion-item {
      --padding-start: 16px;
      --padding-end: 16px;
      --border-radius: 12px;
      margin: 4px 0;
      --color: var(--app-text-secondary);
      --background: transparent;
      --background-hover: var(--app-hover-bg);
      --background-activated: var(--app-active-bg);
    }

    .menu-list ion-item.active-item {
      --color: #2e7d32;
      --background: var(--app-hover-bg);
    }

    .menu-list ion-item.active-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 4px;
      height: 24px;
      background: #2e7d32;
      border-radius: 0 4px 4px 0;
    }

    .menu-list ion-item ion-icon {
      font-size: 22px;
      margin-right: 12px;
    }

    .theme-toggle-section {
      padding: 16px 8px;
      border-bottom: 1px solid var(--app-border-color);
      margin-bottom: 8px;
    }

    .theme-toggle-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--app-text-muted);
      padding: 0 16px;
      margin-bottom: 8px;
    }

    .theme-toggle-button {
      --padding-start: 16px;
      --padding-end: 16px;
      --border-radius: 12px;
      --color: var(--app-text-secondary);
      --background: transparent;
      --background-hover: var(--app-hover-bg);
      --background-activated: var(--app-active-bg);
      margin: 4px 0;
    }

    .theme-toggle-button ion-icon {
      font-size: 22px;
      margin-right: 12px;
    }

    .menu-footer {
      position: absolute;
      bottom: 0;
      left: 0;
      right: 0;
      padding: 16px 8px;
      border-top: 1px solid var(--app-border-color);
      background: var(--app-bg-color);
    }

    .menu-footer ion-item {
      --padding-start: 16px;
      --padding-end: 16px;
      --border-radius: 12px;
      --color: #d32f2f;
      --background: transparent;
      --background-hover: var(--app-hover-bg);
    }

    .menu-footer ion-item ion-icon {
      font-size: 22px;
      margin-right: 12px;
    }
  `],
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonMenu,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonContent,
    IonList,
    IonItem,
    IonIcon,
    IonLabel,
    IonMenuToggle,
    IonAvatar,
    IonNote
  ]
})
export class NavMenuComponent {
  moonOutline = moonOutline;
  moonSharp = moonSharp;
  sunnyOutline = sunnyOutline;
  sunnySharp = sunnySharp;
  helpCircleOutline = helpCircleOutline;
  helpCircleSharp = helpCircleSharp;
  shieldCheckmarkOutline = shieldCheckmarkOutline;
  shieldCheckmarkSharp = shieldCheckmarkSharp;

  menuItems: MenuItem[] = [
    {
      title: 'Students',
      path: '/students',
      iconOutline: schoolOutline,
      iconSharp: schoolSharp
    },
    {
      title: 'Answer Keys',
      path: '/answer-key',
      iconOutline: keyOutline,
      iconSharp: keySharp
    },
    {
      title: 'Scanner',
      path: '/scanner',
      iconOutline: scanOutline,
      iconSharp: scanSharp
    },
    {
      title: 'Results',
      path: '/results',
      iconOutline: peopleOutline,
      iconSharp: peopleSharp
    },
    {
      title: 'Records',
      path: '/records',
      iconOutline: documentTextOutline,
      iconSharp: documentTextSharp
    },
    {
      title: 'Profile',
      path: '/profile',
      iconOutline: personOutline,
      iconSharp: personSharp
    }
  ];

  currentPath: string = '/students';
  user: any = null;

  constructor(
    private router: Router,
    public themeService: ThemeService,
    private authService: AuthService
  ) {
    this.router.events.subscribe(event => {
      if (event instanceof NavigationEnd) {
        this.loadUser();
        this.currentPath = this.router.url;
      }
    });
    this.loadUser();
  }

  loadUser() {
    this.user = this.authService.getCurrentUser();
    const role = this.user?.role || this.authService.getRoleFromToken();
    const existingAdmin = this.menuItems.find(m => m.path === '/admin');
    const existingDashboard = this.menuItems.find(m => m.path === '/dashboard');

    if (role === 'admin') {
      if (!existingDashboard) {
        this.menuItems.unshift({
          title: 'Dashboard',
          path: '/dashboard',
          iconOutline: analyticsOutline,
          iconSharp: analyticsSharp
        });
      }
      if (!existingAdmin) {
        this.menuItems.push({
          title: 'Admin',
          path: '/admin',
          iconOutline: shieldCheckmarkOutline,
          iconSharp: shieldCheckmarkSharp
        });
      }
    } else {
      this.menuItems = this.menuItems.filter(m => m.path !== '/admin' && m.path !== '/dashboard');
    }
  }

  isActive(path: string): boolean {
    return this.currentPath === path;
  }

  setActive(path: string) {
    this.currentPath = path;
  }

  toggleTheme() {
    this.themeService.toggleTheme();
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }
}
