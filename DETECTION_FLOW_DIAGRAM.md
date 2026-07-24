# Auto-Scan OMR Detection Flow Diagram

## High-Level User Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        TEACHER / USER                           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
                    [Open Scanner Page]
                              ↓
     ┌────────────────────────────────────────────────────────┐
     │ 1. Select Answer Key (50 questions = 50 characters)    │
     │ 2. Set Camera URL (http://192.168.254.197)           │
     │ 3. Click "Test Connection"                            │
     │ 4. Toggle "Auto-Scan" ON                              │
     └────────────────────────────────────────────────────────┘
                              ↓
                   [Point Camera at Sheet]
                              ↓
     ┌────────────────────────────────────────────────────────┐
     │     ✅ AUTO-SCAN RUNNING (2-second intervals)         │
     └────────────────────────────────────────────────────────┘
                              ↓
     ┌────────────────────────────────────────────────────────┐
     │  Frame 1: Detected 30/50 (60% confidence) → Continue  │
     │  Frame 2: Detected 45/50 (70% confidence) → Continue  │
     │  Frame 3: Detected 50/50 (85% confidence) ✅ PROCESS  │
     └────────────────────────────────────────────────────────┘
                              ↓
     ┌────────────────────────────────────────────────────────┐
     │     ✅ AUTO-GRADING (comparing to answer key)         │
     │        Question 1: Expected A, Got A ✓               │
     │        Question 2: Expected B, Got B ✓               │
     │        Question 3: Expected C, Got D ✗               │
     │        ...                                            │
     │        Score: 48/50 = 96%                            │
     └────────────────────────────────────────────────────────┘
                              ↓
     ┌────────────────────────────────────────────────────────┐
     │              [RESULTS DISPLAYED]                       │
     │        • Student: Auto-detected from OCR              │
     │        • Score: 96% (48/50 questions)                │
     │        • Per-question breakdown with confidence       │
     │        • Low-confidence answers flagged for review    │
     └────────────────────────────────────────────────────────┘
                              ↓
                    [Results Saved to DB]
```

## Technical Detection Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Angular)                            │
├──────────────────────────────────────────────────────────────────┤
│  1. Capture Frame from ESP32 Camera                              │
│     GET http://192.168.254.197/capture → JPEG blob              │
│                                                                  │
│  2. Convert to Base64                                           │
│     FileReader → "data:image/jpeg;base64,/9j/4AAQ..."         │
│                                                                  │
│  3. POST to Backend Detection Endpoint                          │
│     POST /api/omr/detect-frame                                 │
│     Body: { imageBuffer: base64, answerKey: "ABDCAB..." }      │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    (HTTP Request/Response)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                    BACKEND (Node.js)                             │
├──────────────────────────────────────────────────────────────────┤
│  POST /api/omr/detect-frame Handler                             │
│                                                                  │
│  4. Decode Base64 → Image Buffer                               │
│     Buffer.from(imageBuffer, 'base64')                         │
│                                                                  │
│  5. Preprocess Image                                           │
│     advancedPreprocessImage(buffer)                            │
│     • Grayscale conversion                                     │
│     • Threshold at pixel intensity 128                        │
│     • Downsample if > 1024px                                 │
│                                                                  │
│  6. OMR Detection (Multi-Column)                              │
│     smartBubbleDetection(processedBuffer, answerKey)          │
│     a) Vertical Projection                                     │
│        - Project darkness across X-axis                       │
│        - Identify column boundaries                           │
│     b) Column Detection                                        │
│        - Find contiguous bubble regions                       │
│        - Calculate number of columns                          │
│     c) Row Distribution                                        │
│        - Distribute questions across columns                  │
│        - Calculate row heights per column                     │
│     d) Bubble Analysis (for each bubble):                     │
│        - Calculate avg pixel intensity                        │
│        - Count dark pixels (intensity < 210)                 │
│        - Determine if marked (percentDark > 15%)             │
│     e) Confidence Scoring                                      │
│        - Base: 50                                             │
│        - Darkness factor: +10-45 (depending on intensity)    │
│        - Contrast factor: +3-5 (vs other bubbles)           │
│        - Final: min(confidence, 99)                          │
│     f) Return Results                                          │
│        { detectedAnswers: ["A","B","C",...],                │
│          confidenceScores: [92,88,75,...],                  │
│          averageConfidence: 85.3 }                          │
│                                                                  │
│  7. Format Response                                            │
│     {                                                           │
│       success: true,                                           │
│       detectedAnswers: ["A","B","C",...],                     │
│       confidenceScores: [92,88,75,...],                       │
│       averageConfidence: 85.3,                                │
│       details: {                                               │
│         numQuestions: 50,                                      │
│         numChoices: 4                                          │
│       }                                                         │
│     }                                                           │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    (HTTP Response)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                    FRONTEND (Angular)                            │
├──────────────────────────────────────────────────────────────────┤
│  8. Evaluate Results                                             │
│     allDetected = detectedAnswers.every(a => a !== '')         │
│     avgConfidence = 85.3%                                       │
│     threshold = 75%                                             │
│                                                                  │
│     IF allDetected && avgConfidence > 75:                      │
│        ✅ Confidence good! Proceed to grading                  │
│     ELSE:                                                       │
│        ⏳ Wait for next frame (2 seconds)                      │
│                                                                  │
│  9. Save Captured Image                                        │
│     preprocessImage(base64) → enhanced image                   │
│     base64ToFile() → File object                              │
│                                                                  │
│ 10. Upload & Process                                           │
│     uploadScan(file, classroomId, answerKeyId)                │
│     → POST /api/scans/upload                                 │
│     → Receive scanId                                          │
│     → Call processScan(scanId)                                │
└──────────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│            BACKEND: Full Scan Processing                         │
├──────────────────────────────────────────────────────────────────┤
│  POST /api/scans/:id/process Handler                            │
│                                                                  │
│  11. Load scan from database                                    │
│      SELECT scanned_tests WHERE id = scanId                    │
│      Load associated answer_key                                │
│                                                                  │
│  12. OCR Extraction                                             │
│      extractStudentInfo(processedBuffer)                       │
│      → studentNumber, studentName, confidence                  │
│      → Save to ocr_extractions table                          │
│                                                                  │
│  13. OMR Detection (again, now for persistence)                │
│      detectBubbles(processedBuffer, answerKeyJson)            │
│      → detectedAnswers, confidenceScores                      │
│                                                                  │
│  14. Find Student                                               │
│      SELECT students WHERE student_number = extracted         │
│      → Get student_id                                          │
│                                                                  │
│  15. Grade Exam                                                 │
│      gradeExam(detectedAnswers, answerKeyArray)               │
│      {                                                          │
│        results: [                                              │
│          { questionNumber: 1, detected: "A", correct: "A",   │
│            isCorrect: true, score: 1 },                       │
│          { questionNumber: 2, detected: "B", correct: "B",   │
│            isCorrect: true, score: 1 },                       │
│          { questionNumber: 3, detected: "D", correct: "C",   │
│            isCorrect: false, score: 0 },                      │
│          ...                                                    │
│        ],                                                       │
│        totalScore: 48,                                         │
│        percentage: 96                                          │
│      }                                                          │
│                                                                  │
│  16. Persist OMR Results                                        │
│      INSERT INTO omr_results                                   │
│      (scanned_test_id, question_number, detected_answer,      │
│       correct_answer, is_correct, confidence)                 │
│      → One row per question                                    │
│                                                                  │
│  17. Persist Exam Response                                      │
│      INSERT/UPDATE exam_responses                             │
│      (student_id, scanned_test_id, answers_json,             │
│       score_per_question_json, total_score, percentage)      │
│                                                                  │
│  18. Update Scan Status                                         │
│      UPDATE scanned_tests                                      │
│      SET scan_status = 'completed', processed_at = NOW()     │
│                                                                  │
│  19. Log Activity                                               │
│      INSERT INTO activity_logs                                 │
│      'OMR scan processed successfully'                        │
│                                                                  │
│  20. Return Complete Scan Details                              │
│      {                                                          │
│        scan: {...full scan data...},                          │
│        omrResults: [...all questions...],                    │
│        ocrExtractions: [...name, ID...],                    │
│        examResponse: {...grades...}                          │
│      }                                                          │
└──────────────────────────────────────────────────────────────────┘
                              ↓
                    (HTTP Response)
                              ↓
┌──────────────────────────────────────────────────────────────────┐
│                    FRONTEND: Display Results                     │
├──────────────────────────────────────────────────────────────────┤
│  21. Show Results Screen                                        │
│      • Student name & ID (from OCR)                           │
│      • Total score: 96% (48/50)                              │
│      • Per-question breakdown:                                │
│        Q1: Expected A, Got A, Confidence 92% ✓              │
│        Q2: Expected B, Got B, Confidence 88% ✓              │
│        Q3: Expected C, Got D, Confidence 75% ✗              │
│        ...                                                    │
│      • Low-confidence answers highlighted for review         │
└──────────────────────────────────────────────────────────────────┘
```

## Multi-Column Detection Algorithm

```
                    INPUT: Image Buffer
                              ↓
        ┌───────────────────────────────────────────────┐
        │  VERTICAL PROJECTION (Darkness Analysis)      │
        ├───────────────────────────────────────────────┤
        │ For each X coordinate (0 to width):          │
        │   Sum darkness = Σ(255 - pixel_value) for Y  │
        │ Result: projection array [vp0, vp1, ...]     │
        └───────────────────────────────────────────────┘
                              ↓
        ┌───────────────────────────────────────────────┐
        │  SMOOTH PROJECTION (Noise Reduction)          │
        ├───────────────────────────────────────────────┤
        │ Apply moving average filter                   │
        │ Window size: max(5, width * 1%)              │
        │ Result: smoother [vpSm0, vpSm1, ...]         │
        └───────────────────────────────────────────────┘
                              ↓
        ┌───────────────────────────────────────────────┐
        │  COLUMN DETECTION (Threshold Analysis)        │
        ├───────────────────────────────────────────────┤
        │ Find peak projection value: maxVp            │
        │ Set threshold: colThreshold = maxVp * 0.25   │
        │ Scan for regions > threshold:                │
        │   - Continuous high values = 1 column       │
        │   - Gap between high values = separate cols  │
        │ Result: colRegions = [[x1,x2], [x3,x4], ...] │
        └───────────────────────────────────────────────┘
                              ↓
        ┌───────────────────────────────────────────────┐
        │  COLUMN MERGING (Remove Noise)               │
        ├───────────────────────────────────────────────┤
        │ Filter tiny regions: width < 3% of total    │
        │ Merge adjacent regions if close             │
        │ Result: final columns = [[x1,x2], [x3,x4]]  │
        └───────────────────────────────────────────────┘
                              ↓
        ┌───────────────────────────────────────────────┐
        │  ROW DISTRIBUTION (Question Mapping)          │
        ├───────────────────────────────────────────────┤
        │ numColumns = length(columns)                 │
        │ baseRows = floor(totalQuestions / numColumns)│
        │ extra = totalQuestions % numColumns          │
        │ For column i:                                │
        │   rowsInCol = baseRows + (i < extra ? 1:0)  │
        │ Distribute questions left-to-right,         │
        │ top-to-bottom within each column            │
        │ Result: question layout map                 │
        └───────────────────────────────────────────────┘
                              ↓
        ┌───────────────────────────────────────────────┐
        │  BUBBLE ANALYSIS (Per Question)              │
        ├───────────────────────────────────────────────┤
        │ For each question cell (column, row):        │
        │   For each choice bubble (A, B, C, D):      │
        │     density = calculateShadingDensity()     │
        │     avgIntensity = mean pixel value         │
        │     percentDark = dark_pixels / total       │
        │   Find darkest bubble                        │
        │   isMarked = percentDark > 15% &&           │
        │             avgIntensity < 210              │
        │ Result: detectedAnswers, confidences        │
        └───────────────────────────────────────────────┘
                              ↓
                    OUTPUT: OMR Results
```

## Confidence Scoring Details

```
For each detected bubble:

┌─────────────────────────────────────────────┐
│         CONFIDENCE CALCULATION              │
├─────────────────────────────────────────────┤
│ Base Score: 50 points                      │
│                                             │
│ + DARKNESS FACTOR (up to +45 points):      │
│   if avgIntensity < 100:    +45 points     │
│   if avgIntensity < 150:    +40 points     │
│   if avgIntensity < 180:    +30 points     │
│   if avgIntensity < 210:    +20 points     │
│   else:                     +10 points     │
│                                             │
│ + CONTRAST FACTOR (up to +5 points):       │
│   Contrast = avgOtherIntensity -           │
│              avgMarkedIntensity            │
│   if contrast > 100:        +5 points      │
│   if contrast > 80:         +3 points      │
│                                             │
│ = FINAL SCORE (capped at 99)              │
└─────────────────────────────────────────────┘

Example:
  Marked bubble: avgIntensity = 90
  Other bubbles: avgIntensity = 190
  Contrast = 100

  Score = 50 (base)
        + 45 (intensity < 100)
        + 5 (contrast > 100)
        = 100 → capped to 99
```

## Decision Tree: Auto-Process or Wait?

```
                  Frame Captured
                        ↓
              Run OMR Detection
                        ↓
        ┌───────────────────────────────┐
        │ Are all questions detected?   │
        ├───────────────────────────────┤
        │ (No empty answer slots)       │
        └───────────────────────────────┘
          ↙ NO                    YES ↘
         ⏳                          ↓
      Continue          Average Confidence > 75%?
      Scanning                       ↓
                         ✅ YES ↓        ↓ ⚠️ NO
                                  ↓      ⏳
                          [PROCESS!]   Continue
                          [AUTO-SAVE]   Scanning
                          [AUTO-GRADE]
                                  ↓
                          Results Displayed
```

---

**This diagram shows the complete end-to-end flow from user opening the app to seeing grading results!**
