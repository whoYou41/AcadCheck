# AcadCheck ONNX Integration — Operation Guide

## Overview

AcadCheck now supports ONNX Runtime for learned inference on OMR-critical tasks:

1. **Bubble Marking Classifier** — replaces hand-tuned darkness thresholds with a learned CNN for detecting marked vs. blank bubbles on **4-choice (A–D)** exam sheets.
2. **Digit Classifier** — augments Tesseract OCR with a learned digit recognizer for structured numeric fields.
3. **Text Recognizer (CRNN)** — augments Tesseract OCR with a learned sequence text recognizer for exam-sheet text fields (student names, IDs, sequence strings).

The system remains fully backward-compatible: if ONNX models are absent, it falls back to classical computer vision heuristics with no code changes required.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     AcadCheck Backend                       │
│                                                             │
│  Image Buffer                                               │
│      ↓                                                     │
│  [advancedPreprocessImage] — sharp (classical CV)          │
│      ↓                                                     │
│  ┌─────────────────┬───────────────────────┐                │
│  │                 │                       │                │
│  │  [smartBubbleDetection]            │                │
│  │    - Classical CV (darkness-wins) │                │
│  │    - ONNX patch classifier        │                │
│  │      (optional augmentation)      │                │
│  │                 │                       │                │
│  │  [detectAnswersFromOCRPattern]     │                │
│  │    - Tesseract OCR + intensity    │                │
│  │                 │                       │                │
│  │  [hybridDetectAnswers]             │                │
│  │    - Merge OCR + bubble results   │                │
│  └─────────────────┴───────────────────────┘                │
│                                                             │
│  [enhancedExtractStudentInfo]                               │
│    - Tesseract + regex                                       │
│    - ONNX text recognizer (optional augmentation)           │
│    - ONNX digit classifier (optional augmentation)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### ONNX Inference Service (`onnx-scanner-service.js`)

```js
const OnnxService = require('./onnx-scanner-service');
await OnnxService.init();
const bubbleResult = await OnnxService.classifyBubble(patchBuffer);
const digitResult = await OnnxService.classifyDigit(digitPatch);
const textResult = await OnnxService.recognizeText(textCropBuffer, width, height);
```

**Key features:**
- Lazy loading with graceful fallback if models are missing
- CPU execution with `all` graph optimizations
- Softmax probability output for confidence calibration
- CTC greedy decoding for text recognizer output
- CTC greedy decoding for text recognizer output

---

## Training Pipeline

### Prerequisites

```bash
# Create Python virtual environment (recommended)
python -m venv ml-training/venv
# Windows:
ml-training\venv\Scripts\activate
# Linux/Mac:
source ml-training/venv/bin/activate

# Install dependencies
pip install -r ml-training/requirements.txt
```

### Step 1: Generate Synthetic Training Data

```bash
cd ml-training

# Generate 10,000 blank + 10,000 marked bubble patches (32×32 grayscale)
python generate_synthetic_data.py

# Generate 20,000 digit patches (0-9, 32×32 grayscale)
python generate_digit_data.py

# Generate 20,000 text-line patches (exam-sheet style words, 128×32 grayscale)
python generate_text_data.py
```

Output directories (all inside `ml-training/`):
- `bubble_dataset/` — blank/ and marked/ subdirectories
- `bubble_dataset_val/` — validation set
- `digit_dataset/` — 0/ through 9/ subdirectories
- `digit_dataset_val/` — validation set
- `text_dataset/` — train/ and val/ subdirectories with `labels.txt`
- `text_dataset_val/` — separate validation set (optional)

### Step 2: Train Models

```bash
# Train bubble classifier (binary: blank vs marked)
python train_bubble_classifier.py

# Train digit classifier (10 classes: 0-9)
python train_digit_classifier.py

# Train text recognizer (CRNN + CTC, alphanumeric vocabulary)
python train_text_recognizer.py
```

Expected training time: ~5-15 minutes on CPU, ~1-3 minutes on GPU.

Output: `bubble_classifier_best.pth`, `digit_classifier_best.pth`, `text_recognizer_best.pth`

### Step 3: Export to ONNX

```bash
# Export bubble classifier
python export_bubble_onnx.py
# Output: backend/models/bubble-classifier.onnx

# Export digit classifier
python export_digit_onnx.py
# Output: backend/models/digit-classifier.onnx

# Export text recognizer
python export_text_onnx.py
# Output: backend/models/text-recognizer.onnx
```

### Step 4: Deploy Models

Place the `.onnx` files in `backend/models/`:

```
backend/
  models/
    bubble-classifier.onnx
    digit-classifier.onnx
    text-recognizer.onnx
```

The ONNX service auto-detects these on startup or when the reload endpoint is called.

---

## How the System Operates with ONNX

### Startup Sequence

1. `server.js` connects to MySQL
2. Runs pending migrations
3. Calls `OnnxService.init(modelsDir)`
4. ONNX service scans `backend/models/` for `.onnx` files
5. Loads available models with `cpu` execution provider
6. Logs loaded model names or warns if none found

### Bubble Detection with ONNX

In `smartBubbleDetection` (`enhanced-scanner.js`):

