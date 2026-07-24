const sharp = require('sharp');
const Tesseract = require('tesseract.js');
const { rectifyExamSheet } = require('./perspective-corrector');
const OnnxService = require('./onnx-scanner-service');
const { detectAdaptiveForm } = require('./adaptive-form-omr');
const path = require('path');
const fs = require('fs');

const CALIBRATION_PATH = path.join(__dirname, 'scan-calibration.json');
let scanCalibrationCache = null;
function loadScanCalibration() {
  if (scanCalibrationCache) return scanCalibrationCache;
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      scanCalibrationCache = JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    } else {
      scanCalibrationCache = { calibrations: {}, defaults: {} };
    }
  } catch (e) {
    console.warn('Failed to load scan calibration:', e.message);
    scanCalibrationCache = { calibrations: {}, defaults: {} };
  }
  return scanCalibrationCache;
}

function getCalibrationForScan(imageBuffer, options = {}) {
  const calibration = loadScanCalibration();
  const filename = options?.calibrationFilename || options?.scanFilename;
  if (!filename) return null;
  return calibration.calibrations[filename] || null;
}

const TESSERACT_POOL_SIZE = 2;
let tesseractPool = [];
let tesseractPoolInitialized = false;

let _bubbleTemplates = null;
async function getBubbleTemplates() {
  if (_bubbleTemplates) return _bubbleTemplates;
  const refDir = path.join(__dirname, '..', 'ml-training', 'reference_images');
  const blankNames = ['bubble_A', 'bubble_B', 'bubble_C', 'bubble_D'];
  const blank = [];
  for (const name of blankNames) {
    const p = path.join(refDir, name + '.png');
    try {
      const buf = await sharp(p).greyscale().resize(32, 32).raw().toBuffer();
      blank.push(new Uint8Array(buf));
    } catch (e) {
      console.warn(`Failed to load template ${p}: ${e.message}`);
    }
  }
  let shaded = null;
  try {
    const buf = await sharp(path.join(refDir, 'bubble_shaded.png')).greyscale().resize(32, 32).raw().toBuffer();
    shaded = new Uint8Array(buf);
  } catch (e) {
    console.warn(`Failed to load shaded template: ${e.message}`);
  }
  _bubbleTemplates = { blank, shaded };
  return _bubbleTemplates;
}

function normalizedCrossCorrelation(a, b) {
  const n = a.length;
  if (n !== b.length || n === 0) return -1;
  let sumA = 0, sumB = 0, sumA2 = 0, sumB2 = 0, sumAB = 0;
  for (let i = 0; i < n; i++) {
    const av = a[i], bv = b[i];
    sumA += av; sumB += bv;
    sumA2 += av * av; sumB2 += bv * bv;
    sumAB += av * bv;
  }
  const meanA = sumA / n, meanB = sumB / n;
  const stdA = Math.sqrt(sumA2 / n - meanA * meanA);
  const stdB = Math.sqrt(sumB2 / n - meanB * meanB);
  if (stdA === 0 || stdB === 0) return 0;
  return (sumAB / n - meanA * meanB) / (stdA * stdB);
}

async function classifyBubbleWithTemplates(patchBuffer) {
  const templates = await getBubbleTemplates();
  if (!templates || !templates.shaded || templates.blank.length === 0) return null;
  
  try {
    const buf = await sharp(patchBuffer).greyscale().resize(32, 32).raw().toBuffer();
    const patch = new Uint8Array(buf);
    
    let bestScore = -Infinity;
    let bestLabel = 'blank';
    
    for (const t of templates.blank) {
      const score = normalizedCrossCorrelation(patch, t);
      if (score > bestScore) {
        bestScore = score;
        bestLabel = 'blank';
      }
    }
    
    const shadedScore = normalizedCrossCorrelation(patch, templates.shaded);
    if (shadedScore > bestScore) {
      bestScore = shadedScore;
      bestLabel = 'shaded';
    }
    
    return { label: bestLabel, score: bestScore, shadedScore };
  } catch (e) {
    return null;
  }
}

async function getTesseractWorker() {
  if (!tesseractPoolInitialized) {
    tesseractPoolInitialized = true;
    for (let i = 0; i < TESSERACT_POOL_SIZE; i++) {
      const worker = await Tesseract.createWorker('eng', 1, {
        logger: () => {},
      });
      tesseractPool.push({ worker, busy: false });
    }
  }
  const available = tesseractPool.find(w => !w.busy);
  if (available) {
    available.busy = true;
    return available;
  }
  const entry = tesseractPool[Math.floor(Math.random() * tesseractPool.length)];
  await new Promise(r => setTimeout(r, 50));
  return getTesseractWorker();
}

function releaseTesseractWorker(entry) {
  if (entry) entry.busy = false;
}

async function recognizeWithTesseract(buffer, options = {}) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height || meta.width < 3 || meta.height < 3) {
      return '';
    }
  } catch {
    return '';
  }
  const entry = await getTesseractWorker();
  try {
    const worker = entry.worker;
    if (options.whitelist) {
      await worker.setVariable('tessedit_char_whitelist', options.whitelist);
    }
    const { data } = await worker.recognize(buffer, options.psm ? { tessedit_pageseg_mode: options.psm } : undefined);
    return (data.text || '').trim();
  } finally {
    releaseTesseractWorker(entry);
  }
}

async function shutdownTesseractPool() {
  for (const entry of tesseractPool) {
    try { await entry.worker.terminate(); } catch (e) { /* ignore */ }
  }
  tesseractPool = [];
  tesseractPoolInitialized = false;
}

/**
 * ENHANCED SCANNER MODULE
 * Improves shaded letter/bubble detection and student name/number extraction
 * Supports ONNX-based learned classification when models are available
 */

/**
 * BLUR DETECTION - Analyzes image sharpness/focus level
 * Returns a blur score: 0-1 (0=very sharp, 1=very blurry)
 */
async function detectBlurLevel(imageBuffer) {
  try {
    const blurred = await sharp(imageBuffer)
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    
    const pixels = blurred.data;
    const width = blurred.info.width;
    
    let laplacianSum = 0;
    let count = 0;
    
    for (let y = 1; y < blurred.info.height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x);
        const center = pixels[idx];
        const neighbors = pixels[idx - width] + pixels[idx + width] + 
                         pixels[idx - 1] + pixels[idx + 1];
        const laplacian = Math.abs(center * 4 - neighbors);
        laplacianSum += laplacian * laplacian;
        count++;
      }
    }
    
    const blurScore = Math.max(0, Math.min(1, 1 - (laplacianSum / count) / 500));
    return blurScore;
  } catch (error) {
    console.warn('Blur detection error, assuming moderate blur:', error.message);
    return 0.5;
  }
}

/**
 * Advanced image preprocessing for better bubble detection
 */
async function advancedPreprocessImage(imagePathOrBuffer, options = {}) {
  try {
    let imageBuffer = imagePathOrBuffer;

    if (Buffer.isBuffer(imagePathOrBuffer)) {
      imageBuffer = imagePathOrBuffer;
    } else if (typeof imagePathOrBuffer === 'string') {
      imageBuffer = await sharp(imagePathOrBuffer).toBuffer();
    } else {
      throw new Error('Invalid input: expected file path or Buffer');
    }

    // Run blur detection on the original image before any transformations
    const originalBlurScore = Math.min(1, Math.max(0, await detectBlurLevel(imageBuffer)));
    console.log(`Original blur level: ${(originalBlurScore * 100).toFixed(1)}% (0=sharp, 100=very blurry)`);

    if (options.rectify !== false) {
      try {
        const rectified = await rectifyExamSheet(imageBuffer);
        if (rectified.rectified) {
          imageBuffer = rectified.buffer;
          console.log(`Perspective correction applied: ${rectified.dstWidth}x${rectified.dstHeight}`);
        }
      } catch (e) {
        console.warn('Perspective correction skipped:', e.message);
      }
    }

    let image = sharp(imageBuffer);
    const metadata = await image.metadata();

    const maxDimension = 3840;
    if (metadata.width > maxDimension || metadata.height > maxDimension) {
      const ratio = Math.min(maxDimension / metadata.width, maxDimension / metadata.height);
      image = image.resize(
        Math.round(metadata.width * ratio),
        Math.round(metadata.height * ratio),
        { fit: 'inside', withoutEnlargement: true }
      );
    }

    let processedImage = image.greyscale();

    // Use the original blur score for sharpening decisions, since rectification/resizing
    // can artificially inflate the blur score
    const blurScore = originalBlurScore;
    
    if (blurScore > 0.3) {
      processedImage = processedImage.sharpen({ sigma: 1.0 });
      if (blurScore > 0.5) {
        processedImage = processedImage.sharpen({ sigma: 1.6 });
      }
      if (blurScore > 0.7) {
        processedImage = processedImage.sharpen({ sigma: 2.0 });
      }
    } else {
      processedImage = processedImage.sharpen({ sigma: 0.5 });
    }

    if (options.highContrast || blurScore > 0.4) {
      processedImage = processedImage.normalize();
      processedImage = processedImage.linear(2.0, (-0.25 * 255));
      processedImage = processedImage.modulate({ brightness: 1.3, saturation: 0, lightness: 15 });
      processedImage = processedImage.normalize();
      processedImage = processedImage.median(1);
      processedImage = processedImage.sharpen({ sigma: 0.8 });
    } else {
      processedImage = processedImage.normalize();
      processedImage = processedImage.linear(1.5, (-0.35 * 255));
      processedImage = processedImage.modulate({ brightness: 1.15, saturation: 0, lightness: -8 });
      processedImage = processedImage.normalize();
      processedImage = processedImage.median(1);
      processedImage = processedImage.sharpen({ sigma: 0.6 });
    }

    const enhancedBuffer = await processedImage.toBuffer();
    return enhancedBuffer;
  } catch (error) {
    console.error('Advanced preprocessing error:', error);
    throw error;
  }
}

/**
 * Extract a rectangular patch around a bubble center for ONNX classification
 */
async function extractBubblePatch(imageBuffer, cx, cy, radius, width, height) {
  // Match the tight per-bubble crops used by build_form_bubble_dataset.py.
  // A 3.5x radius patch can contain an adjacent shaded choice, making a
  // binary marked/blank model appear to agree with the wrong grid column.
  const patchHalf = Math.max(8, Math.min(24, Math.floor(radius * 1.5)));
  const x1 = Math.max(0, Math.floor(cx) - patchHalf);
  const y1 = Math.max(0, Math.floor(cy) - patchHalf);
  const x2 = Math.min(width, Math.floor(cx) + patchHalf);
  const y2 = Math.min(height, Math.floor(cy) + patchHalf);
  const patchW = x2 - x1;
  const patchH = y2 - y1;

  if (patchW <= 0 || patchH <= 0) return null;

  try {
    const patchBuffer = await sharp(imageBuffer)
      .extract({ left: x1, top: y1, width: patchW, height: patchH })
      .toBuffer();
    return patchBuffer;
  } catch (err) {
    return null;
  }
}

/**
 * SMART BUBBLE DETECTION (FIXED v4)
 * 
 * CRITICAL FIXES:
 * 1. Uses RAW greyscale data (no normalize) to preserve intensity differences
 * 2. Uses original image for geometry calculations (not rectified)
 * 3. Detects very dark images and applies LOCAL normalization per question
 * 4. For each question, independently stretches bubble intensities to full 0-255 range
 * 5. Z-score analysis on locally-normalized values for accurate discrimination
 * 6. Always picks the darkest bubble if z-score confidence is low
 * 7. Hybrid approach: z-score for clean images, relative ranking for dark images
 * 8. Fixed layout inference to match actual exam sheet format (10x5 for 50 questions)
 * 9. Added layout detection fallback for robustness
 */
