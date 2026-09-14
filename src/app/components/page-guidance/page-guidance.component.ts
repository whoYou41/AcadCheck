import { CommonModule } from '@angular/common';
import { Component, HostListener, OnDestroy } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter, Subscription } from 'rxjs';
import { PAGE_TOURS, ProductTour, ProductTourStep } from './page-guidance.tours';

@Component({
  selector: 'app-page-guidance',
  standalone: true,
  imports: [CommonModule],
  template: `<button *ngIf="showLauncher" class="tour-launcher" (click)="start()">Tour</button>
    <section *ngIf="active" class="product-tour-layer">
      <div *ngIf="targetVisible" class="tour-spotlight" [ngStyle]="spotlightStyle"></div>
      <article class="tour-card" [ngStyle]="cardStyle" role="dialog">
        <header><span class="tour-icon">*</span>
          <span class="tour-heading"><small>INTERACTIVE {{ tour?.name | uppercase }} TOUR</small><strong>{{ step?.title }}</strong></span>
          <button class="icon-button" type="button" (click)="skip()">x</button>
        </header>
        <div class="tour-progress"><span [style.width.%]="progress"></span></div>
        <div class="tour-body">
          <div class="step-count">STEP {{ stepIndex + 1 }} OF {{ tour?.steps?.length }}</div>
          <p>{{ step?.description }}</p>
          <div *ngIf="step?.detail" class="algorithm-detail"><strong>How the algorithm works</strong><span>{{ step?.detail }}</span></div>
          <div class="tour-action" [class.completed]="interactionComplete"><strong>{{ actionLabel }}</strong><span>{{ step?.action }}</span></div>
          <div *ngIf="!targetVisible" class="target-missing">Feature not visible. <button type="button" (click)="retryTarget()">Check again</button></div>
        </div>
        <footer><button class="skip-button" type="button" (click)="skip()">Skip</button><span class="spacer"></span><button type="button" (click)="back()">Back</button><button class="next-button" type="button" (click)="next()">{{ nextLabel }}</button></footer>
      </article>
    </section>`,
  styleUrls: ['./page-guidance.component.scss']
})
export class PageGuidanceComponent implements OnDestroy {
  tour?: ProductTour;
  active = false;
  stepIndex = 0;
  interactionComplete = false;
  targetVisible = false;
  spotlightStyle: Record<string, string> = {};
  cardStyle: Record<string, string> = {};
  private pageKey = '';
  private target?: HTMLElement;
  private targetEvent?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly routeSub: Subscription;
  private readonly onInteract = () => {
    this.interactionComplete = true;
    this.timer = setTimeout(() => this.next(), 550);
  };

  constructor(private router: Router) {
    this.updateTour(this.router.url);
    this.routeSub = this.router.events.pipe(filter(event => event instanceof NavigationEnd))
      .subscribe(event => this.updateTour((event as NavigationEnd).urlAfterRedirects));
  }

  get step(): ProductTourStep | undefined { return this.tour?.steps[this.stepIndex]; }
  get isLast(): boolean { return !!this.tour && this.stepIndex === this.tour.steps.length - 1; }
  get showLauncher(): boolean { return !!this.tour && !this.active; }
  get progress(): number { return this.tour ? ((this.stepIndex + 1) / this.tour.steps.length) * 100 : 0; }
  get actionLabel(): string { return this.interactionComplete ? 'Done — moving on' : 'Try it on the page'; }
  get nextLabel(): string { return this.isLast ? 'Finish' : 'Next'; }
  start(): void { if (this.tour) { this.active = true; this.stepIndex = 0; this.activateStep(true); } }
  next(): void { if (this.isLast) this.finish(); else if (this.tour) { this.stepIndex++; this.activateStep(true); } }
  back(): void { if (this.stepIndex > 0) { this.stepIndex--; this.activateStep(true); } }
  skip(): void { this.finish(); }
  retryTarget(): void { this.activateStep(true); }

  finish(): void {
    this.detachTarget();
    this.active = false;
    localStorage.setItem(this.storageKey(), 'complete');
  }

  @HostListener('window:resize')
  @HostListener('window:scroll')
  reposition(): void { if (this.active) this.locateTarget(false); }

  @HostListener('document:keydown.escape')
  closeOnEscape(): void { if (this.active) this.finish(); }

  ngOnDestroy(): void {
    this.routeSub.unsubscribe();
    this.detachTarget();
    if (this.timer) clearTimeout(this.timer);
  }

  private updateTour(url: string): void {
    this.detachTarget();
    this.active = false;
    this.pageKey = url.split('?')[0].split('/').filter(Boolean)[0] || '';
    this.tour = PAGE_TOURS[this.pageKey];
    if (this.timer) clearTimeout(this.timer);
    if (this.tour && localStorage.getItem(this.storageKey()) !== 'complete') {
      this.timer = setTimeout(() => this.start(), 650);
    }
  }

  private activateStep(scroll: boolean): void {
    this.detachTarget();
    this.interactionComplete = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.locateTarget(scroll), 80);
  }

  private locateTarget(scroll: boolean): void {
    const selector = this.step?.target;
    this.target = selector
      ? Array.from(document.querySelectorAll<HTMLElement>(selector)).find(el => !!el.offsetParent)
      : undefined;
    this.targetVisible = !!this.target;
    if (!this.target) return;
    if (scroll) this.target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    this.timer = setTimeout(() => this.drawTarget(), scroll ? 320 : 0);
  }

  private drawTarget(): void {
    if (!this.target || !this.step) return;
    const r = this.target.getBoundingClientRect();
    const pad = 7;
    this.spotlightStyle = {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px`
    };
    this.cardStyle = this.placeCard(r);
    this.target.classList.add('product-tour-target');
    if (this.step.interactionEvent) {
      this.targetEvent = this.step.interactionEvent;
      this.target.addEventListener(this.targetEvent, this.onInteract, { once: true });
    }
  }

  private placeCard(r: DOMRect): Record<string, string> {
    if (innerWidth <= 680) return {};
    const width = Math.min(390, innerWidth - 32);
    const left = r.right + width + 28 < innerWidth
      ? r.right + 14
      : Math.max(16, r.left - width - 14);
    const top = Math.max(16, Math.min(r.top, innerHeight - 455));
    return { left: `${left}px`, top: `${top}px`, width: `${width}px` };
  }

  private detachTarget(): void {
    if (this.target && this.targetEvent) this.target.removeEventListener(this.targetEvent, this.onInteract);
    this.target?.classList.remove('product-tour-target');
    this.target = undefined;
    this.targetEvent = undefined;
  }

  private storageKey(): string { return `acadcheck_product_tour_v1_${this.pageKey}`; }
}
