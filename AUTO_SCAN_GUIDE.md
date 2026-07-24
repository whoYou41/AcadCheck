# Auto-Scan OMR Detection Guide

## Overview

The auto-scan feature enables **real-time, automated optical mark recognition (OMR)** for exam sheets. It intelligently detects shaded bubbles, calculates confidence scores, and automatically grades papers against an answer key.

## How It Works

### Detection Pipeline

```
Camera Frame
    ↓
[Capture] → Convert to Base64
    ↓
[Backend] → Preprocess Image (grayscale, threshold)
    ↓
[Column Detection] → Find answer column boundaries
    ↓
[Row Detection] → Identify question rows
    ↓
[Bubble Analysis] → Calculate shading density per bubble
    ↓
[Confidence Scoring] → Rate each detection
    ↓
[Result] → Return detected answers + confidence scores
    ↓
[Frontend] → If confidence > 75% AND all detected → Auto-grade
```

### Multi-Column Layout Support

The detection algorithm automatically discovers how many columns of bubbles exist on the sheet:

1. **Vertical Projection**: Analyzes darkness levels across the image width
2. **Column Regions**: Identifies contiguous areas of high bubble density
3. **Row Distribution**: Distributes questions evenly across detected columns
4. **Per-Column Scanning**: Processes each column independently for accuracy

This supports **any number of columns** without manual configuration—just point the camera at the sheet!

## Using Auto-Scan

### Setup

1. **Load Answer Key**
   - Select an answer key in the dropdown (format: `ABCDABCDABCD...`)
   - E.g., 50-question sheet requires 50-character string

2. **Point Camera**
   - Enter ESP32 camera URL (default: `http://192.168.254.197`)
   - Click **Test Connection** to verify camera is online

3. **Enable Auto-Scan**
   - Toggle **Auto-Scan** checkbox
   - Camera will start monitoring for sheets

### During Scan

- Frontend captures frames every **2 seconds**
- Each frame is sent to backend for real-time analysis
- When **confidence > 75% AND all questions detected**:
  - Paper is locked (auto-scan stops)
  - Image is saved
  - Automatic grading begins
- Results display immediately with per-question breakdown

### Confidence Scoring

Each detected bubble gets a confidence score (0-99%) based on:

- **Darkness level** of the marked bubble (darker = higher confidence)
- **Contrast** with unmarked bubbles in the same row
- **Consistency** with adjacent question bubbles

An answer with <50% confidence appears in the results with a warning—teacher can manually review if needed.

## Configuration

### Image Preprocessing

Located in `backend/enhanced-scanner.js`, function `advancedPreprocessImage()`:

- **Downsampling**: Resizes large images to max 1024px (preserves quality)
- **Grayscale conversion**: Reduces color noise
- **Binary threshold**: Converts to pure black/white
- **Dilation/Erosion**: Fills small gaps in bubble marks

### Bubble Detection Thresholds

Adjust these parameters in `smartBubbleDetection()`:

```javascript
// Darkness threshold for "marked" vs "unmarked"
const percentDarkThreshold = 0.15;  // % of pixels darker than 210

// Intensity threshold for confident detection
const avgIntensityThreshold = 210;  // Pixel values < 210 = likely marked

// Contrast factor
const minContrastForConfidence = 80; // Difference from unmakred bubbles
```

**Tuning tips:**
- If detecting too many false positives: **increase thresholds**
- If missing light/partial marks: **decrease thresholds**
- Run `test-omr-detection.js` on actual sheets to find optimal values

### Column Detection Sensitivity

```javascript
const colThreshold = Math.max(10, maxVp * 0.25); // Column darkness threshold
```

- Increase multiplier (0.25 → 0.35) for fewer, wider columns
- Decrease multiplier (0.25 → 0.15) for more, narrower columns

## Backend Endpoints

### `POST /api/omr/detect-frame`

Performs real-time OMR detection on a single frame.

**Request:**
```json
{
  "imageBuffer": "base64-encoded-image",
  "answerKeyId": 1
  // OR
  "answerKey": "ABCDABCDABCD..."
}
```

