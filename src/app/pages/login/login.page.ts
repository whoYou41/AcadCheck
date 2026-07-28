import { Component, OnDestroy, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonGrid, IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonInput, IonButton, IonIcon, IonItem, IonLabel, IonLoading, IonToast } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  checkmarkOutline, eyeOffOutline, eyeOutline, lockClosedOutline,
  logInOutline, personOutline, schoolOutline
} from 'ionicons/icons';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.page.html',
  styleUrls: ['./login.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonInput,
    IonButton,
    IonIcon,
    IonItem,
    IonLabel,
    IonLoading,
    IonToast
  ],
})
export class LoginPage implements OnDestroy {
  username: string = '';
  password: string = '';
  showPassword: boolean = false;
  isLoading: boolean = false;
  showToast: boolean = false;
  toastMessage: string = '';
  toastColor: string = 'success';
  isLoginSuccess: boolean = false;
  signedInName: string = '';
  private successTimer?: ReturnType<typeof setTimeout>;

  private router = inject(Router);
  private authService = inject(AuthService);

  constructor() {
    addIcons({
      schoolOutline,
      personOutline,
      lockClosedOutline,
      logInOutline,
      eyeOutline,
      eyeOffOutline,
      checkmarkOutline
    });
  }

  login() {
    if (!this.username || !this.password) {
      this.showToastMessage('Please enter both username and password', 'warning');
      return;
    }

    if (this.isLoading || this.isLoginSuccess) {
      return;
    }

    this.isLoading = true;

    this.authService.login({ username: this.username, password: this.password }).subscribe({
      next: (response) => {
        this.isLoading = false;
        if (response.success && response.user) {
          // Store user data
          localStorage.setItem('currentUser', JSON.stringify(response.user));
          if (response.token) {
            localStorage.setItem('token', response.token);
          }

          this.playSignInAnimation(response.user);
        } else {
          this.showToastMessage(response.message || 'Login failed', 'danger');
        }
      },
      error: (error) => {
        this.isLoading = false;
        this.showToastMessage(error.message || 'Login failed. Please try again.', 'danger');
      }
    });
  }

  private playSignInAnimation(user: any) {
    this.signedInName = String(user?.first_name || user?.username || 'there').trim();
    this.isLoginSuccess = true;
    this.showToast = false;

    this.successTimer = setTimeout(() => {
      this.isLoginSuccess = false;
      this.router.navigate(['/students']);
    }, 1050);
  }

  ngOnDestroy() {
    if (this.successTimer) clearTimeout(this.successTimer);
  }

  private showToastMessage(message: string, color: string = 'primary') {
    this.toastMessage = message;
    this.toastColor = color;
    this.showToast = true;
    setTimeout(() => {
      this.showToast = false;
    }, 3000);
  }

  forgotPassword() {
    // Simulate forgot password action
    console.log('Forgot password clicked');
  }

  register() {
    // Navigate to registration page
    this.router.navigate(['/register']);
  }

  togglePasswordVisibility() {
    this.showPassword = !this.showPassword;
  }
}
