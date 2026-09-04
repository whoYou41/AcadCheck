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
