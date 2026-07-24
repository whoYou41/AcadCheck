const sharp = require('sharp');
const { recognizeWithTesseract } = require('./enhanced-scanner');

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

    const upscaleFactor = Math.min(2.5, Math.max(1.5, Math.sqrt(18000 / (safeCropWidth * safeCropHeight))));
    const upscaledWidth = Math.max(80, Math.floor(safeCropWidth * upscaleFactor));
    const upscaledHeight = Math.max(64, Math.floor(safeCropHeight * upscaleFactor));

    const croppedBuffer = await img
      .extract({ left: cropLeft, top: cropTop, width: safeCropWidth, height: safeCropHeight })
      .toBuffer();

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

    let bestRawText = '';
    const attempts = [
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

    const hasGoodText = (bestRawText || '').length >= 20 || /\d{2}-\d{2}-\d{4}/.test(bestRawText || '');
    if (!hasGoodText) {
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

    // QR-era sheets contain only the student's handwritten classroom
    // sequence number. The answer-key identity/date now comes from the QR, so
    // accept a clean one-to-four digit OCR result when the caller explicitly
    // enables this structured-field mode.
    if (!sequence && options.allowStandalone === true) {
      const labeledMatch = normalized.match(
        /(?:STUDENT\s+)?SEQUENCE(?:\s+NO)?\s*[-:#]?\s*(\d{1,4})\b/
      );
      const numericOnlyMatch = normalized.match(/^\s*(\d{1,4})\s*$/);
      const standaloneMatch = labeledMatch || numericOnlyMatch;
      if (standaloneMatch) {
        const numericValue = Number.parseInt(standaloneMatch[1], 10);
        if (numericValue > 0) {
          sequence = String(numericValue);
          confidence = labeledMatch ? 82 : 68;
        }
      }
    }

    if (!sequence) {
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

    if (!sequence) {
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
};
