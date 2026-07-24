import { Component, Input, OnInit, OnDestroy, AfterViewChecked, ElementRef, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonCard, IonCardHeader, IonCardSubtitle, IonCardContent, IonSpinner } from '@ionic/angular/standalone';

declare const Chart: any;

export interface QuestionerRankingItem {
  questionNumber: number;
  totalResponses: number;
  correctCount: number;
  accuracyRate: number; // 0-1
}

@Component({
  selector: 'app-questioner-chart',
  templateUrl: './questioner-chart.component.html',
  styleUrls: ['./questioner-chart.component.scss'],
  standalone: true,
  imports: [CommonModule, IonCard, IonCardHeader, IonCardSubtitle, IonCardContent, IonSpinner]
})
export class QuestionerChartComponent implements OnInit, OnDestroy, AfterViewChecked {
  @Input() data: QuestionerRankingItem[] = [];
  @Input() isLoading = false;

  @ViewChild('rankingChart', { static: false }) chartRef!: ElementRef<HTMLCanvasElement>;

  private chart: any = null;
  private needsRender = false;

  constructor() {}

  ngOnInit() {
    this.needsRender = true;
  }

  ngAfterViewChecked() {
    if (this.needsRender && this.data.length > 0 && this.chartRef?.nativeElement) {
      this.needsRender = false;
      this.renderChart();
    }
  }

  ngOnDestroy() {
    if (this.chart) {
      try { this.chart.destroy(); } catch { /* ignore */ }
      this.chart = null;
    }
  }

  private renderChart() {
    if (this.chart) {
      try { this.chart.destroy(); } catch { /* ignore */ }
      this.chart = null;
    }

    const ctx = this.chartRef?.nativeElement;
    if (!ctx) return;

    if (this.data.length === 0) return;

    // Sort by accuracy descending
    const sorted = [...this.data].sort((a, b) => b.accuracyRate - a.accuracyRate);

    // Build labels: "Q1", "Q2", ...
    const labels = sorted.map(d => `Q${d.questionNumber}`);

    const accuracyValues = sorted.map(d => +(d.accuracyRate * 100).toFixed(1));
    const rawScores = sorted.map(d => `${d.correctCount}/${d.totalResponses}`);

    const colorTheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches
      ? { text: '#e6e6e6', grid: '#333' }
      : { text: '#222', grid: '#e6e6e6' };

    // Generate colors – green for best, red for worst
    const bgColors = sorted.map((_, idx, arr) => {
      const ratio = arr.length > 1 ? idx / (arr.length - 1) : 0.5;
      const r = Math.round(255 * ratio);
      const g = Math.round(255 * (1 - ratio));
      return `rgba(${r}, ${g}, 80, 0.7)`;
    });

    const borderColors = sorted.map((_, idx, arr) => {
      const ratio = arr.length > 1 ? idx / (arr.length - 1) : 0.5;
      const r = Math.round(255 * ratio);
      const g = Math.round(255 * (1 - ratio));
      return `rgb(${r}, ${g}, 80)`;
    });

    this.chart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Correct %',
            data: accuracyValues,
            backgroundColor: bgColors,
            borderColor: borderColors,
            borderWidth: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: {
          legend: { labels: { color: colorTheme.text } },
          tooltip: {
            callbacks: {
              afterLabel: (context: any) => rawScores[context.dataIndex]
            }
          }
        },
        scales: {
          x: {
            min: 0,
            max: 100,
            ticks: {
              color: colorTheme.text,
              callback: (value: number) => value + '%'
            },
            grid: { color: colorTheme.grid }
          },
          y: {
            ticks: { color: colorTheme.text },
            grid: { color: colorTheme.grid }
          }
        }
      }
    });
  }
}