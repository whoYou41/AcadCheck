const assert = require('assert');
const SequenceDetector = require('./sequence-detector');

const { locateCanonicalProfile } = SequenceDetector._test;

function drawField(boxCount, { includeBottom = true } = {}) {
  const width = 580;
  const height = 335;
  const pixels = Buffer.alloc(width * height, 255);
  const left = Math.round(width * (boxCount === 4 ? 0.425 : 0.526));
  const fieldWidth = Math.round(width * (boxCount === 4 ? 0.405 : 0.203));
  const right = left + fieldWidth - 1;
  const top = 120;
  const bottom = 220;
  const paint = (x, y) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && px < width && py >= 0 && py < height) pixels[py * width + px] = 0;
      }
    }
  };
  for (let x = left; x <= right; x++) {
    paint(x, top);
    if (includeBottom) paint(x, bottom);
  }
  for (let boundary = 0; boundary <= boxCount; boundary++) {
    const x = Math.round(left + (fieldWidth - 1) * boundary / boxCount);
    for (let y = top; y <= bottom; y++) paint(x, y);
  }
  return { pixels, width, height };
}

assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('1'), '1');
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('01'), '1');
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('0001'), '1');
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('0099'), '99');
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('0000'), null);
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('0100'), null);
assert.strictEqual(SequenceDetector.normalizeStandaloneSequence('1O'), null);

const twoBox = drawField(2);
assert.strictEqual(locateCanonicalProfile(twoBox.pixels, twoBox.width, twoBox.height, 4), null);
assert.strictEqual(locateCanonicalProfile(twoBox.pixels, twoBox.width, twoBox.height, 2)?.boxCount, 2);

const fourBox = drawField(4);
assert.strictEqual(locateCanonicalProfile(fourBox.pixels, fourBox.width, fourBox.height, 4)?.boxCount, 4);

const incomplete = drawField(4, { includeBottom: false });
assert.strictEqual(locateCanonicalProfile(incomplete.pixels, incomplete.width, incomplete.height, 4), null);

console.log('Sequence detector contract passed (01/0001, 2/4 boxes, no QR, incomplete-field rejection).');

async function testCellReadings() {
  const model = require('./onnx-scanner-service');
  const originalClassifier = model.classifyDigit;
  const { classifySequenceField } = SequenceDetector._test;
  const width = 120, height = 104;
  const field = { left: 0, top: 0, right: 119, bottom: 103, width, height, boxCount: 2 };
  const render = (writtenCells) => {
    const pixels = Buffer.alloc(width * height, 255);
    for (const cell of writtenCells) {
      for (let y = 30; y < 76; y++) {
        for (let x = 26 + cell * 60; x < 32 + cell * 60; x++) pixels[y * width + x] = 0;
      }
    }
    return pixels;
  };
  try {
    model.classifyDigit = async () => ({ digit: 1, confidence: 0.94 });
    const leadingBlank = await classifySequenceField(render([1]), width, height, field);
    assert.strictEqual(leadingBlank?.sequence, '1', 'a blank tens box must not reject a written ones digit');
    assert.strictEqual(leadingBlank?.confidence, 94, 'blank boxes must not reduce digit confidence');
    assert.strictEqual(await classifySequenceField(render([0]), width, height, field), null,
      'a blank ones box must not silently change an incomplete sequence');
    assert.strictEqual(await classifySequenceField(render([]), width, height, field), null);
    const clipped = render([1]);
    for (let y = 8; y < 96; y++) for (let x = 4; x < 10; x++) clipped[y * width + x] = 0;
    assert.strictEqual(await classifySequenceField(clipped, width, height, field), null,
      'unreadable edge ink must not be treated as an empty leading cell');
    model.classifyDigit = async () => ({ digit: 1, confidence: 0.2 });
    assert.strictEqual(await classifySequenceField(render([1]), width, height, field), null,
      'supporting leading blanks must not weaken the confidence gate');
    model.classifyDigit = async () => null;
    assert.strictEqual(await classifySequenceField(render([1]), width, height, field), null,
      'classifier failure must not become a blank cell');
  } finally {
    model.classifyDigit = originalClassifier;
  }
  console.log('Sequence cell regressions passed (leading blank, trailing blank, clipped ink, confidence).');
}
async function testRealSequenceCrop() {
  const model = require('./onnx-scanner-service');
  await model.init();
  assert.ok(model.getLoadedModels().includes('digit'), 'digit model must be available');
  const crop = require('fs').readFileSync(require('path').join(__dirname, 'test-fixtures', 'sequence-0003.png'));
  const result = await SequenceDetector._test.detectCanonicalSequence(crop);
  assert.strictEqual(result?.sequence, '3', 'recover the narrowed four-box field from scan 437');
  assert.strictEqual(result?.rawDigits, '0003');
  assert.strictEqual(result?.boxCount, 4);
  assert.ok(result?.confidence >= 90);
  console.log('Real failed-capture regression passed (0003 -> student sequence 3).');
}
testCellReadings().then(testRealSequenceCrop).catch(error => { console.error(error); process.exitCode = 1; });
