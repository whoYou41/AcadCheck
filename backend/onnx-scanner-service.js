const ort = require('onnxruntime-node');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

// Calibrated after rebuilding the model from all-A/B/C/D, random, blank, and
// verified camera patches. The new model has a conventional marked boundary;
// keep this configurable for future explicitly validated retraining.
const BUBBLE_RAW_MARKED_THRESHOLD = Number(process.env.ONNX_BUBBLE_RAW_THRESHOLD || 0.50);

const TEXT_VOCAB = [];
for (let c = 65; c <= 90; c++) TEXT_VOCAB.push(String.fromCharCode(c));
for (let c = 97; c <= 122; c++) TEXT_VOCAB.push(String.fromCharCode(c));
for (let d = 0; d <= 9; d++) TEXT_VOCAB.push(String(d));
TEXT_VOCAB.push(' ', '-', "'", '.', ',', '/');

const TEXT_IDX_TO_CHAR = {};
TEXT_VOCAB.forEach((ch, i) => {
  TEXT_IDX_TO_CHAR[i + 1] = ch;
});

class OnnxScannerService {
  constructor(modelsDir = path.join(__dirname, 'models')) {
    this.modelsDir = modelsDir;
    this.bubbleSession = null;
    this.digitSession = null;
    this.textSession = null;
    this.useOnnx = false;
    this.loadedModels = [];
    this._initPromise = null;
  }

  async init(modelsDir = this.modelsDir) {
    if (modelsDir && path.resolve(modelsDir) !== path.resolve(this.modelsDir)) {
      this.modelsDir = modelsDir;
      this._resetSessions();
    }
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._loadModels();
    return this._initPromise;
  }

  _resetSessions() {
    this.bubbleSession = null;
    this.digitSession = null;
    this.textSession = null;
    this.useOnnx = false;
    this.loadedModels = [];
    this._initPromise = null;
  }

  async reload(modelsDir = this.modelsDir) {
    this.modelsDir = modelsDir;
    this._resetSessions();
    return this.init(modelsDir);
  }

  async _loadModels() {
    const modelsToLoad = [
      { key: 'bubble', file: 'bubble-classifier.onnx', session: 'bubbleSession' },
      { key: 'digit', file: 'digit-classifier.onnx', session: 'digitSession' },
      { key: 'text', file: 'text-recognizer.onnx', session: 'textSession' },
    ];

    for (const m of modelsToLoad) {
      const modelPath = path.join(this.modelsDir, m.file);
      try {
        if (!fs.existsSync(modelPath)) {
          console.warn(`[ONNX] Model file not found: ${modelPath}. Falling back to classical CV.`);
          continue;
        }
        const session = await ort.InferenceSession.create(modelPath, {
          executionProviders: ['cpu'],
          graphOptimizationLevel: 'all',
        });
        this[m.session] = session;
        this.loadedModels.push(m.key);
        console.log(`[ONNX] Loaded ${m.key} classifier from ${m.file}`);
      } catch (err) {
        console.warn(`[ONNX] Failed to load ${m.file}: ${err.message}`);
      }
    }

    this.useOnnx = this.loadedModels.length > 0;
    if (this.useOnnx) {
      console.log(`[ONNX] ONNX inference enabled. Loaded models: ${this.loadedModels.join(', ')}`);
    } else {
      console.warn('[ONNX] No models loaded. System will use classical CV heuristics only.');
    }
    return this.useOnnx;
  }

  _preprocessPatch(patchBuffer, inputSize = 32) {
    // Must match ml-training/train_on_real_v3.py: normalize + sharpen + resize + /255
    return sharp(patchBuffer)
      .greyscale()
      .normalize()
      .sharpen({ sigma: 0.8 })
      .resize(inputSize, inputSize)
      .raw()
      .toBuffer({ resolveWithObject: true })
      .then(result => {
        const pixels = result.data;
        const floatData = new Float32Array(pixels.length);
        for (let i = 0; i < pixels.length; i++) {
          floatData[i] = pixels[i] / 255.0;
        }
        return floatData;
      });
  }

  _calibrateBubbleProbability(rawProbability) {
    const probability = Math.max(1e-7, Math.min(1 - 1e-7, Number(rawProbability) || 0));
    const threshold = Math.max(1e-5, Math.min(1 - 1e-5, BUBBLE_RAW_MARKED_THRESHOLD));
    const odds = probability / (1 - probability);
    const thresholdOdds = threshold / (1 - threshold);
    return odds / (odds + thresholdOdds);
  }

  async classifyBubble(patchBuffer, threshold = 0.5) {
    if (!this.bubbleSession) return null;
    
    try {
      const inputData = await this._preprocessPatch(patchBuffer, 32);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 1, 32, 32]);
      
      const results = await this.bubbleSession.run({ input: inputTensor });
      const logits = results.output.data;
      
      const temperature = 1.0;
      const scaledLogits = logits.map(val => val / temperature);
      const maxLogit = Math.max(...scaledLogits);
      const expSum = scaledLogits.reduce((sum, val) => sum + Math.exp(val - maxLogit), 0);
      const probabilities = scaledLogits.map(val => Math.exp(val - maxLogit) / expSum);
      
      const rawMarkedProbability = probabilities[1];
      const markedProb = this._calibrateBubbleProbability(rawMarkedProbability);
      const isMarked = markedProb > threshold;
      
