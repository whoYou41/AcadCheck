const sharp = require('sharp');

function computeHomography(src, dst) {
  const [s0, s1, s2, s3] = src;
  const [d0, d1, d2, d3] = dst;

  const A = [];
  for (let i = 0; i < 4; i++) {
    const sx = [s0, s1, s2, s3][i][0];
    const sy = [s0, s1, s2, s3][i][1];
    const dx = [d0, d1, d2, d3][i][0];
    const dy = [d0, d1, d2, d3][i][1];
    A.push([-sx, -sy, -1, 0, 0, 0, sx * dx, sy * dx, -dx]);
    A.push([0, 0, 0, -sx, -sy, -1, sx * dy, sy * dy, -dy]);
  }

  const solve = (matrix) => {
    const n = matrix.length;
    const m = matrix[0].length;
    for (let col = 0; col < m - 1; col++) {
      let maxRow = col;
      for (let row = col + 1; row < n; row++) {
        if (Math.abs(matrix[row][col]) > Math.abs(matrix[maxRow][col])) {
          maxRow = row;
        }
      }
      [matrix[col], matrix[maxRow]] = [matrix[maxRow], matrix[col]];
      if (Math.abs(matrix[col][col]) < 1e-10) continue;
      for (let row = col + 1; row < n; row++) {
        const factor = matrix[row][col] / matrix[col][col];
        for (let j = col; j < m; j++) {
          matrix[row][j] -= factor * matrix[col][j];
        }
      }
    }
    const x = new Array(m).fill(0);
    for (let i = m - 2; i >= 0; i--) {
      let sum = matrix[i][m - 1];
      for (let j = i + 1; j < m - 1; j++) {
        sum -= matrix[i][j] * x[j];
      }
      x[i] = Math.abs(matrix[i][i]) > 1e-10 ? sum / matrix[i][i] : 0;
    }
    return x;
  };

  const h = solve(A);
  return [
    [h[0], h[1], h[2]],
    [h[3], h[4], h[5]],
    [h[6], h[7], 1]
  ];
}

function invertHomography(H) {
  const [a, b, c, d, e, f, g, h] = [H[0][0], H[0][1], H[0][2], H[1][0], H[1][1], H[1][2], H[2][0], H[2][1]];
  const det = a * (e - f * h) - b * (d - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;
  return [
    [(e - f * h) * invDet, (c * h - b) * invDet, (b * f - c * e) * invDet],
    [(f * g - d) * invDet, (a * h - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (c * g - a * h) * invDet, (a * e - b * d) * invDet]
  ];
}

function sampleBilinear(data, width, height, x, y) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const dx = x - x0;
  const dy = y - y0;
  const idx00 = y0 * width + x0;
  const idx10 = y0 * width + x1;
  const idx01 = y1 * width + x0;
  const idx11 = y1 * width + x1;
  const v00 = data[idx00];
  const v10 = data[idx10];
  const v01 = data[idx01];
  const v11 = data[idx11];
  const top = v00 + (v10 - v00) * dx;
  const bottom = v01 + (v11 - v01) * dx;
  return top + (bottom - top) * dy;
}

function polygonArea(points) {
  let twiceArea = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    twiceArea += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceArea) / 2;
}

function normalizeAngle(angle) {
  let normalized = angle;
  while (normalized > 90) normalized -= 180;
  while (normalized < -90) normalized += 180;
  return normalized;
}

