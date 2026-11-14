import * as ort from 'onnxruntime-web/wasm';

export interface OfflineSequenceResult {
  sequence?: string;
  sequenceCandidate?: string;
  confidence: number;
  rawDigits: string;
  boxCount: number;
  digitConfidences: Array<number | null>;
}

interface SequenceField {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  boxCount: number;
  score: number;
}

interface DigitPatch {
  pixels: Float32Array | null;
  blank: boolean;
}

interface RegistrationPoint {
  x: number;
  y: number;
}

let digitSession: Promise<ort.InferenceSession> | null = null;

function offlineAssetUrl(path: string): string {
  const karmaPrefix = '__karma__' in globalThis ? '_karma_webpack_/' : '';
  return new URL(`${karmaPrefix}assets/${path}`, document.baseURI).toString();
}

function loadDigitSession(): Promise<ort.InferenceSession> {
  if (!digitSession) {
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmPaths = offlineAssetUrl('ort/');
    const modelUrl = offlineAssetUrl('models/digit-classifier.onnx');
    digitSession = ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    }).catch(error => {
      digitSession = null;
      throw error;
    });
  }
  return digitSession!;
}

function otsuThreshold(pixels: Uint8Array): number {
  const histogram = new Uint32Array(256);
  for (const value of pixels) histogram[value]++;
  let total = 0;
  for (let index = 0; index < 256; index++) total += index * histogram[index];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let threshold = 160;
  for (let index = 0; index < 256; index++) {
    backgroundWeight += histogram[index];
    if (!backgroundWeight) continue;
    const foregroundWeight = pixels.length - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += index * histogram[index];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (total - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      threshold = index;
    }
  }
  return Math.max(80, Math.min(205, threshold + 12));
}