async function smartBubbleDetection(imageBuffer, answerKey, options) {
  try {
    const cleanKey = (answerKey || '').replace(/\s/g, '');
    const numQuestions = cleanKey.length;
    if (numQuestions === 0) throw new Error('Invalid answer key');

    const inferredNumChoices = options?.numChoices
      || Math.max(4, new Set(cleanKey.toUpperCase().split('')).size);
    const numChoices = inferredNumChoices;
    const useMinIntensity = options?.useMinIntensity === true;
    let intensityMetric = options?.intensityMetric || 'minWithContrast'; // 'min', 'avg', 'contrast', 'minWithContrast'

    const img = sharp(imageBuffer);
    const metadata = await img.metadata();
    const width = metadata.width;
    const height = metadata.height;
    
    // KEY FIX: Use original image for grid calculations to maintain consistency
    // Only apply preprocessing for intensity measurement, not for geometry
    let gridCols = 1;
    let gridRows = numQuestions;

    if (options && options.blocksPerRow && options.questionsPerBlock) {
      gridCols = options.blocksPerRow;
      gridRows = options.questionsPerBlock;
    } else {
      const aspectRatio = width / height;
      if (numQuestions <= 25) {
        gridCols = 1;
        gridRows = numQuestions;
      } else if (numQuestions <= 50) {
        if (aspectRatio > 1.4) {
          gridCols = 10;
          gridRows = 5;
        } else if (aspectRatio > 1.0) {
          gridCols = 5;
          gridRows = 10;
        } else {
          gridCols = 2;
          gridRows = 25;
        }
      } else if (numQuestions <= 75) {
        gridCols = 3;
        gridRows = 25;
      } else if (numQuestions <= 100) {
        gridCols = 4;
        gridRows = 25;
      } else {
        gridRows = 25;
        gridCols = Math.ceil(numQuestions / gridRows);
      }
    }

    const isStandard50Form = options?.formLayout === 'acadcheck-50';
    const calibration = getCalibrationForScan(imageBuffer, options);
    const topMargin    = calibration?.topMarginRatio != null ? Math.floor(height * calibration.topMarginRatio) : (options?.topMargin != null ? options.topMargin : Math.floor(height * (isStandard50Form ? 0.16 : 0.05)));
    const bottomMargin = calibration?.bottomMarginRatio != null ? Math.floor(height * calibration.bottomMarginRatio) : (options?.bottomMargin != null ? options.bottomMargin : height - Math.floor(height * (isStandard50Form ? 0.18 : 0.05)));
    const leftMargin   = calibration?.leftMarginRatio != null ? Math.floor(width * calibration.leftMarginRatio) : (options?.leftMargin != null ? options.leftMargin : Math.floor(width * 0.05));
    const rightMargin  = calibration?.rightMarginRatio != null ? Math.floor(width * calibration.rightMarginRatio) : (options?.rightMargin != null ? options.rightMargin : Math.floor(width * 0.95));
    const effectiveBlocksPerRow = calibration?.blocksPerRow || options?.blocksPerRow || gridCols;
    const effectiveQuestionsPerBlock = calibration?.questionsPerBlock || options?.questionsPerBlock || gridRows;

    const usableHeight = bottomMargin - topMargin;
    const usableWidth  = rightMargin - leftMargin;
    const cellWidth    = usableWidth / effectiveBlocksPerRow;
    const cellHeight   = usableHeight / effectiveQuestionsPerBlock;

    // Use original image raw buffer for measurement to preserve geometry
    const raw = await sharp(imageBuffer).greyscale().raw().toBuffer();
    // The standard form is calibrated from its own printed rings by the
    // adaptive reader. Never project bubble centres from an older upload.
    let referenceGrid = null;
    // This is deliberately tracked separately from answer confidence. A
    // misprojected grid can still produce strong-looking dark-pixel scores,
    // but those scores do not prove that the pixels belong to answer bubbles.
    let geometryEvidenceUnreliable = false;
    // A phone capture can include a different amount of paper margin than the
    // reference image.  Locate the solid shaded bubbles first, then fit the
    // projected grid to those components.  Printed labels/rings are excluded.
    if (referenceGrid?.verifiedGeometry && referenceGrid.similarity < 0.995) {
      const refinedCenters = referenceGrid.centers.map(row => row.map(([x, y]) => [x, y]));
      const findSolidMarks = (column) => {
        const points = refinedCenters.slice(column * 25, column * 25 + 25).flat();
        const xValues = points.map(point => point[0]).sort((a, b) => a - b);
        const observedSpacing = xValues.length > 1
          ? xValues.slice(1).map((x, index) => x - xValues[index]).filter(gap => gap > 12).sort((a, b) => a - b)[0] || 55
          : 55;
        // Stay inside the answer bubbles. The old ±180px search included the
        // question numbers and the vertical form print, which then appeared
        // as false A/D clusters on mixed-answer sheets.
        const lanePadding = Math.max(22, Math.min(48, observedSpacing * 0.65));
        const minX = Math.max(0, Math.floor(Math.min(...points.map(p => p[0])) - lanePadding));
        const maxX = Math.min(width - 1, Math.ceil(Math.max(...points.map(p => p[0])) + lanePadding));
        const minY = Math.max(0, Math.floor(Math.min(...points.map(p => p[1])) - 45));
        const maxY = Math.min(height - 1, Math.ceil(Math.max(...points.map(p => p[1])) + 45));
        const visited = new Uint8Array((maxX - minX + 1) * (maxY - minY + 1));
        const marks = [];
        const regionW = maxX - minX + 1;
        for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
          const local = (y - minY) * regionW + (x - minX);
          if (visited[local] || raw[y * width + x] > 90) continue;
          const queue = [y * width + x];
          visited[local] = 1;
          let count = 0, sumX = 0, sumY = 0, loX = x, hiX = x, loY = y, hiY = y;
          for (let i = 0; i < queue.length; i++) {
            const index = queue[i], px = index % width, py = Math.floor(index / width);
            count++; sumX += px; sumY += py; loX = Math.min(loX, px); hiX = Math.max(hiX, px); loY = Math.min(loY, py); hiY = Math.max(hiY, py);
            for (const [nx, ny] of [[px - 1, py], [px + 1, py], [px, py - 1], [px, py + 1]]) {
              if (nx < minX || nx > maxX || ny < minY || ny > maxY) continue;
              const ni = (ny - minY) * regionW + (nx - minX);
              if (!visited[ni] && raw[ny * width + nx] <= 90) { visited[ni] = 1; queue.push(ny * width + nx); }
            }
          }
          const boxW = hiX - loX + 1, boxH = hiY - loY + 1;
          const fillRatio = count / Math.max(1, boxW * boxH);
          if (count >= 140 && boxW >= 14 && boxH >= 14 && boxW <= 65 && boxH <= 65
              && boxW / boxH > 0.65 && boxW / boxH < 1.55 && fillRatio >= 0.32) {
            marks.push([sumX / count, sumY / count, count]);
          }
        }
        // One intentionally shaded bubble exists per question row.  Keep the
        // 25 largest solid components; printed letters and broken ring pieces
        // are much smaller and must not influence registration.
        return marks.sort((a, b) => b[2] - a[2]).slice(0, 25);
      };
      for (let column = 0; column < 2; column++) {
        const marks = findSolidMarks(column);
        let usedMarkClusters = false;
        let marksByRow = [];
        let best = { score: -Infinity, dx: 0, dy: 0 };
        for (let dy = -15; dy <= 15; dy += 1) {
          for (let dx = -15; dx <= 15; dx += 1) {
            let score = 0;
            for (let row = 0; row < 25; row++) {
              for (let choice = 0; choice < numChoices; choice++) {
                const [x, y] = refinedCenters[column * 25 + row][choice];
                let nearest = Infinity;
                for (const [mx, my] of marks) nearest = Math.min(nearest, (x + dx - mx) ** 2 + (y + dy - my) ** 2);
                if (nearest < 24 * 24) score += 600 - nearest;
              }
            }
            if (score > best.score) best = { score, dx, dy };
          }
        }
        for (let row = 0; row < 25; row++) {
          for (let choice = 0; choice < numChoices; choice++) {
            refinedCenters[column * 25 + row][choice][0] += best.dx;
            refinedCenters[column * 25 + row][choice][1] += best.dy;
          }
        }
        // Camera perspective and paper curvature can leave a few lower rows
        // offset after the column-wide correction. When one solid filled mark
        // is visible in each row, anchor each row to its nearest component.
        if (marks.length >= 20) {
          const maxRowAdjustment = Math.max(12, cellHeight * 0.65);
          marksByRow = [...marks].sort((a, b) => a[1] - b[1]);
          for (let row = 0; row < 25; row++) {
            const expectedY = refinedCenters[column * 25 + row][0][1];
            // A complete sheet supplies one solid component per row. Preserve
            // that ordering so two projected rows cannot snap to the same
            // mark when the sheet is translated or slightly curved.
            const nearest = marksByRow.length === 25
              ? marksByRow[row]
              : marks.reduce((bestMark, mark) =>
                  Math.abs(mark[1] - expectedY) < Math.abs(bestMark[1] - expectedY) ? mark : bestMark
                );
            if (marksByRow.length === 25 || Math.abs(nearest[1] - expectedY) <= maxRowAdjustment) {
              for (let choice = 0; choice < numChoices; choice++) {
                refinedCenters[column * 25 + row][choice][1] = nearest[1];
              }
            }
          }
        }

        // A mixed sheet supplies direct horizontal evidence for A-D: the 25
        // solid marks in a block fall into up to four distinct x clusters.
        // When every choice is represented, use those observed positions in
        // preference to a page-edge homography. This makes the answer reader
        // independent of where the paper is placed in the camera frame.
        if (marks.length >= 20 && numChoices === 4) {
          const xs = marks.map(mark => mark[0]);
          const minMarkX = Math.min(...xs);
          const maxMarkX = Math.max(...xs);
          const expectedSpacing = Math.abs(refinedCenters[column * 25][1][0] - refinedCenters[column * 25][0][0]);
          if (maxMarkX - minMarkX >= expectedSpacing * 2.2) {
            let centers = Array.from({ length: 4 }, (_, i) => minMarkX + (maxMarkX - minMarkX) * i / 3);
            let groups = [];
            for (let iteration = 0; iteration < 12; iteration++) {
              groups = Array.from({ length: 4 }, () => []);
              for (const mark of marks) {
                let selected = 0;
                for (let i = 1; i < 4; i++) {
                  if (Math.abs(mark[0] - centers[i]) < Math.abs(mark[0] - centers[selected])) selected = i;
                }
                groups[selected].push(mark);
              }
              const next = centers.map((center, i) => groups[i].length
                ? groups[i].reduce((sum, mark) => sum + mark[0], 0) / groups[i].length
                : center);
              if (next.every((center, i) => Math.abs(center - centers[i]) < 0.25)) { centers = next; break; }
              centers = next;
            }
            const ordered = centers.map((center, i) => ({ center, count: groups[i].length }))
              .sort((a, b) => a.center - b.center);
            const clusterGaps = [
              ordered[1].center - ordered[0].center,
              ordered[2].center - ordered[1].center,
              ordered[3].center - ordered[2].center,
            ];
            const medianGap = [...clusterGaps].sort((a, b) => a - b)[1];
            const evenlySpaced = clusterGaps.every(gap => gap >= medianGap * 0.70 && gap <= medianGap * 1.30)
              && medianGap >= expectedSpacing * 0.55 && medianGap <= expectedSpacing * 1.45;
            if (ordered.every(group => group.count >= 1) && evenlySpaced
                && ordered[3].center - ordered[0].center >= expectedSpacing * 2.2) {
              for (let row = 0; row < 25; row++) {
                for (let choice = 0; choice < 4; choice++) {
                  refinedCenters[column * 25 + row][choice][0] = ordered[choice].center;
                }
              }
              usedMarkClusters = true;
              console.log(`[GRID] Direct choice clusters column ${column + 1}: ${ordered.map(group => `${group.center.toFixed(1)}(${group.count})`).join(', ')}`);
            } else {
              geometryEvidenceUnreliable = true;
              console.log(`[GRID] Rejected irregular choice clusters column ${column + 1}: ${clusterGaps.map(gap => gap.toFixed(1)).join(', ')}`);
            }
          }
        }

        // A filled component alone is periodic across A-D: a translated B can
        // look like an A at the neighbouring grid position. Align against the
        // outlines of all four printed bubbles to retain the choice identity.
        // At the correct offset four rings contribute; an offset of one choice
        // spacing can align at most three.
        const rowStart = column * 25;
        const firstRow = refinedCenters[rowStart];
        const choiceSpacing = firstRow.length > 1
          ? firstRow.slice(1).reduce((sum, point, index) => sum + Math.abs(point[0] - firstRow[index][0]), 0) / (firstRow.length - 1)
          : 50;
        const ringRadius = Math.max(8, Math.min(24, choiceSpacing * 0.32));
        let ringBest = { score: -Infinity, dx: 0 };
        for (let dx = -70; dx <= 70; dx++) {
          let score = 0;
          for (let row = 0; row < 25; row++) {
            for (let choice = 0; choice < numChoices; choice++) {
              const [cx, cy] = refinedCenters[rowStart + row][choice];
              let darkSamples = 0;
              for (let sample = 0; sample < 24; sample++) {
                const angle = sample * Math.PI * 2 / 24;
                const x = Math.round(cx + dx + Math.cos(angle) * ringRadius);
                const y = Math.round(cy + Math.sin(angle) * ringRadius);
                if (x >= 0 && x < width && y >= 0 && y < height && raw[y * width + x] < 175) darkSamples++;
              }
              // A solid mark must not outweigh several correctly aligned
              // empty rings, otherwise the result is periodic by one choice.
              score += Math.min(8, darkSamples);
            }
          }
          if (score > ringBest.score || (score === ringBest.score && Math.abs(dx) < Math.abs(ringBest.dx))) {
            ringBest = { score, dx };
          }
        }
        // Use the ring disambiguator only when the solid-mark fit is pinned to
        // the positive search boundary. In ordinary aligned frames the
        // homography is already choice-stable and a ring-only correction can
        // overfit print noise by a full choice spacing.
        const ringCorrection = !usedMarkClusters && best.dx >= 14 && ringBest.dx < -20 ? ringBest.dx : 0;
        for (let row = 0; row < 25; row++) {
          for (let choice = 0; choice < numChoices; choice++) {
            refinedCenters[rowStart + row][choice][0] += ringCorrection;
          }
        }
        console.log(`[GRID] Refined column ${column + 1}: marks=${marks.length}, dx=${best.dx}, dy=${best.dy}, ringDx=${ringCorrection}`);
      }
      referenceGrid = { ...referenceGrid, centers: refinedCenters };
    }
    if (referenceGrid?.verifiedGeometry && !options?.intensityMetric) intensityMetric = 'avg';
    const registeredRowCenters = [];
    if (referenceGrid?.centers && !referenceGrid.verifiedGeometry) {
      for (let row = 0; row < Math.min(25, gridRows); row++) {
        const lanes = [...(referenceGrid.centers[row] || []), ...(referenceGrid.centers[row + 25] || [])];
        const baseY = Math.round(lanes.reduce((sum, point) => sum + point[1], 0) / Math.max(1, lanes.length));
        let bestY = baseY, bestScore = -Infinity;
        for (let y = Math.max(4, baseY - 14); y <= Math.min(height - 5, baseY + 14); y++) {
          let score = 0;
          for (const [x] of lanes) {
            const cx = Math.round(x);
            for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
              score += 255 - raw[(y + dy) * width + cx + dx];
            }
          }
          if (score > bestScore) { bestScore = score; bestY = y; }
        }
        registeredRowCenters[row] = bestY;
      }
    }


    // Refine each printed answer-row position from the image rather than
    // assuming a perfectly level camera capture.  We search near the form's
    // nominal row, so headings and the sequence footer cannot be selected.
    const calibratedRowCenters = new Array(gridRows);
    if (isStandard50Form && options?.autoCalibrateFormGrid !== false) {
      for (let row = 0; row < gridRows; row++) {
        const nominal = topMargin + (row + 0.5) * cellHeight;
        const radius = Math.max(3, Math.floor(cellHeight * 0.50));
        let bestY = Math.round(nominal), bestScore = -1;
        for (let y = Math.max(1, Math.round(nominal - radius)); y < Math.min(height - 1, Math.round(nominal + radius)); y++) {
          let score = 0;
          for (let x = Math.floor(width * 0.10); x < Math.floor(width * 0.85); x += 2) {
            if (raw[y * width + x] < 120) score++;
          }
          if (score > bestScore) { bestScore = score; bestY = y; }
        }
        calibratedRowCenters[row] = bestY;
      }
    }

    const blurScore = Math.min(1, Math.max(0, await detectBlurLevel(imageBuffer)));

    function measureBubbleAt(cx, cy, radius, minX, maxX, minY, maxY, bubbleSpacing) {
      const sampleR = Math.max(3, Math.floor(radius * 0.8));
      const cxInt = Math.floor(cx);
      const cyInt = Math.floor(cy);
      const minXInt = minX != null ? Math.floor(minX) : 0;
      const maxXInt = maxX != null ? Math.floor(maxX) : width - 1;
      const minYInt = minY != null ? Math.floor(minY) : 0;
      const maxYInt = maxY != null ? Math.floor(maxY) : height - 1;

      let sum = 0, count = 0, darkCount = 0, veryDarkCount = 0, extremeDarkCount = 0, minVal = 255, maxVal = 0;
      let darkestX = cxInt, darkestY = cyInt, darkestVal = 255;

      for (let dy = -sampleR; dy <= sampleR; dy++) {
        for (let dx = -sampleR; dx <= sampleR; dx++) {
          if (dx * dx + dy * dy > sampleR * sampleR) continue;
          const x = cxInt + dx;
          const y = cyInt + dy;
          if (x < minXInt || x > maxXInt || y < minYInt || y > maxYInt) continue;
          const val = raw[y * width + x];
          sum += val; count++;
          if (val < darkestVal) {
            darkestVal = val;
            darkestX = x;
            darkestY = y;
          }
          if (val < 140) darkCount++;
          if (val < 90) veryDarkCount++;
          if (val < 50) extremeDarkCount++;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }

      return { avgIntensity: count ? sum / count : 255, percentDark: count ? (darkCount / count) * 100 : 0, pixelCount: count, contrast: maxVal - minVal, minIntensity: minVal, veryDarkPercent: count ? (veryDarkCount / count) * 100 : 0, extremeDarkPercent: count ? (extremeDarkCount / count) * 100 : 0, darkestX, darkestY };
    }

    const detectedAnswers = [];
    const confidenceScores = [];
    const allMarkedLetters = [];
    // Per-bubble ONNX classification requires an image extraction and model
    // inference for every choice.  Classical measurements are the primary
    // detector, so keep ONNX as an explicit diagnostic/recovery opt-in.
    const useOnnx = options?.useOnnx === true && OnnxService.isAvailable();

    // Grid geometry is deterministic after page rectification.  Full-page OCR
    // for printed question numbers is expensive and can introduce bad row
    // offsets on low-light phone captures, so only use it when explicitly
    // requested by a diagnostic/calibration caller.
    const questionAnchors = options?.useQuestionAnchors === true
      ? await detectQuestionNumbers(imageBuffer, numQuestions)
      : null;
    const useAnchors = Array.isArray(questionAnchors) && questionAnchors.length >= Math.min(numQuestions, 10);

    let imgSum = 0, imgCount = 0;
    for (let i = 0; i < raw.length; i++) {
      imgSum += raw[i];
      imgCount++;
    }
    const imgAvgIntensity = imgCount > 0 ? imgSum / imgCount : 128;
    const isDarkImage = imgAvgIntensity < 100;

    for (let q = 0; q < numQuestions; q++) {
      const col = Math.floor(q / effectiveQuestionsPerBlock);
      const row = q % effectiveQuestionsPerBlock;

      const cellLeft    = leftMargin + col * cellWidth;
      const cellTop     = topMargin + row * cellHeight;
      let cellCenterY = (referenceGrid?.verifiedGeometry ? referenceGrid?.centers?.[q]?.[0]?.[1] : registeredRowCenters[row])
        || referenceGrid?.centers?.[q]?.[0]?.[1]
        || calibratedRowCenters[row]
        || (cellTop + cellHeight / 2);

      if (useAnchors) {
        const anchor = questionAnchors[q];
        if (anchor) {
          const anchoredY = topMargin + (anchor.yCenter - (questionAnchors[0]?.yCenter || topMargin));
          if (anchoredY > topMargin && anchoredY < bottomMargin) {
            cellCenterY = anchoredY;
          }
        }
      }

    const bubbleAreaLeft  = cellLeft + cellWidth * 0.10;
    const bubbleAreaWidth = cellWidth * 0.65;
    const bubbleSpacing = bubbleAreaWidth / (numChoices + 1);
    const adaptiveBubbleRadius = Math.max(2, Math.min(
      Math.floor(cellHeight * 0.22 * (1 - blurScore * 0.15)),
      Math.floor(bubbleSpacing * 0.6)
    ));
    const bubbleRadius    = adaptiveBubbleRadius;

      const bubbleCenters = referenceGrid?.centers?.[q]
        ? referenceGrid.centers[q].map(([x]) => x)
        : [];
      if (bubbleCenters.length === 0 && Array.isArray(options?.bubbleXOffsets) && options.bubbleXOffsets[col]) {
        const colOffsets = options.bubbleXOffsets[col];
        for (let c = 0; c < numChoices && c < colOffsets.length; c++) {
          bubbleCenters.push(colOffsets[c]);
        }
        while (bubbleCenters.length < numChoices) {
          bubbleCenters.push(bubbleAreaLeft + bubbleAreaWidth * (bubbleCenters.length + 1) / (numChoices + 1));
        }
      } else if (bubbleCenters.length === 0) {
        for (let c = 0; c < numChoices; c++) {
          bubbleCenters.push(bubbleAreaLeft + bubbleAreaWidth * (c + 1) / (numChoices + 1));
        }
      }

      const bubbleAreaTop = cellTop + cellHeight * 0.10;
      const bubbleAreaBottom = cellTop + cellHeight * 0.90;
      const measurements = bubbleCenters.map((cx, idx) => ({ ...measureBubbleAt(cx, cellCenterY, bubbleRadius, referenceGrid ? 0 : bubbleAreaLeft, referenceGrid ? width - 1 : bubbleAreaLeft + bubbleAreaWidth, referenceGrid ? 0 : bubbleAreaTop, referenceGrid ? height - 1 : bubbleAreaBottom, bubbleSpacing), cx, cy: cellCenterY }));
      const intensities  = measurements.map(m => m.avgIntensity);

      const minIntensity = Math.min(...intensities);
      const maxIntensity = Math.max(...intensities);
      const rawRange = maxIntensity - minIntensity;
      
      // KEY FIX: Detect when ALL bubbles have the same intensity (no answer filled)
      // In this case, don't try to normalize - no answer is marked
      const allSame = intensities.every(v => Math.abs(v - intensities[0]) < 3);
      
      let normalizedIntensities;
      let range;
      if (rawRange > 2 && !allSame) {
        range = rawRange;
        normalizedIntensities = intensities.map(v => ((v - minIntensity) / range) * 100);
      } else {
        // No meaningful difference between bubbles = no answer
        range = 0;
        normalizedIntensities = intensities.map(() => 0); // Score 0 = no mark
      }
      
      const darknessScores = normalizedIntensities.map((v, i) => {
        const base = 100 - v;
        const m = measurements[i];
        const extremeBonus = Math.min(15, m.extremeDarkPercent * 0.2);
        const veryDarkBonus = Math.min(10, m.veryDarkPercent * 0.1);
        // Only add bonuses if there's actually a mark (intensity suggests dark fill)
        if (m.avgIntensity > 120) return base; // Light bubbles get no bonus
        return base + extremeBonus + veryDarkBonus;
      });

      const markedLetters = [];
      const avgDarkness = darknessScores.reduce((a, b) => a + b, 0) / darknessScores.length;
      for (let c = 0; c < numChoices; c++) {
        if (darknessScores[c] > 55 && darknessScores[c] > avgDarkness + 8) {
          markedLetters.push(String.fromCharCode(65 + c));
        }
      }

      // Only try to find a single winner if there's meaningful range
      if (markedLetters.length === 0 && range > 2) {
        const ranked = darknessScores
          .map((s, idx) => ({ score: s, idx }))
          .sort((a, b) => b.score - a.score);
        if ((ranked[0].score - ranked[1].score) > 12) {
          markedLetters.push(String.fromCharCode(65 + ranked[0].idx));
        }
      }
      const darknessIsDecisive = markedLetters.length === 1 && range > 2 && (() => {
        const ranked = darknessScores
          .map((s, idx) => ({ score: s, idx }))
          .sort((a, b) => b.score - a.score);
        return (ranked[0].score - ranked[1].score) > 15;
      })();

      // ONNX provides calibrated supporting evidence. It must not replace an
      // independently selected geometric answer.
      let onnxProbabilities = null;
      if (useOnnx) {
        onnxProbabilities = [];
        for (let c = 0; c < numChoices; c++) {
          const cx = bubbleCenters[c];
          const patchBuffer = await extractBubblePatch(imageBuffer, cx, cellCenterY, bubbleRadius, width, height);
          if (patchBuffer) {
            const prob = await OnnxService.getBubbleMarkedProbability(patchBuffer);
            onnxProbabilities.push(prob !== null ? prob : 0);
          } else {
            onnxProbabilities.push(0);
          }
        }
      }

      if (markedLetters.length > 1) {
        const scored = markedLetters.map(letter => {
          const idx = letter.charCodeAt(0) - 65;
          return { letter, darkness: darknessScores[idx], intensity: intensities[idx], contrast: measurements[idx].contrast, onnxProb: onnxProbabilities ? onnxProbabilities[idx] : 0 };
        }).sort((a, b) => b.darkness - a.darkness);

        const top = scored[0];
        const second = scored[1];
        const topGap = top.darkness - second.darkness;
        if (topGap > 10 && top.contrast >= second.contrast * 0.7) {
          markedLetters.length = 0;
          markedLetters.push(top.letter);
        } else if (topGap > 6 && top.intensity < second.intensity - 3) {
          markedLetters.length = 0;
          markedLetters.push(top.letter);
        }
       }

      // Keep only unresolved multiple shades as an invalid response. A clear
      // intensity/contrast winner is a single mark, not a false multi-mark.
      const shadeMarks = [...markedLetters];

      const minIntensities = measurements.map(m => m.minIntensity);
      const rankedByMinIntensity = minIntensities
        .map((minVal, idx) => ({ minVal, idx, darkness: darknessScores[idx], intensity: intensities[idx], contrast: measurements[idx].contrast }))
        .sort((a, b) => {
          if (a.minVal !== b.minVal) return a.minVal - b.minVal;
          return a.idx - b.idx;
        });
      const darkest = rankedByMinIntensity[0];
      const secondDarkest = rankedByMinIntensity[1];

      let answer = '';
      let confidence = 0;

      if (intensityMetric === 'avg') {
        const rankedByAvg = intensities
          .map((avgVal, idx) => ({ avgVal, idx, darkness: darknessScores[idx], contrast: measurements[idx].contrast }))
          .sort((a, b) => {
            if (a.avgVal !== b.avgVal) return a.avgVal - b.avgVal;
            return b.contrast - a.contrast;
          });
        const top = rankedByAvg[0];
        const second = rankedByAvg[1];
        const avgGap = second.avgVal - top.avgVal;
        if (avgGap > 3) {
          answer = String.fromCharCode(65 + top.idx);
          confidence = Math.round(Math.min(90, 60 + avgGap * 0.5));
        } else {
          const rankedByDarkness = darknessScores
            .map((s, idx) => ({ score: s, idx }))
            .sort((a, b) => b.score - a.score);
          const topDark = rankedByDarkness[0];
          const secondDark = rankedByDarkness[1];
          const darkGap = topDark.score - secondDark.score;
          if (darkGap > 10) {
            answer = String.fromCharCode(65 + topDark.idx);
            confidence = Math.round(Math.min(85, 55 + darkGap * 0.3));
          } else {
            answer = '';
            confidence = 0;
          }
        }
        markedLetters.length = 0;
        if (answer) markedLetters.push(answer);
      } else if (intensityMetric === 'contrast') {
        const rankedByContrast = measurements.map((m, idx) => ({ contrast: m.contrast, idx, darkness: darknessScores[idx], intensity: intensities[idx] }))
          .sort((a, b) => {
            if (b.contrast !== a.contrast) return b.contrast - a.contrast;
            return a.intensity - b.intensity;
          });
        const top = rankedByContrast[0];
        const second = rankedByContrast[1];
        const contrastGap = top.contrast - second.contrast;
        if (contrastGap > 3) {
          answer = String.fromCharCode(65 + top.idx);
          confidence = Math.round(Math.min(85, 55 + contrastGap * 0.5));
        } else {
          const rankedByMin = minIntensities
            .map((minVal, idx) => ({ minVal, idx }))
            .sort((a, b) => a.minVal - b.minVal);
          const darkest2 = rankedByMin[0];
          const secondDarkest2 = rankedByMin[1];
          const minGap = secondDarkest2.minVal - darkest2.minVal;
          if (minGap > 3) {
            answer = String.fromCharCode(65 + darkest2.idx);
            confidence = Math.round(Math.min(80, 55 + minGap * 0.4));
          } else {
            answer = String.fromCharCode(65 + top.idx);
            confidence = Math.round(Math.min(60, 30 + contrastGap * 0.3));
          }
        }
        markedLetters.length = 0;
        markedLetters.push(answer);
      } else if (intensityMetric === 'minWithContrast' || useMinIntensity) {
        const minGap = secondDarkest.minVal - darkest.minVal;
        if (minGap > 5) {
          answer = String.fromCharCode(65 + darkest.idx);
          confidence = Math.round(Math.min(85, 60 + minGap * 0.5));
          markedLetters.length = 0;
          markedLetters.push(answer);
        } else {
          const rankedByDarkness = darknessScores
            .map((score, idx) => ({ score, idx }))
            .sort((a, b) => b.score - a.score);
          const topDark = rankedByDarkness[0];
          const secondDark = rankedByDarkness[1];
          const darkGap = topDark.score - secondDark.score;
          if (darkGap > 8) {
            answer = String.fromCharCode(65 + topDark.idx);
            confidence = Math.round(Math.min(90, 55 + darkGap * 0.3));
          } else {
            answer = String.fromCharCode(65 + topDark.idx);
            confidence = Math.round(Math.min(60, Math.max(20, topDark.score * 0.4)));
          }
          markedLetters.length = 0;
          markedLetters.push(answer);
        }
      } else if (markedLetters.length === 1) {
        const markedIdx = markedLetters[0].charCodeAt(0) - 65;
        const topMin = rankedByMinIntensity[0].minVal;
        const secondMin = rankedByMinIntensity[1]?.minVal ?? topMin;
        const minTied = topMin === secondMin;
        if (minTied || rankedByMinIntensity[0].idx !== markedIdx) {
          if (minTied) {
            answer = String.fromCharCode(65 + darkest.idx);
            confidence = Math.round(Math.min(60, Math.max(20, darkest.darkness * 0.4)));
            markedLetters.length = 0;
            markedLetters.push(answer);
          } else {
            const minGap = secondMin - topMin;
            if (minGap > 5) {
              answer = String.fromCharCode(65 + darkest.idx);
              confidence = Math.round(Math.min(85, 60 + minGap * 0.5));
              markedLetters.length = 0;
              markedLetters.push(answer);
            } else {
              answer = markedLetters[0];
              confidence = Math.round(Math.min(95, 50 + darknessScores[markedIdx] * 0.4));
            }
          }
        } else {
          answer = markedLetters[0];
          confidence = Math.round(Math.min(95, 50 + darknessScores[markedIdx] * 0.4));
        }
      } else if (markedLetters.length === 0) {
        // FIX: When no answer is clearly marked (all bubbles similar intensity),
        // return empty string instead of defaulting to 'A'
        if (range < 3 || allSame) {
          answer = '';
          confidence = 0;
        } else {
          answer = String.fromCharCode(65 + darkest.idx);
          const minGap = secondDarkest.minVal - darkest.minVal;
          confidence = minGap > 3
            ? Math.round(Math.min(90, 60 + minGap * 0.5))
            : Math.round(Math.min(50, Math.max(10, darkest.darkness * 0.3)));
          markedLetters.push(answer);
        }
      } else {
        answer = String.fromCharCode(65 + darkest.idx);
        const minGap = secondDarkest.minVal - darkest.minVal;
        confidence = minGap > 3
          ? Math.round(Math.min(80, 55 + minGap * 0.4))
          : Math.round(Math.min(60, Math.max(15, darkest.darkness * 0.35)));
        markedLetters.length = 0;
        markedLetters.push(answer);
      }

      // Keep unresolved, low-confidence multiple shades invalid. A high-
      // confidence geometric winner can resolve ring/print artefacts that
      // otherwise look like a second mark in a raw darkness pass.
      let hasUnresolvedAmbiguity = shadeMarks.length > 1 && confidence < 65;
      if (hasUnresolvedAmbiguity) {
        answer = '';
        confidence = 0;
        markedLetters.length = 0;
        markedLetters.push(...shadeMarks);
      }

      // ONNX is a readability check on the actual bubble patch. It can raise
      // confidence on agreement; a decisive disagreement makes the row
      // ungradable instead of allowing a high-confidence grid guess through.
      if (useOnnx && onnxProbabilities) {
        const rankedOnnx = onnxProbabilities
          .map((probability, idx) => ({ probability, idx }))
          .sort((a, b) => b.probability - a.probability);
        const top = rankedOnnx[0];
        const second = rankedOnnx[1];
        const onnxAnswer = String.fromCharCode(65 + top.idx);
        const onnxDecisive = top.probability >= 0.85
          && top.probability - second.probability >= 0.50;
        if (answer && shadeMarks.length === 1 && onnxAnswer === answer && onnxDecisive) {
          confidence = Math.max(confidence, Math.round(top.probability * 100));
        } else if (answer && onnxDecisive && onnxAnswer !== answer) {
          hasUnresolvedAmbiguity = true;
          shadeMarks.push(onnxAnswer);
          answer = '';
          confidence = 0;
          markedLetters.length = 0;
          markedLetters.push(...shadeMarks);
        }
      }

      allMarkedLetters.push(hasUnresolvedAmbiguity ? shadeMarks : (answer ? [answer] : []));
      detectedAnswers.push(answer);
      confidenceScores.push(confidence);
    }

    return {
      detectedAnswers,
      confidenceScores,
      markedLetters: allMarkedLetters,
      details: {
        numQuestions,
        numChoices,
        gridCols,
        gridRows,
        blurScore: Number((blurScore * 100).toFixed(1)),
        geometryEvidenceUnreliable,
        averageConfidence: confidenceScores.length > 0
          ? parseFloat((confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length).toFixed(2))
          : 0
      }
    };
  } catch (error) {
    console.error('smartBubbleDetection error:', error);
    throw error;
  }
}