function assessPlacement(corners, width, height) {
  if (!corners || corners.length !== 4 || !width || !height) {
    return { detected: false, acceptable: false, confidence: 0, reason: 'Answer sheet boundary not found' };
  }

  const [tl, tr, br, bl] = corners;
  const topWidth = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
  const bottomWidth = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
  const leftHeight = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
  const rightHeight = Math.hypot(br[0] - tr[0], br[1] - tr[1]);
  const sheetWidth = (topWidth + bottomWidth) / 2;
  const sheetHeight = (leftHeight + rightHeight) / 2;
  const aspectRatio = sheetWidth / Math.max(1, sheetHeight);
  const coverage = polygonArea(corners) / Math.max(1, width * height);
  const topAngle = Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) * 180 / Math.PI;
  const bottomAngle = Math.atan2(br[1] - bl[1], br[0] - bl[0]) * 180 / Math.PI;
  const leftAngle = Math.atan2(bl[1] - tl[1], bl[0] - tl[0]) * 180 / Math.PI - 90;
  const rightAngle = Math.atan2(br[1] - tr[1], br[0] - tr[0]) * 180 / Math.PI - 90;
  const rotationDeg = (topAngle + bottomAngle) / 2;
  const perspectiveDeg = Math.max(
    Math.abs(normalizeAngle(topAngle - bottomAngle)),
    Math.abs(normalizeAngle(leftAngle - rightAngle))
  );

  let confidence = 100;
  if (coverage < 0.12) confidence -= 55;
  else if (coverage < 0.22) confidence -= 25;
  if (coverage > 0.98) confidence -= 20;
  if (aspectRatio < 0.35 || aspectRatio > 0.85) confidence -= 45;
  if (Math.min(sheetWidth, sheetHeight) < 150) confidence -= 40;
  if (Math.abs(rotationDeg) > 35 || perspectiveDeg > 35) confidence -= 30;
  confidence = Math.max(0, Math.round(confidence));

  const acceptable = confidence >= 65;
  return {
    detected: true,
    acceptable,
    confidence,
    coverage: Number(coverage.toFixed(3)),
    aspectRatio: Number(aspectRatio.toFixed(3)),
    rotationDeg: Number(rotationDeg.toFixed(1)),
    perspectiveDeg: Number(perspectiveDeg.toFixed(1)),
    reason: acceptable ? 'Sheet placement is usable' : 'Center the complete answer sheet inside the camera frame'
  };
}

function warpPerspective(srcBuffer, srcWidth, srcHeight, H, dstWidth, dstHeight) {
  const Hinv = invertHomography(H);
  if (!Hinv) return null;

  const dst = new Uint8Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    for (let x = 0; x < dstWidth; x++) {
      const denom = Hinv[2][0] * x + Hinv[2][1] * y + Hinv[2][2];
      if (Math.abs(denom) < 1e-10) {
        dst[y * dstWidth + x] = 255;
        continue;
      }
      const srcX = (Hinv[0][0] * x + Hinv[0][1] * y + Hinv[0][2]) / denom;
      const srcY = (Hinv[1][0] * x + Hinv[1][1] * y + Hinv[1][2]) / denom;
      if (srcX < 0 || srcX >= srcWidth - 1 || srcY < 0 || srcY >= srcHeight - 1) {
        dst[y * dstWidth + x] = 255;
      } else {
        dst[y * dstWidth + x] = Math.round(sampleBilinear(srcBuffer, srcWidth, srcHeight, srcX, srcY));
      }
    }
  }
  return dst;
}

function isUsableWarp(data, width, height) {
  if (!data || width < 100 || height < 100) return false;

  // Sampling is deliberate: this guard must be cheap enough for live camera
  // frames, while still catching the blank/striped output produced by a bad
  // homography or an incorrectly ordered page quadrilateral.
  const step = Math.max(1, Math.floor(Math.min(width, height) / 300));
  let samples = 0;
  let nearWhite = 0;
  let nearBlack = 0;
  let transitions = 0;
  let previous = -1;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const value = data[y * width + x];
      samples++;
      if (value >= 245) nearWhite++;
      if (value <= 15) nearBlack++;
      if (previous >= 0 && Math.abs(value - previous) >= 18) transitions++;
      previous = value;
    }
  }
  if (!samples) return false;
  const whiteRatio = nearWhite / samples;
  const blackRatio = nearBlack / samples;
  const transitionRatio = transitions / Math.max(1, samples - 1);
  return whiteRatio < 0.995 && blackRatio < 0.75 && transitionRatio >= 0.015;
}