export class OfflineSequenceDetector {
  async detect(
    canvas: HTMLCanvasElement,
    paperBand?: { start: number; end: number } | null,
    registeredCenters?: RegistrationPoint[][],
    registeredProjector?: (x: number, y: number) => RegistrationPoint,
    allowRawFallback = true
  ): Promise<OfflineSequenceResult | null> {
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return null;
      const registered = registeredCenters?.length === 50
        ? this.rectifySequenceRegion(
          context.getImageData(0, 0, canvas.width, canvas.height),
          registeredCenters,
          registeredProjector
        )
        : null;
      if (registered) {
        const fields = [4, 2]
          .map(boxCount => this.locateExpectedSequenceBoxes(registered.gray, registered.width, registered.height, boxCount))
          .filter((field): field is SequenceField => !!field)
          .sort((left, right) => right.score - left.score);
        // Choose the best complete printed lattice before interpreting digits.
        if (fields.length) {
          const registeredResult = await this.classifyField(registered.gray, registered.width, registered.height, fields[0]);
          if (registeredResult) return registeredResult;
        }
        if (!allowRawFallback) return null;
      }
      // Use the actual lower camera crop only if registered classification did
      // not resolve a sequence; do not rescan the same registered pixels.
      const top = Math.floor(canvas.height * 0.70);
      const paperWidth = paperBand ? paperBand.end - paperBand.start : canvas.width;
      const margin = Math.round(paperWidth * 0.03);
      const left = paperBand ? Math.max(0, paperBand.start - margin) : 0;
      const right = paperBand ? Math.min(canvas.width, paperBand.end + margin) : canvas.width;
      const image = context.getImageData(left, top, right - left, canvas.height - top);
      const gray = this.toGrayscale(image.data);
      // Footer boxes touch the page's lower margin. Pad below the camera crop
      // so a box border at the image edge remains a complete detectable line.
      const padding = Math.max(16, Math.ceil(image.height * 0.08));
      const paddedHeight = image.height + padding;
      const paddedGray = new Uint8Array(image.width * paddedHeight).fill(255);
      for (let row = 0; row < image.height; row++) {
        paddedGray.set(gray.subarray(row * image.width, (row + 1) * image.width), row * image.width);
      }
      const field = this.locateSequenceBoxes(paddedGray, image.width, paddedHeight);
      if (!field) return null;
      return this.classifyField(paddedGray, image.width, paddedHeight, field);
    } catch (error) {
      console.warn('Offline student sequence detection failed:', error);
      return null;
    }
  }

  private toGrayscale(data: Uint8ClampedArray): Uint8Array {
    const gray = new Uint8Array(data.length / 4);
    for (let source = 0, target = 0; source < data.length; source += 4, target++) {
      gray[target] = Math.round(0.299 * data[source] + 0.587 * data[source + 1] + 0.114 * data[source + 2]);
    }
    return gray;
  }

  private rectifySequenceRegion(
    image: ImageData,
    centers: RegistrationPoint[][],
    projector?: (x: number, y: number) => RegistrationPoint
  ): { gray: Uint8Array; width: number; height: number; data: Uint8ClampedArray } | null {
    const leftXs = [0.18375, 0.23125, 0.27875, 0.32625];
    const rightXs = [0.66, 0.7075, 0.755, 0.8025];
    const samples: Array<{ u: number; v: number; x: number; y: number }> = [];
    centers.forEach((row, index) => {
      const rowIndex = index % 25;
      const xs = index < 25 ? leftXs : rightXs;
      row.forEach((point, choice) => samples.push({
        u: xs[choice],
        v: 0.216 + rowIndex * 0.0264,
        x: point.x,
        y: point.y,
      }));
    });
    if (samples.length !== 200) return null;
    const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    const targetX = [0, 0, 0];
    const targetY = [0, 0, 0];
    for (const sample of samples) {
      const values = [1, sample.u, sample.v];
      for (let row = 0; row < 3; row++) {
        targetX[row] += values[row] * sample.x;
        targetY[row] += values[row] * sample.y;
        for (let column = 0; column < 3; column++) matrix[row][column] += values[row] * values[column];
      }
    }
    const xModel = this.solveThreeByThree(matrix, targetX);
    const yModel = this.solveThreeByThree(matrix, targetY);
    if (!xModel || !yModel) return null;
    const residual = Math.sqrt(samples.reduce((sum, sample) => {
      const predictedX = xModel[0] + xModel[1] * sample.u + xModel[2] * sample.v;
      const predictedY = yModel[0] + yModel[1] * sample.u + yModel[2] * sample.v;
      return sum + (predictedX - sample.x) ** 2 + (predictedY - sample.y) ** 2;
    }, 0) / samples.length);
    if (!Number.isFinite(residual) || residual > Math.max(18, image.width * 0.018)) return null;

    const width = 580;
    const height = 335;
    const gray = new Uint8Array(width * height);
    let minimum = 255;
    let maximum = 0;
    for (let y = 0; y < height; y++) {
      const v = (2162.5 + y) / 2500;
      for (let x = 0; x < width; x++) {
        const u = (140 + x) / 800;
        const projected = projector?.(140 + x, 2162.5 + y);
        const sourceX = projected?.x ?? xModel[0] + xModel[1] * u + xModel[2] * v;
        const sourceY = projected?.y ?? yModel[0] + yModel[1] * u + yModel[2] * v;
        if (sourceX < 0 || sourceY < 0 || sourceX >= image.width - 1 || sourceY >= image.height - 1) return null;
        const x0 = Math.floor(sourceX);
        const y0 = Math.floor(sourceY);
        const dx = sourceX - x0;
        const dy = sourceY - y0;
        const luminance = (sampleX: number, sampleY: number): number => {
          const offset = (sampleY * image.width + sampleX) * 4;
          return 0.299 * image.data[offset] + 0.587 * image.data[offset + 1] + 0.114 * image.data[offset + 2];
        };
        const topValue = luminance(x0, y0) * (1 - dx) + luminance(x0 + 1, y0) * dx;
        const bottomValue = luminance(x0, y0 + 1) * (1 - dx) + luminance(x0 + 1, y0 + 1) * dx;
        const value = Math.round(topValue * (1 - dy) + bottomValue * dy);
        gray[y * width + x] = value;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    if (maximum - minimum < 20) return null;
    for (let index = 0; index < gray.length; index++) {
      gray[index] = Math.round(255 * (gray[index] - minimum) / (maximum - minimum));
    }
    return { gray, width, height, data: new Uint8ClampedArray() };
  }

  private solveThreeByThree(matrix: number[][], target: number[]): number[] | null {
    const augmented = matrix.map((row, index) => [...row, target[index]]);
    for (let column = 0; column < 3; column++) {
      let pivot = column;
      for (let row = column + 1; row < 3; row++) {
        if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
      }
      if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
      [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
      const divisor = augmented[column][column];
      for (let index = column; index < 4; index++) augmented[column][index] /= divisor;
      for (let row = 0; row < 3; row++) {
        if (row === column) continue;
        const factor = augmented[row][column];
        for (let index = column; index < 4; index++) augmented[row][index] -= factor * augmented[column][index];
      }
    }
    return augmented.map(row => row[3]);
  }

  private locateExpectedSequenceBoxes(
    pixels: Uint8Array,
    width: number,
    height: number,
    boxCount: number,
    wideSearch = false
  ): SequenceField | null {
    const leftFraction = boxCount === 4 ? 0.425 : 0.255;
    const widthFraction = boxCount === 4 ? 0.405 : 0.203;
    const threshold = Math.min(155, Math.max(100, otsuThreshold(pixels) + 13));
    const candidates: SequenceField[] = [];
    const rowStride = width + 1;
    const expandedDarkPrefix = new Uint32Array(height * rowStride);
    for (let y = Math.floor(height * 0.40); y < height - 8; y++) {
      let count = 0;
      for (let x = 0; x < width; x++) {
        let dark = false;
        for (let dy = -3; dy <= 3; dy++) {
          if (pixels[(y + dy) * width + x] <= threshold) {
            dark = true;
            break;
          }
        }
        if (dark) count++;
        expandedDarkPrefix[y * rowStride + x + 1] = count;
      }
    }
    // A phone may frame a cut-out sheet much smaller than the camera view;
    // its centered footer field then shifts relative to the answer-grid crop.
    // Keep the quick nominal search, followed by a wider but bounded footer pass.
    const offsets = wideSearch
      ? [-0.01, 0.01, -0.015, 0.015, -0.02, 0.02, -0.025, 0.025, -0.03, 0.03, -0.04, 0.04, -0.05, 0.05, -0.06, 0.06, -0.08, 0.08, -0.09, 0.09, -0.10, 0.10, -0.11, 0.11, -0.12, 0.12, -0.13, 0.13, -0.14, 0.14]
      : [0, -0.01, 0.01];
    const scales = wideSearch ? [0.72, 0.80, 0.88, 0.92, 0.96, 1, 1.04, 1.08, 1.16, 1.24, 1.32] : [1, 0.96, 1.04, 0.92, 1.08];
    for (const scale of scales) {
      for (const offset of offsets) {
        const left = Math.round(width * (leftFraction + offset));
        const fieldWidth = Math.round(width * widthFraction * scale);
        const right = left + fieldWidth - 1;
        if (left < 16 || right >= width - 16) continue;
        const rows: Array<{ score: number; y: number }> = [];
        for (let y = Math.floor(height * 0.40); y < height - 8; y++) {
          const rowOffset = y * rowStride;
          const supported = expandedDarkPrefix[rowOffset + right + 1] - expandedDarkPrefix[rowOffset + left];
          const score = supported / fieldWidth;
          if (score >= 0.58) rows.push({ score, y });
        }
        rows.sort((first, second) => second.score - first.score);
        const peaks: Array<{ score: number; y: number }> = [];
        for (const row of rows) {
          if (peaks.every(existing => Math.abs(row.y - existing.y) > 8)) peaks.push(row);
        }
        const strongestPeaks = peaks.slice(0, 16);
        for (const first of strongestPeaks) {
          for (const second of strongestPeaks) {
            const fieldHeight = second.y - first.y + 1;
            if (second.y <= first.y || fieldHeight < Math.round(height * 0.20) || fieldHeight > Math.round(height * 0.42)) continue;
            const evidence: number[] = [];
            for (let boundary = 0; boundary <= boxCount; boundary++) {
              const x = Math.round(left + (fieldWidth - 1) * boundary / boxCount);
              let supported = 0;
              let sampled = 0;
              for (let y = first.y + 7; y < second.y - 6; y++) {
                sampled++;
                let core = 255;
                for (let dx = -3; dx <= 3; dx++) core = Math.min(core, pixels[y * width + x + dx]);
                const sides: number[] = [];
                for (const dx of [-14, -13, -12, -11, -10, 10, 11, 12, 13, 14]) {
                  if (x + dx >= 0 && x + dx < width) sides.push(pixels[y * width + x + dx]);
                }
                const sideMean = sides.reduce((sum, value) => sum + value, 0) / Math.max(1, sides.length);
                if (sideMean - core > 18) supported++;
              }
              evidence.push(supported / Math.max(1, sampled));
            }
            if (Math.min(...evidence) < 0.55) continue;
            const expectedHeight = height * 0.29;
            const heightScore = 1 - Math.min(1, Math.abs(fieldHeight - expectedHeight) / expectedHeight);
            candidates.push({
              left,
              right,
              top: first.y,
              bottom: second.y,
              width: fieldWidth,
              height: fieldHeight,
              boxCount,
              score: first.score + second.score
                + 2 * evidence.reduce((sum, value) => sum + value, 0) / evidence.length
                + heightScore,
            });
          }
        }
      }
    }
    candidates.sort((first, second) => second.score - first.score);
    return candidates[0] || (wideSearch ? null
      : this.locateExpectedSequenceBoxes(pixels, width, height, boxCount, true));
  }

  private locateSequenceBoxes(pixels: Uint8Array, width: number, height: number): SequenceField | null {
    const threshold = otsuThreshold(pixels);
    const minLine = Math.max(24, Math.floor(width * 0.055));
    const maxLine = Math.floor(width * 0.48);
    const lines: Array<{ y: number; start: number; end: number; length: number }> = [];
    for (let y = Math.floor(height * 0.06); y < Math.ceil(height * 0.985); y++) {
      let start = -1;
      let lastDark = -1;
      let gaps = 0;
      for (let x = Math.floor(width * 0.08); x < Math.ceil(width * 0.92); x++) {
        if (pixels[y * width + x] <= threshold) {
          if (start < 0) start = x;
          lastDark = x;
          gaps = 0;
        } else if (start >= 0 && ++gaps > 2) {
          const length = lastDark - start + 1;
          if (length >= minLine && length <= maxLine) lines.push({ y, start, end: lastDark, length });
          start = -1;
          lastDark = -1;
          gaps = 0;
        }
      }
    }
    return this.groupAndScoreLines(lines, pixels, width, height, threshold);
  }

  private groupAndScoreLines(
    runs: Array<{ y: number; start: number; end: number; length: number }>,
    pixels: Uint8Array,
    width: number,
    height: number,
    threshold: number
  ): SequenceField | null {
    const groups: Array<{
      items: typeof runs;
      lastY: number;
      start: number;
      end: number;
      length: number;
    }> = [];
    for (const run of runs) {
      let best: typeof groups[number] | null = null;
      let bestOverlap = 0;
      for (const group of groups) {
        if (group.lastY >= run.y || group.lastY < run.y - 2 || group.items.length >= 4) continue;
        const overlapPixels = Math.min(run.end, group.end) - Math.max(run.start, group.start) + 1;
        const overlap = overlapPixels / Math.max(1, Math.min(run.length, group.length));
        const similarity = Math.min(run.length, group.length) / Math.max(run.length, group.length);
        if (overlap > 0.55 && similarity > 0.66 && overlap > bestOverlap) {
          best = group;
          bestOverlap = overlap;
        }
      }
      if (!best) {
        groups.push({ items: [run], lastY: run.y, start: run.start, end: run.end, length: run.length });
        continue;
      }
      best.items.push(run);
      best.lastY = run.y;
      best.start = Math.round(best.items.reduce((sum, item) => sum + item.start, 0) / best.items.length);
      best.end = Math.round(best.items.reduce((sum, item) => sum + item.end, 0) / best.items.length);
      best.length = best.end - best.start + 1;
    }
    const lines = groups.map(group => ({
      y: Math.round(group.items.reduce((sum, item) => sum + item.y, 0) / group.items.length),
      start: group.start,
      end: group.end,
      length: group.length,
    }));
    const candidates: SequenceField[] = [];
    for (let first = 0; first < lines.length; first++) {
      for (let second = first + 1; second < lines.length; second++) {
        const top = lines[first];
        const bottom = lines[second];
        const fieldHeight = bottom.y - top.y;
        if (fieldHeight < Math.max(14, height * 0.055) || fieldHeight > height * 0.34) continue;
        const left = Math.max(top.start, bottom.start);
        const right = Math.min(top.end, bottom.end);
        const fieldWidth = right - left + 1;
        if (fieldWidth < Math.max(24, width * 0.055)) continue;
        const overlap = fieldWidth / Math.max(top.length, bottom.length);
        if (overlap < 0.72) continue;
        const aspect = fieldWidth / fieldHeight;
        if (aspect < 0.55 || aspect > 5.4) continue;
        const boxCount = aspect < 1.25 || aspect >= 2.10 ? 4 : 2;
        if (boxCount === 4 && fieldWidth < width * 0.10) continue;
        let separatorEvidence = 0;
        for (let boundary = 0; boundary <= boxCount; boundary++) {
          const x = Math.round(left + (fieldWidth - 1) * boundary / boxCount);
          let strongest = 0;
          for (let dx = -2; dx <= 2; dx++) {
            strongest = Math.max(
              strongest,
              this.verticalEvidence(pixels, width, top.y, bottom.y, x + dx, threshold)
            );
          }
          separatorEvidence += strongest;
        }
        separatorEvidence /= boxCount + 1;
        if (separatorEvidence < 0.24) continue;
        let interiorSum = 0;
        let interiorCount = 0;
        const insetX = Math.max(2, Math.floor(fieldWidth * 0.04));
        const insetY = Math.max(2, Math.floor(fieldHeight * 0.10));
        for (let y = top.y + insetY; y <= bottom.y - insetY; y++) {
          for (let x = left + insetX; x <= right - insetX; x++) {
            interiorSum += pixels[y * width + x];
            interiorCount++;
          }
        }
        const interiorMean = interiorSum / Math.max(1, interiorCount);
        if (interiorMean < 120) continue;
        const expectedAspect = boxCount === 4 ? (aspect < 1.25 ? 0.72 : 3.55) : 1.75;
        const aspectScore = 1 - Math.min(1, Math.abs(aspect - expectedAspect) / expectedAspect);
        const bottomBias = Math.max(0, (top.y + bottom.y) / (2 * height));
        candidates.push({
          left, top: top.y, right, bottom: bottom.y, width: fieldWidth,
          height: fieldHeight + 1, boxCount,
          score: overlap * 3 + separatorEvidence * 4 + aspectScore + bottomBias + Math.min(2, (interiorMean - 100) / 35),
        });
      }
    }
    candidates.sort((left, right) => right.score - left.score);
    return candidates[0] || null;
  }

  private verticalEvidence(
    pixels: Uint8Array,
    width: number,
    top: number,
    bottom: number,
    x: number,
    threshold: number
  ): number {
    if (x < 0 || x >= width) return 0;
    const inset = Math.max(2, Math.floor((bottom - top) * 0.08));
    let dark = 0;
    let total = 0;
    for (let y = top + inset; y <= bottom - inset; y++) {
      total++;
      if (pixels[y * width + x] <= threshold) dark++;
    }
    return dark / Math.max(1, total);
  }

  private async classifyField(
    pixels: Uint8Array,
    width: number,
    height: number,
    field: SequenceField
  ): Promise<OfflineSequenceResult | null> {
    const patches: Array<Float32Array | null> = [];
    for (let index = 0; index < field.boxCount; index++) {
      const cellLeft = Math.round(field.left + field.width * index / field.boxCount);
      const cellRight = Math.round(field.left + field.width * (index + 1) / field.boxCount) - 1;
      const insetX = Math.max(2, Math.floor((cellRight - cellLeft + 1) * 0.08));
      const insetY = Math.max(2, Math.floor(field.height * 0.08));
      const left = Math.max(0, cellLeft + insetX);
      const right = Math.min(width - 1, cellRight - insetX);
      const top = Math.max(0, field.top + insetY);
      const bottom = Math.min(height - 1, field.bottom - insetY);
      const cellWidth = right - left + 1;
      const cellHeight = bottom - top + 1;
      if (cellWidth < 4 || cellHeight < 6) return null;
      const cell = new Uint8Array(cellWidth * cellHeight);
      for (let y = 0; y < cellHeight; y++) {
        cell.set(pixels.subarray((top + y) * width + left, (top + y) * width + right + 1), y * cellWidth);
      }
      const patch = this.digitPatch(cell, cellWidth, cellHeight);
      if (!patch.blank && !patch.pixels) return null;
      patches.push(patch.pixels);
    }
    const firstDigit = patches.findIndex(patch => patch !== null);
    if (firstDigit < 0 || patches.slice(firstDigit).some(patch => patch === null)) return null;
    const digitPatches = patches.slice(firstDigit) as Float32Array[];
    const input = new Float32Array(digitPatches.length * 32 * 32);
    digitPatches.forEach((patch, index) => input.set(patch, index * 32 * 32));
    const session = await loadDigitSession();
    const response = await session.run({
      input: new ort.Tensor('float32', input, [digitPatches.length, 1, 32, 32]),
    });
    const logits = response['output']?.data;
    if (!logits || logits.length !== digitPatches.length * 10) return null;
    const readings: Array<{ digit: number; confidence: number }> = [];
    for (let row = 0; row < digitPatches.length; row++) {
      const values = Array.from(logits.slice(row * 10, row * 10 + 10), Number);
      const maximum = Math.max(...values);
      const exponentials = values.map(value => Math.exp(value - maximum));
      const total = exponentials.reduce((sum, value) => sum + value, 0);
      const probabilities = exponentials.map(value => value / total);
      const digit = probabilities.reduce(
        (best, value, index) => value > probabilities[best] ? index : best,
        0
      );
      readings.push({ digit, confidence: probabilities[digit] });
    }
    const rawDigits = readings.map(reading => reading.digit).join('');
    const sequenceNumber = Number.parseInt(rawDigits, 10);
    const minimum = Math.min(...readings.map(reading => reading.confidence));
    const average = readings.reduce((sum, reading) => sum + reading.confidence, 0) / readings.length;
    if (!Number.isInteger(sequenceNumber) || sequenceNumber < 1 || sequenceNumber > 99) {
      return null;
    }
    const candidate = {
      sequenceCandidate: String(sequenceNumber),
      confidence: Math.round(Math.min(96, average * 100)),
      rawDigits,
      boxCount: field.boxCount,
      digitConfidences: [
        ...Array(firstDigit).fill(null),
        ...readings.map(reading => Math.round(reading.confidence * 100)),
      ],
    };
    if (minimum < 0.42 || average < 0.58) return candidate;
    return { ...candidate, sequence: String(sequenceNumber) };
  }

  private digitPatch(cell: Uint8Array, width: number, height: number): DigitPatch {
    const threshold = otsuThreshold(cell);
    const visited = new Uint8Array(cell.length);
    const queue = new Int32Array(cell.length);
    const components: Array<{
      members: number[];
      area: number;
      minX: number;
      maxX: number;
      minY: number;
      maxY: number;
    }> = [];
    for (let initial = 0; initial < cell.length; initial++) {
      if (visited[initial] || cell[initial] > threshold) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = initial;
      visited[initial] = 1;
      const members: number[] = [];
      let minX = initial % width;
      let maxX = minX;
      let minY = Math.floor(initial / width);
      let maxY = minY;
      while (head < tail) {
        const index = queue[head++];
        const y = Math.floor(index / width);
        const x = index - y * width;
        members.push(index);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nextX = x + dx;
            const nextY = y + dy;
            if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
            const next = nextY * width + nextX;
            if (!visited[next] && cell[next] <= threshold) {
              visited[next] = 1;
              queue[tail++] = next;
            }
          }
        }
      }
      const componentWidth = maxX - minX + 1;
      const componentHeight = maxY - minY + 1;
      const touchesEdge = minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1;
      if (
        members.length >= Math.max(5, Math.floor(width * height * 0.008))
        && componentHeight >= height * 0.24
        && componentWidth >= Math.max(1, width * 0.055)
        && !(touchesEdge && (componentWidth > width * 0.72 || componentHeight > height * 0.88))
      ) {
        components.push({ members, area: members.length, minX, maxX, minY, maxY });
      }
    }
    if (!components.length) {
      let inkCount = 0;
      for (const value of cell) if (value <= threshold) inkCount++;
      return { pixels: null, blank: inkCount < Math.max(3, cell.length * 0.002) };
    }
    const largest = Math.max(...components.map(item => item.area));
    const selected = components.filter(item => item.area >= Math.max(3, largest * 0.10));
    const minX = Math.min(...selected.map(item => item.minX));
    const maxX = Math.max(...selected.map(item => item.maxX));
    const minY = Math.min(...selected.map(item => item.minY));
    const maxY = Math.max(...selected.map(item => item.maxY));
    const inkWidth = maxX - minX + 1;
    const inkHeight = maxY - minY + 1;
    const side = Math.max(20, Math.ceil(Math.max(inkWidth, inkHeight) * 1.42));
    const square = new Uint8Array(side * side).fill(255);
    const offsetX = Math.floor((side - inkWidth) / 2);
    const offsetY = Math.floor((side - inkHeight) / 2);
    for (const component of selected) {
      for (const index of component.members) {
        const y = Math.floor(index / width);
        const x = index - y * width;
        square[(offsetY + y - minY) * side + offsetX + x - minX] = Math.min(cell[index], 35);
      }
    }
    return { pixels: this.resizeAndSharpen(square, side), blank: false };
  }

  private resizeAndSharpen(source: Uint8Array, size: number): Float32Array {
    const resized = new Float32Array(32 * 32);
    for (let y = 0; y < 32; y++) {
      const sourceY = (y + 0.5) * size / 32 - 0.5;
      const y0 = Math.max(0, Math.min(size - 1, Math.floor(sourceY)));
      const y1 = Math.min(size - 1, y0 + 1);
      const dy = sourceY - Math.floor(sourceY);
      for (let x = 0; x < 32; x++) {
        const sourceX = (x + 0.5) * size / 32 - 0.5;
        const x0 = Math.max(0, Math.min(size - 1, Math.floor(sourceX)));
        const x1 = Math.min(size - 1, x0 + 1);
        const dx = sourceX - Math.floor(sourceX);
        const top = source[y0 * size + x0] * (1 - dx) + source[y0 * size + x1] * dx;
        const bottom = source[y1 * size + x0] * (1 - dx) + source[y1 * size + x1] * dx;
        resized[y * 32 + x] = top * (1 - dy) + bottom * dy;
      }
    }
    const output = new Float32Array(resized.length);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const center = resized[y * 32 + x] * 5;
        const neighbors = (y > 0 ? resized[(y - 1) * 32 + x] : resized[y * 32 + x])
          + (y < 31 ? resized[(y + 1) * 32 + x] : resized[y * 32 + x])
          + (x > 0 ? resized[y * 32 + x - 1] : resized[y * 32 + x])
          + (x < 31 ? resized[y * 32 + x + 1] : resized[y * 32 + x]);
        output[y * 32 + x] = Math.max(0, Math.min(255, center - neighbors)) / 255;
      }
    }
    return output;
  }
}