/**
 * ONNX-AIDED DIGIT RECOGNITION
 * Classifies individual digit patches using ONNX model for structured fields.
 */
async function recognizeDigitsWithOnnx(imageBuffer, regions) {
  if (!OnnxService.isAvailable()) return null;
  
  const results = [];
  for (const region of regions) {
    if (!region || region.w < 3 || region.h < 3) continue;
    try {
      const patchBuffer = await sharp(imageBuffer)
        .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
        .greyscale()
        .normalize()
        .sharpen({ sigma: 0.8 })
        .toBuffer();
      
      const result = await OnnxService.classifyDigit(patchBuffer);
      if (result) {
        results.push({
          ...result,
          region
        });
      }
    } catch (err) {
      // ignore individual region failures
    }
  }
  return results.length > 0 ? results : null;
}

/**
 * ONNX-AIDED TEXT RECOGNITION
 * Runs the text recognizer on cropped regions and returns decoded text.
 */
async function recognizeTextWithOnnx(imageBuffer, regions) {
  if (!OnnxService.isAvailable()) return null;
  
  const results = [];
  for (const region of regions) {
    if (!region || region.w < 3 || region.h < 3) continue;
    try {
      const cropBuffer = await sharp(imageBuffer)
        .extract({ left: region.x, top: region.y, width: region.w, height: region.h })
        .greyscale()
        .normalize()
        .sharpen({ sigma: 0.8 })
        .toBuffer();
      
      const result = await OnnxService.recognizeText(cropBuffer);
      if (result && result.text) {
        results.push({
          text: result.text,
          confidence: result.confidence,
          region,
        });
      }
    } catch (err) {
      // ignore individual region failures
    }
  }
  return results.length > 0 ? results : null;
}