      return {
        isMarked,
        confidence: markedProb,
        blankProbability: probabilities[0],
        markedProbability: markedProb,
        rawMarkedProbability,
        rawLogits: Array.from(logits),
      };
    } catch (err) {
      console.warn('[ONNX] Bubble classification error:', err.message);
      return null;
    }
  }

  /**
   * Classify a bubble patch and return the raw marked probability (0-1)
   * without applying a threshold. Useful for weighted scoring.
   */
  async getBubbleMarkedProbability(patchBuffer) {
    if (!this.bubbleSession) return null;
    
    try {
      const inputData = await this._preprocessPatch(patchBuffer, 32);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 1, 32, 32]);
      
      const results = await this.bubbleSession.run({ input: inputTensor });
      const logits = results.output.data;
      
      const temperature = 1.0;
      const scaledLogits = logits.map(val => val / temperature);
      const maxLogit = Math.max(...scaledLogits);
      const expSum = scaledLogits.reduce((sum, val) => sum + Math.exp(val - maxLogit), 0);
      const probabilities = scaledLogits.map(val => Math.exp(val - maxLogit) / expSum);
      
      return this._calibrateBubbleProbability(probabilities[1]);
    } catch (err) {
      console.warn('[ONNX] Bubble probability error:', err.message);
      return null;
    }
  }

  async classifyDigit(patchBuffer, topK = 3) {
    if (!this.digitSession) return null;
    
    try {
      const inputData = await this._preprocessPatch(patchBuffer, 32);
      const inputTensor = new ort.Tensor('float32', inputData, [1, 1, 32, 32]);
      
      const results = await this.digitSession.run({ input: inputTensor });
      const logits = Array.from(results.output.data);
      
      const indexed = logits.map((val, idx) => ({ val, idx }));
      indexed.sort((a, b) => b.val - a.val);
      const top = indexed.slice(0, topK);
      
      const maxLogit = top[0].val;
      const expSum = top.reduce((sum, item) => sum + Math.exp(item.val - maxLogit), 0);
      const probabilities = top.map(item => ({
        digit: item.idx,
        confidence: Math.exp(item.val - maxLogit) / expSum,
      }));
      
      return {
        digit: probabilities[0].digit,
        confidence: probabilities[0].confidence,
        topK: probabilities,
      };
    } catch (err) {
      console.warn('[ONNX] Digit classification error:', err.message);
      return null;
    }
  }

  async recognizeText(imageBuffer, imgWidth = 128, imgHeight = 32) {
    if (!this.textSession) return null;
    
    try {
      const meta = await sharp(imageBuffer).metadata();
      const origW = meta.width || imgWidth;
      const origH = meta.height || imgHeight;

      const scale = imgHeight / origH;
      const scaledW = Math.round(origW * scale);
      const finalW = Math.min(imgWidth, Math.max(1, scaledW));

      const resized = await sharp(imageBuffer)
        .greyscale()
        .resize(finalW, imgHeight, { fit: 'fill', withoutEnlargement: false })
        .extend({
          top: 0,
          bottom: 0,
          left: Math.max(0, Math.floor((imgWidth - finalW) / 2)),
          right: Math.max(0, imgWidth - finalW - Math.floor((imgWidth - finalW) / 2)),
        })
        .raw()
        .toBuffer({ resolveWithObject: true });

      const pixels = resized.data;
      const floatData = new Float32Array(pixels.length);
      for (let i = 0; i < pixels.length; i++) {
        floatData[i] = pixels[i] / 255.0;
      }

      const inputTensor = new ort.Tensor('float32', floatData, [1, 1, imgHeight, imgWidth]);
      
      const results = await this.textSession.run({ input: inputTensor });
      const logits = results.logits.data;
      const seqLen = results.logits.dims[1];
      const numClasses = results.logits.dims[2];
      
      const decoded = this._ctcGreedyDecode(logits, seqLen, numClasses);
      
      const confidence = this._computeConfidence(logits, seqLen, numClasses, decoded);
      
      return {
        text: decoded,
        confidence,
        rawLogits: Array.from(logits).slice(0, 1000),
      };
    } catch (err) {
      console.warn('[ONNX] Text recognition error:', err.message);
      return null;
    }
  }

  _ctcGreedyDecode(logits, seqLen, numClasses) {
    const chars = [];
    let prev = -1;
    
    for (let t = 0; t < seqLen; t++) {
      let maxVal = -Infinity;
      let maxIdx = 0;
      for (let c = 0; c < numClasses; c++) {
        const val = logits[t * numClasses + c];
        if (val > maxVal) {
          maxVal = val;
          maxIdx = c;
        }
      }
      
      if (maxIdx !== 0 && maxIdx !== prev) {
        const ch = TEXT_IDX_TO_CHAR[maxIdx];
        if (ch) chars.push(ch);
      }
      prev = maxIdx;
    }
    
    return chars.join('').trim();
  }

  _computeConfidence(logits, seqLen, numClasses, decoded) {
    if (decoded.length === 0) return 0;
    
    let sum = 0;
    let count = 0;
    const charProbs = [];
    
    for (let t = 0; t < seqLen; t++) {
      let maxVal = -Infinity;
      for (let c = 0; c < numClasses; c++) {
        const val = logits[t * numClasses + c];
        if (val > maxVal) maxVal = val;
      }
      sum += maxVal;
      count++;
    }
    
    const avgLogit = count > 0 ? sum / count : -Infinity;
    const confidence = Math.max(0, Math.min(100, Math.exp(avgLogit) * 100));
    return Math.round(confidence);
  }

  isAvailable() {
    return this.useOnnx;
  }

  getLoadedModels() {
    return this.loadedModels;
  }

  getBubbleCalibration() {
    return { rawMarkedThreshold: BUBBLE_RAW_MARKED_THRESHOLD };
  }
}

module.exports = new OnnxScannerService();
