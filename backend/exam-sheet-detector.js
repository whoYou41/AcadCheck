const sharp = require('sharp');
const { recognizeWithTesseract } = require('./enhanced-scanner');
const { rectifyExamSheet, detectDocumentCorners } = require('./perspective-corrector');

const EXAM_KEYWORDS = /exam|sheet|answer|question|score|student|name|id|date|bubble|multiple.?choice|mark|fill|circle|oval|response|option|instruction|direction|test|quiz|exam.?sheet|answer.?sheet|omr|optical|scan|grade|instructor|class/i;
const STRONG_EXAM_KEYWORDS = /bubble|multiple.?choice|fill|score|answer.?key|OMR|optical|mark|sheet|answer.?sheet|exam.?sheet/i;

async function detectExamSheet(imageBuffer, options = {}) {
  try {
    const img = sharp(imageBuffer);
    const metadata = await img.metadata();

    const width = metadata.width || 0;
    const height = metadata.height || 0;

    if (!width || !height || width < 100 || height < 100) {
      return {
        isExamSheet: false,
        confidence: 0,
        recommendation: 'reject',
        reason: 'Image too small for exam sheet analysis',
        rectified: false,
        cornersDetected: false,
        ocrText: '',
        imageInfo: { width, height }
      };
    }

    const aspectRatio = width / height;
    let rectifiedBuffer = imageBuffer;
    let rectified = false;
    let cornersDetected = false;
    let placement = null;

    try {
      const rectResult = await rectifyExamSheet(imageBuffer);
      rectifiedBuffer = rectResult.buffer;
      rectified = rectResult.rectified;
      cornersDetected = !!(rectResult.corners);
      placement = rectResult.placement || null;
    } catch (e) {
      console.warn('Rectification skipped for detect-exam-sheet:', e.message);
    }

    let ocrText = '';
    // Live auto-detection needs a quick, placement-only decision. OCR is
    // retained for the manual standalone check, but must not delay or bias
    // the camera loop once the full paper boundary has been found.
    if (!options.fast) try {
      // Try OCR on rectified image first
      const psm = options.psm || '6';
      ocrText = await recognizeWithTesseract(rectifiedBuffer, { psm });
      console.log(`[EXAM-DETECT] OCR attempt 1 (rectified, PSM ${psm}): ${(ocrText || '').length} chars`);
      
      // If minimal text, try more aggressive preprocessing
      if (!ocrText || ocrText.trim().length < 5) {
        try {
          // Only upscale if image is reasonably sized to avoid sharp errors
          if (width >= 200 && height >= 200) {
            const targetW = Math.max(width, 800);
            const targetH = Math.max(height, 1000);
            const upscaled = await img
              .resize({ width: targetW, height: targetH, withoutEnlargement: true })
              .toBuffer();
            const upscaledText = await recognizeWithTesseract(upscaled, { psm: '6' });
            console.log(`[EXAM-DETECT] OCR attempt 2 (upscaled to ${targetW}x${targetH}): ${(upscaledText || '').length} chars`);
            if (upscaledText && upscaledText.length > ocrText.length) {
              ocrText = upscaledText;
            }
          }
        } catch (upErr) {
          console.warn('[EXAM-DETECT] Upscaling failed:', upErr.message);
        }
      }
      
      // Last resort: try on original buffer with different PSM
      if (!ocrText || ocrText.trim().length < 5) {
        const fallbackText = await recognizeWithTesseract(imageBuffer, { psm: '1' }); // PSM 1 = auto
        console.log(`[EXAM-DETECT] OCR attempt 3 (original, PSM auto): ${(fallbackText || '').length} chars`);
        if (fallbackText && fallbackText.length > ocrText.length) {
          ocrText = fallbackText;
        }
      }
    } catch (e) {
      console.warn('[EXAM-DETECT] OCR failed:', e.message);
    }

    const trimmedOcr = (ocrText || '').trim();
    const strongKeywords = (trimmedOcr.match(STRONG_EXAM_KEYWORDS) || []).length;
    const weakKeywords = (trimmedOcr.match(EXAM_KEYWORDS) || []).length;
    
    // More generous scoring: even without strong keywords, if we have:
    // - text of reasonable length
    // - AND reasonable dimensions
    // - AND portrait aspect ratio
    // Then it's probably an exam sheet
    let ocrConfidence = Math.min(50, strongKeywords * 15 + weakKeywords * 5);
    
    // If OCR found nothing but image is large and portrait, boost confidence
    if (trimmedOcr.length === 0 && width >= 400 && height >= 500) {
      ocrConfidence = 15; // Baseline for reasonable-sized portrait documents
      console.log(`[EXAM-DETECT] No OCR text but good dimensions, baseline score: 15`);
    } else if (trimmedOcr.length > 50 && ocrConfidence < 10) {
      // If OCR found substantial text but no keywords matched, still decent chance
      ocrConfidence = Math.max(ocrConfidence, 15);
      console.log(`[EXAM-DETECT] Found text but no keywords, baseline score: 15`);
    } else if (trimmedOcr.length > 200) {
      // Substantial text without keywords is still likely an exam sheet
      ocrConfidence = Math.max(ocrConfidence, 20);
    }
    
    // DEBUG: Log OCR results
    console.log(`[EXAM-DETECT] OCR text length: ${trimmedOcr.length}, Strong: ${strongKeywords}, Weak: ${weakKeywords}, OCR Score: ${ocrConfidence}`);

    let aspectScore = 0;
    const portraitDeviation = Math.abs(1 - aspectRatio);
    const landscapeDeviation = Math.abs(aspectRatio - 1);
    const isPortrait = aspectRatio < 1;
    const isLandscape = aspectRatio > 1;

    if (isPortrait && aspectRatio >= 0.60 && aspectRatio <= 0.85) {
      aspectScore = 25;
    } else if (isPortrait && aspectRatio >= 0.55 && aspectRatio <= 0.95 && portraitDeviation <= 0.4) {
      aspectScore = 20;
    } else if ((isPortrait && aspectRatio >= 0.5 && aspectRatio <= 1.1 && portraitDeviation <= 0.5) ||
               (isLandscape && aspectRatio >= 1.5 && aspectRatio <= 2.5 && landscapeDeviation <= 0.8)) {
      aspectScore = 12;
    } else if (aspectRatio >= 0.4 && aspectRatio <= 2.5) {
      aspectScore = 5;
    }

    const cornerScore = cornersDetected ? 20 : 0;
    let rawCornerScore = 0;
    try {
      const corners = await detectDocumentCorners(imageBuffer);
      if (corners) rawCornerScore = 10;
    } catch (e) { }

    // Exam sheets are typically larger documents
    const minDimension = Math.min(width, height);
    const maxDimension = Math.max(width, height);
    let dimensionScore = 0;
    if (minDimension >= 800 && maxDimension >= 1000) {
      dimensionScore = 20; // High quality scan
    } else if (minDimension >= 600 && maxDimension >= 800) {
      dimensionScore = 18; // Good quality scan
    } else if (minDimension >= 400 && maxDimension >= 500) {
      dimensionScore = 14; // Medium quality
    } else if (minDimension >= 300 && maxDimension >= 400) {
      dimensionScore = 10; // Lower quality but still valid
    } else if (minDimension >= 250) {
      dimensionScore = 6; // Barely passable
    }

    const rawConfidence = Math.min(100, ocrConfidence + aspectScore + cornerScore + rawCornerScore + dimensionScore);
    const confidence = Math.round(rawConfidence);
    
    // DEBUG: Log all score components
    console.log(`[EXAM-DETECT] Scores - OCR: ${ocrConfidence}, Aspect: ${aspectScore}, Corner: ${cornerScore}, RawCorner: ${rawCornerScore}, Dimension: ${dimensionScore}, Final: ${confidence}%`);

    let recommendation, reason;
    if (confidence >= 75) {
      recommendation = 'accept';
      reason = strongKeywords >= 2 ? 'Clear exam sheet detected' : 'Likely exam sheet';
    } else if (confidence >= 55) {
      recommendation = 'watch';
      reason = 'Partial exam indicators found';
    } else if (confidence >= 35) {
      recommendation = 'watch';
      reason = 'Possible document, needs verification';
    } else {
      recommendation = 'reject';
      reason = 'Not detected as exam sheet';
    }

    const isExamSheet = options.fast
      ? !!placement?.acceptable && cornersDetected && confidence >= 55
      : confidence >= 55 && strongKeywords >= 1;

    return {
      isExamSheet,
      confidence,
      recommendation,
      reason,
      rectified,
      cornersDetected: cornersDetected || rawCornerScore > 0,
      placement,
      ocrText: trimmedOcr.substring(0, 500),
      imageInfo: { width, height, aspectRatio: Math.round(aspectRatio * 100) / 100 }
    };
  } catch (error) {
    console.error('Exam sheet detection error:', error);
    return {
      isExamSheet: false,
      confidence: 0,
      recommendation: 'reject',
      reason: 'Detection failed: ' + error.message,
      rectified: false,
      cornersDetected: false,
      ocrText: '',
      imageInfo: {}
    };
  }
}

module.exports = { detectExamSheet };