/**
 * ENHANCED STUDENT INFO EXTRACTION
 */
async function enhancedExtractStudentInfo(imageBuffer, studentDatabase = null) {
  try {
    const text = await recognizeWithTesseract(imageBuffer, {
      psm: Tesseract.PSM ? Tesseract.PSM.AUTO : 3,
    });

    const lines = text.split('\n').map(l => l.trim()).filter(l => l && l.length > 0);
    
    let studentNumber = '';
    let studentName = '';
    let sequentialNumber = null;
    let examDate = null;
    const allNumbers = [];
    const allNames = [];

    const sequentialPattern = /(\d{2}[-\/\s]\d{2}[-\/\s]\d{4})(?:[-\/\s](\d+))?/;
    const numberPatterns = [
      /[Ss](?:tudent)?\s*(?:no|no\.|number|#|id)[\s:]*([A-Za-z]?\d{4}[-]?\d{3})/i,
      /\b([A-Za-z]?\d{4}[-]?\d{3})\b/,
      /[Ii][Dd][\s:]*([A-Za-z]?\d{4}[-]?\d{3})/i,
      /(?:student|pupil|candidate)[\s:]*([A-Za-z]?\d{4}[-]?\d{3})/i,
    ];

    function normalizeOcrLine(line) {
      return line
        .replace(/\bI\b/g, '1')
        .replace(/\bO\b/g, '0')
        .replace(/(?<=\d)O/g, '0')
        .replace(/(?<=\d)I/g, '1')
        .replace(/[lL]/g, '1')
        .replace(/[sS]/g, '5')
        .replace(/[bB]/g, '8')
        .replace(/[zZ]/g, '2')
        .replace(/[gG]/g, '9')
        .replace(/[tT]/g, '7');
    }
    
    for (const line of lines) {
      const normalizedLine = normalizeOcrLine(line);
      const seqMatch = normalizedLine.match(sequentialPattern);
      if (seqMatch) {
        examDate = seqMatch[1];
        sequentialNumber = parseInt(seqMatch[2]);
        const fullId = seqMatch[0];
        if (!allNumbers.includes(fullId)) {
          allNumbers.push(fullId);
        }
        if (!studentNumber) {
          studentNumber = fullId;
        }
        continue;
      }

      for (const pattern of numberPatterns) {
        const match = normalizedLine.match(pattern);
        if (match && match[1]) {
          const number = match[1].replace(/\s/g, '');
          if (!allNumbers.includes(number)) {
            allNumbers.push(number);
          }
          if (!studentNumber && isValidStudentNumber(number)) {
            studentNumber = number;
          }
        }
      }
    }

    const namePatterns = [
      /(?:name|student|pupil)[\s:]*([A-Za-z\s'-]+?)(?:\n|$|,|;)/i,
      /^(?:[A-Z][a-z]*(?:\s+[A-Z][a-z]*)+)\s*$/,
      /(?:name|student|pupil)[\s:]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    ];

    for (const line of lines) {
      for (const pattern of namePatterns) {
        const match = line.match(pattern);
        if (match && match[1]) {
          const name = sanitizeNameString(match[1]);
          if (name && name.length > 2 && !allNames.includes(name)) {
            allNames.push(name);
          }
        }
      }
    }

    if (OnnxService.isAvailable()) {
      try {
        const img = sharp(imageBuffer);
        const metadata = await img.metadata();
        const width = metadata.width;
        const height = metadata.height;
        
        const idRegions = [
          { x: Math.floor(width * 0.05), y: Math.floor(height * 0.55), w: Math.floor(width * 0.35), h: Math.floor(height * 0.10) },
        ];
        const nameRegions = [
          { x: Math.floor(width * 0.40), y: Math.floor(height * 0.55), w: Math.floor(width * 0.50), h: Math.floor(height * 0.10) },
        ];
        
        const onnxIdResults = await recognizeDigitsWithOnnx(imageBuffer, idRegions);
        if (onnxIdResults && onnxIdResults.length > 0) {
          const best = onnxIdResults.reduce((a, b) => a.confidence > b.confidence ? a : b);
          if (best.confidence > 70 && best.digit !== undefined) {
            const onnxDigits = onnxIdResults.map(r => String(r.digit)).join('');
            if (!studentNumber || best.confidence > (calculateExtractionConfidence(studentNumber, studentName, text) * 0.01 * 100)) {
              studentNumber = onnxDigits;
            }
          }
        }
        
        const onnxNameResults = await recognizeTextWithOnnx(imageBuffer, nameRegions);
        if (onnxNameResults && onnxNameResults.length > 0) {
          const best = onnxNameResults.reduce((a, b) => a.confidence > b.confidence ? a : b);
          if (best.confidence > 60 && best.text) {
            const cleaned = sanitizeNameString(best.text);
            if (cleaned && cleaned.length > 2) {
              if (!studentName || best.confidence > (calculateExtractionConfidence(studentNumber, studentName, text) * 0.01 * 100 + 10)) {
                studentName = cleaned;
              }
            }
          }
        }
      } catch (onnxErr) {
        console.warn('ONNX text augmentation failed, using Tesseract only:', onnxErr.message);
      }
    }

    if (allNumbers.length > 0 && !studentNumber) {
      studentNumber = allNumbers[0];
    }

    if (allNames.length > 0 && !studentName) {
      studentName = allNames.reduce((a, b) => a.length > b.length ? a : b);
    }

    return {
      studentNumber: studentNumber || '',
      studentName: studentName || '',
      sequentialNumber: sequentialNumber,
      examDate: examDate,
      rawText: text,
      confidence: calculateExtractionConfidence(studentNumber, studentName, text),
      rawExtractions: { numbers: allNumbers, names: allNames },
      processingDetails: {
        linesProcessed: lines.length,
        numbersFound: allNumbers.length,
        namesFound: allNames.length
      }
    };
  } catch (error) {
    console.error('Enhanced OCR error:', error);
    return {
      studentNumber: '',
      studentName: '',
      sequentialNumber: null,
      examDate: null,
      rawText: '',
      confidence: 0,
      error: error.message
    };
  }
}

function isValidStudentNumber(number) {
  if (!number) return false;
  const pattern = /^[A-Za-z]?\d{4}-?\d{3}$/;
  return pattern.test(number);
}

function sanitizeNameString(name) {
  if (!name) return '';
  name = name.replace(/\s+/g, ' ').trim();
  const cleanName = name
    .replace(/[^A-Za-z\s'-]/g, '')
    .replace(/^\s+|\s+$/g, '')
    .replace(/\s+/g, ' ');
  return cleanName;
}

function calculateExtractionConfidence(studentNumber, studentName, rawText) {
  let confidence = 0;
  if (studentNumber && isValidStudentNumber(studentNumber)) confidence += 40;
  else if (studentNumber) confidence += 20;
  if (studentName && studentName.length > 3) confidence += 30;
  else if (studentName) confidence += 10;
  if (studentNumber && studentName) confidence += 20;
  if (rawText.length > 100) confidence += 10;
  return Math.min(confidence, 100);
}

function levenshteinDistance(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(0));
  for (let i = 0; i <= len1; i++) matrix[0][i] = i;
  for (let j = 0; j <= len2; j++) matrix[j][0] = j;
  for (let j = 1; j <= len2; j++) {
    for (let i = 1; i <= len1; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(matrix[j][i - 1] + 1, matrix[j - 1][i] + 1, matrix[j - 1][i - 1] + indicator);
    }
  }
  return matrix[len2][len1];
}

function findBestStudentMatch(extractedName, extractedNumber, databaseStudents) {
  if (!databaseStudents || databaseStudents.length === 0) return null;
  let bestMatch = null;
  let bestScore = Infinity;
  if (extractedNumber) {
    const numberMatch = databaseStudents.find(s => s.student_number === extractedNumber || s.student_number === extractedNumber.replace('-', ''));
    if (numberMatch) return { ...numberMatch, matchType: 'number_exact', confidence: 99 };
  }
  if (extractedName) {
    const extractedNameLower = extractedName.toLowerCase();
    for (const student of databaseStudents) {
      const fullName = `${student.first_name} ${student.last_name}`.toLowerCase();
      const distance = levenshteinDistance(extractedNameLower, fullName);
      if (distance < bestScore) {
        bestScore = distance;
        const maxDistance = Math.max(extractedNameLower.length, fullName.length);
        const matchConfidence = Math.max(0, 100 - (distance / maxDistance) * 100);
        if (matchConfidence > 60) bestMatch = { ...student, matchType: 'name_fuzzy', confidence: Math.round(matchConfidence) };
      }
    }
  }
  return bestMatch;
}

function createScanReport(ocrResult, bubbleResult, gradingResult) {
  return {
    ocrAnalysis: {
      studentNumber: ocrResult.studentNumber,
      studentName: ocrResult.studentName,
      confidence: ocrResult.confidence,
      details: ocrResult.processingDetails,
      rawExtractions: ocrResult.rawExtractions
    },
    bubbleAnalysis: {
      questionsDetected: bubbleResult.detectedAnswers.length,
      averageConfidence: bubbleResult.details.averageConfidence,
      detectedAnswers: bubbleResult.detectedAnswers,
      confidencePerQuestion: bubbleResult.confidenceScores
    },
    gradingAnalysis: gradingResult ? {
      totalScore: gradingResult.totalScore,
      percentage: gradingResult.percentage,
      correctAnswers: gradingResult.correctCount,
      totalQuestions: gradingResult.totalQuestions,
      incorrectAnswers: gradingResult.totalQuestions - gradingResult.correctCount
    } : null,
    qualityMetrics: {
      ocrQuality: ocrResult.confidence,
      bubbleDetectionQuality: bubbleResult.details.averageConfidence,
      overallQuality: calculateOverallQuality(ocrResult, bubbleResult)
    }
  };
}

function calculateOverallQuality(ocrResult, bubbleResult) {
  const weights = { ocr: 0.3, bubbles: 0.7 };
  const score = (ocrResult.confidence * weights.ocr) + (parseFloat(bubbleResult.details.averageConfidence) * weights.bubbles);
  return Math.round(score);
}

/**
 * OCR-BASED ANSWER PATTERN DETECTION
 * Detects lines like: "1. A B C D" or "1. A C D" or "12. ABCD"
 */
async function detectAnswersFromOCRPattern(imageBuffer, numQuestions = 50, options) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();
    const width = metadata.width;
    const height = metadata.height;

    const topMargin    = Math.floor(height * 0.05);
    const bottomMargin = height - Math.floor(height * 0.05);
    const leftMargin   = Math.floor(width * 0.05);
    const rightMargin  = Math.floor(width * 0.95);
    const cropWidth = rightMargin - leftMargin;
    const cropHeight = bottomMargin - topMargin;

    const ocrReadyBuffer = await preprocessForOcrReadability(
      await img.extract({ left: leftMargin, top: topMargin, width: cropWidth, height: cropHeight }).toBuffer()
    );

    const psmModes = [
      Tesseract.PSM ? Tesseract.PSM.SINGLE_COLUMN : 4,
      Tesseract.PSM ? Tesseract.PSM.AUTO : 3,
      Tesseract.PSM ? Tesseract.PSM.SINGLE_BLOCK : 6,
      Tesseract.PSM ? Tesseract.PSM.SINGLE_LINE : 7,
      Tesseract.PSM ? Tesseract.PSM.RAW_LINE : 13
    ].filter(Boolean);
    let bestText = '';
    let bestLineCount = 0;
    const ocrPromises = psmModes.map(psm =>
      recognizeWithTesseract(ocrReadyBuffer, { psm, whitelist: 'ABCDabcd0123456789' })
        .then(text => ({ text, psm, lineCount: (text || '').split('\n').filter(l => l.trim().length > 0).length }))
        .catch(() => ({ text: '', psm, lineCount: 0 }))
    );
    const ocrResults = await Promise.all(ocrPromises);
    for (const result of ocrResults) {
      if (result.lineCount > bestLineCount) {
        bestLineCount = result.lineCount;
        bestText = result.text;
      }
      if (bestLineCount >= Math.min(numQuestions, 10)) break;
    }

    const lines = (bestText || '').split('\n').map(l => l.trim()).filter(l => l && l.length > 0);
    const detectedAnswers = new Array(numQuestions).fill('');
    const confidenceScores = new Array(numQuestions).fill(0);

    const numberedPattern = /^(\d+)[.\s)]+([A-Da-d](?:\s+[A-Da-d])*)$/;
    const compactPattern = /^(\d+)[.\s)]+([A-Da-d]{2,4})$/;
    const loosePattern = /^(\d+)[^A-Da-d]*([A-Da-d][A-Da-d\s]*)$/;

    const raw = await img.greyscale().raw().toBuffer();
    const usableHeight = bottomMargin - topMargin;
    const usableWidth = rightMargin - leftMargin;

    let gridCols, gridRows;
    if (options && options.blocksPerRow && options.questionsPerBlock) {
      gridCols = options.blocksPerRow;
      gridRows = options.questionsPerBlock;
    } else {
      const aspectRatio = width / height;
      if (numQuestions <= 25) { gridCols = 1; gridRows = numQuestions; }
      else if (numQuestions <= 50) {
        if (aspectRatio > 1.4) { gridCols = 10; gridRows = 5; }
        else { gridCols = 2; gridRows = 25; }
      }
      else if (numQuestions <= 75) { gridCols = 3; gridRows = 25; }
      else if (numQuestions <= 100) { gridCols = 4; gridRows = 25; }
      else { gridRows = 25; gridCols = Math.ceil(numQuestions / gridRows); }
    }

    const cellWidth = usableWidth / gridCols;
    const regionHeight = usableHeight / gridRows;

    function measureBubbleAt(cx, cy, radius, minX, maxX, minY, maxY, bubbleSpacing) {
      const r = Math.max(4, Math.floor(radius));
      const patchR = Math.max(4, Math.min(
        Math.floor(radius * 2.5),
        bubbleSpacing != null ? Math.floor(bubbleSpacing * 0.8) : Infinity
      ));

      let darkestX = Math.floor(cx);
      let darkestY = Math.floor(cy);
      let darkestVal = 255;

      const searchLeft = Math.max(minX != null ? Math.floor(minX) : 0, Math.floor(cx) - Math.floor(patchR * 0.6));
      const searchRight = Math.min(maxX != null ? Math.floor(maxX) : width - 1, Math.floor(cx) + Math.floor(patchR * 0.6));
      const searchTop = Math.max(minY != null ? Math.floor(minY) : 0, Math.floor(cy) - patchR);
      const searchBottom = Math.min(maxY != null ? Math.floor(maxY) : height - 1, Math.floor(cy) + patchR);

      for (let py = searchTop; py <= searchBottom; py++) {
        for (let px = searchLeft; px <= searchRight; px++) {
          if (px < (minX != null ? Math.floor(minX) : 0) || px > (maxX != null ? Math.floor(maxX) : width - 1) || py < (minY != null ? Math.floor(minY) : 0) || py > (maxY != null ? Math.floor(maxY) : height - 1) || px !== Math.floor(px)) continue;
          const val = raw[py * width + px];
          if (val < darkestVal) {
            darkestVal = val;
            darkestX = px;
            darkestY = py;
          }
        }
      }

      let sum = 0, count = 0, darkCount = 0, veryDarkCount = 0, extremeDarkCount = 0, minVal = 255, maxVal = 0;
      const sampleR = Math.max(4, Math.floor(radius * 1.1));
      for (let dy = -sampleR; dy <= sampleR; dy++) {
        for (let dx = -sampleR; dx <= sampleR; dx++) {
          if (dx * dx + dy * dy > sampleR * sampleR) continue;
          const x = darkestX + dx;
          const y = darkestY + dy;
          if (x < (minX != null ? Math.floor(minX) : 0) || x > (maxX != null ? Math.floor(maxX) : width - 1) || y < (minY != null ? Math.floor(minY) : 0) || y > (maxY != null ? Math.floor(maxY) : height - 1) || x !== Math.floor(x)) continue;
          const val = raw[y * width + x];
          sum += val;
          count++;
          if (val < 140) darkCount++;
          if (val < 90) veryDarkCount++;
          if (val < 50) extremeDarkCount++;
          if (val < minVal) minVal = val;
          if (val > maxVal) maxVal = val;
        }
      }
      const avgIntensity = count ? sum / count : 255;
      const percentDark = count ? (darkCount / count) * 100 : 0;
      const veryDarkPercent = count ? (veryDarkCount / count) * 100 : 0;
      const extremeDarkPercent = count ? (extremeDarkCount / count) * 100 : 0;
      const contrast = maxVal - minVal;
      return { avgIntensity, percentDark, pixelCount: count, contrast, minIntensity: minVal, veryDarkPercent, extremeDarkPercent, darkestX, darkestY };
    }

    const ocrMarkedLetters = new Array(numQuestions).fill(0).map(() => []);

    for (const line of lines) {
      const match = line.match(numberedPattern) || line.match(compactPattern) || line.match(loosePattern);
      if (match) {
        const qNum = parseInt(match[1]);
        const answerPart = match[2].toUpperCase().replace(/\s/g, '');
        if (qNum >= 1 && qNum <= numQuestions && answerPart.length >= 1) {
          const counts = {};
          for (const ch of answerPart) { if ('ABCD'.includes(ch)) counts[ch] = (counts[ch] || 0) + 1; }
          const letters = Object.entries(counts);
          if (letters.length > 0) {
            letters.sort((a, b) => b[1] - a[1]);
            const answer = letters[0][0];
            const idx = qNum - 1;
            const col = Math.floor(idx / gridRows);
            const row = idx % gridRows;
            const cellLeft = leftMargin + col * cellWidth;
            const cellCenterY = topMargin + row * regionHeight + regionHeight / 2;
            const bubbleLeft = cellLeft + cellWidth * 0.30;
            const bubbleRight = cellLeft + cellWidth * 0.95;
            const bubbleTop = cellTop + regionHeight * 0.10;
            const bubbleBottom = cellTop + regionHeight * 0.90;
            const bubbleSpacing = (bubbleRight - bubbleLeft) / (4 + 1);
            const bubbleRadius = Math.max(2, Math.min(
              Math.floor(regionHeight * 0.22),
              Math.floor(bubbleSpacing * 0.6)
            ));
            const choices = ['A', 'B', 'C', 'D'];
            const intensities = choices.map((_, cIdx) => { const cx = bubbleLeft + bubbleSpacing * (cIdx + 1); return measureBubbleAt(cx, cellCenterY, bubbleRadius, bubbleLeft, bubbleRight, bubbleTop, bubbleBottom, bubbleSpacing); });
            const avgIntensities = intensities.map(m => m.avgIntensity);
            const ranked = avgIntensities.map((intensity, i) => ({ intensity, i, percentDark: intensities[i].percentDark })).sort((a, b) => a.intensity - b.intensity);
            const darkestLetter = choices[ranked[0].i];
            const secondDarkestIntensity = ranked[1].intensity;
            const gap = secondDarkestIntensity - ranked[0].intensity;
            const isMultiMark = ranked[0].intensity < 210 && gap < 10 && ranked[1].intensity < 215;
            const othersSum = avgIntensities.reduce((a, b) => a + b, 0) - ranked[0].intensity;
            const avgOther = othersSum / (choices.length - 1);
            const relativeDarkening = avgOther - ranked[0].intensity;
            const confirmed = !isMultiMark && darkestLetter === answer && gap > 3 && ranked[0].intensity < 200;
            const bubbleConfirm = !isMultiMark && relativeDarkening > 5 && gap > 2;
            const finalAnswer = isMultiMark ? '' : ((confirmed || bubbleConfirm) ? darkestLetter : darkestLetter);
            detectedAnswers[idx] = finalAnswer;
            confidenceScores[idx] = isMultiMark ? 0 : ((confirmed || bubbleConfirm) ? 85 : 60);
          }
        }
      }
    }

    return { detectedAnswers, confidenceScores, markedLetters: ocrMarkedLetters, details: { numQuestions, validAnswers: detectedAnswers.filter(a => a !== '').length, source: 'ocr_pattern' } };
  } catch (error) {
    console.error('OCR pattern detection error:', error);
    return null;
  }
}

