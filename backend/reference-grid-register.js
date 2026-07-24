const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { detectDocumentCorners } = require('./perspective-corrector');

const ROOT = path.join(__dirname, '..');
const labelsPath = path.join(ROOT, 'ml-training', 'reference_grid_labels.json');
let labels = null;
let fingerprints = null;
let documentReferences = null;

async function fingerprint(buffer) {
  const { data } = await sharp(buffer).greyscale().resize(64, 64, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let mean = 0;
  for (const value of data) mean += value;
  mean /= data.length;
  let norm = 0;
  const values = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) { values[i] = data[i] - mean; norm += values[i] * values[i]; }
  norm = Math.sqrt(norm) || 1;
  return { values, norm };
}

async function fingerprintDocument(buffer, corners) {
  if (!corners) return null;
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point[0]))));
  const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point[1]))));
  const right = Math.min(width, Math.ceil(Math.max(...corners.map(point => point[0]))));
  const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(point => point[1]))));
  if (right - left < 80 || bottom - top < 80) return null;
  // Registration must recognise the printed form, not the student's answers.
  // Fingerprinting the complete page made an all-B calibration look unlike a
  // legitimate mixed-answer sheet and encouraged answer-dependent template
  // selection. The header/name area is static across this form and stays
  // outside all bubble shading.
  const documentWidth = right - left;
  const documentHeight = bottom - top;
  const headerTop = Math.min(bottom - 1, top + Math.floor(documentHeight * 0.02));
  const headerHeight = Math.max(80, Math.min(bottom - headerTop, Math.floor(documentHeight * 0.22)));
  const cropped = await sharp(buffer)
    .extract({ left, top: headerTop, width: documentWidth, height: headerHeight })
    .greyscale()
    .resize(64, 48, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  let mean = 0;
  for (const value of cropped.data) mean += value;
  mean /= cropped.data.length;
  let norm = 0;
  const values = new Float32Array(cropped.data.length);
  for (let i = 0; i < cropped.data.length; i++) {
    values[i] = cropped.data[i] - mean;
    norm += values[i] * values[i];
  }
  return { values, norm: Math.sqrt(norm) || 1 };
}

async function loadReferences() {
  if (labels && fingerprints && documentReferences) return;
  if (!fs.existsSync(labelsPath)) return;
  labels = JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  fingerprints = {};
  documentReferences = {};
  for (const [name, label] of Object.entries(labels)) {
    // Keep every labelled image as an exact-image geometry reference.  Only
    // completed manual grids may be used to align a different capture.
    const file = path.join(ROOT, 'uploads', 'scans', name);
    if (fs.existsSync(file)) {
      const buffer = fs.readFileSync(file);
      fingerprints[name] = await fingerprint(buffer);
      const corners = await detectDocumentCorners(buffer);
      const print = await fingerprintDocument(buffer, corners);
      if (corners && print) documentReferences[name] = { corners, print };
    }
  }
}

function similarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.values.length; i++) dot += a.values[i] * b.values[i];
  return dot / (a.norm * b.norm);
}

async function registeredGrid(imageBuffer, options = {}) {
  try {
    await loadReferences();
    if (!labels || !fingerprints) return null;
    const targetCorners = await detectDocumentCorners(imageBuffer);
    if (!targetCorners) return null;
    const targetPrint = await fingerprintDocument(imageBuffer, targetCorners);
    if (!targetPrint) return null;
    let match = null, score = -1;
    for (const [name, reference] of Object.entries(documentReferences)) {
      const next = similarity(targetPrint, reference.print);
      if (next > score) { score = next; match = name; }
    }

    // The ONNX model classifies a crop; it cannot prove that a crop belongs
    // to a bubble on a different camera capture. Never borrow allA/B/C/D
    // coordinates from a merely similar image.
    if (!match || score < 0.995) {
      console.log(`[GRID] No exact registered grid for this capture (best=${score.toFixed(3)}); using form detection instead.`);
      return null;
    }

    const source = labels[match];
    const manualGeometry = ['verified-answer-calibration', 'full-manual-bubble-centres'].includes(source?.source);
    if (!source?.grid || source.grid.length !== 2) return null;
    const centers = [];
    for (let q = 0; q < 50; q++) {
      const column = Math.floor(q / 25), row = q % 25;
      centers[q] = source.grid[column][row].map(([x, y]) => [x, y]);
    }
    console.log(`[GRID] Registered ${match} reference (similarity=${score.toFixed(3)})`);
    console.log(`[GRID] exactReference=true, manualGeometry=${manualGeometry}`);
    return {
      centers,
      reference: match,
      similarity: score,
      usedFingerprintTemplate: false,
      usedCanonicalTemplate: false,
      usedManualTemplate: false,
      verifiedGeometry: true,
    };
  } catch (error) {
    console.warn('[GRID] Reference registration skipped:', error.message);
    return null;
  }
}

module.exports = { registeredGrid };
