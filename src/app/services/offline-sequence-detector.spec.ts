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
});