/**
 * HYBRID DETECTION (FIXED v3): OCR pattern + bubble darkness
 *
 * FIX: Trust bubble detection primarily. OCR is only used as tiebreaker.
 * Bubble detection now uses statistical z-score based analysis.
 * Automatically tries multiple intensity metrics and picks the best result.
 */
// Form-independent reader for a complete 50-question sheet. It derives the
// two blocks and four choices from the solid, circular shaded marks rather
// than projecting a grid from a different printed form.
async function detectCompleteFilledForm(imageBuffer) {
  try {
    const { data, info } = await sharp(imageBuffer).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    if (width < 500 || height < 900) return null;
    const top = Math.floor(height * 0.13), bottom = Math.floor(height * 0.88);
    const seen = new Uint8Array(width * height), blobs = [];
    for (let y = top; y < bottom; y++) for (let x = Math.floor(width * 0.08); x < Math.floor(width * 0.92); x++) {
      const start = y * width + x;
      if (seen[start] || data[start] > 42) continue;
      const queue = [start]; seen[start] = 1;
      let count = 0, sx = 0, sy = 0, lx = x, hx = x, ly = y, hy = y;
      for (let i = 0; i < queue.length; i++) {
        const index = queue[i], px = index % width, py = Math.floor(index / width);
        count++; sx += px; sy += py; lx = Math.min(lx, px); hx = Math.max(hx, px); ly = Math.min(ly, py); hy = Math.max(hy, py);
        for (const next of [index - 1, index + 1, index - width, index + width]) {
          const nx = next % width, ny = Math.floor(next / width);
          if (nx < 0 || nx >= width || ny < top || ny >= bottom || seen[next] || data[next] > 42) continue;
          seen[next] = 1; queue.push(next);
        }
      }
      const bw = hx - lx + 1, bh = hy - ly + 1, fill = count / Math.max(1, bw * bh);
      if (count >= 30 && bw >= 10 && bw <= 70 && bh >= 10 && bh <= 70 && bw / bh >= 0.60 && bw / bh <= 1.65 && fill >= 0.32) blobs.push({ x: sx / count, y: sy / count });
    }
    // A light fill can be missed by the solid-blob pass.  Thirty-six strong
    // marks (18 per block) are enough to fit the printed 25x4 lattice; the
    // remaining rows are then measured at their inferred ring centres.
    if (blobs.length < 36 || blobs.length > 70) { console.log(`[FORM-OMR] Direct reader found ${blobs.length} filled-mark candidates.`); return null; }
    const sortedX = [...blobs].sort((a, b) => a.x - b.x);
    let split = -1, widest = -Infinity;
    for (let i = 1; i < sortedX.length; i++) if (sortedX[i].x - sortedX[i - 1].x > widest) { widest = sortedX[i].x - sortedX[i - 1].x; split = i; }
    if (split < 18 || sortedX.length - split < 18 || widest < width * 0.08) return null;
    const answers = [];
    for (const marks of [sortedX.slice(0, split), sortedX.slice(split)]) {
      const byY = [...marks].sort((a, b) => a.y - b.y);
      const yGaps = byY.slice(1).map((mark, i) => mark.y - byY[i].y).filter(gap => gap > 8).sort((a, b) => a - b);
      const yStep = yGaps[Math.floor(yGaps.length / 2)];
      if (!yStep) return null;
      let centers = Array.from({ length: 4 }, (_, i) => marks[0].x + (marks[marks.length - 1].x - marks[0].x) * i / 3), groups = [];
      for (let pass = 0; pass < 16; pass++) {
        groups = Array.from({ length: 4 }, () => []);
        for (const mark of marks) { let chosen = 0; for (let i = 1; i < 4; i++) if (Math.abs(mark.x - centers[i]) < Math.abs(mark.x - centers[chosen])) chosen = i; groups[chosen].push(mark); }
        const next = centers.map((center, i) => groups[i].length ? groups[i].reduce((sum, mark) => sum + mark.x, 0) / groups[i].length : center);
        if (next.every((center, i) => Math.abs(center - centers[i]) < 0.15)) { centers = next; break; } centers = next;
      }
      const order = centers.map((x, i) => ({ x, count: groups[i].length })).sort((a, b) => a.x - b.x);
      const gaps = order.slice(1).map((item, i) => item.x - order[i].x), step = [...gaps].sort((a, b) => a - b)[1];
      if (order.some(item => item.count < 1) || gaps.some(gap => gap < step * 0.65 || gap > step * 1.35)) return null;
      // Fit an offset for the 25 equally spaced printed rows, allowing for
      // missing strong components at either end of the column.
      let bestOffset = null, bestScore = -Infinity;
      for (const mark of byY) for (let row = 0; row < 25; row++) {
        const offset = mark.y - row * yStep;
        let score = 0;
        for (const probe of byY) {
          const nearest = Math.round((probe.y - offset) / yStep);
          if (nearest >= 0 && nearest < 25 && Math.abs(probe.y - (offset + nearest * yStep)) < yStep * 0.34) score++;
        }
        if (score > bestScore) { bestScore = score; bestOffset = offset; }
      }
      if (bestScore < 18) return null;
      const radius = Math.max(7, Math.min(18, Math.round(step * 0.28)));
      const meanAt = (cx, cy) => {
        let sum = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
          if (dx * dx + dy * dy > radius * radius) continue;
          const x = Math.round(cx + dx), y = Math.round(cy + dy);
          if (x >= 0 && x < width && y >= 0 && y < height) { sum += data[y * width + x]; count++; }
        }
        return count ? sum / count : 255;
      };
      for (let row = 0; row < 25; row++) {
        const y = bestOffset + row * yStep;
        const levels = order.map(item => meanAt(item.x, y));
        const choice = levels.indexOf(Math.min(...levels));
        answers.push(String.fromCharCode(65 + choice));
      }
    }
    const inferredGeometry = blobs.length !== 50;
    console.log(`[FORM-OMR] Read 50 bubble positions from the rectified form (${blobs.length} solid marks; inferred geometry=${inferredGeometry}).`);
    // Do not turn an inferred lattice into a grade. It is useful to prove
    // that a page was found, but it cannot establish A/B/C/D identity on a
    // different printed template without fiducials or a verified template.
    return { detectedAnswers: answers, confidenceScores: Array(50).fill(inferredGeometry ? 55 : 94), markedLetters: answers.map(answer => [answer]), details: { numQuestions: 50, averageConfidence: inferredGeometry ? 55 : 94, blurScore: 0, source: 'form-solid-marks', geometryEvidenceUnreliable: inferredGeometry } };
  } catch (error) { console.warn('[FORM-OMR] Direct filled-mark reader skipped:', error.message); return null; }
}

