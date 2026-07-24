import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { 
  IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
  IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton,
  IonIcon, IonMenuButton, IonToast, IonSpinner
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  analyticsOutline, arrowForwardOutline, atOutline, calendarOutline,
  callOutline, checkmarkCircleOutline, closeCircleOutline, documentTextOutline,
  logOutOutline, mailOutline, personOutline, scanOutline,
  shieldCheckmarkOutline, timeOutline
} from 'ionicons/icons';
import { AuthService } from '../../services/auth.service';
import { Router } from '@angular/router';
import { ScanService } from '../../services/scan.service';

@Component({
  selector: 'page-profile',
  templateUrl: './profile.page.html',
  styleUrls: ['./profile.page.scss'],
  standalone: true,
  imports: [
    CommonModule, IonContent, IonHeader, IonToolbar, IonTitle, IonButtons,
    IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonButton,
    IonIcon, IonMenuButton, IonToast, IonSpinner
  ],
})
export class ProfilePage implements OnInit {
  user: any = null;
  stats: any = null;
  isLoading = true;
  toastMessage: string = '';
  showToast: boolean = false;

  constructor(
    private authService: AuthService,
    private scanService: ScanService,
    public router: Router
  ) {
    addIcons({
      analyticsOutline, arrowForwardOutline, atOutline, calendarOutline,
      callOutline, checkmarkCircleOutline, closeCircleOutline, documentTextOutline,
      logOutOutline, mailOutline, personOutline, scanOutline,
      shieldCheckmarkOutline, timeOutline
    });
  }

  ngOnInit() {
    this.loadUserProfile();
    this.loadUserStats();
  }

  loadUserProfile() {
    const currentUser = this.authService.getCurrentUser();
    if (currentUser) {
      this.user = currentUser;
    }
    this.isLoading = false;
  }

  loadUserStats() {
    // Load user-specific statistics (scans performed, etc.)
    this.scanService.getScans({ limit: 100 }).subscribe({
      next: (response: any) => {
        const scans = response.scans || [];
        this.stats = {
          totalScans: scans.length,
          completedScans: scans.filter((s: any) => s.scan_status === 'completed').length,
          pendingScans: scans.filter((s: any) => s.scan_status === 'pending').length,
          failedScans: scans.filter((s: any) => s.scan_status === 'failed').length,
        };
      },
      error: (err) => {
        console.error('Failed to load stats:', err);
        this.stats = { totalScans: 0, completedScans: 0, pendingScans: 0, failedScans: 0 };
      }
    });
  }

  getDisplayName(): string {
    if (!this.user) return 'AcadCheck User';
    return [this.user.first_name, this.user.middle_name, this.user.last_name]
      .filter(Boolean)
      .join(' ')
      .trim() || this.user.username || 'AcadCheck User';
  }

  getInitials(): string {
    if (!this.user) return 'AC';
    const first = String(this.user.first_name || '').trim().charAt(0);
    const last = String(this.user.last_name || '').trim().charAt(0);
    return `${first}${last}`.toUpperCase() || String(this.user.username || 'AC').slice(0, 2).toUpperCase();
  }

  getCompletionRate(): number {
    const total = Number(this.stats?.totalScans || 0);
    const completed = Number(this.stats?.completedScans || 0);
    return total > 0 ? Math.round((completed / total) * 100) : 0;
  }

  logout() {
    this.authService.logout();
    this.router.navigate(['/login']);
  }

  showToastMessage(msg: string) {
    this.toastMessage = msg;
    this.showToast = true;
    setTimeout(() => this.showToast = false, 3000);
  }
}
