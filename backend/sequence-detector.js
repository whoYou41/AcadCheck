const sharp = require('sharp');
const { recognizeWithTesseract } = require('./enhanced-scanner');
const OnnxService = require('./onnx-scanner-service');

const MAX_STUDENT_SEQUENCE = 60;

/**
 * Accept the sequence formats printed on both supported answer sheets.  The
 * current sheet has two boxes (01); the older QR-era sheet has four (0001).
 * Student sequential_number values are stored canonically as 1..60.
 */
function normalizeStandaloneSequence(value) {
  const digits = String(value ?? '').trim();
  if (!/^\d{1,4}$/.test(digits)) return null;
  const numeric = Number.parseInt(digits, 10);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > MAX_STUDENT_SEQUENCE) return null;
  return String(numeric);
}

function otsuThreshold(pixels) {
  const histogram = new Uint32Array(256);
  for (const value of pixels) histogram[value]++;
  const count = pixels.length;
  if (!count) return 160;
  let total = 0;
  for (let i = 0; i < 256; i++) total += i * histogram[i];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let bestThreshold = 160;
  for (let i = 0; i < 256; i++) {
    backgroundWeight += histogram[i];
    if (!backgroundWeight) continue;
    const foregroundWeight = count - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += i * histogram[i];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (total - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      bestThreshold = i;
    }
  }
  return Math.max(80, Math.min(205, bestThreshold + 12));
}

function darkRuns(pixels, width, y, fromX, toX, threshold, gapAllowance = 2) {
  const runs = [];
  let start = -1;
  let lastDark = -1;
  let gaps = 0;
  for (let x = fromX; x < toX; x++) {
    if (pixels[y * width + x] <= threshold) {
      if (start < 0) start = x;
      lastDark = x;
      gaps = 0;
    } else if (start >= 0 && ++gaps > gapAllowance) {
      const length = lastDark - start + 1;
      runs.push({ start, end: lastDark, length });
      start = -1;
      lastDark = -1;
      gaps = 0;
    }
  }
  if (start >= 0) {
    const length = lastDark - start + 1;
    runs.push({ start, end: lastDark, length });
  }
  return runs;
}

function groupHorizontalRuns(runs) {
  const groups = [];
  for (const run of runs) {
    let bestGroup = null;
    let bestOverlap = 0;
    for (const group of groups) {
      if (group.lastY >= run.y || group.lastY < run.y - 2) continue;
      if (group.items.length >= 4) continue;
      const overlapPixels = Math.min(run.end, group.end) - Math.max(run.start, group.start) + 1;
      const overlap = overlapPixels / Math.max(1, Math.min(run.length, group.length));
      const lengthSimilarity = Math.min(run.length, group.length) / Math.max(run.length, group.length);
      if (overlap > 0.55 && lengthSimilarity > 0.66 && overlap > bestOverlap) {
        bestGroup = group;
        bestOverlap = overlap;
      }
    }
    if (bestGroup) {
      bestGroup.items.push(run);
      bestGroup.lastY = run.y;
      bestGroup.start = Math.round(bestGroup.items.reduce((sum, item) => sum + item.start, 0) / bestGroup.items.length);
      bestGroup.end = Math.round(bestGroup.items.reduce((sum, item) => sum + item.end, 0) / bestGroup.items.length);
      bestGroup.length = bestGroup.end - bestGroup.start + 1;
    } else {
      groups.push({ items: [run], lastY: run.y, start: run.start, end: run.end, length: run.length });
    }
  }
  return groups.map(group => ({
    y: Math.round(group.items.reduce((sum, item) => sum + item.y, 0) / group.items.length),
    start: group.start,
    end: group.end,
    length: group.length,
    thickness: group.items.length,
  }));
}

function verticalLineEvidence(pixels, width, top, bottom, x, threshold) {
  const inset = Math.max(2, Math.floor((bottom - top) * 0.08));
  let dark = 0;
  let total = 0;
  for (let y = top + inset; y <= bottom - inset; y++) {
    total++;
    if (pixels[y * width + x] <= threshold) dark++;
  }
  return total ? dark / total : 0;
}