async function detectDocumentCorners(imageBuffer) {
  const grayscale = await sharp(imageBuffer)
    .greyscale()
    .resize(800, null, { withoutEnlargement: true, fit: 'inside' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const data = grayscale.data;
  const width = grayscale.info.width;
  const height = grayscale.info.height;

  // Camera captures place a bright sheet against a darker background.  Merge
  // short dark interruptions caused by printed/filled answer columns.
  const bright = [];
  for (let x = 0; x < width; x++) {
    let n = 0;
    for (let y = 0; y < height; y++) if (data[y * width + x] >= 160) n++;
    bright[x] = n >= height * 0.45;
  }
  const runs = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    if (x < width && bright[x]) { if (start < 0) start = x; }
    else if (start >= 0) { runs.push([start, x - 1]); start = -1; }
  }
  const mergeGap = Math.max(5, Math.floor(width * 0.01));
  let best = null;
  for (const run of runs) {
    if (best && run[0] - best[1] - 1 <= mergeGap) best[1] = run[1];
    else if (!best || run[1] - run[0] > best[1] - best[0]) best = [...run];
  }
  if (best && best[1] - best[0] >= width * 0.15) {
    const needed = (best[1] - best[0] + 1) * 0.5;
    let minY = height, maxY = -1;
    for (let y = 0; y < height; y++) {
      let n = 0;
      for (let x = best[0]; x <= best[1]; x++) if (data[y * width + x] >= 160) n++;
      if (n >= needed) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    }
    if (maxY - minY >= height * 0.4) {
      const padX = Math.floor((best[1] - best[0]) * 0.02), padY = Math.floor((maxY - minY) * 0.02);
      const full = await sharp(imageBuffer).metadata();
      const sx = (full.width || width) / width, sy = (full.height || height) / height;
      // Find the paper edge on each row and fit a line through it.  Unlike a
      // fixed rectangular crop, this follows a tilted/keystoned sheet.
      const samples = [];
      for (let y = minY + padY; y <= maxY - padY; y += Math.max(2, Math.floor((maxY - minY) / 80))) {
        let left = -1, right = -1;
        for (let x = Math.max(0, best[0] - padX * 2); x <= Math.min(width - 1, best[1] + padX * 2); x++) {
          if (data[y * width + x] >= 160) { left = x; break; }
        }
        for (let x = Math.min(width - 1, best[1] + padX * 2); x >= Math.max(0, best[0] - padX * 2); x--) {
          if (data[y * width + x] >= 160) { right = x; break; }
        }
        if (left >= 0 && right - left >= width * 0.15) samples.push({ y, left, right });
      }
      const fitEdge = (key, fallback) => {
        if (samples.length < 8) return y => fallback;
        const meanY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
        const meanX = samples.reduce((s, p) => s + p[key], 0) / samples.length;
        const denom = samples.reduce((s, p) => s + (p.y - meanY) ** 2, 0) || 1;
        const slope = samples.reduce((s, p) => s + (p.y - meanY) * (p[key] - meanX), 0) / denom;
        return y => meanX + slope * (y - meanY);
      };
      const top = Math.max(0, minY - padY), bottom = Math.min(height - 1, maxY + padY);
      const leftAt = fitEdge('left', best[0] - padX), rightAt = fitEdge('right', best[1] + padX);
      return [
        [Math.max(0, leftAt(top)) * sx, top * sy],
        [Math.min(width - 1, rightAt(top)) * sx, top * sy],
        [Math.min(width - 1, rightAt(bottom)) * sx, bottom * sy],
        [Math.max(0, leftAt(bottom)) * sx, bottom * sy]
      ];
    }
  }

  const threshold = 220;
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;

  const step = Math.max(1, Math.floor(width / 200));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const val = data[y * width + x];
      if (val < threshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  if (!found || maxX - minX < 50 || maxY - minY < 50) {
    return null;
  }

  const padX = Math.floor((maxX - minX) * 0.02);
  const padY = Math.floor((maxY - minY) * 0.02);
  minX = Math.max(0, minX - padX);
  minY = Math.max(0, minY - padY);
  maxX = Math.min(width - 1, maxX + padX);
  maxY = Math.min(height - 1, maxY + padY);

  const fullImg = await sharp(imageBuffer).metadata();
  const origW = fullImg.width || width;
  const origH = fullImg.height || height;
  const scaleX = origW / width;
  const scaleY = origH / height;

  return [
    [minX * scaleX, minY * scaleY],
    [maxX * scaleX, minY * scaleY],
    [maxX * scaleX, maxY * scaleY],
    [minX * scaleX, maxY * scaleY]
  ];
}

async function maybeRotateToPortrait(imageBuffer, width, height) {
  if (!width || !height) {
    const meta = await sharp(imageBuffer).metadata();
    width = meta.width;
    height = meta.height;
  }
  if (!width || !height) return imageBuffer;
  if (width > height) {
    const rotated = await sharp(imageBuffer)
      .rotate(90)
      .png()
      .toBuffer();
    const rMeta = await sharp(rotated).metadata();
    return rotated;
  }
  return imageBuffer;
}

async function rectifyExamSheet(imageBuffer) {
  try {
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width || 800;
    const height = metadata.height || 600;

    const corners = await detectDocumentCorners(imageBuffer);
    if (!corners) {
      return { buffer: imageBuffer, rectified: false, corners: null, placement: assessPlacement(null, width, height) };
    }

    const placement = assessPlacement(corners, width, height);

    const [tl, tr, br, bl] = corners;
    const left = Math.max(0, Math.floor(Math.min(tl[0], bl[0])));
    const top = Math.max(0, Math.floor(Math.min(tl[1], tr[1])));
    const right = Math.min(width, Math.ceil(Math.max(tr[0], br[0])));
    const bottom = Math.min(height, Math.ceil(Math.max(bl[1], br[1])));
    const cropFallback = async () => {
      if (right - left < 100 || bottom - top < 100) return null;
      const buffer = await sharp(imageBuffer)
        .extract({ left, top, width: right - left, height: bottom - top })
        .png()
        .toBuffer();
      return { buffer, rectified: true, corners, placement, dstWidth: right - left, dstHeight: bottom - top, perspectiveCorrected: false };
    };

    // Preserve the original page pixels here. The custom JavaScript
    // homography can generate vertical stripe artifacts on phone captures;
    // the OpenCV reader performs its own validated perspective normalization
    // from this intact page crop.
    const cropped = await cropFallback();
    if (cropped) return cropped;

    const widthTop = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
    const widthBottom = Math.hypot(br[0] - bl[0], br[1] - bl[1]);
    const heightLeft = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
    const heightRight = Math.hypot(br[0] - tr[0], br[1] - tr[1]);

    const srcGray = await sharp(imageBuffer)
      .greyscale()
      // Keep enough source resolution for individual 4-choice bubbles after
      // warping. A 2,000px cap reduced portrait camera sheets to ~650px wide,
      // which made the bubble rings and fills indistinguishable.
      .resize(Math.min(width, 4000), null, { withoutEnlargement: true, fit: 'inside' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    const srcW = srcGray.info.width;
    const srcH = srcGray.info.height;
    const scaleX = srcW / width;
    const scaleY = srcH / height;

    const dstWidth = Math.max(100, Math.round(Math.max(widthTop, widthBottom) * scaleX));
    const dstHeight = Math.max(100, Math.round(Math.max(heightLeft, heightRight) * scaleY));

    const scaledCorners = corners.map(([x, y]) => [x * scaleX, y * scaleY]);

    const dstCorners = [
      [0, 0],
      [dstWidth - 1, 0],
      [dstWidth - 1, dstHeight - 1],
      [0, dstHeight - 1]
    ];

    const H = computeHomography(scaledCorners, dstCorners);
    if (!H) {
      const cropped = await cropFallback();
      return cropped || { buffer: imageBuffer, rectified: false, corners, placement };
    }

    const warpedData = warpPerspective(srcGray.data, srcW, srcH, H, dstWidth, dstHeight);
    if (!warpedData || !isUsableWarp(warpedData, dstWidth, dstHeight)) {
      const cropped = await cropFallback();
      return cropped || { buffer: imageBuffer, rectified: false, corners, placement };
    }

    // Pass an actual Buffer to sharp. On Windows, passing a Uint8Array here
    // has produced corrupted vertical-stripe images for some camera frames.
    const rectifiedBuffer = await sharp(Buffer.from(warpedData), {
      raw: { width: dstWidth, height: dstHeight, channels: 1 }
    })
      .png()
      .toBuffer();

    const finalMeta = await sharp(rectifiedBuffer).metadata();
    return {
      buffer: rectifiedBuffer,
      rectified: true,
      corners,
      placement,
      dstWidth: finalMeta.width,
      dstHeight: finalMeta.height,
      perspectiveCorrected: true
    };
  } catch (error) {
    console.warn('Perspective correction failed, using original image:', error.message);
    return { buffer: imageBuffer, rectified: false, corners: null, placement: null };
  }
}

module.exports = {
  rectifyExamSheet,
  computeHomography,
  warpPerspective,
  detectDocumentCorners,
  assessPlacement
};
