import { Injectable, NgZone, OnDestroy } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

export interface UsbPrinterDevice {
  deviceName: string;
  productName: string;
  vendorId: number;
  productId: number;
  permissionGranted: boolean;
}
export interface UsbPrinterStatus {
  usbHostSupported: boolean;
  devices: UsbPrinterDevice[];
  connected: boolean;
  printerName: string;
  busy: boolean;
}
export interface UsbPrintResult {
  submitted: boolean;
  printerName: string;
  bytesSent: number;
  completionConfirmed: boolean;
}
export interface SavedQuestionResult { questionNumber: number; isCorrect: boolean; }
export interface UsbPrinterBridge {
  getStatus(): Promise<UsbPrinterStatus>;
  connect(options: { deviceName: string }): Promise<{ connected: boolean; printerName: string }>;
  disconnect(): Promise<UsbPrinterStatus>;
  printScore(options: { scoreText: string; questionResults?: SavedQuestionResult[]; testPage?: boolean }): Promise<UsbPrintResult>;
  addListener(event: 'devicesChanged', listener: (status: UsbPrinterStatus) => void): Promise<PluginListenerHandle>;
}
const NativeUsbPrinter = registerPlugin<UsbPrinterBridge>('UsbPrinter');

export function savedScoreText(scan: any): string {
  const rawScore = scan?.examResponse?.total_score ?? scan?.grading?.totalScore;
  const score = Number(rawScore);
  const total = Number(scan?.omrResults?.length || scan?.grading?.totalQuestions);
  if (rawScore === null || rawScore === undefined || rawScore === '' ||
      !Number.isInteger(score) || !Number.isInteger(total) ||
      total < 1 || total > 500 || score < 0 || score > total) {
    throw new Error('This result does not contain a valid saved score and question count.');
  }
  return `${score}/${total}`;
}

export function savedQuestionResults(scan: any): SavedQuestionResult[] {
  const rows = Array.isArray(scan?.omrResults) ? scan.omrResults
    : Array.isArray(scan?.grading?.results) ? scan.grading.results : [];
  if (rows.length) {
    return rows.map((row: any, index: number) => ({
      questionNumber: Number(row?.question_number ?? row?.questionNumber ?? index + 1),
      isCorrect: row?.is_correct === true || Number(row?.is_correct) === 1 || row?.isCorrect === true || row?.score === 1,
    })).filter((row: SavedQuestionResult) => Number.isInteger(row.questionNumber) && row.questionNumber > 0);
  }
  let scores = scan?.examResponse?.score_per_question_json ?? scan?.examResponse?.scorePerQuestion;
  if (typeof scores === 'string') {
    try { scores = JSON.parse(scores); } catch { return []; }
  }
  if (!scores || typeof scores !== 'object') return [];
  return Object.entries(scores).map(([questionNumber, score]) => ({
    questionNumber: Number(questionNumber),
    isCorrect: Number(score) === 1,
  })).filter((row: SavedQuestionResult) => Number.isInteger(row.questionNumber) && row.questionNumber > 0);
}

@Injectable({ providedIn: 'root' })
export class UsbPrinterService implements OnDestroy {
  readonly available = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  state: UsbPrinterStatus = {
    usbHostSupported: false, devices: [], connected: false, printerName: '', busy: false
  };
  working = false;
  private bridge: UsbPrinterBridge = NativeUsbPrinter;
  private listener?: PluginListenerHandle;
  private initialization?: Promise<void>;
  private disposed = false;

  constructor(private zone: NgZone) {}

  initialize(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (!this.initialization) {
      this.initialization = this.watch().catch(error => { this.initialization = undefined; throw error; });
    }
    return this.initialization;
  }

  private async watch(): Promise<void> {
    if (!this.listener) {
      const listener = await this.bridge.addListener('devicesChanged', state => {
        this.zone.run(() => { this.state = state; });
      });
      if (this.disposed) { await listener.remove(); return; }
      this.listener = listener;
    }
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.available) return;
    const state = await this.bridge.getStatus();
    this.zone.run(() => { this.state = state; });
  }

  async connect(deviceName: string): Promise<void> {
    await this.run(async () => {
      const result = await this.bridge.connect({ deviceName });
      if (!result.connected) throw new Error('The printer connection was not established.');
    });
  }

  async disconnect(): Promise<void> {
    await this.run(() => this.bridge.disconnect());
  }

  async print(scoreText: string, testPage = false, questionResults: SavedQuestionResult[] = []): Promise<UsbPrintResult> {
    return this.run(async () => {
      const payload = { scoreText, testPage, ...(questionResults.length ? { questionResults } : {}) };
      const result = await this.bridge.printScore(payload);
      if (!result.submitted) throw new Error('The printer did not accept the print data.');
      return result;
    });
  }

  private async run<T>(action: () => Promise<T>): Promise<T> {
    if (!this.available) throw new Error('USB printing is available in the installed Android app.');
    if (this.working) throw new Error('A printer operation is already running.');
    this.working = true;
    try { return await action(); }
    finally {
      this.working = false;
      // A status refresh must not turn an accepted job into a retryable failure.
      await this.refresh().catch(() => {});
    }
  }

  ngOnDestroy(): void {
    this.disposed = true;
    void this.listener?.remove();
  }
}
