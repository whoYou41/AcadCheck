import { Component, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonGrid, IonRow, IonCol, IonCard, IonCardHeader, IonCardTitle, IonCardContent, IonInput, IonButton, IonIcon, IonItem, IonLabel, IonCheckbox, IonButtons, IonLoading, IonToast } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { schoolOutline, personOutline, lockClosedOutline, mailOutline, callOutline, personAddOutline, arrowBackOutline, eyeOutline, eyeOffOutline } from 'ionicons/icons';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    IonContent,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonGrid,
    IonRow,
    IonCol,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCardContent,
    IonInput,
    IonButton,
    IonIcon,
    IonItem,
    IonLabel,
    IonCheckbox,
    IonButtons,
    IonLoading,
    IonToast
  ],
})
export class RegisterPage {
  firstName: string = '';
  lastName: string = '';
  email: string = '';
  phone: string = '';
  username: string = '';
  password: string = '';
  confirmPassword: string = '';
  showPassword: boolean = false;
  showConfirmPassword: boolean = false;
  agreeTerms: boolean = false;
  isLoading: boolean = false;
  showToast: boolean = false;
  toastMessage: string = '';
  toastColor: string = 'success';

  private router = inject(Router);
  private authService = inject(AuthService);

  constructor() {
    addIcons({
      schoolOutline,
      personOutline,
      lockClosedOutline,
      mailOutline,
      callOutline,
      personAddOutline,
      arrowBackOutline
    });
  }

  register() {
    if (!this.validateForm()) {
      return;
    }

    this.isLoading = true;

    const userData = {
      first_name: this.firstName,
      last_name: this.lastName,
      email: this.email,
      phone: this.phone,
      username: this.username,
      password: this.password
    };

    this.authService.register(userData).subscribe({
      next: (response) => {
        this.isLoading = false;
        if (response.success) {
          this.showToastMessage('Registration successful! Please login with your credentials.', 'success');
          setTimeout(() => {
            this.router.navigate(['/login']);
          }, 2000);
        } else {
          this.showToastMessage(response.message || 'Registration failed', 'danger');
        }
      },
      error: (error) => {
        this.isLoading = false;
        this.showToastMessage(error.message || 'Registration failed. Please try again.', 'danger');
      }
    });
  }

  validateForm(): boolean {
    if (!this.firstName || !this.lastName || !this.email || !this.phone || 
        !this.username || !this.password || !this.confirmPassword) {
      console.log('Please fill in all fields');
      return false;
    }

    if (this.password !== this.confirmPassword) {
      console.log('Passwords do not match');
      return false;
    }

    if (!this.agreeTerms) {
      console.log('Please agree to the terms and conditions');
      return false;
    }

    return true;
  }

  goBack() {
    this.router.navigate(['/login']);
  }

  showTerms() {
    // Show terms and conditions (placeholder)
    console.log('Show terms and conditions');
  }

  togglePasswordVisibility() {
    this.showPassword = !this.showPassword;
  }

  toggleConfirmPasswordVisibility() {
    this.showConfirmPassword = !this.showConfirmPassword;
  }

  private showToastMessage(message: string, color: string = 'primary') {
    this.toastMessage = message;
    this.toastColor = color;
    this.showToast = true;
    setTimeout(() => {
      this.showToast = false;
    }, 3000);
  }
}
