import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly STORAGE_KEY = 'app-theme-mode';

  constructor() {
    this.enforceLightTheme();
  }

  enforceLightTheme(): void {
    try {
      localStorage.removeItem(this.STORAGE_KEY);
      document.body.classList.remove('dark', 'dark-theme');
      document.body.classList.add('light');
      document.documentElement.removeAttribute('data-theme');
      document.documentElement.style.colorScheme = 'light';
      document.documentElement.style.setProperty('--ion-background-color', '#ffffff');
      document.documentElement.style.setProperty('--ion-background-color-rgb', '255, 255, 255');
      document.documentElement.style.setProperty('--ion-text-color', '#333333');
      document.documentElement.style.setProperty('--ion-text-color-rgb', '51, 51, 51');
      document.documentElement.style.setProperty('--ion-card-background', '#ffffff');
      document.documentElement.style.setProperty('--ion-item-background', '#ffffff');
    } catch (e) {
      console.error('Light theme apply error:', e);
    }
  }
}
