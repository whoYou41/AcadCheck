import { Inject, Injectable, InjectionToken } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import jsQR from 'jsqr';
import * as ort from 'onnxruntime-web/wasm';
import { OfflineSequenceDetector } from './offline-sequence-detector';

export interface NativeOmrPayload {
  success?: boolean;
  gradeable?: boolean;
  geometryVerified?: boolean;
  answers?: unknown;
  confidenceScores?: unknown;
  markedLetters?: unknown;
  rowStates?: unknown;
  averageConfidence?: unknown;
  processingMs?: unknown;
  reason?: unknown;
  qualityGate?: { reason?: unknown };
  qualityMetrics?: {
    overall?: unknown;
    [key: string]: unknown;
  };
  sheetPresence?: unknown;
  presenceConfidence?: unknown;
  sheetFingerprint?: unknown;
  sheetFingerprintVersion?: unknown;
  overlayGeometry?: unknown;
  sequence?: unknown;
  sequenceCandidate?: unknown;
  sequenceConfidence?: unknown;
  sequenceRawDigits?: unknown;
  sequenceBoxCount?: unknown;
  sequenceDigitConfidences?: unknown;
}

export interface NativeOfflineOmrPlugin {
  prewarm(): Promise<{
    ready: boolean;
    engine?: string;
    opencvVersion?: string;
    templateCount?: number;
  }>;
  scan(options: {
    imageBase64: string;
    questionCount: number;
    trackingSessionId?: string;
    frameId?: string;
  }): Promise<NativeOmrPayload>;
}

const NativeOfflineOmr = registerPlugin<NativeOfflineOmrPlugin>('OfflineOmr');
const NATIVE_OFFLINE_OMR = new InjectionToken<NativeOfflineOmrPlugin>('NativeOfflineOmr', {
  providedIn: 'root', factory: () => NativeOfflineOmr,
});

let bubbleSession: Promise<ort.InferenceSession> | null = null;

function offlineAssetUrl(path: string): string {
  const karmaPrefix = '__karma__' in globalThis ? '_karma_webpack_/' : '';
  return new URL(`${karmaPrefix}assets/${path}`, document.baseURI).toString();
}

function loadBubbleSession(): Promise<ort.InferenceSession> {
  if (!bubbleSession) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = offlineAssetUrl('ort/');
    const modelUrl = offlineAssetUrl('models/bubble-classifier.onnx');
    bubbleSession = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).catch(error => {
      bubbleSession = null;
      throw error;
    });
  }
  return bubbleSession;
}

export interface OfflineOmrResult {
  answers: string[];
  confidences: number[];
  detectedCount: number;
  uncertainCount: number;
  gradeable: boolean;
  overallConfidence: number;
  processingMs: number;
  qrData: string;
  anchorMethod: 'barcode-detector' | 'jsqr' | 'qr-finder' | 'answer-grid';
  source?: 'device-fallback' | 'device-native-verified';
  reason?: string;
  markedLetters?: string[][];
  rowStates?: string[];
  rowMapComplete?: boolean;
  temporalEligible?: boolean;
  geometryVerified?: boolean;
  sheetPresence?: string;
  presenceConfidence?: number;
  sheetFingerprint?: string;
  sheetFingerprintVersion?: number;
  overlayGeometry?: unknown;
  qualityMetrics?: Record<string, unknown>;
  sequence?: string;
  sequenceCandidate?: string;
  sequenceConfidence?: number;
  sequenceRawDigits?: string;
  sequenceBoxCount?: number;
  sequenceDigitConfidences?: Array<number | null>;
}

export interface OfflineOmrOptions {
  trackingSessionId?: string;
  frameId?: string;
}

interface Point {
  x: number;
  y: number;
}

interface SheetAnchor {
  origin: Point;
  horizontal: Point;
  vertical: Point;
  homography?: [number, number, number, number, number, number, number, number];
  qrData?: string;
  method: OfflineOmrResult['anchorMethod'];
}

const CANONICAL_WIDTH = 800;
const CANONICAL_HEIGHT = 2500;
const CANONICAL_QR_CORNERS: Point[] = [
  { x: 197.58, y: 2299.08 },
  { x: 337.14, y: 2298.32 },
  { x: 337.78, y: 2527.46 },
  { x: 196.03, y: 2523.73 },
];
const NOMINAL_LEFT_X = [0.18375, 0.23125, 0.27875, 0.32625];
// Keep these coordinates identical to the versioned acadcheck-50-v1 backend
// template.  The previous offline-only right-block and row-span overrides
// projected the grid into neighboring text when the QR homography was used.
const NOMINAL_RIGHT_X = [0.66, 0.7075, 0.755, 0.8025];
const NOMINAL_TOP_Y = 0.216;
const NOMINAL_ROW_SPACING = 0.0264;

interface FinderCandidate extends Point {
  size: number;
  hits: number;
}

interface AnswerGrid {
  centers: Point[][];
  radius: number;
  verified?: boolean;
}

function desktopOmrBridge(): NativeOfflineOmrPlugin | undefined {
  return (globalThis as typeof globalThis & { acadcheckOmr?: NativeOfflineOmrPlugin }).acadcheckOmr;
}

@Injectable({ providedIn: 'root' })
export class OfflineOmrService {
  private readonly browserSequenceDetector = new OfflineSequenceDetector();

  constructor(@Inject(NATIVE_OFFLINE_OMR) private readonly nativeOmr: NativeOfflineOmrPlugin = NativeOfflineOmr) {
    const reader = Capacitor.isNativePlatform() ? this.nativeOmr : desktopOmrBridge();
    if (reader) {
      void reader.prewarm().catch(error => {
        console.warn('Native offline OMR prewarm failed:', error);
      });
    }
  }