**Response:**
```json
{
  "success": true,
  "detectedAnswers": ["A", "B", "C", "", "A", ...],
  "confidenceScores": [92, 88, 75, 0, 85, ...],
  "averageConfidence": 82.5,
  "details": {
    "numQuestions": 50,
    "numChoices": 4
  }
}
```

### `POST /api/scans/:id/process`

Performs complete processing: OCR + OMR + Grading + Persistence.

Called automatically after auto-scan detection.

## Troubleshooting

### No Bubbles Detected

**Check:**
1. Camera image clarity (test with `/capture` endpoint)
2. Lighting conditions (proper contrast needed)
3. Threshold values (run `test-omr-detection.js`)
4. Sheet orientation (should be straight, not tilted)

**Solution:**
- Adjust `avgIntensityThreshold` or `percentDarkThreshold`
- Improve lighting to increase bubble contrast

### Low Confidence Scores

**Common causes:**
1. Partial marks (light pencil, not fully shaded)
2. Nearby marks interfering (teacher notes near bubbles)
3. Creased/folded paper
4. Different bubble sizes

**Solution:**
- Decrease intensity threshold to accept lighter marks
- Increase margin padding to exclude nearby text
- For creased papers: manually verify in UI

### False Multi-Column Detection

**If detecting wrong number of columns:**

1. Check column threshold: `colThreshold = Math.max(10, maxVp * 0.25)`
2. Increase multiplier to merge nearby columns
3. Or provide explicit column count (future feature)

### Camera Not Connecting

**Check:**
1. Camera IP address is correct
2. Firewall allows HTTP on port 80
3. Camera firmware has `/capture` and `/status` endpoints
4. Try `curl http://192.168.254.197/capture` from desktop

## Testing

### Test on Sample Image

```bash
cd backend
node test-omr-detection.js ../path/to/sheet.jpg "ABDCAABDCAABDCAABDCAABDCAABDCAABDCAABDCAABDCAABDCA"
```

Output includes:
- Per-question accuracy
- Average confidence
- JSON report saved to `omr-test-results.json`

### Live Frontend Test

1. Start backend: `node server.js`
2. Open frontend in browser
3. Select answer key
4. Set camera URL
5. Enable **Auto-Scan**
6. Hold paper in front of camera
7. Wait for detection (2-second intervals)

## Performance

- **Detection latency**: ~500ms per frame
- **Frame capture rate**: Every 2 seconds (configurable)
- **Memory usage**: ~50-100MB per frame (native image buffers)
- **GPU acceleration**: None (CPU-based Sharp + Tesseract)

**Optimization ideas:**
- Batch multiple frames for parallel processing
- Cache answer key preprocessing
- Use WebGL for preprocessing in frontend
- Implement frame skipping on low confidence

## Advanced: Custom Answer Key Format

Current format: `ABCDABCDABCD...` (string of letters)

To support other formats (numeric, multiple answers per question):
1. Modify `smartBubbleDetection()` to accept structured answer key
2. Update `/api/omr/detect-frame` request schema
3. Adjust confidence calculation for multi-answer questions

## Known Limitations

1. **Single-sided sheets only** - No support for back-of-page detection
2. **Tilted papers** - No perspective correction (manual straightening required)
3. **Overlapping marks** - Returns highest-confidence bubble only
4. **Different bubble styles** - Trained on standard oval/circle marks

## Future Enhancements

- [ ] Perspective correction (auto-deskew tilted papers)
- [ ] Registration point detection (automatic sheet alignment)
- [ ] Multi-page exam support
- [ ] Barcode/QR code integration for student ID
- [ ] Confidence-based manual review workflow
- [ ] Batch processing (multiple sheets at once)
- [ ] GPU acceleration via TensorFlow.js

## Feedback & Issues

Report issues with:
- Sheet type (e.g., A4, Legal, custom size)
- Bubble style (e.g., hexagon, diamond, square)
- Lighting conditions
- Camera resolution/quality

Include:
- Sample sheet image
- Answer key used
- Detected answers vs. expected
- Confidence scores
- Camera model/firmware version