// The adaptive reader establishes bubble geometry from the current sheet.
// Validate its selected bubbles with the trained ONNX model, but never let
// that model silently rewrite an answer: a decisive disagreement is retained
// as an ambiguous response so it scores zero and remains reviewable.
async function verifyAdaptiveAnswersWithAi(imageBuffer, adaptive, enabled = true) {
  if (!enabled || !adaptive?.success || !Array.isArray(adaptive.answers)
      || !Array.isArray(adaptive.centers) || adaptive.centers.length !== adaptive.answers.length
      || !OnnxService.isAvailable()) return adaptive;

  try {
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (!width || !height) return adaptive;

    const answers = [...adaptive.answers];
    const confidenceScores = [...(adaptive.confidenceScores || [])];
    const markedLetters = Array.isArray(adaptive.markedLetters)
      ? adaptive.markedLetters.map(row => Array.isArray(row) ? [...row] : [])
      : answers.map(answer => answer ? [answer] : []);
    let checkedRows = 0, agreements = 0, withheldRows = 0;

    for (let row = 0; row < answers.length; row++) {
      const answer = String(answers[row] || '').toUpperCase();
      const centers = adaptive.centers[row];
      const selected = answer.charCodeAt(0) - 65;
      if (selected < 0 || selected > 3 || !Array.isArray(centers) || centers.length < 4) continue;

      const gaps = [1, 2, 3].map(index => Math.abs(Number(centers[index][0]) - Number(centers[index - 1][0]))).filter(Boolean);
      const spacing = gaps.length ? Math.min(...gaps) : 0;
      const radius = Math.max(7, Math.min(26, spacing ? spacing * 0.27 : 14));
      const probabilities = await Promise.all(centers.slice(0, 4).map(async ([x, y]) => {
        const patch = await extractBubblePatch(imageBuffer, Number(x), Number(y), radius, width, height);
        return patch ? (await OnnxService.getBubbleMarkedProbability(patch)) ?? 0 : 0;
      }));
      const ranked = probabilities.map((probability, index) => ({ probability, index })).sort((a, b) => b.probability - a.probability);
      const [top, second] = ranked;
      checkedRows++;

      if (top.index === selected && top.probability >= 0.70 && top.probability - second.probability >= 0.18) {
        agreements++;
        confidenceScores[row] = Math.max(Number(confidenceScores[row] || 0), Math.round(top.probability * 100));
      } else if (top.index !== selected && top.probability >= 0.92 && top.probability - second.probability >= 0.55) {
        answers[row] = '';
        confidenceScores[row] = 0;
        markedLetters[row] = [...new Set([answer, String.fromCharCode(65 + top.index)])];
        withheldRows++;
      }
    }

    return {
      ...adaptive,
      answers,
      confidenceScores,
      markedLetters,
      averageConfidence: confidenceScores.length
        ? Number((confidenceScores.reduce((sum, value) => sum + Number(value || 0), 0) / confidenceScores.length).toFixed(2)) : 0,
      aiVerification: { model: 'onnx-bubble-classifier', checkedRows, agreements, withheldRows },
    };
  } catch (error) {
    console.warn('[AI-OMR] ONNX verification skipped:', error.message);
    return adaptive;
  }
}

