import { Injectable } from '@angular/core';

export interface OfflineOmrResult {
  answers: string[];
  confidences: number[];
  detectedCount: number;
  uncertainCount: number;
  anchorMethod: 'barcode-detector' | 'qr-finder' | 'page-template';
}

interface Point {
  x: number;
  y: number;
}

interface SheetAnchor {
  origin: Point;
  horizontal: Point;
  vertical: Point;
  method: OfflineOmrResult['anchorMethod'];
}

interface FinderCandidate extends Point {
  size: number;
  hits: number;
}

@Injectable({ providedIn: 'root' })
export class OfflineOmrService {
  async detect(file: File, questionCount: number): Promise<OfflineOmrResult> {
    if (questionCount < 1 || questionCount > 50) {
      throw new Error('Offline automatic detection currently supports answer sheets with up to 50 questions.');
    }

    const canvas = await this.loadCanvas(file);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This device could not read the captured image.');
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const grayscale = this.toGrayscale(image.data);

    const anchor = await this.findBarcodeAnchor(canvas)
      || this.findQrFinderAnchor(grayscale, canvas.width, canvas.height)
      || this.findPageTemplateAnchor(grayscale, canvas.width, canvas.height);
    if (!anchor) {
      throw new Error('Could not locate the printed QR code. Retake the photo with the full sheet visible and upright.');
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
        const center = this.project(anchor, firstX + choice * choiceSpacing, y);
        return this.sampleBubble(grayscale, canvas.width, canvas.height, center, anchor);
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

    const detectedCount = answers.filter(Boolean).length;
    if (!detectedCount) {
      throw new Error('The sheet was located, but no confident filled bubbles were found. Check focus and lighting.');
    }
    return { answers, confidences, detectedCount, uncertainCount, anchorMethod: anchor.method };
  }

  private async loadCanvas(file: File): Promise<HTMLCanvasElement> {
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
      const [topLeft, topRight, , bottomLeft] = detection.cornerPoints;
      return {
        origin: { x: topLeft.x, y: topLeft.y },
        horizontal: { x: topRight.x - topLeft.x, y: topRight.y - topLeft.y },
        vertical: { x: bottomLeft.x - topLeft.x, y: bottomLeft.y - topLeft.y },
        method: 'barcode-detector',
      };
    } catch {
      return null;
    }
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
            if (finderRatioA < 2.5 || finderRatioA > 6.5 || finderRatioB < 2.5 || finderRatioB > 6.5) continue;
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

  private findPageTemplateAnchor(gray: Uint8Array, width: number, height: number): SheetAnchor | null {
    // Last-resort support for Android WebViews without BarcodeDetector. Find
    // the bright vertical paper band and synthesize the QR anchor from the
    // fixed AcadCheck print layout. Conservative scoring later prevents a
    // guessed position from creating confident answers on unrelated images.
    const scores = new Float32Array(width);
    for (let x = 0; x < width; x += 2) {
      let bright = 0;
      let samples = 0;
      for (let y = Math.floor(height * 0.04); y < Math.floor(height * 0.9); y += 4) {
        if (gray[y * width + x] > 178) bright++;
        samples++;
      }
      scores[x] = bright / Math.max(1, samples);
      if (x + 1 < width) scores[x + 1] = scores[x];
    }
    const smoothed = this.smooth(scores, Math.max(3, Math.round(width * 0.012)));
    const peak = Math.max(...smoothed);
    const threshold = Math.max(0.48, peak * 0.7);
    const bands: Array<{ start: number; end: number; score: number }> = [];
    let start = -1;
    for (let x = 0; x <= width; x++) {
      if (x < width && smoothed[x] >= threshold) {
        if (start < 0) start = x;
      } else if (start >= 0) {
        const end = x - 1;
        const center = (start + end) / 2;
        const bandWidth = end - start + 1;
        if (bandWidth >= width * 0.14 && bandWidth <= width * 0.55 && center > width * 0.2 && center < width * 0.8) {
          bands.push({ start, end, score: bandWidth * (1 - Math.abs(center - width / 2) / width) });
        }
        start = -1;
      }
    }
    const band = bands.sort((a, b) => b.score - a.score)[0];
    if (!band) return null;
    const paperWidth = band.end - band.start + 1;
    const qrSide = paperWidth * 0.2;
    const origin = { x: band.start + paperWidth * 0.235, y: height * 0.69 };
    return {
      origin,
      horizontal: { x: qrSide, y: 0 },
      vertical: { x: 0, y: qrSide },
      method: 'page-template',
    };
  }

  private smooth(values: Float32Array, radius: number): number[] {
    const result = Array(values.length).fill(0);
    let sum = 0;
    for (let index = 0; index < values.length; index++) {
      sum += values[index];
      if (index - radius - 1 >= 0) sum -= values[index - radius - 1];
      const count = Math.min(index + 1, radius + 1);
      result[index] = sum / count;
    }
    return result;
  }

  private project(anchor: SheetAnchor, x: number, y: number): Point {
    return {
      x: anchor.origin.x + anchor.horizontal.x * x + anchor.vertical.x * y,
      y: anchor.origin.y + anchor.horizontal.y * x + anchor.vertical.y * y,
    };
  }

  private sampleBubble(
    gray: Uint8Array,
    width: number,
    height: number,
    center: Point,
    anchor: SheetAnchor
  ): number {
    const qrScale = (Math.hypot(anchor.horizontal.x, anchor.horizontal.y) + Math.hypot(anchor.vertical.x, anchor.vertical.y)) / 2;
    const radius = Math.max(2, qrScale * 0.055);
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