/** Locate the outlined 2- or 4-cell sequence field without using the QR code. */
function locateSequenceBoxes(pixels, width, height, threshold, returnAll = false, options = {}) {
  const minLine = Math.max(24, Math.floor(width * 0.055));
  const maxLine = Math.floor(width * 0.48);
  const fromX = Math.floor(width * 0.08);
  const toX = Math.ceil(width * 0.92);
  const runs = [];
  for (let y = Math.floor(height * 0.06); y < Math.ceil(height * 0.985); y++) {
    const rowRuns = darkRuns(pixels, width, y, fromX, toX, threshold, 2);
    for (const run of rowRuns) {
      if (run.length >= minLine && run.length <= maxLine) runs.push({ y, ...run });
    }
  }

  const lines = groupHorizontalRuns(runs);
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const topLine = lines[i];
      const bottomLine = lines[j];
      const boxHeight = bottomLine.y - topLine.y;
      if (boxHeight < Math.max(14, height * 0.055) || boxHeight > height * 0.34) continue;
      const left = Math.max(topLine.start, bottomLine.start);
      const right = Math.min(topLine.end, bottomLine.end);
      const boxWidth = right - left + 1;
      if (boxWidth < minLine) continue;
      const overlap = boxWidth / Math.max(topLine.length, bottomLine.length);
      if (overlap < 0.72) continue;
      const aspect = boxWidth / boxHeight;
      const minimumAspect = Number(options.minimumAspect ?? 0.55);
      const maximumAspect = Number(options.maximumAspect ?? 5.4);
      if (aspect < minimumAspect || aspect > maximumAspect) continue;
      const boxCount = aspect < 1.25 || aspect >= Number(options.fourBoxAspectThreshold ?? 2.55) ? 4 : 2;
      if (boxCount === 4 && boxWidth < width * Number(options.minimumFourBoxWidthFraction ?? 0.10)) continue;
      const expectedAspect = boxCount === 4
        ? aspect < 1.25 ? 0.72 : Number(options.expectedFourBoxAspect ?? 3.55)
        : Number(options.expectedTwoBoxAspect ?? 1.75);
      let separatorEvidence = 0;
      for (let separator = 0; separator <= boxCount; separator++) {
        const x = Math.round(left + (boxWidth - 1) * separator / boxCount);
        let strongest = 0;
        for (let dx = -2; dx <= 2; dx++) {
          if (x + dx >= 0 && x + dx < width) {
            strongest = Math.max(strongest, verticalLineEvidence(pixels, width, topLine.y, bottomLine.y, x + dx, threshold));
          }
        }
        separatorEvidence += strongest;
      }
      separatorEvidence /= boxCount + 1;
      if (separatorEvidence < 0.24) continue;
      const interiorInsetX = Math.max(2, Math.floor(boxWidth * 0.04));
      const interiorInsetY = Math.max(2, Math.floor(boxHeight * 0.10));
      let interiorTotal = 0;
      let interiorSum = 0;
      for (let y = topLine.y + interiorInsetY; y <= bottomLine.y - interiorInsetY; y++) {
        for (let x = left + interiorInsetX; x <= right - interiorInsetX; x++) {
          interiorSum += pixels[y * width + x];
          interiorTotal++;
        }
      }
      const interiorMean = interiorTotal ? interiorSum / interiorTotal : 0;
      // The field is printed on white paper. This rejects tablecloth edges and
      // dense QR sub-rectangles that can also contain repeated straight lines.
      if (interiorMean < 120) continue;
      const yCenter = (topLine.y + bottomLine.y) / 2 / height;
      const positionScore = 1 - Math.min(1, Math.abs(yCenter - 0.56));
      const aspectScore = 1 - Math.min(1, Math.abs(aspect - expectedAspect) / expectedAspect);
      const paperScore = Math.min(1, Math.max(0, (interiorMean - 100) / 70));
      const score = overlap * 3 + separatorEvidence * 4 + aspectScore + positionScore + paperScore * 2;
      candidates.push({
        left,
        top: topLine.y,
        right,
        bottom: bottomLine.y,
        width: boxWidth,
        height: boxHeight + 1,
        boxCount,
        score,
        separatorEvidence,
        interiorMean,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return returnAll ? candidates : (candidates[0] || null);
}

function connectedInkComponents(pixels, width, height, threshold) {
  const visited = new Uint8Array(width * height);
  const components = [];
  const queue = new Int32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const initial = y * width + x;
      if (visited[initial] || pixels[initial] > threshold) continue;
      let head = 0;
      let tail = 0;
      queue[tail++] = initial;
      visited[initial] = 1;
      let minX = x, maxX = x, minY = y, maxY = y;
      const members = [];
      while (head < tail) {
        const index = queue[head++];
        const currentY = Math.floor(index / width);
        const currentX = index - currentY * width;
        members.push(index);
        minX = Math.min(minX, currentX);
        maxX = Math.max(maxX, currentX);
        minY = Math.min(minY, currentY);
        maxY = Math.max(maxY, currentY);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = currentX + dx;
            const ny = currentY + dy;
            if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
            const next = ny * width + nx;
            if (!visited[next] && pixels[next] <= threshold) {
              visited[next] = 1;
              queue[tail++] = next;
            }
          }
        }
      }
      components.push({ members, area: members.length, minX, maxX, minY, maxY });
    }
  }
  return components;
}