async function hybridDetectAnswers(imageBuffer, answerKey, numQuestions = 50, options) {
  // Support the long-standing three-argument call form
  // (buffer, answerKey, options).  The public scanner endpoints used that
  // form, which previously caused the supplied layout to be silently ignored.
  if (numQuestions && typeof numQuestions === 'object' && options === undefined) {
    options = numQuestions;
    numQuestions = 50;
  }
  const cleanKey = (answerKey || '').replace(/\s/g, '');
  const actualNumQuestions = cleanKey.length || numQuestions;
  // Standard 50-question sheets must be derived from the current capture.
  // Historical allA/allB/allC/allD geometry is intentionally disabled.
  const verifiedGrid = null;
  if (verifiedGrid?.verifiedGeometry) {
    const baseOptions = {
      ...options,
      blocksPerRow: 2,
      questionsPerBlock: 25,
      numChoices: 4,
      formLayout: 'acadcheck-50',
      useOnnx: true,
    };
    // Average fill is robust against isolated pen/paper specks.  The
    // min-with-contrast pass is used only when average fill found no answer,
    // which recovers faint but genuinely shaded bubbles without overriding a
    // confident primary selection.
    const result = await smartBubbleDetection(imageBuffer, answerKey, {
      ...baseOptions,
      intensityMetric: 'avg',
    });
    const faintMarkFallback = await smartBubbleDetection(imageBuffer, answerKey, {
      ...baseOptions,
      intensityMetric: 'minWithContrast',
    });
    const minimumPass = await smartBubbleDetection(imageBuffer, answerKey, {
      ...baseOptions,
      intensityMetric: 'min',
    });
    for (let i = 0; i < result.detectedAnswers.length; i++) {
      const primaryAnswer = result.detectedAnswers[i];
      const contrastAnswer = faintMarkFallback.detectedAnswers[i];
      const minimumAnswer = minimumPass.detectedAnswers[i];
      const primaryConfidence = Number(result.confidenceScores[i] || 0);
      const contrastConfidence = Number(faintMarkFallback.confidenceScores[i] || 0);
      const minimumConfidence = Number(minimumPass.confidenceScores[i] || 0);
      let selectedAnswer = primaryAnswer || contrastAnswer || minimumAnswer;
      // minWithContrast and min are one related metric family. Let their
      // agreement overturn average darkness only when the primary result is
      // itself weak; this recovers faint marks without double-counting two
      // correlated votes against a strong primary reading.
      if (primaryAnswer
        && contrastAnswer
        && contrastAnswer === minimumAnswer
        && contrastAnswer !== primaryAnswer
        && primaryConfidence < 80
        && Math.max(contrastConfidence, minimumConfidence) + 5 >= primaryConfidence) {
        selectedAnswer = contrastAnswer;
      }
      const passes = [result, faintMarkFallback, minimumPass];
      const supporting = passes
        .map(pass => ({
          answer: pass.detectedAnswers[i],
          confidence: Number(pass.confidenceScores[i] || 0),
          marked: pass.markedLetters[i],
        }))
        .filter(pass => pass.answer === selectedAnswer)
        .sort((a, b) => b.confidence - a.confidence);
      if (selectedAnswer && supporting.length) {
        result.detectedAnswers[i] = selectedAnswer;
        result.confidenceScores[i] = supporting[0].confidence;
        result.markedLetters[i] = supporting[0].marked;
      }
    }
    result.details.averageConfidence = Number((result.confidenceScores.reduce((sum, value) => sum + value, 0) / Math.max(1, result.confidenceScores.length)).toFixed(2));
    return {
      ...result,
      details: {
        ...result.details,
        source: 'verified-grid',
        selectedMetric: 'confidence-aware-metric-consensus',
        reference: verifiedGrid.reference,
        referenceSimilarity: Number(verifiedGrid.similarity || 0),
      },
    };
  }

  if (actualNumQuestions === 50 && options?.formLayout === 'acadcheck-50') {
    let adaptive = await detectAdaptiveForm(imageBuffer, {
      // The persistent worker invokes ONNX only for uncertain rows and does so
      // in one batch. It is therefore safe in the live path; decisive OpenCV
      // rows never pay for model inference.
      useCnn: options?.verifyWithAi !== false,
      includeDiagnostics: options?.includeDiagnostics === true,
    });
    if (adaptive?.source === 'fast-hybrid-grid'
      && adaptive.success
      && adaptive.geometryVerified === true
      && Array.isArray(adaptive.answers)
      && adaptive.answers.length === 50
      && Array.isArray(adaptive.markedLetters)
      && adaptive.markedLetters.length === 50) {
      console.log(
        `[FAST-OMR] Read 50 rows in ${Number(adaptive.processingMs || 0).toFixed(1)} ms `
        + `(${adaptive.blankRows || 0} blank, ${adaptive.multipleRows || 0} multiple, `
        + `${adaptive.uncertainRows || 0} uncertain).`
      );
      return {
        detectedAnswers: adaptive.answers,
        confidenceScores: adaptive.confidenceScores || Array(50).fill(0),
        markedLetters: adaptive.markedLetters,
        details: {
          numQuestions: 50,
          formLayout: adaptive.formLayout || 'acadcheck-50-v1',
          averageConfidence: Number(adaptive.averageConfidence || 0),
          geometryConfidence: Number(adaptive.geometryConfidence || 0),
          blurScore: 0,
          source: 'fast-hybrid-grid',
          currentSheetGeometry: true,
          geometryEvidenceUnreliable: false,
          multiMarkCapable: true,
          partialMarkCapable: true,
          rowStates: adaptive.rowStates || [],
          blankRows: Number(adaptive.blankRows || 0),
          ambiguousRows: Number(adaptive.multipleRows || 0),
          multipleRows: Number(adaptive.multipleRows || 0),
          uncertainRows: Number(adaptive.uncertainRows || 0),
          uncertainRowNumbers: adaptive.uncertainRowNumbers || [],
          markedRows: Number(adaptive.markedRows || 0),
          processingMs: Number(adaptive.processingMs || 0),
          stagesMs: adaptive.stagesMs || {},
          placement: adaptive.placement || null,
          sheetFingerprint: adaptive.sheetFingerprint || null,
          grid: adaptive.grid || null,
          locator: adaptive.locator || null,
          aiVerification: adaptive.aiVerification || null,
        },
      };
    }
    if (adaptive?.source === 'fast-hybrid-grid-rejected'
      || adaptive?.source === 'fast-hybrid-grid-error') {
      return {
        detectedAnswers: [],
        confidenceScores: [],
        markedLetters: [],
        details: {
          numQuestions: 50,
          averageConfidence: 0,
          geometryConfidence: 0,
          blurScore: 0,
          source: adaptive.source,
          currentSheetGeometry: false,
          geometryEvidenceUnreliable: true,
          processingMs: Number(adaptive.processingMs || 0),
          stagesMs: adaptive.stagesMs || {},
          placement: adaptive.placement || null,
          rejectionReason: adaptive.reason || 'Answer-sheet geometry could not be verified',
        },
      };
    }
    // Compatibility for old detector results during a rolling deployment.
    // The normal worker never reaches this per-patch verifier.
    adaptive = await verifyAdaptiveAnswersWithAi(
      imageBuffer, adaptive, options?.fastMode !== true && options?.verifyWithAi !== false
    );
    // Only the component reader has enough evidence to assign A-D on an
    // unregistered capture. The older Hough diagnostic can find a bubble-like
    // lattice, but it cannot safely establish the printed choice identities.
    if (adaptive?.source === 'adaptive-solid-mark-grid'
      && adaptive.success
      && Array.isArray(adaptive.answers)
      && adaptive.answers.length === 50) {
      console.log(`[ADAPTIVE-OMR] Read 50 answers from page components (${adaptive.averageConfidence.toFixed(1)}% confidence).`);
      return {
        detectedAnswers: adaptive.answers,
        confidenceScores: adaptive.confidenceScores || Array(50).fill(adaptive.averageConfidence || 0),
        markedLetters: Array.isArray(adaptive.markedLetters)
          ? adaptive.markedLetters
          : adaptive.answers.map(answer => answer ? [answer] : []),
        details: {
          numQuestions: 50,
          averageConfidence: Number(adaptive.averageConfidence || 0),
          blurScore: 0,
          source: 'adaptive-solid-mark-grid',
          currentSheetGeometry: true,
          geometryEvidenceUnreliable: false,
          componentThreshold: adaptive.componentThreshold,
          componentMinArea: adaptive.componentMinArea,
          rowRegularity: adaptive.rowRegularity,
          aiVerification: adaptive.aiVerification || null,
        },
      };
    }
    if (adaptive?.source === 'adaptive-multi-mark-grid'
      && adaptive.success
      && Array.isArray(adaptive.answers)
      && adaptive.answers.length === 50
      && Array.isArray(adaptive.markedLetters)
      && adaptive.markedLetters.length === 50) {
      console.log(`[ADAPTIVE-OMR] Read 50 rows with ${adaptive.ambiguousRows} multi-mark row(s) (${adaptive.averageConfidence.toFixed(1)}% confidence).`);
      return {
        detectedAnswers: adaptive.answers,
        confidenceScores: adaptive.confidenceScores,
        markedLetters: adaptive.markedLetters,
        details: {
          numQuestions: 50,
          averageConfidence: Number(adaptive.averageConfidence || 0),
          blurScore: 0,
          source: 'adaptive-multi-mark-grid',
          currentSheetGeometry: true,
          geometryEvidenceUnreliable: false,
          multiMarkCapable: true,
          ambiguousRows: Number(adaptive.ambiguousRows || 0),
          componentThreshold: adaptive.componentThreshold,
          componentMinArea: adaptive.componentMinArea,
          aiVerification: adaptive.aiVerification || null,
        },
      };
    }
    if (adaptive?.source === 'adaptive-partial-mark-grid'
      && adaptive.success
      // Permit genuinely partial response sheets only when the current page
      // itself supplied a strong printed-ring lattice. This accepts a clean
      // 24/50 form while still rejecting the earlier 4/50 false-blank reads
      // caused by a drifting grid.
      && (adaptive.ringGeometryVerified === true
        ? Number(adaptive.latticeSupport || 0) >= 95
        : adaptive.componentGeometryVerified === true)
      && Number(adaptive.markedRows || 0) >= 10
      && Array.isArray(adaptive.answers)
      && adaptive.answers.length === 50
      && Array.isArray(adaptive.markedLetters)
      && adaptive.markedLetters.length === 50) {
      console.log(`[ADAPTIVE-OMR] Read partial 50-row form: ${adaptive.markedRows} marked, ${adaptive.ambiguousRows} multi-mark (${adaptive.averageConfidence.toFixed(1)}% confidence).`);
      return {
        detectedAnswers: adaptive.answers,
        confidenceScores: adaptive.confidenceScores,
        markedLetters: adaptive.markedLetters,
        details: {
          numQuestions: 50,
          averageConfidence: Number(adaptive.averageConfidence || 0),
          blurScore: 0,
          source: 'adaptive-partial-mark-grid',
          currentSheetGeometry: true,
          geometryEvidenceUnreliable: false,
          partialMarkCapable: true,
          ringGeometryVerified: adaptive.ringGeometryVerified === true,
          componentGeometryVerified: adaptive.componentGeometryVerified === true,
          ringsDetected: Number(adaptive.ringsDetected || 0),
          latticeSupport: Number(adaptive.latticeSupport || 0),
          ambiguousRows: Number(adaptive.ambiguousRows || 0),
          markedRows: Number(adaptive.markedRows || 0),
          aiVerification: adaptive.aiVerification || null,
        },
      };
    }
    if (adaptive?.source === 'adaptive-ring-grid'
      && adaptive.success
      && adaptive.geometryVerified
      && Array.isArray(adaptive.answers)
      && adaptive.answers.length === 50
      && Number(adaptive.averageConfidence || 0) >= 90) {
      console.log(`[ADAPTIVE-OMR] Read a complete 50-row ring grid (${adaptive.averageConfidence.toFixed(1)}% confidence).`);
      return {
        detectedAnswers: adaptive.answers,
        confidenceScores: adaptive.confidenceScores,
        markedLetters: adaptive.markedLetters,
        details: {
          numQuestions: 50,
          averageConfidence: Number(adaptive.averageConfidence || 0),
          blurScore: 0,
          source: 'adaptive-ring-grid',
          currentSheetGeometry: true,
          geometryEvidenceUnreliable: false,
          ringGeometryVerified: true,
          ringsDetected: Number(adaptive.ringsDetected || 0),
          aiVerification: adaptive.aiVerification || null,
        },
      };
    }
    if (adaptive?.source === 'adaptive-multiple-marks' && adaptive?.geometryVerified) {
      if (!options?.fastMode) console.warn(`[ADAPTIVE-OMR] ${adaptive.reason}.`);
      return {
        detectedAnswers: [],
        confidenceScores: [],
        markedLetters: [],
        details: {
          numQuestions: 50,
          averageConfidence: 0,
          blurScore: 0,
          source: 'adaptive-multiple-marks',
          geometryEvidenceUnreliable: false,
          ambiguousRows: Number(adaptive.ambiguousRows || 0),
          solidMarksDetected: Number(adaptive.solidMarksDetected || 0),
          rejectionReason: adaptive.reason,
        },
      };
    }
    if (adaptive?.source === 'adaptive-ring-diagnostic' && adaptive?.geometryVerified) {
      if (!options?.fastMode) console.warn(`[ADAPTIVE-OMR] ${adaptive.reason}.`);
      return {
        detectedAnswers: adaptive.answers || [],
        confidenceScores: adaptive.confidenceScores || [],
        markedLetters: adaptive.markedLetters || [],
        details: {
          numQuestions: 50,
          averageConfidence: Number(adaptive.averageConfidence || 0),
          blurScore: 0,
          source: 'adaptive-ring-diagnostic',
          geometryEvidenceUnreliable: false,
          multiMarkCapable: true,
          ambiguousRows: Number(adaptive.ambiguousRows || 0),
          rejectionReason: adaptive.reason,
        },
      };
    }
    // Live and upload grading must not fall through to a projected fixed grid
    // when the current sheet's A-D geometry could not be verified.
    if (options?.trustedOnly === true) {
      const rejectionReason = adaptive?.reason || 'Answer-sheet row geometry was not verified';
      if (!options?.fastMode) console.warn(`[ADAPTIVE-OMR] ${rejectionReason}; legacy guessing disabled for live scan.`);
      return {
        detectedAnswers: [],
        confidenceScores: [],
        markedLetters: [],
        details: {
          numQuestions: 50,
          averageConfidence: 0,
          blurScore: 0,
          source: 'unverified-form',
          geometryEvidenceUnreliable: true,
          rejectionReason,
        },
      };
    }
    // The legacy direct reader is useful as page-presence evidence, but on a
    // uniformly answered sheet perspective drift can make one shaded lane
    // look like four x clusters. Never allow it to grade after the adaptive
    // reader rejected the page geometry.
    const directFormResult = await detectCompleteFilledForm(imageBuffer);
    if (directFormResult) {
      console.warn('[FORM-OMR] Legacy direct result withheld because adaptive A-D geometry was not verified.');
    }
  }

  const explicitLayout = options?.blocksPerRow && options?.questionsPerBlock;
  const candidateLayouts = explicitLayout
    ? [{ blocksPerRow: options.blocksPerRow, questionsPerBlock: options.questionsPerBlock }]
    : [
        { blocksPerRow: 1, questionsPerBlock: actualNumQuestions },
        { blocksPerRow: 2, questionsPerBlock: 25 },
        { blocksPerRow: 5, questionsPerBlock: 10 },
        { blocksPerRow: 10, questionsPerBlock: 5 },
        { blocksPerRow: 25, questionsPerBlock: 2 },
      ];

  // Live scanning already supplies a calibrated layout.  Trying every metric
  // and OCR fallback can turn one scan into dozens of expensive passes.
  const fastMode = options?.fastMode === true;
  const metricsToTry = options?.intensityMetric
    ? [options.intensityMetric]
    : (fastMode ? ['min'] : ['min', 'avg', 'minWithContrast']);

  const useMinOptions = options?.useMinIntensity !== undefined
    ? [options.useMinIntensity]
    : (fastMode ? [true] : [false, true]);

  let bestResult = null;
  let bestScore = -1;

  for (const layout of candidateLayouts) {
    for (const useMin of useMinOptions) {
      for (const metric of metricsToTry) {
        const trialOptions = { ...options, blocksPerRow: layout.blocksPerRow, questionsPerBlock: layout.questionsPerBlock, intensityMetric: metric, useMinIntensity: useMin };
        try {
          const result = await smartBubbleDetection(imageBuffer, answerKey, trialOptions);
          if (!result || !result.detectedAnswers || result.detectedAnswers.length === 0) continue;

          const answers = result.detectedAnswers.filter(a => a && ['A','B','C','D'].includes(a));
          const validCount = answers.length;
          const avgConf = result.details?.averageConfidence || 0;
          const uniqueLetters = new Set(answers).size;
          const varietyBonus = Math.min(30, uniqueLetters * 5);
          const keyLetters = new Set(cleanKey.split(''));
          const isUniformKey = cleanKey.length > 10 && keyLetters.size === 1;
          const sameLetterPenalty = (validCount > 10 && uniqueLetters === 1 && !isUniformKey) ? -50 : 0;

          // Never score recognition against the answer key. That leaks the
          // expected result into detection and inflates measured accuracy.
          const completionRatio = validCount / Math.max(1, actualNumQuestions);
          const score = completionRatio * 100 + avgConf * 0.5 + varietyBonus + sameLetterPenalty;

          if (score > bestScore) {
            bestScore = score;
            bestResult = { ...result, _triedMetric: metric, _layout: `${layout.blocksPerRow}x${layout.questionsPerBlock}` };
            console.log(`  [LAYOUT PICK] ${layout.blocksPerRow}x${layout.questionsPerBlock} | metric=${metric} useMin=${useMin} => score=${score.toFixed(1)} filled=${validCount}/${actualNumQuestions} conf=${avgConf.toFixed(1)}`);
          }
        } catch (e) {
          // skip failed metrics/layouts
        }
      }
    }
  }

  const bubbleResult = bestResult || await smartBubbleDetection(imageBuffer, answerKey, options);
  let ocrResult = null;
  let stripOcrResult = null;
  // OCR is useful for diagnostics, but it is much slower than bubble
  // detection and does not normally change a confident OMR result.
  if (!fastMode && options?.enableOcrFallback !== false) {
    try { ocrResult = await detectAnswersFromOCRPattern(imageBuffer, actualNumQuestions, options); } catch (e) { }
    if (!ocrResult || (ocrResult.detectedAnswers || []).filter(a => a).length < Math.min(actualNumQuestions, 10)) {
      try { stripOcrResult = await detectAnswersFromColumnStrips(imageBuffer, actualNumQuestions, options); } catch (e) { }
    }
  }

  const finalAnswers = [];
  const finalConfidence = [];
  const mergedMarkedLetters = [];

  for (let i = 0; i < actualNumQuestions; i++) {
    const bubbleAns = bubbleResult.detectedAnswers[i];
    const bubbleConf = Math.min(100, bubbleResult.confidenceScores[i] || 0);
    const ocrAns = ocrResult ? ocrResult.detectedAnswers[i] : '';
    const ocrConf = Math.min(100, ocrResult ? (ocrResult.confidenceScores[i] || 0) : 0);
    const stripAns = stripOcrResult ? stripOcrResult.detectedAnswers[i] : '';
    const stripConf = Math.min(100, stripOcrResult ? (stripOcrResult.confidenceScores[i] || 0) : 0);

    let answer = '';
    let confidence = 0;

    if (bubbleAns && bubbleConf >= 60) {
      answer = bubbleAns;
      confidence = bubbleConf;
      if ((ocrAns === bubbleAns && ocrConf >= 60) || (stripAns === bubbleAns && stripConf >= 60)) {
        confidence = Math.min(98, confidence + 15);
      } else if ((ocrAns && ocrAns !== bubbleAns && ocrConf >= 85) || (stripAns && stripAns !== bubbleAns && stripConf >= 85)) {
        confidence = Math.max(30, bubbleConf - 20);
      }
    } else if (bubbleAns && bubbleConf >= 40) {
      const bestOcr = ocrConf >= stripConf ? { ans: ocrAns, conf: ocrConf } : { ans: stripAns, conf: stripConf };
      if (bestOcr.ans && bestOcr.conf >= 75) {
        answer = bestOcr.ans;
        confidence = bestOcr.conf;
      } else {
        answer = bubbleAns;
        confidence = Math.max(30, bubbleConf);
      }
    } else {
      const bestOcr = ocrConf >= stripConf ? { ans: ocrAns, conf: ocrConf } : { ans: stripAns, conf: stripConf };
      if (bestOcr.ans && bestOcr.conf >= 55) {
        answer = bestOcr.ans;
        confidence = bestOcr.conf;
      } else if (bubbleAns) {
        answer = bubbleAns;
        confidence = Math.max(20, bubbleConf);
      }
    }

    finalAnswers.push(answer);
    finalConfidence.push(confidence);
    mergedMarkedLetters.push(
      Array.isArray(bubbleResult.markedLetters?.[i]) ? bubbleResult.markedLetters[i] : 
      Array.isArray(ocrResult?.markedLetters?.[i]) ? ocrResult.markedLetters[i] : []
    );
  }

  let avgConfidence = finalConfidence.length > 0
    ? parseFloat((finalConfidence.reduce((a, b) => a + b, 0) / finalConfidence.length).toFixed(2))
    : 0;

  // Do not expose a guessed answer pattern from a weak frame. This makes
  // blank, misaligned, or partly off-camera sheets visibly unanswerable to
  // the caller, which in turn prevents both auto-capture and accidental grade
  // submission.
  if (avgConfidence < 65) {
    finalAnswers.fill('');
    finalConfidence.fill(0);
    avgConfidence = 0;
  }

  return {
    detectedAnswers: finalAnswers,
    confidenceScores: finalConfidence,
    markedLetters: mergedMarkedLetters,
    details: {
      numQuestions: actualNumQuestions,
      validAnswers: finalAnswers.filter(a => a !== '').length,
      averageConfidence: avgConfidence,
      source: 'hybrid-ocr-epoch',
      selectedMetric: bubbleResult._triedMetric || options?.intensityMetric || 'min'
    }
  };
}

