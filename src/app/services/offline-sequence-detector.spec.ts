import { OfflineSequenceDetector } from './offline-sequence-detector';

describe('Offline sequence box placement', () => {
  const detector = new OfflineSequenceDetector() as any;
  function field(shift: number, missingDivider = false): Uint8Array {
    const pixels = new Uint8Array(580 * 335).fill(255);
    const left = Math.round(580 * .425) + shift;
    const width = Math.round(580 * .405);
    for (let y = 180; y <= 276; y++) {
      for (let x = left; x < left + width; x++) {
        const divider = Array.from({ length: 5 }, (_, i) => Math.round(left + (width - 1) * i / 4));
        if (y <= 181 || y >= 275 || divider.some((line, i) =>
          !(missingDivider && i === 2) && Math.abs(x - line) <= 1)) pixels[y * 580 + x] = 0;
      }
    }
    return pixels;
  }
  function twoBoxField(shift: number, widthScale = 1): Uint8Array {
    const pixels = new Uint8Array(580 * 335).fill(255);
    const left = Math.round(580 * .255) + shift;
    const width = Math.round(580 * .203 * widthScale);
    for (let y = 180; y <= 276; y++) for (let x = left; x < left + width; x++) {
      const divider = Math.round(left + (width - 1) / 2);
      if (y <= 181 || y >= 275 || Math.abs(x - left) <= 1
        || Math.abs(x - divider) <= 1 || Math.abs(x - (left + width - 1)) <= 1) pixels[y * 580 + x] = 0;
    }
    return pixels;
  }
  for (const shift of [-12, 0, 12]) {
    it(`locates the current two-box sequence field after a ${shift}px shift`, () => {
      const result = detector.locateExpectedSequenceBoxes(twoBoxField(shift), 580, 335, 2);
      expect(result).not.toBeNull();
      expect(Math.abs(result.left - (Math.round(580 * .255) + shift))).toBeLessThanOrEqual(4);
    });
  }
  it('finds a wider sequence field shifted toward the page center', () => {
    const shift = 50;
    const pixels = twoBoxField(shift, 1.25);
    const result = detector.locateExpectedSequenceBoxes(pixels, 580, 335, 2, true);
    expect(result).not.toBeNull();
    expect(Math.abs(result.left - (Math.round(580 * .255) + shift))).toBeLessThanOrEqual(4);
    expect(Math.abs(result.width - Math.round(580 * .203 * 1.25))).toBeLessThanOrEqual(4);
  });
  for (const shift of [-24, -12, 0, 12, 24]) {
    it(`locates all four boxes after a ${shift}px shift`, () => {
      const result = detector.locateExpectedSequenceBoxes(field(shift), 580, 335, 4);
      expect(result).not.toBeNull();
      expect(Math.abs(result.left - (Math.round(580 * .425) + shift))).toBeLessThanOrEqual(4);
    });
  }
  it('rejects blank paper and a box field with a missing divider', () => {
    expect(detector.locateExpectedSequenceBoxes(new Uint8Array(580 * 335).fill(255), 580, 335, 4)).toBeNull();
    expect(detector.locateExpectedSequenceBoxes(field(24, true), 580, 335, 4)).toBeNull();
  });


  it('keeps the bottom box border inside the crop when the footer touches the camera edge', async () => {
    const width = 400;
    const height = 500;
    const cropTop = 350;
    const cropHeight = height - cropTop;
    const rgba = new Uint8ClampedArray(width * cropHeight * 4);
    for (let i = 0; i < rgba.length; i += 4) { rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255; rgba[i + 3] = 255; }
    const dark = (x: number, y: number) => { const i = (y * width + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0; };
    for (let y = 100; y < cropHeight; y++) {
      for (let t = 0; t < 3; t++) { dark(140 + t, y); dark(230 - t, y); dark(185 + t, y); }
    }
    for (let x = 140; x <= 230; x++) for (let t = 0; t < 3; t++) { dark(x, 100 + t); dark(x, cropHeight - 1 - t); }
    const context = { getImageData: () => ({ data: rgba, width, height: cropHeight }) };
    const canvas = { width, height, getContext: () => context } as any;
    spyOn(detector, 'classifyField').and.resolveTo({
      sequenceCandidate: '2', confidence: 90, rawDigits: '02', boxCount: 2, digitConfidences: [90, 90],
    });
    const result = await detector.detect(canvas);
    expect(result?.sequenceCandidate).toBe('2');
    const call = (detector.classifyField as jasmine.Spy).calls.mostRecent();
    expect(call.args[2]).toBeGreaterThan(height - cropTop);
    expect(call.args[3].bottom).toBeLessThan(call.args[2]);
  });
});
