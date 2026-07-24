import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type ThemeMode = 'light' | 'dark';

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly STORAGE_KEY = 'app-theme-mode';
  
  private themeSubject = new BehaviorSubject<ThemeMode>(this.getInitialTheme());
  theme$ = this.themeSubject.asObservable();

  constructor() {
    this.applyTheme(this.themeSubject.value);
  }

  private getInitialTheme(): ThemeMode {
    const stored = localStorage.getItem(this.STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
    // Default to dark mode
    return 'dark';
  }

  get currentTheme(): ThemeMode {
    return this.themeSubject.value;
  }

  toggleTheme(): void {
    const newTheme: ThemeMode = this.themeSubject.value === 'light' ? 'dark' : 'light';
    this.setTheme(newTheme);
  }

  setTheme(theme: ThemeMode): void {
    localStorage.setItem(this.STORAGE_KEY, theme);
    this.themeSubject.next(theme);
    this.applyTheme(theme);
  }

  private applyTheme(theme: ThemeMode): void {
    try {
      document.body.classList.remove('light', 'dark');
      document.body.classList.add(theme);
      
      if (theme === 'dark') {
        document.documentElement.style.setProperty('--ion-background-color', '#121212');
        document.documentElement.style.setProperty('--ion-background-color-rgb', '18, 18, 18');
        document.documentElement.style.setProperty('--ion-text-color', '#e0e0e0');
        document.documentElement.style.setProperty('--ion-text-color-rgb', '224, 224, 224');
        document.documentElement.style.setProperty('--ion-card-background', '#1e1e1e');
        document.documentElement.style.setProperty('--ion-item-background', '#1e1e1e');
      } else {
        document.documentElement.style.setProperty('--ion-background-color', '#ffffff');
        document.documentElement.style.setProperty('--ion-background-color-rgb', '255, 255, 255');
        document.documentElement.style.setProperty('--ion-text-color', '#333333');
        document.documentElement.style.setProperty('--ion-text-color-rgb', '51, 51, 51');
        document.documentElement.style.setProperty('--ion-card-background', '#ffffff');
        document.documentElement.style.setProperty('--ion-item-background', '#ffffff');
      }
    } catch (e) {
      console.error('Theme apply error:', e);
    }
  }
}
