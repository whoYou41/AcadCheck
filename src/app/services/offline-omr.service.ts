import { Injectable } from '@angular/core';
import jsQR from 'jsqr';

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

@Injectable({ providedIn: 'root' })
export class OfflineOmrService {
  async detect(file: File, questionCount: number): Promise<OfflineOmrResult> {
    const startedAt = performance.now();
    if (questionCount < 1 || questionCount > 50) {
      throw new Error('Offline automatic detection currently supports answer sheets with up to 50 questions.');
    }

    const canvas = await this.loadCanvas(file);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This device could not read the captured image.');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const grayscale = this.toGrayscale(image.data);

    const anchor = await this.findBarcodeAnchor(canvas)
      || this.findJsQrAnchor(image.data, canvas.width, canvas.height)
      || this.findQrFinderAnchor(grayscale, canvas.width, canvas.height);
    const answerGrid = anchor?.homography
      ? this.findAnswerGrid(grayscale, canvas.width, canvas.height, anchor)
      : this.findAnswerGridComponents(grayscale, canvas.width, canvas.height, !!anchor)
        || this.findAnswerGrid(grayscale, canvas.width, canvas.height, anchor);
    if (!anchor && !answerGrid) {
      throw new Error('Could not register the 50-row answer grid. Retake the photo with the complete sheet centered, upright, and in focus.');
    }

    const answers = Array(questionCount).fill('');
    const confidences = Array(questionCount).fill(0);
    let uncertainCount = 0;

    for (let index = 0; index < questionCount; index++) {
      const row = index < 25 ? index : index - 25;
      const rightBlock = index >= 25;
      const progress = row / 24;
      // These curves describe the fixed AcadCheck 50-row layout in QR-side
      // units. Quadratic terms compensate for the perspective compression
      // between the QR at the bottom and the answer rows near the top.
      const y = 0.715 * progress * progress + 5.15 * progress - 6.545;
      const firstX = rightBlock
        ? 0.004 * progress * progress + 0.4 * progress + 1.837
        : -0.035 * progress * progress + 0.074 * progress - 0.39;
      const choiceSpacing = 0.022 * progress * progress + 0.0155 * progress + 0.2585;
      const values = Array.from({ length: 4 }, (_, choice) => {
        if (answerGrid) {
          const center = answerGrid.centers[index][choice];
          return this.sampleBubble(grayscale, canvas.width, canvas.height, center, answerGrid.radius);
        }
        const usesCanonicalGrid = !!anchor!.homography;
        const canonicalX = (rightBlock ? NOMINAL_RIGHT_X[choice] : NOMINAL_LEFT_X[choice]) * CANONICAL_WIDTH;
        const canonicalY = (NOMINAL_TOP_Y + row * NOMINAL_ROW_SPACING) * CANONICAL_HEIGHT;
        const center = usesCanonicalGrid
          ? this.project(anchor!, canonicalX, canonicalY)
          : this.project(anchor!, firstX + choice * choiceSpacing, y);
        return this.sampleBubble(
          grayscale,
          canvas.width,
          canvas.height,
          center,
          this.anchorBubbleRadius(anchor!, usesCanonicalGrid ? canonicalX : undefined, usesCanonicalGrid ? canonicalY : undefined)
        );
      });
      const ranked = values
        .map((value, choice) => ({ value, choice }))
        .sort((a, b) => a.value - b.value);
      const darkest = ranked[0];
      const second = ranked[1];
      const baseline = (ranked[2].value + ranked[3].value) / 2;
      const darkness = baseline - darkest.value;
      const separation = second.value - darkest.value;

      // A real fill is both darker than the paper inside the other bubbles
      // and clearly separated from the runner-up. This deliberately leaves
      // blank, faint, and multiple-mark rows for human review.
      const accepted = darkest.value < 190 && darkness >= 22 && separation >= 12;
      if (accepted) {
        answers[index] = ['A', 'B', 'C', 'D'][darkest.choice];
        confidences[index] = Math.round(Math.min(99, 55 + darkness * 0.55 + separation * 0.7));
      } else {
        uncertainCount++;
      }
    }

    // Partial or unproved geometry can produce individually dark samples at
    // the wrong lane. Keep those readings as review suggestions, but do not
    // present them as high-confidence answers or authorize an automatic grade.
    const gradeable = !!anchor?.homography && !!answerGrid?.verified && uncertainCount === 0;
    if (!gradeable) {
      for (let index = 0; index < confidences.length; index++) {
        if (confidences[index] > 0) confidences[index] = Math.min(49, confidences[index]);
      }
      uncertainCount = questionCount;
    }

    const detectedCount = answers.filter(Boolean).length;
    if (!detectedCount) {
      throw new Error('The sheet was located, but no confident filled bubbles were found. Check focus and lighting.');
    }
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
      qrData: anchor?.qrData || '',
      anchorMethod: anchor?.method || 'answer-grid',
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

  private findJsQrAnchor(
    rgba: Uint8ClampedArray,
    width: number,
    height: number
  ): SheetAnchor | null {
    // jsQR is bundled into the Android/Web build. It does not need a network
    // service, Google Play Services, or BarcodeDetector support from WebView.
    const result = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
    if (!result) return null;
    const location = result.location;
    return this.createPerspectiveAnchor(
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner,
      'jsqr',
      result.data
    );
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
    const grid = this.fitRingLattice(latticeCircles, width, height, paper, qrAnchored);
    return grid;
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
    if (paperWidth < width * 0.12 || paperWidth > width * 0.62) return null;

    const leftFit = this.fitPeriodicValues(
      circles.map(circle => circle.x),
      paperStart + paperWidth * (qrAnchored ? 0.14 : 0.03), paperStart + paperWidth * (qrAnchored ? 0.28 : 0.34),
      paperWidth * 0.035, paperWidth * 0.085, 4
    );
    const rightFit = this.fitPeriodicValues(
      circles.map(circle => circle.x),
      paperStart + paperWidth * 0.5, paperStart + paperWidth * 0.82,
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
    count: number
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
    return best && best.score >= count * 1.2 ? best : null;
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
    anchor: SheetAnchor | null = null
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
    const minSpacing = Math.max(8, Math.round(paperWidth * (qrAnchored ? 0.04 : 0.024)));
    const maxSpacing = Math.max(minSpacing + 1, Math.round(paperWidth * 0.065));
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
        Math.round(height * 0.42),
        height - 1 - Math.round(height * 0.035) - spacing * 24
      );
      for (let start = Math.round(height * 0.045); start <= latestStart; start++) {
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
    for (let phaseOffset = 0; phaseOffset <= 3; phaseOffset++) {
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
    const centers: Point[][] = [];
    for (let row = 0; row < 25; row++) {
      centers.push(Array.from({ length: 4 }, (_, choice) => ({ x: left.first + choice * left.spacing, y: rows[row] })));
    }
    for (let row = 0; row < 25; row++) {
      centers.push(Array.from({ length: 4 }, (_, choice) => ({ x: right.first + choice * right.spacing, y: rows[row] })));
    }
    return { centers, radius };
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
    const evidenceRadius = Math.max(3, rowSpacing * 0.38);
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
    const right = this.findChoiceColumns(horizontalProfile, paperStart, paperWidth, 0.53, 0.72);
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
    for (let fraction = 0.17; fraction <= 0.46; fraction += 0.01) {
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

}