function countAnswerDistribution(detectedAnswers, markedLetters) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  const questionMap = {};
  for (let i = 0; i < detectedAnswers.length; i++) {
    const ans = (detectedAnswers[i] || '').trim().toUpperCase();
    if (ans && counts.hasOwnProperty(ans)) { counts[ans]++; questionMap[i + 1] = ans; }
  }
  const totalAnswered = Object.values(counts).reduce((a, b) => a + b, 0);
  return { counts, totalAnswered, totalQuestions: detectedAnswers.length, unanswered: detectedAnswers.length - totalAnswered, questionMap };
}

/**
 * OCR-READABLE PREPROCESSING
 * Targeted contrast enhancement for faint pencil marks while keeping
 * the page background stable. Designed for Tesseract readability.
 */
async function preprocessForOcrReadability(imageBuffer) {
  try {
    const img = sharp(imageBuffer);
    const meta = await img.metadata();
    const maxDim = 2400;
    let processed = img.greyscale();
    if ((meta.width || 0) > maxDim || (meta.height || 0) > maxDim) {
      const ratio = Math.min(maxDim / (meta.width || 1), maxDim / (meta.height || 1));
      processed = processed.resize(Math.round((meta.width || 1) * ratio), Math.round((meta.height || 1) * ratio), { fit: 'inside', withoutEnlargement: false });
    }

    // Mild denoise + local contrast amplify for faint marks
    return processed
      .median(1)
      .sharpen({ sigma: 0.8 })
      .normalize()
      .linear(1.35, (-0.25 * 255))
      .modulate({ brightness: 1.1, saturation: 0, lightness: -5 })
      .toBuffer();
  } catch (error) {
    console.warn('OCR readability preprocessing failed, falling back to raw buffer:', error.message);
    return imageBuffer;
  }
}

/**
 * Per-column OCR strip fallback.
 * Crops each block column and runs SINGLE_COLUMN + SINGLE_LINE OCR,
 * returning a partial detector answer map for ambiguous questions.
 */
async function detectAnswersFromColumnStrips(imageBuffer, numQuestions, options = {}) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();
    const width = metadata.width;
    const height = metadata.height;

    const topMargin = Math.floor(height * 0.05);
    const bottomMargin = height - Math.floor(height * 0.05);
    const leftMargin = Math.floor(width * 0.05);
    const rightMargin = Math.floor(width * 0.95);
    const usableHeight = bottomMargin - topMargin;
    const usableWidth = rightMargin - leftMargin;

    let gridCols, gridRows;
    if (options && options.blocksPerRow && options.questionsPerBlock) {
      gridCols = options.blocksPerRow;
      gridRows = options.questionsPerBlock;
    } else {
      const aspectRatio = width / height;
      if (numQuestions <= 25) { gridCols = 1; gridRows = numQuestions; }
      else if (numQuestions <= 50) {
        if (aspectRatio > 1.4) { gridCols = 10; gridRows = 5; }
        else { gridCols = 2; gridRows = 25; }
      }
      else if (numQuestions <= 75) { gridCols = 3; gridRows = 25; }
      else if (numQuestions <= 100) { gridCols = 4; gridRows = 25; }
      else { gridRows = 25; gridCols = Math.ceil(numQuestions / gridRows); }
    }

    const cellWidth = usableWidth / gridCols;
    const regionHeight = usableHeight / gridRows;

    const detectedAnswers = new Array(numQuestions).fill('');
    const confidenceScores = new Array(numQuestions).fill(0);

    const MIN_STRIP_WIDTH = 60;
    const MIN_ROW_HEIGHT = 20;
    const maxColumnsToScan = Math.min(gridCols, 2);

     for (let col = 0; col < maxColumnsToScan; col++) {
      const stripLeft = Math.max(0, Math.floor(leftMargin + col * cellWidth));
      const stripTop = Math.floor(topMargin);
      const rawStripWidth = Math.max(MIN_STRIP_WIDTH, Math.floor(cellWidth));
      const rawStripHeight = Math.max(MIN_ROW_HEIGHT * gridRows, Math.floor(usableHeight));
      const stripWidth = Math.min(rawStripWidth, width - stripLeft);
      const stripHeight = Math.min(rawStripHeight, height - stripTop);

      if (stripWidth < MIN_STRIP_WIDTH || stripHeight < MIN_ROW_HEIGHT) continue;

      console.log('COLUMN STRIP: col=' + col + ' left=' + stripLeft + ' top=' + stripTop + ' width=' + stripWidth + ' height=' + stripHeight + ' imgWidth=' + width + ' imgHeight=' + height);
      const stripBuffer = await sharp(imageBuffer)
        .extract({ left: stripLeft, top: stripTop, width: stripWidth, height: stripHeight })
        .toBuffer();

      if (!stripBuffer || stripBuffer.length < 100) continue;

      const ocrReady = await preprocessForOcrReadability(stripBuffer);

      if (!ocrReady || ocrReady.length < 100) continue;

      let bestText = '';
      let bestLineCount = 0;
      for (const psm of [Tesseract.PSM ? Tesseract.PSM.SINGLE_COLUMN : 4, Tesseract.PSM ? Tesseract.PSM.SINGLE_LINE : 7]) {
        try {
          const text = await recognizeWithTesseract(ocrReady, {
            psm,
            whitelist: 'ABCDabcd0123456789',
          });
          const lineCount = (text || '').split('\n').filter(l => l.trim().length > 0).length;
          if (lineCount > bestLineCount) { bestLineCount = lineCount; bestText = text; }
        } catch (e) { }
      }

      if (!bestText) continue;

      for (const line of bestText.split('\n')) {
        const match = line.trim().match(/^(\d+)[.\s)]+([A-Da-d][A-Da-d\s]*)$/);
        if (!match) continue;
        const qNum = parseInt(match[1]);
        const answerPart = match[2].toUpperCase().replace(/\s/g, '');
        const idx = qNum - 1;
        if (idx < 0 || idx >= numQuestions) continue;

        const counts = {};
        for (const ch of answerPart) { if ('ABCD'.includes(ch)) counts[ch] = (counts[ch] || 0) + 1; }
        const letters = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (letters.length === 0) continue;

        const row = idx % gridRows;
        const localTop = stripTop + Math.floor(row * regionHeight);
        const localBottom = stripTop + Math.floor((row + 1) * regionHeight);
        const rowHeight = localBottom - localTop;
        if (rowHeight < MIN_ROW_HEIGHT) continue;

        const answer = letters[0][0];
        detectedAnswers[idx] = answer;
        confidenceScores[idx] = 40;
      }
    }

    return { detectedAnswers, confidenceScores, markedLetters: [], details: { numQuestions, validAnswers: detectedAnswers.filter(a => a !== '').length, source: 'column_strip_ocr' } };
  } catch (error) {
    console.warn('Column strip OCR failed:', error.message);
    console.warn('Stack:', error.stack);
    return null;
  }
}

/**
 * Detects printed question numbers from the left margin of the sheet.
 * Returns an array of {number, yCenter} ordered by Y position, or null on failure.
 * These anchors are used to align bubble rows precisely instead of relying on
 * a fixed grid alone.
 */
async function detectQuestionNumbers(imageBuffer, numExpected, options = {}) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();
    const width = metadata.width;
    const height = metadata.height;
    if (!width || !height || numExpected < 1) return null;

    const marginFraction = options.marginFraction || 0.12;
    const cropX = Math.floor(width * (options.cropLeft != null ? options.cropLeft : 0.02));
    const cropW = Math.max(60, Math.floor(width * marginFraction));
    const cropTop = Math.floor(height * 0.04);
    const cropBottom = height - Math.floor(height * 0.04);
    const cropH = Math.max(60, cropBottom - cropTop);

    const cropBuffer = await img
      .extract({ left: cropX, top: cropTop, width: cropW, height: cropH })
      .greyscale()
      .normalize()
      .sharpen({ sigma: 1.2 })
      .resize({ width: Math.max(200, cropW * 3), height: Math.max(200, cropH * 3), kernel: sharp.kernel.lanczos3 })
      .toBuffer();

    const candidates = [];
    const psmModes = [Tesseract.PSM ? Tesseract.PSM.SINGLE_COLUMN : 4, Tesseract.PSM ? Tesseract.PSM.SINGLE_BLOCK : 6];
    const qNumResults = await Promise.all(psmModes.map(psm =>
      recognizeWithTesseract(cropBuffer, { psm, whitelist: '0123456789' })
        .then(text => ({ text: text.trim(), conf: 90 }))
        .catch(() => null)
    ));
    for (const result of qNumResults) {
      if (result && result.text.length > 0) candidates.push(result);
    }

    if (candidates.length === 0) return null;

    const allLines = candidates
      .map(c => c.text.split('\n').map(l => l.trim()).filter(Boolean))
      .flat();

    const parsed = [];
    for (const line of allLines) {
      const m = line.match(/^(\d+)$/);
      if (!m) continue;
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= (numExpected || 999)) {
        parsed.push(n);
      }
    }

    if (parsed.length < Math.min(3, numExpected)) return null;

    const counts = {};
    for (const n of parsed) counts[n] = (counts[n] || 0) + 1;
    const orderedNumbers = Object.keys(counts)
      .map(Number)
      .sort((a, b) => a - b)
      .slice(0, numExpected);

    if (orderedNumbers.length < 2) return null;

    const step = (cropBottom - cropTop) / (orderedNumbers.length || 1);
    const anchors = orderedNumbers.map((num, idx) => ({
      number: num,
      yCenter: cropTop + step * (idx + 0.5),
    }));

    return anchors;
  } catch (error) {
    console.warn('Question number detection failed:', error.message);
    return null;
  }
}

async function detectEpoch(imageBuffer) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();
    const width = metadata.width, height = metadata.height;
    if (!width || !height || width < 50 || height < 50) return { epoch: null, confidence: 0, rawText: '' };
    const cropWidth = Math.max(40, Math.floor(width * 0.20));
    const cropHeight = Math.max(20, Math.floor(height * 0.18));
    const left = Math.max(0, width - cropWidth), top = 0;
    const croppedBuffer = await img.extract({ left, top, width: cropWidth, height: cropHeight }).greyscale().normalize().sharpen({ sigma: 1.2 }).toBuffer();
    const rawText = await recognizeWithTesseract(croppedBuffer, {});
    const text = rawText;
    let epoch = null;
    const patterns = [/EPOCH[\s:\-]*([A-Z0-9\-]{5,25})/i, /\bE[\s:\-]*(\d{4}[\-\s]?\d{2,3})\b/, /\bE\d{6,9}\b/];
    for (const pattern of patterns) {
      const match = rawText.match(pattern);
      if (match && match[1]) { epoch = match[1].trim().replace(/\s+/g, '-'); break; }
    }
    return { epoch: epoch || null, confidence: epoch ? 85 : 0, rawText };
  } catch (error) {
    console.error('Epoch detection error:', error);
    return { epoch: null, confidence: 0, rawText: '', error: error.message };
  }
}

module.exports = {
  advancedPreprocessImage, detectBlurLevel, smartBubbleDetection, enhancedExtractStudentInfo,
  findBestStudentMatch, createScanReport, levenshteinDistance, sanitizeNameString,
  isValidStudentNumber, detectAnswersFromOCRPattern, hybridDetectAnswers, detectEpoch,
  countAnswerDistribution, extractBubblePatch, recognizeDigitsWithOnnx,
  preprocessForOcrReadability, detectAnswersFromColumnStrips, detectQuestionNumbers,
  recognizeWithTesseract, getBubbleTemplates, classifyBubbleWithTemplates, detectCompleteFilledForm
};