async function digitPatchFromCell(pixels, width, height) {
  const threshold = otsuThreshold(pixels);
  const minArea = Math.max(5, Math.floor(width * height * 0.008));
  const components = connectedInkComponents(pixels, width, height, threshold)
    .filter(component => {
      const componentWidth = component.maxX - component.minX + 1;
      const componentHeight = component.maxY - component.minY + 1;
      const touchesEdge = component.minX === 0 || component.minY === 0 || component.maxX === width - 1 || component.maxY === height - 1;
      return component.area >= minArea
        && componentHeight >= height * 0.24
        && componentWidth >= Math.max(1, width * 0.055)
        && !(touchesEdge && (componentWidth > width * 0.72 || componentHeight > height * 0.88));
    })
    .sort((a, b) => b.area - a.area);
  if (!components.length) return null;

  const largest = components[0];
  const selected = components.filter(component => component.area >= Math.max(3, largest.area * 0.10));
  const minX = Math.min(...selected.map(component => component.minX));
  const maxX = Math.max(...selected.map(component => component.maxX));
  const minY = Math.min(...selected.map(component => component.minY));
  const maxY = Math.max(...selected.map(component => component.maxY));
  const inkWidth = maxX - minX + 1;
  const inkHeight = maxY - minY + 1;
  const side = Math.max(20, Math.ceil(Math.max(inkWidth, inkHeight) * 1.42));
  const canvas = Buffer.alloc(side * side, 255);
  const offsetX = Math.floor((side - inkWidth) / 2);
  const offsetY = Math.floor((side - inkHeight) / 2);
  const selectedPixels = new Set(selected.flatMap(component => component.members));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const source = y * width + x;
      if (selectedPixels.has(source)) {
        canvas[(offsetY + y - minY) * side + offsetX + x - minX] = Math.min(pixels[source], 35);
      }
    }
  }
  return sharp(canvas, { raw: { width: side, height: side, channels: 1 } }).png().toBuffer();
}

async function classifySequenceField(pixels, width, height, field, options = {}) {
  const readings = [];
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
    if (cellWidth < 4 || cellHeight < 6) {
      return options.includeRejected ? { rejected: 'invalid-cell', field, index } : null;
    }
    const cellPixels = Buffer.alloc(cellWidth * cellHeight);
    for (let y = 0; y < cellHeight; y++) {
      pixels.copy(cellPixels, y * cellWidth, (top + y) * width + left, (top + y) * width + right + 1);
    }
    const patch = await digitPatchFromCell(cellPixels, cellWidth, cellHeight);
    if (!patch) {
      // Only truly empty cells may be omitted; faint or clipped ink is unreadable.
      const threshold = otsuThreshold(cellPixels);
      const inkCount = cellPixels.reduce((count, value) => count + (value <= threshold ? 1 : 0), 0);
      readings.push(inkCount < Math.max(3, cellPixels.length * 0.002) ? { blank: true } : null);
      continue;
    }
    const classification = await OnnxService.classifyDigit(patch, 3);
    readings.push(classification);
  }

  // Leading blanks are valid ([_][1] or [_][_][0][1]). A blank after
  // a written digit is incomplete and must never turn 10 into 1.
  const firstDigit = readings.findIndex(reading => reading && !reading.blank);
  const digits = readings.slice(firstDigit);
  if (firstDigit < 0 || readings.some(reading => !reading) || digits.some(reading => reading.blank)) {
    return options.includeRejected
      ? { rejected: 'missing-cell-ink', field, readings }
      : null;
  }
  const rawDigits = digits.map(reading => String(reading.digit)).join('');
  const sequence = normalizeStandaloneSequence(rawDigits);
  const minimumConfidence = Math.min(...digits.map(reading => Number(reading.confidence || 0)));
  const averageConfidence = digits.reduce((sum, reading) => sum + Number(reading.confidence || 0), 0) / digits.length;
  if (!sequence || minimumConfidence < 0.42 || averageConfidence < 0.58) {
    return options.includeRejected
      ? { rejected: 'digit-confidence-or-range', field, rawDigits, sequence, minimumConfidence, averageConfidence, readings }
      : null;
  }
  return {
    sequence,
    rawDigits,
    confidence: Math.round(Math.min(96, averageConfidence * 100)),
    boxCount: field.boxCount,
    digitConfidences: readings.map(reading => reading.blank ? null : Math.round(Number(reading.confidence || 0) * 100)),
    field: { left: field.left, top: field.top, width: field.width, height: field.height },
  };
}

async function normalizedPixels(imageBuffer) {
  const normalized = await sharp(imageBuffer)
    .greyscale()
    .normalize()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    pixels: normalized.data,
    width: normalized.info.width,
    height: normalized.info.height,
  };
}

async function detectBoxedSequence(croppedBuffer, locatorOptions = {}) {
  if (!OnnxService.getLoadedModels().includes('digit')) return null;
  const { pixels, width, height } = await normalizedPixels(croppedBuffer);
  const threshold = Number.isFinite(Number(locatorOptions.thresholdOverride))
    ? Number(locatorOptions.thresholdOverride)
    : otsuThreshold(pixels);
  const field = locateSequenceBoxes(pixels, width, height, threshold, false, locatorOptions);
  if (!field) return locatorOptions.includeRejected ? { rejected: 'field-not-found', threshold } : null;
  return classifySequenceField(pixels, width, height, field, locatorOptions);
}

