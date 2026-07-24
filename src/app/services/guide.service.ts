import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class GuideService {
  private guideShownKey = 'welcome_guide_shown';
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

  isWelcomeGuideShown(): boolean {
    try {
      return localStorage.getItem(this.guideShownKey) === 'true';
    } catch (e) {
      return false;
    }
  }

  setWelcomeGuideShown(): void {
    try {
      localStorage.setItem(this.guideShownKey, 'true');
    } catch (e) {
      console.error('Error saving guide state:', e);
    }
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
      localStorage.setItem(this.guideShownKey, 'false');
      localStorage.setItem(this.pageGuidanceShownKey, JSON.stringify(this.pageGuidanceState));
    } catch (e) {
      console.error('Error resetting guides:', e);
    }
  }
}
