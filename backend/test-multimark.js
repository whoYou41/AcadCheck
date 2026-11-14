const assert = require('assert');
const sharp = require('sharp');
const EnhancedScanner = require('./enhanced-scanner');

(async () => {
  const centers = [114, 155, 197, 238];
  const shapes = centers.map(x => '<circle cx="' + x + '" cy="200" r="22" fill="white" stroke="black" stroke-width="2"/>');
  // B is strongly shaded; D is a lighter but still clearly filled second mark.
  shapes.push('<circle cx="155" cy="200" r="19" fill="black"/>');
  shapes.push('<circle cx="238" cy="200" r="14" fill="black"/>');
  const svg = Buffer.from('<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">' + shapes.join('') + '</svg>');
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#fff' } })
    .composite([{ input: svg }]).png().toBuffer();
  const result = await EnhancedScanner.smartBubbleDetection(image, 'A', {
    blocksPerRow: 1, questionsPerBlock: 1,
    topMargin: 40, bottomMargin: 360, leftMargin: 40, rightMargin: 360,
  });
  assert.deepStrictEqual(result.markedLetters, [['B', 'D']], 'both filled bubbles must be retained');
  assert.deepStrictEqual(result.detectedAnswers, [''], 'a double-mark row must not select the darkest bubble');
  assert.deepStrictEqual(result.confidenceScores, [0], 'a rejected double-mark row must not earn confidence');
  await EnhancedScanner.shutdownTesseractPool();
  console.log('Double-mark regression passed (darker B plus lighter filled D is invalid).');
})().catch(async error => {
  console.error(error);
  await EnhancedScanner.shutdownTesseractPool();
  process.exitCode = 1;
});