function locateCanonicalProfile(pixels, width, height, boxCount, geometry = {}) {
  const leftFraction = boxCount === 4 ? 0.425 : 0.255;
  const widthFraction = boxCount === 4 ? 0.405 : 0.203;
  const left = Math.round(width * (leftFraction + Number(geometry.offset || 0)));
  const fieldWidth = Math.round(width * widthFraction * Number(geometry.scale || 1));
  const right = left + fieldWidth - 1;
  const threshold = Math.min(155, Math.max(100, otsuThreshold(pixels) + 25));
  const rowScores = [];
  for (let y = 8; y < height - 8; y++) {
    let darkColumns = 0;
    for (let x = left; x <= right; x++) {
      let dark = false;
      for (let dy = -3; dy <= 3; dy++) {
        if (pixels[(y + dy) * width + x] <= threshold) {
          dark = true;
          break;
        }
      }
      if (dark) darkColumns++;
    }
    rowScores.push({ y, score: darkColumns / fieldWidth });
  }
  rowScores.sort((a, b) => b.score - a.score);
  const peaks = [];
  for (const row of rowScores) {
    if (row.score < 0.58) break;
    if (peaks.every(existing => Math.abs(existing.y - row.y) > 8)) peaks.push(row);
  }

  const minimumHeight = Math.round(height * 0.20);
  const maximumHeight = Math.round(height * 0.42);
  const candidates = [];
  for (const first of peaks) {
    for (const second of peaks) {
      if (second.y <= first.y) continue;
      const fieldHeight = second.y - first.y + 1;
      if (fieldHeight < minimumHeight || fieldHeight > maximumHeight) continue;
      const boundaryEvidence = [];
      for (let boundary = 0; boundary <= boxCount; boundary++) {
        const boundaryX = Math.round(left + (fieldWidth - 1) * boundary / boxCount);
        let supportedRows = 0;
        let sampledRows = 0;
        for (let y = first.y + 7; y <= second.y - 7; y++) {
          sampledRows++;
          let core = 255;
          let background = 0;
          let backgroundSamples = 0;
          for (let dx = -3; dx <= 3; dx++) core = Math.min(core, pixels[y * width + boundaryX + dx]);
          for (const dx of [-14, -13, -12, -11, -10, 10, 11, 12, 13, 14]) {
            const sampleX = boundaryX + dx;
            if (sampleX >= 0 && sampleX < width) {
              background += pixels[y * width + sampleX];
              backgroundSamples++;
            }
          }
          if (backgroundSamples > 0 && background / backgroundSamples - core > 18) supportedRows++;
        }
        boundaryEvidence.push(sampledRows ? supportedRows / sampledRows : 0);
      }
      const minimumBoundaryEvidence = Math.min(...boundaryEvidence);
      if (minimumBoundaryEvidence < 0.55) continue;
      const averageBoundaryEvidence = boundaryEvidence.reduce((sum, value) => sum + value, 0) / boundaryEvidence.length;
      const expectedHeight = height * 0.29;
      const heightScore = 1 - Math.min(1, Math.abs(fieldHeight - expectedHeight) / expectedHeight);
      candidates.push({
        left,
        top: first.y,
        right,
        bottom: second.y,
        width: fieldWidth,
        height: fieldHeight,
        boxCount,
        profile: boxCount === 4 ? 'legacy-four-box' : 'current-two-box',
        score: first.score + second.score + averageBoundaryEvidence * 2 + heightScore,
        boundaryEvidence,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function locateAdjustedCanonicalProfile(pixels, width, height, boxCount) {
  // Registration follows the answer grid; the footer can be a few percent
  // narrower or shifted after printing. Require every box boundary at each
  // bounded candidate, so a partial legacy field cannot become a two-box ID.
  for (const scale of [1, 0.96, 1.04, 0.92, 1.08]) {
    for (const offset of [0, -0.01, 0.01]) {
      const field = locateCanonicalProfile(pixels, width, height, boxCount, { scale, offset });
      if (field) return field;
    }
  }
  return null;
}

async function detectCanonicalSequence(canonicalCrop) {
  if (!OnnxService.getLoadedModels().includes('digit')) return null;
  const { pixels, width, height } = await normalizedPixels(canonicalCrop);
  // Compare both complete box lattices before classifying. A smaller false
  // lattice can appear inside a legacy four-box field after tilt/shift and
  // produce a high-confidence but incorrect two-digit identity.
  const fields = [4, 2]
    .map(boxCount => locateAdjustedCanonicalProfile(pixels, width, height, boxCount))
    .filter(Boolean)
    .sort((left, right) => right.score - left.score);
  if (fields.length) {
    const field = fields[0];
    const result = await classifySequenceField(pixels, width, height, field);
    return result ? { ...result, profile: field.profile } : null;
  }

  // Allow a bounded geometry recovery for small print/registration shifts.
  const locatorOptions = {
    minimumAspect: 0.55,
    maximumAspect: 3.2,
    fourBoxAspectThreshold: 1.30,
    expectedFourBoxAspect: 1.80,
    expectedTwoBoxAspect: 0.90,
    minimumFourBoxWidthFraction: 0.20,
  };
  const located = await detectBoxedSequence(canonicalCrop, locatorOptions);
  return located ? { ...located, profile: 'canonical-line-recovery' } : null;
}

function invert3x3(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 3 || matrix.some(row => !Array.isArray(row) || row.length !== 3)) return null;
  const [a, b, c] = matrix[0].map(Number);
  const [d, e, f] = matrix[1].map(Number);
  const [g, h, i] = matrix[2].map(Number);
  if (![a, b, c, d, e, f, g, h, i].every(Number.isFinite)) return null;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return [
    [A / determinant, B / determinant, C / determinant],
    [D / determinant, E / determinant, F / determinant],
    [G / determinant, H / determinant, I / determinant],
  ];
}

async function canonicalSequenceCrop(imageBuffer, placement) {
  const inverse = invert3x3(placement?.perspectiveTransform);
  const canonicalSize = placement?.canonicalSize;
  if (!inverse || !Array.isArray(canonicalSize) || canonicalSize.length !== 2) return null;
  const canonicalWidth = Number(canonicalSize[0]);
  const canonicalHeight = Number(canonicalSize[1]);
  if (!Number.isFinite(canonicalWidth) || !Number.isFinite(canonicalHeight) || canonicalWidth < 100 || canonicalHeight < 200) return null;

  // Includes the sequence label/boxes on both v1 layouts, but excludes the
  // answer grid and most of the legacy QR. Fractions keep this valid if the
  // canonical raster is resized in a future template revision.
  const canonicalLeft = Math.round(canonicalWidth * 0.175);
  const canonicalTop = Math.round(canonicalHeight * 0.865);
  const outputWidth = Math.round(canonicalWidth * 0.725);
  const outputHeight = Math.max(80, Math.round(canonicalHeight * 0.134));
  const source = await sharp(imageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
  const sourceWidth = source.info.width;
  const sourceHeight = source.info.height;
  const output = Buffer.alloc(outputWidth * outputHeight, 255);

  for (let y = 0; y < outputHeight; y++) {
    const canonicalY = canonicalTop + y;
    for (let x = 0; x < outputWidth; x++) {
      const canonicalX = canonicalLeft + x;
      const denominator = inverse[2][0] * canonicalX + inverse[2][1] * canonicalY + inverse[2][2];
      if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) continue;
      const sourceX = (inverse[0][0] * canonicalX + inverse[0][1] * canonicalY + inverse[0][2]) / denominator;
      const sourceY = (inverse[1][0] * canonicalX + inverse[1][1] * canonicalY + inverse[1][2]) / denominator;
      const x0 = Math.floor(sourceX);
      const y0 = Math.floor(sourceY);
      if (x0 < 0 || y0 < 0 || x0 + 1 >= sourceWidth || y0 + 1 >= sourceHeight) continue;
      const dx = sourceX - x0;
      const dy = sourceY - y0;
      const topValue = source.data[y0 * sourceWidth + x0] * (1 - dx)
        + source.data[y0 * sourceWidth + x0 + 1] * dx;
      const bottomValue = source.data[(y0 + 1) * sourceWidth + x0] * (1 - dx)
        + source.data[(y0 + 1) * sourceWidth + x0 + 1] * dx;
      output[y * outputWidth + x] = Math.round(topValue * (1 - dy) + bottomValue * dy);
    }
  }
  return sharp(output, { raw: { width: outputWidth, height: outputHeight, channels: 1 } }).png().toBuffer();
}

function normalizeSequenceOcr(text) {
  return text
    .replace(/sequenc[es]?/gi, 'SEQUENCE')
    .toUpperCase()
    .replace(/\bI\b/g, '1')
    .replace(/\bO\b/g, '0')
    .replace(/(?<=\d)O/g, '0')
    .replace(/(?<=\d)I/g, '1')
    .replace(/[lL|]/g, '1')
    .replace(/\bO(\d)/g, '0$1')
    .replace(/\bI(\d)/g, '1$1')
    .replace(/[~!@#$%^&*()_+=\[\]{};:,.<>\/?`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findSequence(rawText, normalizedText, lines) {
  const candidates = [];

  const withLabelPattern = /sequenc[es]?\s*[:\-]?\s*(\d{1,2})\s*[.\-\s]\s*(\d{1,2})(?:\s*[.\-\s]+\s*|\s+)(\d{4})\s*(?:[.\-\s]\s*|\s*[-|]\s*)(\d+)?/i;
  const withLabelMatch = (normalizedText || rawText).match(withLabelPattern) || rawText.match(withLabelPattern);
  if (withLabelMatch) {
    candidates.push({ match: withLabelMatch, pattern: 'with-label', confidence: 95 });
  }

  const directPattern = /(\d{2}[-\/]\d{2}[-\/]\d{4})(?:[-\/](\d+))?/;
  const directMatch = normalizedText.match(directPattern);
  if (directMatch) {
    candidates.push({ match: directMatch, pattern: 'direct', confidence: 90 });
  }

  const loosePattern = /(\d{1,2})[-\/]?\s*(\d{1,2})[-\/]?\s*(\d{4})(?:[-\/]?\s*(\d+))?/;
  const looseMatch = (normalizedText || rawText).match(loosePattern);
  if (looseMatch) {
    candidates.push({ match: looseMatch, pattern: 'loose', confidence: 85 });
  }

  for (const line of lines) {
    if (candidates.length > 0 && candidates[0].confidence >= 95) break;
    const linePattern = /(\d{1,2})[-\/]?\s*(\d{1,2})[-\/]?\s*(\d{4})(?:[-\/]?\s*(\d+))?/;
    const lineMatch = line.match(linePattern);
    if (lineMatch) {
      candidates.push({ match: lineMatch, pattern: 'line', confidence: 75 });
      break;
    }
  }

  if (candidates.length === 0) return null;

  const best = candidates.reduce((a, b) => a.confidence > b.confidence ? a : b);
  const m = best.match;
  let d, mo, y, seq;

  if (best.pattern === 'with-label') {
    d = m[1].padStart(2, '0');
    mo = m[2].padStart(2, '0');
    y = m[3];
    seq = m[4];
  } else if (best.pattern === 'direct') {
    d = m[1].slice(0, 2);
    mo = m[1].slice(3, 5);
    y = m[1].slice(6, 10);
    seq = m[2];
  } else {
    d = (m[1] || '').padStart(2, '0');
    mo = (m[2] || '').padStart(2, '0');
    y = m[3] || '';
    seq = m[4];
  }

  if (y.length === 2) y = `20${y}`;
  if (parseInt(d, 10) > 31 || parseInt(mo, 10) > 12 || y.length !== 4 || parseInt(y, 10) < 1900 || parseInt(y, 10) > 2099) return null;

  return `${d}-${mo}-${y}${seq ? `-${seq}` : ''}`;
}

async function detectSequenceFromBottom(imageBuffer, options = {}) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();

    const width = metadata.width || 800;
    const height = metadata.height || 1000;

    const MIN_CROP_SIZE = 50;
    const MIN_CROP_HEIGHT = 60;

    if (width < MIN_CROP_SIZE || height < MIN_CROP_HEIGHT) {
      return {
        sequence: null,
        confidence: 0,
        rawText: '',
        cropRegion: { top: 0, left: 0, width, height },
        error: 'Image too small for sequence detection'
      };
    }

    if (options.allowStandalone === true && options.placement) {
      const canonicalCrop = await canonicalSequenceCrop(imageBuffer, options.placement);
      if (canonicalCrop) {
        const canonicalResult = await detectCanonicalSequence(canonicalCrop);
        if (canonicalResult) {
          return {
            sequence: canonicalResult.sequence,
            confidence: canonicalResult.confidence,
            rawText: canonicalResult.rawDigits,
            method: 'omr-anchored-boxed-digit-onnx',
            boxCount: canonicalResult.boxCount,
            digitConfidences: canonicalResult.digitConfidences,
            sequenceProfile: canonicalResult.profile,
            cropRegion: { canonical: true, left: 0.175, top: 0.865, width: 0.725, height: 0.134 },
            sequenceRegion: canonicalResult.field,
          };
        }
      }
    }

    const bottomRegionHeight = options.bottomRegionHeight
      ? Math.max(MIN_CROP_HEIGHT, Math.floor(height * options.bottomRegionHeight))
      : Math.max(MIN_CROP_HEIGHT, Math.floor(height * 0.25));

    const cropTop = options.cropTop != null ? options.cropTop : Math.max(0, height - bottomRegionHeight);
    const cropLeft = options.cropLeft != null ? Math.floor(width * options.cropLeft) : Math.max(MIN_CROP_SIZE, Math.floor(width * 0.05));
    const cropWidth = options.cropWidth
      ? Math.max(MIN_CROP_SIZE, Math.floor(width * options.cropWidth))
      : Math.max(MIN_CROP_SIZE, Math.floor(width * (options.cropRight != null ? options.cropRight - (options.cropLeft || 0.05) : 0.90)));

    const cropRight = cropLeft + cropWidth;

    const safeCropWidth = Math.min(cropWidth, width - cropLeft);
    const safeCropHeight = Math.min(bottomRegionHeight, height - cropTop);

    if (safeCropWidth < MIN_CROP_SIZE || safeCropHeight < MIN_CROP_SIZE) {
      return {
        sequence: null,
        confidence: 0,
        rawText: '',
        cropRegion: { top: cropTop, left: cropLeft, width: cropWidth, height: bottomRegionHeight },
        error: 'Calculated crop region too small'
      };
    }

    const targetScale = Math.min(2.5, Math.max(1, Math.sqrt(180000 / (safeCropWidth * safeCropHeight))));
    const resizeScale = safeCropWidth > 1400
      ? 1400 / safeCropWidth
      : targetScale;
    const upscaledWidth = Math.max(80, Math.floor(safeCropWidth * resizeScale));
    const upscaledHeight = Math.max(64, Math.floor(safeCropHeight * resizeScale));

    const croppedBuffer = await img
      .extract({ left: cropLeft, top: cropTop, width: safeCropWidth, height: safeCropHeight })
      .toBuffer();

    // When OMR supplied a verified sheet transform, never fall back to a
    // camera-wide rectangle candidate: a table/background edge must not be
    // allowed to select the wrong student after the anchored read declines.
    if (options.allowStandalone === true) {
      // The printed footer sits against the physical bottom edge. Add a white
      // margin so the raw box locator can see the bottom border instead of
      // treating it as clipped by the camera frame.
      const bottomPadding = Math.max(16, Math.ceil(safeCropHeight * 0.08));
      const paddedCrop = await sharp(croppedBuffer)
        .extend({ top: 0, left: 0, right: 0, bottom: bottomPadding, background: { r: 255, g: 255, b: 255 } })
        .png()
        .toBuffer();
      const boxedResult = await detectBoxedSequence(paddedCrop);
      if (boxedResult) {
        return {
          sequence: boxedResult.sequence,
          confidence: boxedResult.confidence,
          rawText: boxedResult.rawDigits,
          method: 'boxed-digit-onnx',
          boxCount: boxedResult.boxCount,
          digitConfidences: boxedResult.digitConfidences,
          cropRegion: {
            top: cropTop,
            left: cropLeft,
            width: safeCropWidth,
            height: safeCropHeight,
          },
          sequenceRegion: boxedResult.field,
        };
      }
    }
    // Preview never waits on Tesseract. Identity comes from a complete
    // registered/boxed field only; the OCR fallbacks are final-scan only.
    if (options.boxedOnly === true) return { sequence: null, confidence: 0, rawText: '' };

    const rawUpscaledBuffer = await sharp(croppedBuffer)
      .resize({
        width: upscaledWidth,
        height: upscaledHeight,
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .toBuffer();

    const preprocessedBuffer = await sharp(croppedBuffer)
      .greyscale()
      .normalize()
      .linear(1.4, -30)
      .modulate({ brightness: 1.6, saturation: 0 })
      .sharpen({ sigma: 2.0 })
      .resize({
        width: upscaledWidth,
        height: upscaledHeight,
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      })
      .toBuffer();

    // Retain the complete sequence row for the OCR fallback. The old form has
    // four taller boxes; the former crop ended inside those boxes.
    const focusLeft = Math.max(0, Math.floor(safeCropWidth * 0.25));
    const focusTop = Math.max(0, Math.floor(safeCropHeight * 0.12));
    const focusWidth = Math.max(40, Math.min(
      safeCropWidth - focusLeft,
      Math.floor(safeCropWidth * 0.50)
    ));
    const focusHeight = Math.max(40, Math.min(
      safeCropHeight - focusTop,
      Math.floor(safeCropHeight * 0.72)
    ));
    const focusedCrop = await sharp(croppedBuffer)
      .extract({ left: focusLeft, top: focusTop, width: focusWidth, height: focusHeight })
      .toBuffer();
    const focusedWidth = Math.max(320, focusWidth * 4);
    const focusedHeight = Math.max(160, focusHeight * 4);
    const focusedRawBuffer = await sharp(focusedCrop)
      .resize(focusedWidth, focusedHeight, { kernel: sharp.kernel.lanczos3 })
      .toBuffer();
    const focusedPreprocessedBuffer = await sharp(focusedCrop)
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.4 })
      .resize(focusedWidth, focusedHeight, { kernel: sharp.kernel.lanczos3 })
      .toBuffer();

    let bestRawText = '';
    let standaloneConsensus = null;
    const attempts = options.allowStandalone === true
      ? [
          // The current form contains one short two-box field. RAW_LINE skips
          // page layout analysis, which otherwise fragments box borders and
          // patterned camera backgrounds into unusably tiny text lines.
          { buffer: focusedPreprocessedBuffer, psm: '7', whitelist: '0123456789 ', label: 'pre-focused-line' },
          { buffer: focusedRawBuffer, psm: '7', whitelist: '0123456789 ', label: 'raw-focused-line' },
          { buffer: preprocessedBuffer, psm: '13', whitelist: '0123456789 ', label: 'pre-standalone-line' },
          { buffer: rawUpscaledBuffer, psm: '13', whitelist: '0123456789 ', label: 'raw-standalone-line' },
        ]
      : [
          { buffer: rawUpscaledBuffer, psm: '6', whitelist: '0123456789-/ ', label: 'raw-psm6' },
          { buffer: preprocessedBuffer, psm: '6', whitelist: '0123456789-/ ', label: 'pre-psm6' },
        ];

    const settledAttempts = await Promise.allSettled(
      attempts.map(attempt =>
        recognizeWithTesseract(attempt.buffer, {
          psm: attempt.psm,
          whitelist: attempt.whitelist || undefined,
        }).then(text => ({ attempt, text }))
          .catch(err => ({ attempt, text: '', error: err }))
      )
    );

    for (const result of settledAttempts) {
      if (result.status === 'fulfilled' && (result.value.text || '').length > (bestRawText || '').length) {
        bestRawText = result.value.text;
      }
    }

    if (options.allowStandalone === true) {
      const readings = settledAttempts.map(result => {
        if (result.status !== 'fulfilled') return '';
        return normalizeSequenceOcr(result.value.text || '').replace(/\s+/g, '');
      });
      const votes = new Map();
      for (const reading of readings) {
        const normalizedReading = normalizeStandaloneSequence(reading);
        if (!normalizedReading) continue;
        votes.set(normalizedReading, Number(votes.get(normalizedReading) || 0) + 1);
      }
      const rankedVotes = [...votes.entries()].sort((left, right) => right[1] - left[1]);
      if (rankedVotes[0]?.[1] >= 2 && rankedVotes[0][1] > Number(rankedVotes[1]?.[1] || 0)) {
        standaloneConsensus = rankedVotes[0][0];
      }
    }

    const hasGoodText = (bestRawText || '').length >= 20
      || /\d{2}-\d{2}-\d{4}/.test(bestRawText || '')
      || standaloneConsensus !== null;
    if (!hasGoodText && options.allowStandalone !== true) {
      try {
        const contextText = await recognizeWithTesseract(rawUpscaledBuffer, { psm: '6' });
        if ((contextText || '').length > (bestRawText || '').length) {
          bestRawText = contextText;
        }
      } catch (err) { }
    }

    const rawText = bestRawText;
    const rawLines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    const normalized = normalizeSequenceOcr(rawText);
    const normalizedLines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
    const allLines = [...new Set([...rawLines, ...normalizedLines])];

    let sequence = null;
    let confidence = 0;

    sequence = findSequence(rawText, normalized, allLines);

    // The current form has a tens box and a ones box. The tens box may be left
    // blank for 1-9 (so both "01" and "1" mean sequence 1). Require the raw
    // and enhanced crops to agree before accepting the short numeric result.
    if (!sequence && options.allowStandalone === true && standaloneConsensus) {
      const numericValue = Number.parseInt(standaloneConsensus, 10);
      if (numericValue > 0 && numericValue <= MAX_STUDENT_SEQUENCE) {
        sequence = String(numericValue);
        confidence = 78;
      }
    }

    if (!sequence && options.allowStandalone !== true) {
      const compact = normalized.replace(/\s+/g, '').replace(/[\/]+/g, '');
      const compactMatch = compact.match(/(\d{2})(\d{2})(\d{4})(\d+)?/);
      if (compactMatch) {
        const d = compactMatch[1], mo = compactMatch[2], y = compactMatch[3], seq = compactMatch[4];
        if (parseInt(d, 10) <= 31 && parseInt(mo, 10) <= 12) {
          sequence = `${d}-${mo}-${y}${seq ? `-${seq}` : ''}`;
          confidence = Math.max(confidence, 60);
        }
      }
    }

    if (!sequence && options.allowStandalone !== true) {
      try {
        const fullBottomHeight = Math.max(100, Math.floor(height * 0.35));
        const fullBottomBuffer = await sharp(imageBuffer)
          .extract({ left: 0, top: Math.max(0, height - fullBottomHeight), width, height: fullBottomHeight })
          .resize({ width: Math.max(600, width * 2), height: Math.max(300, fullBottomHeight * 2), kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
          .toBuffer();

        const fullBottomText = await recognizeWithTesseract(fullBottomBuffer, { psm: '6' });
        const fullBottomNormalized = normalizeSequenceOcr(fullBottomText);
        const fullBottomResult = findSequence(fullBottomText, fullBottomNormalized, [fullBottomText]);
        if (fullBottomResult) {
          sequence = fullBottomResult;
          confidence = Math.max(confidence, 75);
        }
      } catch (e) { }
    }

    if (sequence) {
      confidence = Math.max(confidence, Math.min(95, 60 + (rawText || '').length));
    }

    return {
      sequence,
      confidence,
      rawText,
      cropRegion: {
        top: cropTop,
        left: cropLeft,
        width: safeCropWidth,
        height: safeCropHeight,
      },
    };
  } catch (error) {
    console.error('Sequence detection error:', error);
    return {
      sequence: null,
      confidence: 0,
      rawText: '',
      error: error.message,
    };
  }
}

module.exports = {
  detectSequenceFromBottom,
  normalizeStandaloneSequence,
  _test: {
    locateSequenceBoxes,
    locateSequenceBoxCandidates: (pixels, width, height, threshold) => locateSequenceBoxes(pixels, width, height, threshold, true),
    darkRuns,
    otsuThreshold,
    canonicalSequenceCrop,
    classifySequenceField,
    detectCanonicalSequence,
    detectBoxedSequence,
    locateCanonicalProfile,
    invert3x3,
  },
};