  async detect(file: File, questionCount: number, options: OfflineOmrOptions = {}): Promise<OfflineOmrResult> {
    if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) {
      throw new Error('Offline automatic detection currently supports answer sheets with up to 50 questions.');
    }
    if (Capacitor.isNativePlatform()) {
      return this.detectNative(file, questionCount, options);
    }
    const desktop = desktopOmrBridge();
    if (desktop) return this.detectNative(file, questionCount, options, desktop);
    return this.detectBrowserFallback(file, questionCount);
  }

  /** Independently read the footer if the packaged native worker omits sequence metadata. */
  async detectSequenceFromImage(
    file: File,
    overlayGeometry?: unknown
  ): Promise<import('./offline-sequence-detector').OfflineSequenceResult | null> {
    const canvas = await this.loadCanvas(file);
    const geometry = overlayGeometry as { width?: unknown; height?: unknown; centers?: unknown } | undefined;
    if (Array.isArray(geometry?.centers) && geometry.centers.length === 50
      && Number(geometry.width) > 0 && Number(geometry.height) > 0) {
      const scaleX = canvas.width / Number(geometry.width);
      const scaleY = canvas.height / Number(geometry.height);
      const centers = geometry.centers.map((row: unknown) => Array.isArray(row)
        ? row.map((point: unknown) => Array.isArray(point) && point.length >= 2
          ? { x: Number(point[0]) * scaleX, y: Number(point[1]) * scaleY }
          : null)
        : null);
      if (centers.every((row: unknown) => Array.isArray(row) && row.length === 4
        && row.every((point: any) => point && Number.isFinite(point.x) && Number.isFinite(point.y)))) {
        const result = await this.browserSequenceDetector.detect(canvas, null, centers as any);
        if (result) return result;
      }
    }
    return this.browserSequenceDetector.detect(canvas);
  }

  private async detectNative(file: File, questionCount: number, options: OfflineOmrOptions, reader = this.nativeOmr): Promise<OfflineOmrResult> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    const payload = await reader.scan({
      imageBase64: btoa(binary),
      questionCount,
      trackingSessionId: options.trackingSessionId,
      frameId: options.frameId,
    });

    const rawAnswers = Array.isArray(payload?.answers) ? payload.answers : [];
    const rawConfidences = Array.isArray(payload?.confidenceScores)
      ? payload.confidenceScores
      : [];
    const rawMarkedLetters = Array.isArray(payload?.markedLetters)
      ? payload.markedLetters
      : [];
    const rawRowStates = Array.isArray(payload?.rowStates) ? payload.rowStates : [];
    const choices = ['A', 'B', 'C', 'D'];
    const answers = Array.from({ length: questionCount }, (_, index) => {
      const answer = String(rawAnswers[index] || '').trim().toUpperCase();
      return choices.includes(answer) ? answer : '';
    });
    const markedLetters = Array.from({ length: questionCount }, (_, index) => {
      if (!Array.isArray(rawMarkedLetters[index])) return [];
      return [...new Set(
        (rawMarkedLetters[index] as unknown[])
          .map(value => String(value || '').trim().toUpperCase())
          .filter(value => choices.includes(value))
      )];
    });
    const rowStates = Array.from({ length: questionCount }, (_, index) => {
      const state = String(rawRowStates[index] || '').trim().toLowerCase();
      return ['single', 'blank', 'multiple', 'uncertain'].includes(state)
        ? state
        : 'uncertain';
    });
    const rowEvidenceComplete = rawAnswers.length >= questionCount
      && rawConfidences.length >= questionCount
      && rawMarkedLetters.length >= questionCount
      && rawRowStates.length >= questionCount
      && answers.every((answer, index) => {
        const marks = rawMarkedLetters[index];
        const state = rowStates[index];
        if (!Array.isArray(marks) || marks.some(mark => !choices.includes(mark))) return false;
        const confidence = rawConfidences[index];
        if (typeof confidence !== 'number' || !Number.isFinite(confidence)
          || confidence < 0 || confidence > 100) return false;
        if (new Set(marks).size !== marks.length || rawAnswers[index] !== answer) return false;
        return state === 'single' ? marks.length === 1 && marks[0] === answer
          : state === 'blank' ? marks.length === 0 && answer === ''
          : state === 'multiple' ? marks.length >= 2 && answer === ''
          : state === 'uncertain' && marks.length === 1 && (answer === '' || answer === marks[0])
            && rawRowStates[index] === 'uncertain';
      });
    const uncertainCount = rowStates.filter(state => state === 'uncertain').length;
    const rowMapComplete = rowEvidenceComplete && uncertainCount === 0;
    const qualityReported = Array.isArray(payload?.qualityMetrics?.['criticalFailures']);
    const temporalEligible = payload?.success === true && payload?.geometryVerified === true
      && rowEvidenceComplete && qualityReported
      && (payload.qualityMetrics!['criticalFailures'] as unknown[]).length === 0;
    const verified = payload?.success === true
      && payload?.geometryVerified === true
      && payload?.gradeable === true
      && qualityReported
      && (payload.qualityMetrics!['criticalFailures'] as unknown[]).length === 0
      && rowMapComplete
      && uncertainCount === 0;
    const confidences = Array.from({ length: questionCount }, (_, index) => {
      const value = Number(rawConfidences[index]);
      return Number.isFinite(value)
        ? Math.max(0, Math.min(100, Math.round(value)))
        : 0;
    });
    const qualityOverall = Number(payload?.qualityMetrics?.overall);
    const averageConfidence = Number(payload?.averageConfidence);
    const overallConfidence = Number.isFinite(qualityOverall)
      ? qualityOverall
      : Number.isFinite(averageConfidence)
        ? averageConfidence
        : 0;
    const criticalFailures = Array.isArray(payload?.qualityMetrics?.['criticalFailures'])
      ? payload.qualityMetrics['criticalFailures'].map(value => String(value))
      : [];
    const rejectionReason = payload?.success !== true
      ? 'The on-device detector could not read this image.'
      : payload?.geometryVerified !== true
        ? 'The complete 50-row answer grid is not aligned in the current frame.'
        : criticalFailures.length > 0
          ? `Improve ${criticalFailures.join(', ')} and keep the complete sheet steady.`
          : uncertainCount > 0
            ? temporalEligible
              ? `${uncertainCount} answer row${uncertainCount === 1 ? ' needs' : 's need'} another matching frame.`
              : `Check row${uncertainCount === 1 ? '' : 's'} ${rowStates.map((state, index) => state === 'uncertain' ? index + 1 : null).filter(Boolean).join(', ')}: improve focus or lighting so each mark is clear.`
            : !rowMapComplete
              ? 'One or more answer rows still have conflicting bubble evidence.'
              : 'The current frame needs another consistent reading.';

    return {
      answers,
      confidences,
      detectedCount: answers.filter(Boolean).length,
      uncertainCount: verified ? 0 : uncertainCount || (rowMapComplete ? 0 : questionCount),
      gradeable: verified,
      overallConfidence: Math.max(0, Math.min(100, Math.round(overallConfidence))),
      processingMs: Math.max(0, Math.round(Number(payload?.processingMs) || 0)),
      qrData: '',
      anchorMethod: 'answer-grid',
      source: 'device-native-verified',
      reason: typeof payload?.reason === 'string'
        ? payload.reason
        : typeof payload?.qualityGate?.reason === 'string'
          ? payload.qualityGate.reason
          : verified
            ? ''
            : rejectionReason,
      markedLetters,
      rowStates,
      rowMapComplete,
      temporalEligible,
      geometryVerified: payload?.geometryVerified === true,
      sheetPresence: typeof payload?.sheetPresence === 'string' ? payload.sheetPresence : undefined,
      presenceConfidence: Number.isFinite(Number(payload?.presenceConfidence))
        ? Number(payload.presenceConfidence)
        : undefined,
      sheetFingerprint: typeof payload?.sheetFingerprint === 'string' ? payload.sheetFingerprint : '',
      sheetFingerprintVersion: Number(payload?.sheetFingerprintVersion) || 0,
      overlayGeometry: payload?.overlayGeometry,
      qualityMetrics: payload?.qualityMetrics && typeof payload.qualityMetrics === 'object'
        ? payload.qualityMetrics as Record<string, unknown>
        : undefined,
      sequence: /^\d{1,2}$/.test(String(payload?.sequence || '')) && Number(payload?.sequence) <= 60
        ? String(Number(payload?.sequence))
        : undefined,
      sequenceCandidate: /^\d{1,2}$/.test(String(payload?.sequenceCandidate || '')) && Number(payload?.sequenceCandidate) <= 60
        ? String(Number(payload?.sequenceCandidate))
        : undefined,
      sequenceConfidence: Number.isFinite(Number(payload?.sequenceConfidence))
        ? Number(payload?.sequenceConfidence)
        : undefined,
      sequenceRawDigits: /^\d{1,4}$/.test(String(payload?.sequenceRawDigits || ''))
        ? String(payload?.sequenceRawDigits)
        : undefined,
      sequenceBoxCount: [2, 4].includes(Number(payload?.sequenceBoxCount))
        ? Number(payload?.sequenceBoxCount)
        : undefined,
      sequenceDigitConfidences: Array.isArray(payload?.sequenceDigitConfidences)
        ? payload.sequenceDigitConfidences.map(value => value == null ? null : Number(value))
        : undefined,
    };
  }

  private async detectBrowserFallback(file: File, questionCount: number): Promise<OfflineOmrResult> {
    const startedAt = performance.now();

    const canvas = await this.loadCanvas(file);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This device could not read the captured image.');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const grayscale = this.toGrayscale(image.data);

    // Use the printed QR only as a perspective anchor. The operator-selected
    // local answer key remains authoritative; QR contents never select data.
    const paperBand = this.findPaperBand(grayscale, canvas.width, canvas.height);
    const anchor = await this.findBarcodeAnchor(canvas)
      || this.findJsQrAnchor(image, paperBand)
      || this.findQrFinderAnchor(grayscale, canvas.width, canvas.height);
    const answerGrid = anchor
      ? this.findAnswerGrid(grayscale, canvas.width, canvas.height, anchor)
      : this.findAnswerGridComponents(grayscale, canvas.width, canvas.height, false)
        || this.findAnswerGrid(grayscale, canvas.width, canvas.height, null);
    if (!answerGrid) {
      const registrationError = new Error(
        'Could not register the 50-row answer grid. Retake the photo with the complete sheet visible, upright, and in focus.'
      ) as Error & { sheetPresence?: 'present' | 'absent' };
      registrationError.sheetPresence = paperBand ? 'present' : 'absent';
      throw registrationError;
    }
    const sequencePromise = this.browserSequenceDetector.detect(
      canvas,
      paperBand,
      answerGrid.centers,
      anchor ? (x, y) => this.project(anchor, x, y) : undefined
    );

    const answers = Array(questionCount).fill('');
    const confidences = Array(questionCount).fill(0);
    const markedLetters: string[][] = Array.from({ length: questionCount }, () => []);
    const rowStates: string[] = Array(questionCount).fill('uncertain');
    const sampledRows: number[][] = [];
    const classicalBlankRows: number[] = [];
    let uncertainCount = 0;

    for (let index = 0; index < questionCount; index++) {
      const values = Array.from({ length: 4 }, (_, choice) => {
        const center = answerGrid.centers[index][choice];
        return this.sampleBubble(grayscale, canvas.width, canvas.height, center, answerGrid.radius);
      });
      sampledRows.push(values);
      const ranked = values
        .map((value, choice) => ({ value, choice }))
        .sort((a, b) => a.value - b.value);
      const darkest = ranked[0];
      const second = ranked[1];
      const baseline = (ranked[2].value + ranked[3].value) / 2;
      const darkness = baseline - darkest.value;
      const separation = second.value - darkest.value;
      const secondDarkness = baseline - second.value;

      // A real fill is both darker than the paper inside the other bubbles
      // and clearly separated from the runner-up. This deliberately leaves
      // blank, faint, and multiple-mark rows for human review.
      const accepted = darkest.value < 190 && darkness >= 22 && separation >= 12;
      if (accepted) {
        answers[index] = ['A', 'B', 'C', 'D'][darkest.choice];
        confidences[index] = Math.round(Math.min(99, 55 + darkness * 0.55 + separation * 0.7));
        markedLetters[index] = [answers[index]];
        rowStates[index] = 'single';
      } else if (
        darkest.value < 190
        && darkness >= 22
        && secondDarkness >= 18
        && ranked[2].value - second.value >= 8
      ) {
        markedLetters[index] = [darkest.choice, second.choice]
          .sort((left, right) => left - right)
          .map(choice => ['A', 'B', 'C', 'D'][choice]);
        rowStates[index] = 'multiple';
        confidences[index] = Math.round(Math.min(95, 55 + Math.min(darkness, secondDarkness)));
      } else if (darkest.value >= 135 && darkness < 18) {
        rowStates[index] = 'blank';
        confidences[index] = Math.round(Math.min(95, 68 + (18 - darkness)));
        classicalBlankRows.push(index);
      } else {
        uncertainCount++;
      }
    }

    // Calling a row blank is a negative assertion and is especially prone to
    // glare, faint pencil, and edge-row registration errors. Audit every
    // classical blank in one model batch. The model may recover a single mark
    // only when it agrees with the darkest physical bubble; any disagreement
    // blocks automatic grading instead of silently scoring the row as blank.
    if (classicalBlankRows.length) {
      try {
        const probabilities = await this.classifyBlankRows(
          grayscale,
          canvas.width,
          canvas.height,
          answerGrid,
          classicalBlankRows
        );
        for (let resultIndex = 0; resultIndex < classicalBlankRows.length; resultIndex++) {
          const row = classicalBlankRows[resultIndex];
          const rowProbabilities = probabilities[resultIndex];
          const ranked = rowProbabilities
            .map((value, choice) => ({ value, choice }))
            .sort((left, right) => right.value - left.value);
          const modelTop = ranked[0];
          const modelSecond = ranked[1];
          const values = sampledRows[row];
          const intensityOrder = values
            .map((value, choice) => ({ value, choice }))
            .sort((left, right) => left.value - right.value);
          const intensityGap = intensityOrder[1].value - intensityOrder[0].value;
          const modelMarks = ranked.filter(item => item.value >= 0.90);

          if (
            modelMarks.length === 1
            && modelTop.choice === intensityOrder[0].choice
            && modelTop.value >= 0.94
            && modelSecond.value <= 0.20
            && intensityGap >= 5
          ) {
            const answer = ['A', 'B', 'C', 'D'][modelTop.choice];
            answers[row] = answer;
            markedLetters[row] = [answer];
            rowStates[row] = 'single';
            confidences[row] = Math.round(Math.min(96, 58 + modelTop.value * 35 + intensityGap * 0.25));
          } else if (modelMarks.length >= 2) {
            answers[row] = '';
            markedLetters[row] = modelMarks
              .map(item => item.choice)
              .sort((left, right) => left - right)
              .map(choice => ['A', 'B', 'C', 'D'][choice]);
            rowStates[row] = 'multiple';
            confidences[row] = Math.round(Math.min(96, 65 + Math.min(...modelMarks.map(item => item.value)) * 25));
          } else if (modelTop.value <= 0.20) {
            // Both classifiers independently found no added ink.
            confidences[row] = 90;
          } else {
            rowStates[row] = 'uncertain';
            confidences[row] = 0;
            markedLetters[row] = modelTop.value >= 0.50
              ? [['A', 'B', 'C', 'D'][modelTop.choice]]
              : [];
            uncertainCount++;
          }
        }
      } catch (error) {
        console.warn('Offline blank verification failed:', error);
        for (const row of classicalBlankRows) {
          rowStates[row] = 'uncertain';
          confidences[row] = 0;
          markedLetters[row] = [];
          uncertainCount++;
        }
      }
    }

    // Partial or unproved geometry can produce individually dark samples at
    // the wrong lane. Keep those readings as review suggestions, but do not
    // present them as high-confidence answers or authorize an automatic grade.
    const gradeable = answerGrid.verified === true && uncertainCount === 0;
    if (!gradeable) {
      for (let index = 0; index < confidences.length; index++) {
        if (confidences[index] > 0) confidences[index] = Math.min(49, confidences[index]);
      }
      if (answerGrid.verified !== true) {
        uncertainCount = questionCount;
        rowStates.fill('uncertain');
        markedLetters.forEach(row => row.splice(0));
      }
    }

    const detectedCount = answers.filter(Boolean).length;
    if (!detectedCount && uncertainCount > 0) {
      throw new Error('The sheet was located, but no confident filled bubbles were found. Check focus and lighting.');
    }
    const sequence = await sequencePromise;
    const acceptedConfidences = confidences.filter(value => value > 0);
    const overallConfidence = acceptedConfidences.length
      ? Math.round(acceptedConfidences.reduce((sum, value) => sum + value, 0) / acceptedConfidences.length)
      : 0;
    return {
      answers,
      confidences,
      detectedCount,
      uncertainCount,
      gradeable,
      overallConfidence,
      processingMs: Math.round(performance.now() - startedAt),
      qrData: '',
      anchorMethod: 'answer-grid',
      source: 'device-fallback',
      markedLetters,
      rowStates,
      rowMapComplete: answerGrid.verified === true,
      geometryVerified: answerGrid.verified === true,
      sheetPresence: 'present',
      sequence: sequence?.sequence,
      sequenceCandidate: sequence?.sequenceCandidate,
      sequenceConfidence: sequence?.confidence,
      sequenceRawDigits: sequence?.rawDigits,
      sequenceBoxCount: sequence?.boxCount,
      sequenceDigitConfidences: sequence?.digitConfidences,
    };
  }

  private async loadCanvas(file: File): Promise<HTMLCanvasElement> {
    if (typeof createImageBitmap !== 'function') return this.loadCanvasWithImage(file);
    const bitmap = await createImageBitmap(file);
    const maxDimension = 1600;
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new Error('This device could not prepare the captured image.');
    }
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas;
  }

  private loadCanvasWithImage(file: File): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        try {
          const maxDimension = 1600;
          const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
          const context = canvas.getContext('2d');
          if (!context) throw new Error('This device could not prepare the captured image.');
          context.fillStyle = '#fff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas);
        } catch (error) {
          reject(error);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('This device could not decode the captured image.'));
      };
      image.src = url;
    });
  }

  private toGrayscale(rgba: Uint8ClampedArray): Uint8Array {
    const gray = new Uint8Array(rgba.length / 4);
    for (let source = 0, target = 0; source < rgba.length; source += 4, target++) {
      gray[target] = Math.round(0.299 * rgba[source] + 0.587 * rgba[source + 1] + 0.114 * rgba[source + 2]);
    }
    return gray;
  }

  private findJsQrAnchor(
    image: ImageData,
    paper?: { start: number; end: number } | null
  ): SheetAnchor | null {
    try {
      const regions = paper
        ? [
            {
              left: Math.max(0, Math.floor(paper.start - image.width * 0.02)),
              top: Math.floor(image.height * 0.5),
              right: Math.min(image.width, Math.ceil(
                paper.start + (paper.end - paper.start) * 0.65
              )),
              bottom: image.height,
            },
            { left: 0, top: 0, right: image.width, bottom: image.height },
          ]
        : [{ left: 0, top: 0, right: image.width, bottom: image.height }];

      for (const region of regions) {
        const cropWidth = Math.max(1, region.right - region.left);
        const cropHeight = Math.max(1, region.bottom - region.top);
        const pixels = new Uint8ClampedArray(cropWidth * cropHeight * 4);
        for (let row = 0; row < cropHeight; row++) {
          const start = ((region.top + row) * image.width + region.left) * 4;
          pixels.set(image.data.subarray(start, start + cropWidth * 4), row * cropWidth * 4);
        }
        const detection = jsQR(pixels, cropWidth, cropHeight, {
          inversionAttempts: 'attemptBoth',
        });
        if (!detection?.location) continue;
        const translate = (point: Point): Point => ({
          x: point.x + region.left,
          y: point.y + region.top,
        });
        return this.createPerspectiveAnchor(
          translate(detection.location.topLeftCorner),
          translate(detection.location.topRightCorner),
          translate(detection.location.bottomRightCorner),
          translate(detection.location.bottomLeftCorner),
          'jsqr',
          detection.data
        );
      }
      return null;
    } catch {
      return null;
    }
  }

  private async findBarcodeAnchor(canvas: HTMLCanvasElement): Promise<SheetAnchor | null> {
    try {
      const Detector = (window as any).BarcodeDetector;
      if (!Detector) return null;
      const detections = await new Detector({ formats: ['qr_code'] }).detect(canvas);
      const detection = detections
        .filter((item: any) => item.cornerPoints?.length >= 4)
        .sort((a: any, b: any) => (b.boundingBox?.width || 0) * (b.boundingBox?.height || 0)
          - (a.boundingBox?.width || 0) * (a.boundingBox?.height || 0))[0];
      if (!detection) return null;
      const [topLeft, topRight, bottomRight, bottomLeft] = detection.cornerPoints;
      return this.createPerspectiveAnchor(topLeft, topRight, bottomRight, bottomLeft, 'barcode-detector', detection.rawValue);
    } catch {
      return null;
    }
  }

  private createPerspectiveAnchor(
    topLeft: Point,
    topRight: Point,
    bottomRight: Point,
    bottomLeft: Point,
    method: OfflineOmrResult['anchorMethod'],
    qrData = ''
  ): SheetAnchor | null {
    const sideLengths = [
      Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
      Math.hypot(bottomRight.x - topRight.x, bottomRight.y - topRight.y),
      Math.hypot(bottomLeft.x - bottomRight.x, bottomLeft.y - bottomRight.y),
      Math.hypot(topLeft.x - bottomLeft.x, topLeft.y - bottomLeft.y),
    ];
    if (Math.min(...sideLengths) < 35 || Math.max(...sideLengths) / Math.min(...sideLengths) > 2.4) return null;

    const homography = this.solveHomography(
      CANONICAL_QR_CORNERS,
      [topLeft, topRight, bottomRight, bottomLeft]
    );
    if (!homography) return null;
    return {
      origin: topLeft,
      horizontal: { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y },
      vertical: { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y },
      homography,
      qrData,
      method,
    };
  }

  private solveHomography(
    source: Point[],
    destination: Point[]
  ): [number, number, number, number, number, number, number, number] | null {
    if (source.length !== 4 || destination.length !== 4) return null;
    const matrix: number[][] = [];
    for (let index = 0; index < 4; index++) {
      const { x, y } = source[index];
      const target = destination[index];
      matrix.push([x, y, 1, 0, 0, 0, -target.x * x, -target.x * y, target.x]);
      matrix.push([0, 0, 0, x, y, 1, -target.y * x, -target.y * y, target.y]);
    }
    for (let column = 0; column < 8; column++) {
      let pivot = column;
      for (let row = column + 1; row < 8; row++) {
        if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
      }
      if (Math.abs(matrix[pivot][column]) < 1e-10) return null;
      [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
      const divisor = matrix[column][column];
      for (let item = column; item < 9; item++) matrix[column][item] /= divisor;
      for (let row = 0; row < 8; row++) {
        if (row === column) continue;
        const factor = matrix[row][column];
        for (let item = column; item < 9; item++) matrix[row][item] -= factor * matrix[column][item];
      }
    }
    return matrix.map(row => row[8]) as [number, number, number, number, number, number, number, number];
  }

  private findQrFinderAnchor(gray: Uint8Array, width: number, height: number): SheetAnchor | null {
    const candidates: FinderCandidate[] = [];
    const startY = Math.floor(height * 0.45);
    const endY = Math.floor(height * 0.995);
    for (let y = startY; y < endY; y += 2) {
      const runs: Array<{ dark: boolean; length: number; end: number }> = [];
      let dark = gray[y * width] < 135;
      let length = 1;
      for (let x = 1; x < width; x++) {
        const nextDark = gray[y * width + x] < 135;
        if (nextDark === dark) {
          length++;
          continue;
        }
        runs.push({ dark, length, end: x });
        if (runs.length > 5) runs.shift();
        dark = nextDark;
        length = 1;
        if (runs.length !== 5 || !this.isFinderPattern(runs.map(run => run.length))) continue;
        if (!(runs[0].dark && !runs[1].dark && runs[2].dark && !runs[3].dark && runs[4].dark)) continue;
        const centerX = runs[4].end - runs[4].length - runs[3].length - runs[2].length / 2;
        const total = runs.reduce((sum, run) => sum + run.length, 0);
        const verticalSize = this.crossCheckFinder(gray, width, height, Math.round(centerX), y, total);
        if (!verticalSize) continue;
        this.mergeFinderCandidate(candidates, { x: centerX, y, size: (total + verticalSize) / 2, hits: 1 });
      }
    }
    const strong = candidates.filter(candidate => candidate.hits >= 2);
    if (strong.length < 3) return null;

    let best: { corner: FinderCandidate; first: FinderCandidate; second: FinderCandidate; score: number } | null = null;
    for (let i = 0; i < strong.length - 2; i++) {
      for (let j = i + 1; j < strong.length - 1; j++) {
        for (let k = j + 1; k < strong.length; k++) {
          const points = [strong[i], strong[j], strong[k]];
          for (let cornerIndex = 0; cornerIndex < 3; cornerIndex++) {
            const corner = points[cornerIndex];
            const other = points.filter((_, index) => index !== cornerIndex);
            const a = { x: other[0].x - corner.x, y: other[0].y - corner.y };
            const b = { x: other[1].x - corner.x, y: other[1].y - corner.y };
            const lenA = Math.hypot(a.x, a.y);
            const lenB = Math.hypot(b.x, b.y);
            if (lenA < corner.size * 2 || lenB < corner.size * 2) continue;
            const averageFinderSize = points.reduce((sum, point) => sum + point.size, 0) / 3;
            const finderRatioA = lenA / averageFinderSize;
            const finderRatioB = lenB / averageFinderSize;
            // Finder centres in a standard QR code are 14 modules apart,
            // while each 1:1:3:1:1 run is 7 modules wide. The expected ratio
            // is therefore about 2 (not 3+). Keeping this gate centred on the
            // QR geometry prevents text/bubbles from becoming a false anchor.
            if (finderRatioA < 1.55 || finderRatioA > 2.75 || finderRatioB < 1.55 || finderRatioB > 2.75) continue;
            const minX = Math.floor(Math.min(...points.map(point => point.x)) - averageFinderSize * 0.55);
            const maxX = Math.ceil(Math.max(...points.map(point => point.x)) + averageFinderSize * 0.55);
            const minY = Math.floor(Math.min(...points.map(point => point.y)) - averageFinderSize * 0.55);
            const maxY = Math.ceil(Math.max(...points.map(point => point.y)) + averageFinderSize * 0.55);
            const darkDensity = this.regionDarkDensity(gray, width, height, minX, minY, maxX, maxY);
            if (darkDensity < 0.28 || darkDensity > 0.7) continue;
            const angleError = Math.abs(a.x * b.x + a.y * b.y) / (lenA * lenB);
            const lengthError = Math.abs(lenA - lenB) / Math.max(lenA, lenB);
            const sizeError = (Math.max(...points.map(point => point.size)) - Math.min(...points.map(point => point.size)))
              / Math.max(...points.map(point => point.size));
            const score = angleError * 2 + lengthError + sizeError + Math.abs(darkDensity - 0.4) * 0.35;
            if (angleError < 0.3 && lengthError < 0.35 && sizeError < 0.45 && (!best || score < best.score)) {
              best = { corner, first: other[0], second: other[1], score };
            }
          }
        }
      }
    }
    if (!best) return null;

    let topRight = best.first;
    let bottomLeft = best.second;
    const cross = (topRight.x - best.corner.x) * (bottomLeft.y - best.corner.y)
      - (topRight.y - best.corner.y) * (bottomLeft.x - best.corner.x);
    if (cross < 0) [topRight, bottomLeft] = [bottomLeft, topRight];
    const moduleSize = (best.corner.size + topRight.size + bottomLeft.size) / 21;
    const legHorizontal = { x: topRight.x - best.corner.x, y: topRight.y - best.corner.y };
    const legVertical = { x: bottomLeft.x - best.corner.x, y: bottomLeft.y - best.corner.y };
    const horizontalLength = Math.hypot(legHorizontal.x, legHorizontal.y);
    const verticalLength = Math.hypot(legVertical.x, legVertical.y);
    const horizontalScale = (horizontalLength + 7 * moduleSize) / horizontalLength;
    const verticalScale = (verticalLength + 7 * moduleSize) / verticalLength;
    const horizontal = { x: legHorizontal.x * horizontalScale, y: legHorizontal.y * horizontalScale };
    const vertical = { x: legVertical.x * verticalScale, y: legVertical.y * verticalScale };
    const origin = {
      x: best.corner.x - horizontal.x * (3.5 * moduleSize / (horizontalLength + 7 * moduleSize))
        - vertical.x * (3.5 * moduleSize / (verticalLength + 7 * moduleSize)),
      y: best.corner.y - horizontal.y * (3.5 * moduleSize / (horizontalLength + 7 * moduleSize))
        - vertical.y * (3.5 * moduleSize / (verticalLength + 7 * moduleSize)),
    };
    return { origin, horizontal, vertical, method: 'qr-finder' };
  }

  private isFinderPattern(runs: number[]): boolean {
    const total = runs.reduce((sum, value) => sum + value, 0);
    if (total < 10) return false;
    const module = total / 7;
    const tolerance = module * 0.8;
    return Math.abs(runs[0] - module) < tolerance
      && Math.abs(runs[1] - module) < tolerance
      && Math.abs(runs[2] - 3 * module) < 3 * tolerance
      && Math.abs(runs[3] - module) < tolerance
      && Math.abs(runs[4] - module) < tolerance;
  }

  private crossCheckFinder(
    gray: Uint8Array,
    width: number,
    height: number,
    x: number,
    y: number,
    expectedTotal: number
  ): number | null {
    const lengths = [0, 0, 0, 0, 0];
    let cursor = y;
    while (cursor >= 0 && gray[cursor * width + x] < 135) { lengths[2]++; cursor--; }
    while (cursor >= 0 && gray[cursor * width + x] >= 135) { lengths[1]++; cursor--; }
    while (cursor >= 0 && gray[cursor * width + x] < 135) { lengths[0]++; cursor--; }
    cursor = y + 1;
    while (cursor < height && gray[cursor * width + x] < 135) { lengths[2]++; cursor++; }
    while (cursor < height && gray[cursor * width + x] >= 135) { lengths[3]++; cursor++; }
    while (cursor < height && gray[cursor * width + x] < 135) { lengths[4]++; cursor++; }
    const total = lengths.reduce((sum, value) => sum + value, 0);
    if (Math.abs(total - expectedTotal) > expectedTotal * 0.65) return null;
    return this.isFinderPattern(lengths) ? total : null;
  }

  private mergeFinderCandidate(candidates: FinderCandidate[], next: FinderCandidate): void {
    const existing = candidates.find(candidate => Math.hypot(candidate.x - next.x, candidate.y - next.y) < next.size * 0.45);
    if (!existing) {
      candidates.push(next);
      return;
    }
    const hits = existing.hits + 1;
    existing.x = (existing.x * existing.hits + next.x) / hits;
    existing.y = (existing.y * existing.hits + next.y) / hits;
    existing.size = (existing.size * existing.hits + next.size) / hits;
    existing.hits = hits;
  }

  private regionDarkDensity(
    gray: Uint8Array,
    width: number,
    height: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number
  ): number {
    let dark = 0;
    let samples = 0;
    for (let y = Math.max(0, minY); y <= Math.min(height - 1, maxY); y += 2) {
      for (let x = Math.max(0, minX); x <= Math.min(width - 1, maxX); x += 2) {
        if (gray[y * width + x] < 135) dark++;
        samples++;
      }
    }
    return samples ? dark / samples : 0;
  }

  private project(anchor: SheetAnchor, x: number, y: number): Point {
    if (anchor.homography) {
      const [a, b, c, d, e, f, g, h] = anchor.homography;
      const scale = g * x + h * y + 1;
      return { x: (a * x + b * y + c) / scale, y: (d * x + e * y + f) / scale };
    }
    return {
      x: anchor.origin.x + anchor.horizontal.x * x + anchor.vertical.x * y,
      y: anchor.origin.y + anchor.horizontal.y * x + anchor.vertical.y * y,
    };
  }

  private anchorBubbleRadius(anchor: SheetAnchor, canonicalX?: number, canonicalY?: number): number {
    if (anchor.homography && canonicalX !== undefined && canonicalY !== undefined) {
      const horizontalStart = this.project(anchor, canonicalX - 8, canonicalY);
      const horizontalEnd = this.project(anchor, canonicalX + 8, canonicalY);
      const verticalStart = this.project(anchor, canonicalX, canonicalY - 8);
      const verticalEnd = this.project(anchor, canonicalX, canonicalY + 8);
      return Math.max(2, (
        Math.hypot(horizontalEnd.x - horizontalStart.x, horizontalEnd.y - horizontalStart.y)
        + Math.hypot(verticalEnd.x - verticalStart.x, verticalEnd.y - verticalStart.y)
      ) / 4);
    }
    const qrScale = (Math.hypot(anchor.horizontal.x, anchor.horizontal.y)
      + Math.hypot(anchor.vertical.x, anchor.vertical.y)) / 2;
    return Math.max(2, qrScale * 0.055);
  }

  private findAnswerGridComponents(
    gray: Uint8Array,
    width: number,
    height: number,
    qrAnchored: boolean
  ): AnswerGrid | null {
    const paper = this.findPaperBand(gray, width, height);
    if (!paper) return null;
    const binary = new Uint8Array(width * height);
    const minY = Math.round(height * 0.035);
    const maxY = Math.round(height * 0.9);
    for (let y = minY; y <= maxY; y++) {
      let mean = 0;
      let samples = 0;
      for (let x = paper.start; x <= paper.end; x += 4) {
        mean += gray[y * width + x];
        samples++;
      }
      const threshold = Math.max(65, Math.min(182, mean / Math.max(1, samples) - 30));
      for (let x = paper.start; x <= paper.end; x++) {
        if (gray[y * width + x] < threshold) binary[y * width + x] = 1;
      }
    }

    const visited = new Uint8Array(binary.length);
    const queue = new Int32Array((paper.end - paper.start + 1) * (maxY - minY + 1));
    const minDiameter = Math.max(7, Math.round(Math.min(width, height) * 0.007));
    const maxDiameter = Math.max(minDiameter + 2, Math.round(Math.min(width, height) * 0.05));
    const candidates: Array<{ x: number; y: number; radius: number; quality: number }> = [];
    for (let seedY = minY; seedY <= maxY; seedY++) {
      for (let seedX = paper.start; seedX <= paper.end; seedX++) {
        const seed = seedY * width + seedX;
        if (!binary[seed] || visited[seed]) continue;
        visited[seed] = 1;
        queue[0] = seed;
        let head = 0;
        let tail = 1;
        let area = 0;
        let left = seedX;
        let right = seedX;
        let top = seedY;
        let bottom = seedY;
        while (head < tail) {
          const index = queue[head++];
          const y = Math.floor(index / width);
          const x = index - y * width;
          area++;
          left = Math.min(left, x);
          right = Math.max(right, x);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
          for (let dy = -1; dy <= 1; dy++) {
            const nextY = y + dy;
            if (nextY < minY || nextY > maxY) continue;
            for (let dx = -1; dx <= 1; dx++) {
              if (!dx && !dy) continue;
              const nextX = x + dx;
              if (nextX < paper.start || nextX > paper.end) continue;
              const next = nextY * width + nextX;
              if (binary[next] && !visited[next]) {
                visited[next] = 1;
                queue[tail++] = next;
              }
            }
          }
        }
        const componentWidth = right - left + 1;
        const componentHeight = bottom - top + 1;
        if (componentWidth < minDiameter || componentHeight < minDiameter
          || componentWidth > maxDiameter || componentHeight > maxDiameter) continue;
        const aspect = componentWidth / componentHeight;
        if (aspect < 0.62 || aspect > 1.62) continue;
        const fill = area / (componentWidth * componentHeight);
        if (fill < 0.12 || fill > 0.92) continue;
        const quality = (1 - Math.abs(1 - aspect)) * Math.min(1, fill / 0.38) * Math.sqrt(area);
        candidates.push({
          x: (left + right) / 2,
          y: (top + bottom) / 2,
          radius: (componentWidth + componentHeight) / 4,
          quality,
        });
      }
    }
    const circles: typeof candidates = [];
    for (const candidate of candidates.sort((a, b) => b.quality - a.quality)) {
      const duplicate = circles.some(circle =>
        Math.hypot(circle.x - candidate.x, circle.y - candidate.y) < Math.min(circle.radius, candidate.radius) * 0.55);
      if (!duplicate) circles.push(candidate);
    }
    const debugRadii = circles.map(circle => circle.radius).sort((a, b) => a - b);
    const medianRadius = debugRadii[Math.floor(debugRadii.length / 2)] || 0;
    const latticeCircles = circles.filter(circle =>
      circle.radius >= medianRadius * 0.78 && circle.radius <= medianRadius * 1.55);
    // Fit rows before columns. A photographed page is a trapezoid, so treating
    // each answer column as one fixed x coordinate shifts the lower bubbles by
    // up to an entire choice. The row-first fit learns that drift from the
    // printed rings themselves and is independent of which bubbles are filled.
    const grid = this.fitRingLatticeByRows(latticeCircles, width, height, paper)
      || this.fitRingLattice(latticeCircles, width, height, paper, qrAnchored);
    return grid || this.findAnswerGrid(gray, width, height, null, latticeCircles);
  }

  private fitRingLatticeByRows(
    circles: Array<{ x: number; y: number; radius: number; quality: number }>,
    width: number,
    height: number,
    paperBounds: { start: number; end: number }
  ): AnswerGrid | null {
    if (circles.length < 70) return null;
    const paperWidth = paperBounds.end - paperBounds.start;
    if (paperWidth < width * 0.12 || paperWidth > width * 0.82) return null;

    // Both 25-question blocks share the same physical row cadence, giving the
    // vertical fit as many as eight ring observations per row. This is much
    // harder for headings, digits, or filled bubbles to imitate.
    const rowFit = this.fitPeriodicValues(
      circles.map(circle => circle.y),
      height * 0.17,
      height * 0.205,
      paperWidth * 0.047,
      paperWidth * 0.055,
      25
    );
    if (!rowFit) return null;

    const rowTolerance = Math.max(4, rowFit.spacing * 0.34);
    const observedRows: Array<number | null> = Array.from({ length: 25 }, (_, row) => {
      const expected = rowFit.first + row * rowFit.spacing;
      const observations = circles
        .filter(circle => Math.abs(circle.y - expected) <= rowTolerance)
        .map(circle => circle.y)
        .sort((a, b) => a - b);
      return observations.length >= 3
        ? observations[Math.floor(observations.length / 2)]
        : null;
    });
    if (observedRows.filter(value => value !== null).length < 19) return null;
    const rows = this.interpolateSeries(observedRows);

    const fitBlock = (firstMinFraction: number, firstMaxFraction: number): {
      firstLine: { intercept: number; slope: number };
      spacingLine: { intercept: number; slope: number };
      support: number;
    } | null => {
      const models: Array<{ row: number; y: number; first: number; spacing: number }> = [];
      for (let row = 0; row < 25; row++) {
        const observations = circles
          .filter(circle =>
            Math.abs(circle.y - rows[row]) <= rowTolerance
            && circle.x >= paperBounds.start + paperWidth * firstMinFraction
            && circle.x <= paperBounds.start + paperWidth * (firstMaxFraction + 0.22))
          .map(circle => circle.x);
        const fit = this.fitPeriodicValues(
          observations,
          paperBounds.start + paperWidth * firstMinFraction,
          paperBounds.start + paperWidth * firstMaxFraction,
          paperWidth * 0.034,
          paperWidth * 0.061,
          4,
          2.5
        );
        if (fit) models.push({ row, y: rows[row], first: fit.first, spacing: fit.spacing });
      }
      if (models.length < 14) return null;

      // Remove text-shaped outliers before fitting the perspective lines.
      const spacings = models.map(model => model.spacing).sort((a, b) => a - b);
      const medianSpacing = spacings[Math.floor(spacings.length / 2)];
      const spacingFiltered = models.filter(model =>
        Math.abs(model.spacing - medianSpacing) <= Math.max(3, medianSpacing * 0.22));
      if (spacingFiltered.length < 12) return null;
      const initialFirstLine = this.fitLine(
        spacingFiltered.map(model => ({ x: model.y, y: model.first })),
        spacingFiltered[Math.floor(spacingFiltered.length / 2)].first
      );
      const firstResiduals = spacingFiltered
        .map(model => Math.abs(model.first - (initialFirstLine.intercept + initialFirstLine.slope * model.y)))
        .sort((a, b) => a - b);
      const medianResidual = firstResiduals[Math.floor(firstResiduals.length / 2)] || 0;
      const inliers = spacingFiltered.filter(model =>
        Math.abs(model.first - (initialFirstLine.intercept + initialFirstLine.slope * model.y))
          <= Math.max(4, medianResidual * 2.5));
      if (inliers.length < 10) return null;

      const firstLine = this.fitLine(
        inliers.map(model => ({ x: model.y, y: model.first })),
        inliers[Math.floor(inliers.length / 2)].first
      );
      const spacingLine = this.fitLine(
        inliers.map(model => ({ x: model.y, y: model.spacing })),
        medianSpacing
      );
      const supportTolerance = Math.max(4, medianSpacing * 0.34);
      const laneSupport = Array(4).fill(0);
      let supportedRows = 0;
      for (const rowY of rows) {
        const first = firstLine.intercept + firstLine.slope * rowY;
        const spacing = spacingLine.intercept + spacingLine.slope * rowY;
        if (spacing < paperWidth * 0.031 || spacing > paperWidth * 0.066) return null;
        let rowSupport = 0;
        for (let choice = 0; choice < 4; choice++) {
          const x = first + choice * spacing;
          const found = circles.some(circle =>
            Math.abs(circle.y - rowY) <= rowTolerance
            && Math.abs(circle.x - x) <= supportTolerance);
          if (found) {
            laneSupport[choice]++;
            rowSupport++;
          }
        }
        if (rowSupport >= 2) supportedRows++;
      }
      const support = laneSupport.reduce((sum, value) => sum + value, 0);
      if (support < 56 || supportedRows < 20 || Math.min(...laneSupport) < 10) return null;
      return { firstLine, spacingLine, support };
    };

    const left = fitBlock(0.055, 0.27);
    const right = fitBlock(0.53, 0.72);
    if (!left || !right) return null;
    const centers: Point[][] = [];
    for (const block of [left, right]) {
      for (const rowY of rows) {
        const first = block.firstLine.intercept + block.firstLine.slope * rowY;
        const spacing = block.spacingLine.intercept + block.spacingLine.slope * rowY;
        centers.push(Array.from({ length: 4 }, (_, choice) => ({
          x: first + choice * spacing,
          y: rowY,
        })));
      }
    }
    const radii = circles.map(circle => circle.radius).sort((a, b) => a - b);
    const printedRadius = radii[Math.floor(radii.length / 2)];
    return { centers, radius: Math.max(2, printedRadius * 0.58) };
  }

  private fitRingLattice(
    circles: Array<{ x: number; y: number; radius: number; quality: number }>,
    width: number,
    height: number,
    paperBounds?: { start: number; end: number },
    qrAnchored = false
  ): AnswerGrid | null {
    if (circles.length < 80) return null;
    const xs = circles.map(circle => circle.x).sort((a, b) => a - b);
    const central = xs.filter(x => x >= width * 0.15 && x <= width * 0.85);
    if (central.length < 60) return null;
    const paperStart = paperBounds?.start ?? central[Math.floor(central.length * 0.02)];
    const paperEnd = paperBounds?.end ?? central[Math.floor(central.length * 0.98)];
    const paperWidth = paperEnd - paperStart;
    if (paperWidth < width * 0.12 || paperWidth > width * 0.82) return null;

    const leftFit = this.fitPeriodicValues(
      circles.map(circle => circle.x),
      paperStart + paperWidth * (qrAnchored ? 0.14 : 0.03), paperStart + paperWidth * (qrAnchored ? 0.28 : 0.34),
      paperWidth * 0.035, paperWidth * 0.085, 4
    );
    const rightFit = this.fitPeriodicValues(
      circles.map(circle => circle.x),
      paperStart + paperWidth * 0.54, paperStart + paperWidth * 0.74,
      paperWidth * 0.035, paperWidth * 0.085, 4
    );
    if (!leftFit || !rightFit) return null;
    const xTolerance = Math.max(4, Math.min(leftFit.spacing, rightFit.spacing) * 0.48);
    const laneBlocks = [leftFit, rightFit].map(fit => circles.filter(circle => {
      const distance = Math.min(...Array.from(
        { length: 4 }, (_, choice) => Math.abs(circle.x - (fit.first + choice * fit.spacing))
      ));
      return distance <= xTolerance;
    }));
    if (laneBlocks.some(block => block.length < 45)) return null;
    const rowFits = laneBlocks.map(block => this.fitPeriodicValues(
      block.map(circle => circle.y),
      height * (qrAnchored ? 0.255 : 0.06), height * (qrAnchored ? 0.31 : 0.42),
      Math.max(8, paperWidth * (qrAnchored ? 0.041 : 0.035)), paperWidth * (qrAnchored ? 0.049 : 0.075), 25
    ));
    if (rowFits.some(fit => !fit)) return null;
    const refinedRowsByBlock = laneBlocks.map((block, blockIndex) => {
      const fit = rowFits[blockIndex]!;
      const tolerance = Math.max(4, fit.spacing * 0.34);
      const values = Array.from({ length: 25 }, (_, row) => {
        const expectedY = fit.first + row * fit.spacing;
        const observations = block
          .filter(circle => Math.abs(circle.y - expectedY) <= tolerance)
          .map(circle => circle.y)
          .sort((a, b) => a - b);
        return observations.length >= 2 ? observations[Math.floor(observations.length / 2)] : null;
      });
      return values.filter(value => value !== null).length >= 18 ? this.interpolateSeries(values) : null;
    });
    if (refinedRowsByBlock.some(rows => !rows)) return null;
    const blockFits = [leftFit, rightFit].map((fit, blockIndex) => Array.from({ length: 4 }, (_, choice) => {
      const expectedX = fit.first + choice * fit.spacing;
      const rowFit = rowFits[blockIndex]!;
      const yTolerance = Math.max(4, rowFit.spacing * 0.34);
      const observations = laneBlocks[blockIndex].filter(circle =>
        Math.abs(circle.x - expectedX) <= xTolerance
        && Math.abs(circle.y - (rowFit.first + Math.round((circle.y - rowFit.first) / rowFit.spacing) * rowFit.spacing)) <= yTolerance);
      return this.fitLine(observations.map(circle => ({ x: circle.y, y: circle.x })), expectedX);
    }));
    const centers: Point[][] = [];
    for (let block = 0; block < 2; block++) {
      for (let row = 0; row < 25; row++) {
        const rowY = refinedRowsByBlock[block]![row];
        centers.push(Array.from({ length: 4 }, (_, choice) => ({
          x: blockFits[block][choice].intercept + blockFits[block][choice].slope * rowY,
          y: rowY,
        })));
      }
    }
    const radii = ([] as typeof circles).concat(...laneBlocks).map(circle => circle.radius).sort((a, b) => a - b);
    const printedRadius = radii[Math.floor(radii.length / 2)];
    return { centers, radius: Math.max(2, printedRadius * 0.58) };
  }

  private fitPeriodicValues(
    values: number[],
    firstMin: number,
    firstMax: number,
    spacingMin: number,
    spacingMax: number,
    count: number,
    minimumScore = count * 1.2
  ): { first: number; spacing: number; score: number } | null {
    let best: { first: number; spacing: number; score: number } | null = null;
    for (let spacing = Math.max(2, Math.round(spacingMin)); spacing <= Math.round(spacingMax); spacing++) {
      const tolerance = Math.max(3, spacing * 0.28);
      for (let first = Math.round(firstMin); first <= Math.round(firstMax); first++) {
        const laneSupport = Array(count).fill(0);
        let score = 0;
        for (const value of values) {
          let nearest = 0;
          for (let lane = 1; lane < count; lane++) {
            if (Math.abs(value - (first + lane * spacing)) < Math.abs(value - (first + nearest * spacing))) nearest = lane;
          }
          const distance = Math.abs(value - (first + nearest * spacing));
          if (distance <= tolerance) {
            laneSupport[nearest]++;
            score += 1 - distance / tolerance;
          }
        }
        score += Math.min(...laneSupport) * 2;
        if (!best || score > best.score) best = { first, spacing, score };
      }
    }
    return best && best.score >= minimumScore ? best : null;
  }

  private interpolateSeries(values: Array<number | null>): number[] {
    const observed = values.map((value, index) => ({ value, index })).filter(item => item.value !== null);
    if (!observed.length) return values.map(() => 0);
    return values.map((value, index) => {
      if (value !== null) return value;
      const before = [...observed].reverse().find(item => item.index < index);
      const after = observed.find(item => item.index > index);
      if (!before) return after!.value as number;
      if (!after) return before.value as number;
      const progress = (index - before.index) / (after.index - before.index);
      return (before.value as number) + ((after.value as number) - (before.value as number)) * progress;
    });
  }

  private fitLine(points: Point[], fallback: number): { intercept: number; slope: number } {
    if (points.length < 4) return { intercept: fallback, slope: 0 };
    const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
    const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
    const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
    const slope = denominator
      ? points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
      : 0;
    return { intercept: meanY - slope * meanX, slope };
  }

  private findAnswerGrid(
    gray: Uint8Array,
    width: number,
    height: number,
    anchor: SheetAnchor | null = null,
    circleEvidence: Array<{ x: number; y: number; radius: number; quality: number }> = []
  ): AnswerGrid | null {
    const paper = this.findPaperBand(gray, width, height);
    if (!paper) return null;
    const paperWidth = paper.end - paper.start;
    const xStart = Math.round(paper.start + paperWidth * 0.1);
    const xEnd = Math.round(paper.start + paperWidth * 0.86);
    const verticalProfile = new Float32Array(height);

    for (let y = Math.round(height * 0.035); y < Math.round(height * 0.9); y++) {
      let rowSum = 0;
      let rowSamples = 0;
      for (let x = paper.start; x <= paper.end; x += 4) {
        rowSum += gray[y * width + x];
        rowSamples++;
      }
      const paperMean = rowSum / Math.max(1, rowSamples);
      const darkThreshold = Math.max(75, Math.min(175, paperMean - 32));
      let dark = 0;
      for (let x = xStart; x <= xEnd; x += 2) {
        const value = gray[y * width + x];
        if (value < darkThreshold) dark += (darkThreshold - value) / 50;
      }
      verticalProfile[y] = dark;
    }

    if (anchor?.homography) {
      // A four-corner QR homography is excellent near the footer but a
      // one-pixel QR-corner error can move the first answer row by several
      // rows after extrapolation.  Use it as an absolute-phase seed, then fit
      // a smooth top-to-bottom correction against all 25 printed ring rows.
      // If that complete physical grid cannot be proved, fail closed instead
      // of falling back to an unconstrained text cadence.
      return this.fitQrConstrainedGrid(
        gray, width, height, verticalProfile, paper.start, paper.end, anchor
      );
    }

    // Current QR sheets have a row pitch around 4.2-5.2% of the visible paper
    // width.  Allowing the legacy 2.4% lower bound made the optimizer lock on
    // the top/bottom edges of each printed ring as two separate answer rows.
    const qrAnchored = !!anchor;
    const minSpacing = Math.max(8, Math.round(paperWidth * 0.047));
    const maxSpacing = Math.max(minSpacing + 1, Math.round(paperWidth * 0.055));
    const projectedFirstRow = anchor?.homography
      ? this.project(anchor, NOMINAL_LEFT_X[0] * CANONICAL_WIDTH, NOMINAL_TOP_Y * CANONICAL_HEIGHT).y
      : null;
    const projectedLastRow = anchor?.homography
      ? this.project(
        anchor,
        NOMINAL_LEFT_X[0] * CANONICAL_WIDTH,
        (NOMINAL_TOP_Y + 24 * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT
      ).y
      : null;
    let bestStart = 0;
    let bestSpacing = 0;
    let bestScore = -Infinity;
    for (let spacing = minSpacing; spacing <= maxSpacing; spacing++) {
      const latestStart = Math.min(
        Math.round(height * (qrAnchored ? 0.42 : 0.20)),
        height - 1 - Math.round(height * 0.035) - spacing * 24
      );
      const earliestStart = Math.round(height * (qrAnchored ? 0.045 : 0.165));
      for (let start = earliestStart; start <= latestStart; start++) {
        if (projectedFirstRow !== null && projectedLastRow !== null) {
          // QR corners are a noisy long-distance extrapolation at row 1, but
          // they reliably identify the absolute 25-row phase.  Reject text or
          // ring-edge cadences that cannot bracket both printed edge rows.
          if (Math.abs(start - projectedFirstRow) > Math.max(spacing * 3.2, height * 0.065)) continue;
          if (Math.abs(start + spacing * 24 - projectedLastRow) > Math.max(spacing * 1.8, height * 0.04)) continue;
        }
        let total = 0;
        let weakest = Infinity;
        for (let row = 0; row < 25; row++) {
          const center = Math.round(start + row * spacing);
          const value = Math.max(
            verticalProfile[Math.max(0, center - 1)],
            verticalProfile[center],
            verticalProfile[Math.min(height - 1, center + 1)]
          );
          total += value;
          weakest = Math.min(weakest, value);
        }
        const score = total + weakest * 5;
        if (score > bestScore) {
          bestScore = score;
          bestStart = start;
          bestSpacing = spacing;
        }
      }
    }
    if (!bestSpacing || bestScore <= 0) return null;

    let gridCandidate: {
      rows: number[];
      left: { first: number; spacing: number };
      right: { first: number; spacing: number };
      score: number;
    } | null = null;
    // Header text can repeat at approximately the row cadence. Compare a
    // few consecutive phases and retain the one whose complete four-choice
    // rings are strongest across both 25-row blocks.
    for (let phaseOffset = 0; phaseOffset <= (qrAnchored ? 3 : 0); phaseOffset++) {
      const candidateStart = bestStart + phaseOffset * bestSpacing;
      if (candidateStart + bestSpacing * 24 >= height * 0.91) break;
      if (projectedFirstRow !== null && projectedLastRow !== null) {
        if (Math.abs(candidateStart - projectedFirstRow) > Math.max(bestSpacing * 3.2, height * 0.065)) continue;
        if (Math.abs(candidateStart + bestSpacing * 24 - projectedLastRow) > Math.max(bestSpacing * 1.8, height * 0.04)) continue;
      }
      const candidate = this.evaluateGridCandidate(
        gray, width, height, verticalProfile, paper.start, paper.end, candidateStart, bestSpacing
      );
      if (candidate && projectedFirstRow !== null && projectedLastRow !== null) {
        if (Math.abs(candidate.rows[0] - projectedFirstRow) > Math.max(bestSpacing * 3.2, height * 0.065)) continue;
        if (Math.abs(candidate.rows[24] - projectedLastRow) > Math.max(bestSpacing * 1.8, height * 0.04)) continue;
      }
      if (candidate && (!gridCandidate || candidate.score > gridCandidate.score)) gridCandidate = candidate;
    }
    if (!gridCandidate) return null;
    const { rows, left, right } = gridCandidate;
    const radius = Math.max(2, Math.min(bestSpacing, left.spacing, right.spacing) * 0.22);
    const leftPerspective = !qrAnchored
      ? this.fitFreePerspectiveChoiceBlock(
        gray, width, height, rows, paper.start, paper.end, bestSpacing, 0.075, 0.27, circleEvidence
      )
      : null;
    const leftReferenceFraction = leftPerspective
      ? (leftPerspective.firsts[12] - paper.start) / paperWidth
      : 0.15;
    const rightMinFraction = Math.max(0.52, leftReferenceFraction + 0.425);
    const rightMaxFraction = Math.min(0.76, leftReferenceFraction + 0.515);
    const rightPerspective = !qrAnchored
      ? this.fitFreePerspectiveChoiceBlock(
        gray, width, height, rows, paper.start, paper.end, bestSpacing,
        rightMinFraction, rightMaxFraction, circleEvidence
      )
      : null;
    const centers: Point[][] = [];
    for (const model of [leftPerspective, rightPerspective]) {
      if (!model) continue;
      for (let row = 0; row < 25; row++) {
        centers.push(Array.from({ length: 4 }, (_, choice) => ({
          x: model.firsts[row] + choice * model.spacings[row],
          y: rows[row],
        })));
      }
    }
    if (centers.length === 50) {
      return { centers, radius };
    }
    return { centers, radius };
  }

  private fitFreePerspectiveChoiceBlock(
    gray: Uint8Array,
    width: number,
    height: number,
    rows: number[],
    paperStart: number,
    paperEnd: number,
    rowSpacing: number,
    firstMinFraction: number,
    firstMaxFraction: number,
    circles: Array<{ x: number; y: number; radius: number; quality: number }> = []
  ): { firsts: number[]; spacings: number[]; score: number } | null {
    const paperWidth = paperEnd - paperStart;
    const firstMin = Math.round(paperStart + paperWidth * firstMinFraction);
    const firstMax = Math.round(paperStart + paperWidth * firstMaxFraction);
    const spacingMin = Math.max(6, Math.round(Math.max(paperWidth * 0.035, rowSpacing * 0.72)));
    const spacingMax = Math.max(spacingMin, Math.round(Math.min(paperWidth * 0.062, rowSpacing * 1.12)));
    const maxFirstDrift = Math.round(paperWidth * 0.12);
    const maxSpacingDrift = Math.round(paperWidth * 0.022);
    const evidenceRadius = Math.max(3, rowSpacing * 0.24);
    const evidence = rows.map(rowY => {
      const profile = new Float32Array(width);
      for (let x = Math.max(0, firstMin - maxFirstDrift);
        x <= Math.min(width - 1, firstMax + maxFirstDrift + spacingMax * 4); x++) {
        profile[x] = this.bubbleRingEvidence(gray, width, height, x, rowY, evidenceRadius);
      }
      return profile;
    });

    const componentTolerance = Math.max(3, rowSpacing * 0.24);
    const componentEvidence = rows.map(rowY => {
      const profile = new Uint8Array(width);
      for (const circle of circles) {
        if (Math.abs(circle.y - rowY) > rowSpacing * 0.34) continue;
        const center = Math.round(circle.x);
        for (let x = Math.max(0, Math.round(center - componentTolerance));
          x <= Math.min(width - 1, Math.round(center + componentTolerance)); x++) profile[x] = 1;
      }
      return profile;
    });

    let best: {
      first: number;
      spacing: number;
      firstDrift: number;
      spacingDrift: number;
      score: number;
      laneTotals: number[];
      rowTotals: number[];
      componentSupport: number;
    } | null = null;
    const scoreModel = (
      first: number,
      spacing: number,
      firstDrift: number,
      spacingDrift: number
    ): void => {
      const laneTotals = [0, 0, 0, 0];
      const rowTotals: number[] = [];
      let componentSupport = 0;
      for (let row = 0; row < 25; row++) {
        const progress = (row - 12) / 24;
        const rowFirst = first + firstDrift * progress;
        const rowPitch = spacing + spacingDrift * progress;
        let rowTotal = 0;
        for (let choice = 0; choice < 4; choice++) {
          const x = Math.round(rowFirst + choice * rowPitch);
          if (x < 0 || x >= width) return;
          const value = evidence[row][x];
          componentSupport += componentEvidence[row][x];
          laneTotals[choice] += value;
          rowTotal += value;
        }
        rowTotals.push(rowTotal);
      }
      const sortedRows = [...rowTotals].sort((a, b) => a - b);
      const score = laneTotals.reduce((sum, value) => sum + value, 0)
        + Math.min(...laneTotals) * 3
        + sortedRows.slice(0, 6).reduce((sum, value) => sum + value, 0) * 2
        + componentSupport * 2200;
      if (!best || score > best.score) {
        best = { first, spacing, firstDrift, spacingDrift, score, laneTotals, rowTotals, componentSupport };
      }
    };

    // Coarse global search followed by a one-pixel refinement keeps live
    // scanning responsive while still following strong trapezoid perspective.
    for (let spacing = spacingMin; spacing <= spacingMax; spacing++) {
      for (let first = firstMin; first <= firstMax; first += 2) {
        for (let firstDrift = -maxFirstDrift; firstDrift <= maxFirstDrift; firstDrift += 4) {
          for (let spacingDrift = -maxSpacingDrift; spacingDrift <= maxSpacingDrift; spacingDrift += 2) {
            scoreModel(first, spacing, firstDrift, spacingDrift);
          }
        }
      }
    }
    if (!best) return null;
    const coarse = best as {
      first: number; spacing: number; firstDrift: number; spacingDrift: number;
      score: number; laneTotals: number[]; rowTotals: number[]; componentSupport: number;
    };
    for (let spacing = Math.max(spacingMin, coarse.spacing - 1);
      spacing <= Math.min(spacingMax, coarse.spacing + 1); spacing++) {
      for (let first = Math.max(firstMin, coarse.first - 3);
        first <= Math.min(firstMax, coarse.first + 3); first++) {
        for (let firstDrift = Math.max(-maxFirstDrift, coarse.firstDrift - 4);
          firstDrift <= Math.min(maxFirstDrift, coarse.firstDrift + 4); firstDrift++) {
          for (let spacingDrift = Math.max(-maxSpacingDrift, coarse.spacingDrift - 2);
            spacingDrift <= Math.min(maxSpacingDrift, coarse.spacingDrift + 2); spacingDrift++) {
            scoreModel(first, spacing, firstDrift, spacingDrift);
          }
        }
      }
    }
    if (!best) return null;
    const model = best as {
      first: number; spacing: number; firstDrift: number; spacingDrift: number;
      score: number; laneTotals: number[]; rowTotals: number[]; componentSupport: number;
    };
    const firsts = rows.map((_, row) => model.first + model.firstDrift * ((row - 12) / 24));
    const spacings = rows.map((_, row) => model.spacing + model.spacingDrift * ((row - 12) / 24));
    return { firsts, spacings, score: model.score };
  }

  private fitQrConstrainedGrid(
    gray: Uint8Array,
    width: number,
    height: number,
    verticalProfile: Float32Array,
    paperStart: number,
    paperEnd: number,
    anchor: SheetAnchor
  ): AnswerGrid | null {
    const projectedRows = Array.from({ length: 25 }, (_, row) => {
      const canonicalY = (NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT;
      const left = this.project(anchor, NOMINAL_LEFT_X[0] * CANONICAL_WIDTH, canonicalY);
      const right = this.project(anchor, NOMINAL_RIGHT_X[3] * CANONICAL_WIDTH, canonicalY);
      return (left.y + right.y) / 2;
    });
    const pitches = projectedRows.slice(1)
      .map((value, index) => value - projectedRows[index])
      .sort((a, b) => a - b);
    const projectedPitch = pitches[Math.floor(pitches.length / 2)] || 0;
    if (!Number.isFinite(projectedPitch) || projectedPitch < 7) return null;

    const step = Math.max(1, Math.round(projectedPitch * 0.08));
    const refineRadius = Math.max(2, Math.round(projectedPitch * 0.18));
    const rowCandidates: Array<{ rows: number[]; score: number }> = [];
    for (let topOffset = -Math.round(projectedPitch * 1.5);
      topOffset <= Math.round(projectedPitch * 4); topOffset += step) {
      for (let bottomOffset = -Math.round(projectedPitch * 1.5);
        bottomOffset <= Math.round(projectedPitch * 2.5); bottomOffset += step) {
        const rows = projectedRows.map((projected, row) => {
          const progress = row / 24;
          const expected = projected + topOffset * (1 - progress) + bottomOffset * progress;
          let bestY = Math.round(expected);
          let bestValue = -Infinity;
          for (let y = Math.max(0, bestY - refineRadius); y <= Math.min(height - 1, bestY + refineRadius); y++) {
            if (verticalProfile[y] > bestValue) {
              bestValue = verticalProfile[y];
              bestY = y;
            }
          }
          return bestY;
        });
        const gaps = rows.slice(1).map((value, index) => value - rows[index]);
        if (rows[0] < height * 0.06 || rows[24] > height * 0.88
          || Math.min(...gaps) < projectedPitch * 0.55
          || Math.max(...gaps) > projectedPitch * 1.5) continue;
        const signals = rows.map(y => verticalProfile[y]);
        const regularity = gaps.reduce((sum, value) => sum + Math.abs(value - projectedPitch), 0);
        const score = signals.reduce((sum, value) => sum + value, 0)
          + Math.min(...signals) * 8
          + (signals[0] + signals[24]) * 3
          - regularity * 0.4;
        rowCandidates.push({ rows, score });
      }
    }
    rowCandidates.sort((a, b) => b.score - a.score);

    let best: {
      rows: number[];
      left: { first: number; spacing: number };
      right: { first: number; spacing: number };
      score: number;
    } | null = null;
    for (const candidate of rowCandidates.slice(0, 12)) {
      const evaluated = this.evaluateRowsCandidate(
        gray, width, height, paperStart, paperEnd, candidate.rows, projectedPitch
      );
      if (!evaluated) continue;
      const score = evaluated.score + candidate.score * 2;
      if (!best || score > best.score) best = { ...evaluated, score };
    }
    if (!best) return null;

    const gaps = best.rows.slice(1).map((value, index) => value - best!.rows[index]).sort((a, b) => a - b);
    const rowSpacing = gaps[Math.floor(gaps.length / 2)] || projectedPitch;
    const radius = Math.max(2, Math.min(rowSpacing, best.left.spacing, best.right.spacing) * 0.22);
    const leftRingModel = this.fitQrChoiceBlock(
      gray, width, height, best.rows, paperStart, paperEnd, rowSpacing, anchor, NOMINAL_LEFT_X, 0.1, 0.38
    );
    const rightRingModel = this.fitQrChoiceBlock(
      gray, width, height, best.rows, paperStart, paperEnd, rowSpacing, anchor, NOMINAL_RIGHT_X, 0.52, 0.75
    );
    const centers: Point[][] = [];
    const referenceRow = 12;
    for (let block = 0; block < 2; block++) {
      const nominalXs = block ? NOMINAL_RIGHT_X : NOMINAL_LEFT_X;
      const fitted = block ? best.right : best.left;
      const referenceY = (NOMINAL_TOP_Y + referenceRow * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT;
      const referenceProjected = nominalXs.map(x => this.project(anchor, x * CANONICAL_WIDTH, referenceY).x);
      const referencePitch = (referenceProjected[3] - referenceProjected[0]) / 3;
      if (!Number.isFinite(referencePitch) || referencePitch <= 0) return null;
      const ringModel = block ? rightRingModel : leftRingModel;
      if (ringModel) {
        for (let row = 0; row < 25; row++) {
          centers.push(Array.from({ length: 4 }, (_, choice) => ({
            x: ringModel.firsts[row] + choice * ringModel.spacings[row],
            y: best!.rows[row],
          })));
        }
        continue;
      }
      const horizontalScale = fitted.spacing / referencePitch;
      for (let row = 0; row < 25; row++) {
        const canonicalY = (NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT;
        centers.push(nominalXs.map(canonicalX => {
          const projected = this.project(anchor, canonicalX * CANONICAL_WIDTH, canonicalY);
          return {
            x: fitted.first + (projected.x - referenceProjected[0]) * horizontalScale,
            y: best!.rows[row],
          };
        }));
      }
    }
    return { centers, radius, verified: !!leftRingModel && !!rightRingModel };
  }

  private fitQrChoiceBlock(
    gray: Uint8Array,
    width: number,
    height: number,
    rows: number[],
    paperStart: number,
    paperEnd: number,
    rowSpacing: number,
    anchor: SheetAnchor,
    nominalXs: number[],
    firstMinFraction: number,
    firstMaxFraction: number
  ): { firsts: number[]; spacings: number[]; score: number } | null {
    const paperWidth = paperEnd - paperStart;
    const referenceRow = 12;
    const projected = rows.map((_, row) => {
      const canonicalY = (NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT;
      const first = this.project(anchor, nominalXs[0] * CANONICAL_WIDTH, canonicalY).x;
      const last = this.project(anchor, nominalXs[3] * CANONICAL_WIDTH, canonicalY).x;
      return { first, spacing: (last - first) / 3 };
    });
    const referencePitch = projected[referenceRow]?.spacing || 0;
    if (!Number.isFinite(referencePitch) || referencePitch <= 0) return null;

    const firstMin = Math.max(
      paperStart,
      Math.round(projected[referenceRow].first - referencePitch * 2.6),
      Math.round(paperStart + paperWidth * firstMinFraction)
    );
    const firstMax = Math.min(
      paperEnd,
      Math.round(projected[referenceRow].first + referencePitch * 2.6),
      Math.round(paperStart + paperWidth * firstMaxFraction)
    );
    const spacingMin = Math.max(
      6,
      Math.round(referencePitch * 0.76),
      Math.round(rowSpacing * 0.72),
      Math.round(paperWidth * 0.036)
    );
    const spacingMax = Math.max(spacingMin, Math.min(
      Math.round(referencePitch * 1.3),
      Math.round(rowSpacing * 1.28),
      Math.round(paperWidth * 0.058)
    ));
    if (firstMin > firstMax || spacingMin > spacingMax) return null;

    // Precompute circular-outline evidence at every plausible x. This tests
    // for the four printed bubbles on every row, so the adjacent question
    // number/letter text cannot masquerade as a complete A-D lane set.
    // Printed rings are about 0.36-0.42 of one row pitch in the current
    // template. Sampling the much smaller filled-interior radius biases the
    // fit toward dark marks and text instead of the invariant ring outlines.
    const evidenceRadius = Math.max(3, rowSpacing * 0.24);
    const evidence = rows.map(rowY => {
      const profile = new Float32Array(width);
      for (let x = Math.max(0, firstMin - spacingMax * 2); x <= Math.min(width - 1, firstMax + spacingMax * 5); x++) {
        profile[x] = this.bubbleRingEvidence(gray, width, height, x, rowY, evidenceRadius);
      }
      return profile;
    });

    let best: {
      firsts: number[];
      spacings: number[];
      score: number;
      firstDrift: number;
      spacingDrift: number;
    } | null = null;
    // The QR supplies the direction of perspective drift, but its magnitude
    // is underestimated after the long extrapolation from the footer. Search
    // a small set of physically plausible multipliers and prove the winner
    // against all 100 printed rings in the block.
    for (const firstDrift of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
      for (const spacingDrift of [0, 1, 2]) {
        for (let spacing = spacingMin; spacing <= spacingMax; spacing++) {
          for (let first = firstMin; first <= firstMax; first++) {
            const firsts = rows.map((_, row) => first
              + (projected[row].first - projected[referenceRow].first)
                * spacing / referencePitch * firstDrift);
            const spacings = rows.map((_, row) => spacing
              + (projected[row].spacing - referencePitch)
                * spacing / referencePitch * spacingDrift);
            const laneTotals = [0, 0, 0, 0];
            const rowTotals: number[] = [];
            let valid = true;
            for (let row = 0; row < rows.length; row++) {
              let rowTotal = 0;
              for (let choice = 0; choice < 4; choice++) {
                const x = Math.round(firsts[row] + choice * spacings[row]);
                if (x < 0 || x >= width) {
                  valid = false;
                  break;
                }
                const value = evidence[row][x];
                laneTotals[choice] += value;
                rowTotal += value;
              }
              if (!valid) break;
              rowTotals.push(rowTotal);
            }
            if (!valid) continue;
            rowTotals.sort((a, b) => a - b);
            const weakestRows = rowTotals.slice(0, 6).reduce((sum, value) => sum + value, 0);
            const score = laneTotals.reduce((sum, value) => sum + value, 0)
              + Math.min(...laneTotals) * 3
              + weakestRows * 2;
            if (!best || score > best.score) {
              best = { firsts, spacings, score, firstDrift, spacingDrift };
            }
          }
        }
      }
    }
    return best;
  }

  private bubbleRingEvidence(
    gray: Uint8Array,
    width: number,
    height: number,
    centerX: number,
    centerY: number,
    radius: number
  ): number {
    const sample = (x: number, y: number): number => {
      const sampleX = Math.max(0, Math.min(width - 1, Math.round(x)));
      const sampleY = Math.max(0, Math.min(height - 1, Math.round(y)));
      return gray[sampleY * width + sampleX];
    };
    const angles = Array.from({ length: 12 }, (_, index) => index * Math.PI / 6);
    const background = angles.reduce((sum, angle) => sum + sample(
      centerX + Math.cos(angle) * radius * 1.48,
      centerY + Math.sin(angle) * radius * 1.48
    ), 0) / angles.length;
    return angles.reduce((sum, angle) => {
      let darkest = 255;
      for (const radialOffset of [-1, 0, 1]) {
        darkest = Math.min(darkest, sample(
          centerX + Math.cos(angle) * (radius + radialOffset),
          centerY + Math.sin(angle) * (radius + radialOffset)
        ));
      }
      return sum + Math.max(0, background - darkest);
    }, 0);
  }

  private evaluateGridCandidate(
    gray: Uint8Array,
    width: number,
    height: number,
    verticalProfile: Float32Array,
    paperStart: number,
    paperEnd: number,
    start: number,
    spacing: number
  ): {
    rows: number[];
    left: { first: number; spacing: number };
    right: { first: number; spacing: number };
    score: number;
  } | null {
    const paperWidth = paperEnd - paperStart;
    const rows = Array.from({ length: 25 }, (_, row) => {
      const expected = start + row * spacing;
      let bestY = Math.round(expected);
      let localBest = -Infinity;
      const radius = Math.max(1, Math.round(spacing * 0.22));
      for (let y = Math.max(0, Math.round(expected) - radius); y <= Math.min(height - 1, Math.round(expected) + radius); y++) {
        if (verticalProfile[y] > localBest) {
          localBest = verticalProfile[y];
          bestY = y;
        }
      }
      return bestY;
    });
    return this.evaluateRowsCandidate(
      gray, width, height, paperStart, paperEnd, rows, spacing
    );
  }

  private evaluateRowsCandidate(
    gray: Uint8Array,
    width: number,
    height: number,
    paperStart: number,
    paperEnd: number,
    rows: number[],
    spacing: number
  ): {
    rows: number[];
    left: { first: number; spacing: number };
    right: { first: number; spacing: number };
    score: number;
  } | null {
    const paperWidth = paperEnd - paperStart;
    const horizontalProfile = new Float32Array(width);
    const profileRadius = Math.max(2, Math.round(spacing * 0.3));
    for (let x = paperStart; x <= paperEnd; x++) {
      let darkness = 0;
      for (const rowY of rows) {
        let localMean = 0;
        let localSamples = 0;
        for (let dx = -profileRadius * 2; dx <= profileRadius * 2; dx += 2) {
          const sampleX = Math.max(paperStart, Math.min(paperEnd, x + dx));
          localMean += gray[rowY * width + sampleX];
          localSamples++;
        }
        const threshold = Math.min(195, localMean / Math.max(1, localSamples) - 12);
        const ringPoints = [
          { x: x - profileRadius, y: rowY },
          { x: x + profileRadius, y: rowY },
          { x, y: rowY - profileRadius },
          { x, y: rowY + profileRadius },
        ];
        for (const point of ringPoints) {
          let pointDarkness = 0;
          for (let delta = -1; delta <= 1; delta++) {
            const sampleX = Math.max(0, Math.min(width - 1, point.x + (point.x === x ? delta : 0)));
            const sampleY = Math.max(0, Math.min(height - 1, point.y + (point.y === rowY ? delta : 0)));
            pointDarkness = Math.max(pointDarkness, threshold - gray[sampleY * width + sampleX]);
          }
          darkness += Math.max(0, pointDarkness);
        }
      }
      horizontalProfile[x] = darkness;
    }
    const left = this.findChoiceColumns(horizontalProfile, paperStart, paperWidth, 0.12, 0.31);
    const right = this.findChoiceColumns(horizontalProfile, paperStart, paperWidth, 0.55, 0.68);
    if (!left || !right) return null;
    const leftValues = Array.from({ length: 4 }, (_, choice) => horizontalProfile[Math.round(left.first + choice * left.spacing)]);
    const rightValues = Array.from({ length: 4 }, (_, choice) => horizontalProfile[Math.round(right.first + choice * right.spacing)]);
    const score = leftValues.reduce((sum, value) => sum + value, 0)
      + rightValues.reduce((sum, value) => sum + value, 0)
      + Math.min(...leftValues, ...rightValues) * 8;
    return { rows, left, right, score };
  }

  private findPaperBand(
    gray: Uint8Array,
    width: number,
    height: number
  ): { start: number; end: number } | null {
    const brightness = new Float32Array(width);
    for (let x = 0; x < width; x += 2) {
      let bright = 0;
      let samples = 0;
      for (let y = Math.round(height * 0.03); y < Math.round(height * 0.92); y += 4) {
        bright += Math.max(0, gray[y * width + x] - 105) / 150;
        samples++;
      }
      brightness[x] = bright / Math.max(1, samples);
      if (x + 1 < width) brightness[x + 1] = brightness[x];
    }
    const prefix = new Float64Array(width + 1);
    for (let x = 0; x < width; x++) prefix[x + 1] = prefix[x] + brightness[x];
    let best: { start: number; end: number; score: number; inside: number; contrast: number } | null = null;
    // A close portrait capture can make the sheet occupy most of the frame.
    // Limiting this search to 46% selected a partial strip and shifted every
    // downstream answer/sequence coordinate away from the printed grid.
    for (let fraction = 0.17; fraction <= 0.82; fraction += 0.01) {
      const bandWidth = Math.round(width * fraction);
      for (let start = Math.round(width * 0.15); start + bandWidth < Math.round(width * 0.85); start += 2) {
        const end = start + bandWidth;
        const inside = (prefix[end] - prefix[start]) / bandWidth;
        const flankWidth = Math.max(1, Math.round(bandWidth * 0.35));
        const leftStart = Math.max(0, start - flankWidth);
        const rightEnd = Math.min(width, end + flankWidth);
        const outsideSum = (prefix[start] - prefix[leftStart]) + (prefix[rightEnd] - prefix[end]);
        const outsideCount = (start - leftStart) + (rightEnd - end);
        const outside = outsideSum / Math.max(1, outsideCount);
        const contrast = inside - outside;
        const center = (start + end) / 2;
        const centerPenalty = Math.abs(center - width / 2) / width;
        const score = contrast * 1.7 + inside * 0.35 - centerPenalty * 0.15;
        if (!best || score > best.score) best = { start, end, score, inside, contrast };
      }
    }
    if (!best || best.inside < 0.36 || best.contrast < 0.06) return null;
    return { start: best.start, end: best.end };
  }

  private findChoiceColumns(
    profile: Float32Array,
    paperStart: number,
    paperWidth: number,
    firstMinFraction: number,
    firstMaxFraction: number
  ): { first: number; spacing: number } | null {
    const minSpacing = Math.max(6, Math.round(paperWidth * 0.043));
    const maxSpacing = Math.max(minSpacing + 1, Math.round(paperWidth * 0.064));
    let best: { first: number; spacing: number; score: number } | null = null;
    const firstMin = Math.round(paperStart + paperWidth * firstMinFraction);
    const firstMax = Math.round(paperStart + paperWidth * firstMaxFraction);
    for (let spacing = minSpacing; spacing <= maxSpacing; spacing++) {
      for (let first = firstMin; first <= firstMax; first++) {
        if (first + spacing * 3 >= profile.length) continue;
        const values = Array.from({ length: 4 }, (_, choice) => {
          const x = Math.round(first + choice * spacing);
          return Math.max(profile[x - 1] || 0, profile[x] || 0, profile[x + 1] || 0);
        });
        const score = values.reduce((sum, value) => sum + value, 0) + Math.min(...values) * 2;
        if (!best || score > best.score) best = { first, spacing, score };
      }
    }
    return best && best.score > 0 ? best : null;
  }

  private sampleBubble(
    gray: Uint8Array,
    width: number,
    height: number,
    center: Point,
    radius: number
  ): number {
    let sum = 0;
    let count = 0;
    const minX = Math.max(0, Math.floor(center.x - radius));
    const maxX = Math.min(width - 1, Math.ceil(center.x + radius));
    const minY = Math.max(0, Math.floor(center.y - radius));
    const maxY = Math.min(height - 1, Math.ceil(center.y + radius));
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const dx = x - center.x;
        const dy = y - center.y;
        if (dx * dx + dy * dy <= radius * radius) {
          sum += gray[y * width + x];
          count++;
        }
      }
    }
    return count ? sum / count : 255;
  }

  private async classifyBlankRows(
    gray: Uint8Array,
    width: number,
    height: number,
    grid: AnswerGrid,
    rows: number[]
  ): Promise<number[][]> {
    const input = new Float32Array(rows.length * 4 * 32 * 32);
    let patchIndex = 0;
    for (const row of rows) {
      for (const center of grid.centers[row]) {
        input.set(
          this.bubblePatch(gray, width, height, center, grid.radius),
          patchIndex++ * 32 * 32
        );
      }
    }
    const session = await loadBubbleSession();
    const response = await session.run({
      input: new ort.Tensor('float32', input, [rows.length * 4, 1, 32, 32]),
    });
    const logits = response['output']?.data;
    if (!logits || logits.length !== rows.length * 4 * 2) {
      throw new Error('The bubble model returned an unexpected output shape.');
    }
    return rows.map((_, rowIndex) => Array.from({ length: 4 }, (_, choice) => {
      const offset = (rowIndex * 4 + choice) * 2;
      const blankLogit = Number(logits[offset]);
      const markedLogit = Number(logits[offset + 1]);
      const maximum = Math.max(blankLogit, markedLogit);
      const blankExp = Math.exp(blankLogit - maximum);
      const markedExp = Math.exp(markedLogit - maximum);
      return markedExp / (blankExp + markedExp);
    }));
  }

  private bubblePatch(
    gray: Uint8Array,
    width: number,
    height: number,
    center: Point,
    radius: number
  ): Float32Array {
    // Native OMR trains and infers on a 29x29 crop that includes the complete
    // printed ring. Scale the browser crop from the registered ring radius,
    // resize it to 32x32, normalize its range, then apply the same sharpening
    // kernel used by the Python worker.
    const halfSize = Math.max(5, radius * 1.8);
    const resized = new Float32Array(32 * 32);
    let minimum = 255;
    let maximum = 0;
    for (let y = 0; y < 32; y++) {
      const sourceY = center.y - halfSize + (y + 0.5) * (halfSize * 2) / 32;
      const y0 = Math.max(0, Math.min(height - 1, Math.floor(sourceY)));
      const y1 = Math.min(height - 1, y0 + 1);
      const dy = sourceY - Math.floor(sourceY);
      for (let x = 0; x < 32; x++) {
        const sourceX = center.x - halfSize + (x + 0.5) * (halfSize * 2) / 32;
        const x0 = Math.max(0, Math.min(width - 1, Math.floor(sourceX)));
        const x1 = Math.min(width - 1, x0 + 1);
        const dx = sourceX - Math.floor(sourceX);
        const top = gray[y0 * width + x0] * (1 - dx) + gray[y0 * width + x1] * dx;
        const bottom = gray[y1 * width + x0] * (1 - dx) + gray[y1 * width + x1] * dx;
        const value = top * (1 - dy) + bottom * dy;
        resized[y * 32 + x] = value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    const scale = maximum > minimum ? 255 / (maximum - minimum) : 0;
    const normalized = new Float32Array(resized.length);
    for (let index = 0; index < resized.length; index++) {
      normalized[index] = (resized[index] - minimum) * scale;
    }
    const output = new Float32Array(normalized.length);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const centerValue = normalized[y * 32 + x] * 5;
        const neighbors = (y > 0 ? normalized[(y - 1) * 32 + x] : normalized[y * 32 + x])
          + (y < 31 ? normalized[(y + 1) * 32 + x] : normalized[y * 32 + x])
          + (x > 0 ? normalized[y * 32 + x - 1] : normalized[y * 32 + x])
          + (x < 31 ? normalized[y * 32 + x + 1] : normalized[y * 32 + x]);
        output[y * 32 + x] = Math.max(0, Math.min(255, centerValue - neighbors)) / 255;
      }
    }
    return output;
  }

}