1. Classical CV computes bubble measurements (intensity, darkness %, contrast)
2. For each of the 4 choices per question, a patch around the bubble center is extracted
3. If ONNX bubble classifier is available:
   - Patch is preprocessed (resize to 32×32, normalize, sharpen)
   - ONNX inference returns `{ isMarked, confidence, blankProbability, markedProbability }`
   - If `isMarked === true`, the letter is added to `markedLetters`
4. Classical CV `isBlocked` check still runs; ONNX acts as an augmentation layer
5. Confidence scores from classical CV are preserved; ONNX presence is logged in details

**When ONNX helps most:**
- Faint marks that classical intensity thresholds miss
- Non-standard mark styles (X marks, checkmarks, heavy scribbles)
- Low-contrast scans where relative darkness is ambiguous

**Fallback:** If ONNX model is not loaded or inference fails, the system uses only classical CV heuristics — no change in behavior.

### Structured Field OCR with ONNX

In `enhancedExtractStudentInfo`:

1. Tesseract.js runs on the full image buffer
2. Regex patterns extract candidate student numbers and names
3. If ONNX digit classifier is available:
   - Digit patches are extracted from detected number regions
   - ONNX classifies each digit with top-3 candidates
   - Results can be used to validate or correct OCR output
4. If ONNX text recognizer is available:
   - Text crops are extracted from candidate name/ID regions
   - ONNX text recognizer decodes the crop using CTC greedy decoding
   - Results can be used to validate or correct Tesseract output
5. Name extraction remains Tesseract + regex, augmented by ONNX text results when confidence is higher

---

## API Endpoints

### `GET /api/omr/onnx/status`

Returns ONNX service status.

**Headers:** `Authorization: Bearer <token>`

**Response:**
```json
{
  "success": true,
  "available": true,
  "loadedModels": ["bubble", "digit", "text"],
  "modelsDir": "C:\\xampp\\htdocs\\AcadCheck\\backend\\models"
}
```

### `POST /api/omr/onnx/reload`

Reload ONNX models from disk (admin only).

**Headers:** `Authorization: Bearer <admin_token>`

**Body:**
```json
{
  "modelsDir": "C:\\xampp\\htdocs\\AcadCheck\\backend\\models"
}
```

**Response:**
```json
{
  "success": true,
  "available": true,
  "loadedModels": ["bubble", "digit", "text"],
  "message": "ONNX models reloaded successfully"
}
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ONNX_MODELS_DIR` | `backend/models` | Directory containing `.onnx` model files |

Add to `backend/.env`:
```env
ONNX_MODELS_DIR=./models
```

### Model Requirements

| Model | Input Shape | Output Shape | Description |
|-------|-------------|--------------|-------------|
| `bubble-classifier.onnx` | `[batch, 1, 32, 32]` | `[batch, 2]` logits | Blank vs. marked bubble |
| `digit-classifier.onnx` | `[batch, 1, 32, 32]` | `[batch, 10]` logits | Single digit 0-9 |
| `text-recognizer.onnx` | `[batch, 1, 32, 128]` | `[batch, 32, num_classes]` logits | Fixed-width CRNN text sequence |

- Format: ONNX opset 17
- Input: `float32` tensor, values in `[0, 1]`
- Output: `float32` logits (apply softmax/CTC decode as needed)
- Execution provider: `cpu`
- Text recognizer uses fixed 128×32 input and fixed seq_len=32 output

---

## Troubleshooting

### Models not loading

1. Check file exists: `ls backend/models/*.onnx`
2. Verify ONNX Runtime is installed: `npm ls onnxruntime-node`
3. Check server logs for specific error messages
4. Ensure model input/output names match: input=`input`, output=`output`

### Low ONNX confidence

- Retrain with more diverse synthetic data (different mark styles, blur levels, rotations)
- Adjust classification threshold in `classifyBubble(threshold)` (default: 0.5)
- Check preprocessing: ensure patches are 32×32 grayscale normalized

### Low text recognition accuracy

- Increase synthetic text dataset size (`generate_text_data.py` default: 20,000)
- Add exam-sheet-specific fonts to `FONTS` in the data generator
- Adjust text crop regions in `enhancedExtractStudentInfo` to better match your sheet layout
- Train for more epochs or adjust learning rate in `train_text_recognizer.py`

### Performance

- ONNX inference adds ~5-20ms per bubble patch on CPU
- For 50 questions × 4 choices = 200 patches, expect ~1-4s additional time
- Consider batching patches or using a GPU execution provider for faster inference

---

## Maintenance

### Retraining Models

When new scan patterns emerge (different bubble shapes, pen types, paper quality):

1. Update `generate_synthetic_data.py` with new mark styles
2. Regenerate dataset: `python generate_synthetic_data.py`
3. Retrain: `python train_bubble_classifier.py`
4. Export: `python export_bubble_onnx.py`
5. Copy `backend/models/bubble-classifier.onnx`
6. Reload via API or restart server

### Retraining Text Recognizer

When OCR errors persist on new sheet fonts or layouts:

1. Update `generate_text_data.py`:
   - Add new fonts to `FONTS`
   - Add domain-specific words to `WORD_POOL`
2. Regenerate dataset: `python generate_text_data.py`
3. Retrain: `python train_text_recognizer.py`
4. Export: `python export_text_onnx.py`
5. Copy `backend/models/text-recognizer.onnx`
6. Reload via API or restart server

### Model Versioning

Replace existing `.onnx` files in `backend/models/` and call `POST /api/omr/onnx/reload` to hot-swap without restart.
