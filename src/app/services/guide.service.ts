import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class GuideService {
  private readonly guideVersion = '2';
  private readonly guideShownKey = 'acadcheck_feature_guide';
  private pageGuidanceShownKey = 'page_guidance_shown';

  // Page guidance state
  pageGuidanceState: { [page: string]: boolean } = {
    'exam-upload': false,
    'answer-key': false,
    'scoring': false,
    'results': false
  };

  constructor() {
    this.loadGuideState();
  }

  private loadGuideState() {
    try {
      // Load page guidance state from localStorage
      const savedState = localStorage.getItem(this.pageGuidanceShownKey);
      if (savedState) {
        this.pageGuidanceState = { ...this.pageGuidanceState, ...JSON.parse(savedState) };
      }
    } catch (e) {
      console.error('Error loading guide state:', e);
    }
  }

  isWelcomeGuideShown(userId?: number | string | null): boolean {
    try {
      if (!userId) return true;
      return localStorage.getItem(this.getUserGuideKey(userId)) === 'true';
    } catch (e) {
      return false;
    }
  }

  setWelcomeGuideShown(userId?: number | string | null): void {
    try {
      if (userId) localStorage.setItem(this.getUserGuideKey(userId), 'true');
    } catch (e) {
      console.error('Error saving guide state:', e);
    }
  }

  private getUserGuideKey(userId: number | string): string {
    return `${this.guideShownKey}_v${this.guideVersion}_user_${userId}`;
  }

  isPageGuidanceShown(page: string): boolean {
    return this.pageGuidanceState[page] || false;
  }

  setPageGuidanceShown(page: string): void {
    this.pageGuidanceState[page] = true;
    try {
      localStorage.setItem(this.pageGuidanceShownKey, JSON.stringify(this.pageGuidanceState));
    } catch (e) {
      console.error('Error saving page guidance state:', e);
    }
  }

  resetGuides(): void {
    this.pageGuidanceState = {
      'exam-upload': false,
      'answer-key': false,
      'scoring': false,
      'results': false
    };
    try {
      const user = JSON.parse(localStorage.getItem('currentUser') || 'null');
      if (user?.id) localStorage.removeItem(this.getUserGuideKey(user.id));
      localStorage.setItem(this.pageGuidanceShownKey, JSON.stringify(this.pageGuidanceState));
    } catch (e) {
      console.error('Error resetting guides:', e);
    }
  }
}
