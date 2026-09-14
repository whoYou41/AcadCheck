import { OfflineOmrService } from './offline-omr.service';

describe('OfflineOmrService browser fallback safety', () => {
  beforeAll(() => {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 30000;
  });
  const truths: Record<string, string> = {
    'allA.jpg': 'A'.repeat(50),
    'allB.jpg': 'B'.repeat(50),
    'allC.jpg': 'C'.repeat(50),
    'allD.jpg': 'D'.repeat(50),
    'random.jpg': 'DBACBDACDBACDACCABDCBADCBADCBADCBADCBBACDCBBADCBCB',
  };

  for (const [filename, truth] of Object.entries(truths)) {
    it(`never auto-grades an incorrect browser reading for ${filename}`, async () => {
      const response = await fetch(`/base/ml-training/real_scans/${filename}`);
      expect(response.ok).toBeTrue();
      const blob = await response.blob();
      const file = new File([blob], filename, { type: 'image/jpeg' });
      const result = await new OfflineOmrService().detect(file, 50);
      expect(result.gradeable && result.answers.join('') !== truth)
        .withContext(JSON.stringify(result))
        .toBeFalse();
      if (result.gradeable) {
        expect(result.detectedCount).withContext(JSON.stringify(result)).toBe(50);
        expect(result.uncertainCount).withContext(JSON.stringify(result)).toBe(0);
      } else {
        expect(result.uncertainCount).withContext(JSON.stringify(result)).toBeGreaterThan(0);
      }
      expect(result.processingMs).toBeLessThan(5000);
      expect(result.source).toBe('device-fallback');
    });
  }

  it('ignores the QR on a distant legacy frame and requires a proved answer grid', async () => {
    const filename = 'scan-live-1787301928493-142242626.jpg';
    const response = await fetch(`/base/uploads/scans/${filename}`);
    const result = await new OfflineOmrService().detect(
      new File([await response.blob()], filename, { type: 'image/jpeg' }),
      50
    );
    expect(result.anchorMethod).toBe('answer-grid');
    expect(result.gradeable).withContext(JSON.stringify(result)).toBeFalse();
    expect(result.uncertainCount).withContext(JSON.stringify(result)).toBeGreaterThan(0);
    expect(result.processingMs).toBeGreaterThan(0);
  });

  const currentQrTruth: Record<string, string> = {
    'scan-live-1787479363321-177354621.jpg': 'CDBDCBBCDDCCDABBBCDBCACBDBBCDBDCDBDBBCCDBCCBABCDCD',
    'scan-live-1787185528107-453967265.jpg': 'AACADCCDBABCCDBABCDDAAAABCDACDCDACDACDACCACDACABAC',
    'scan-live-1787185481641-183733412.jpg': 'AACADCCDBABCCDBABCDDAAAABCDACDCDACDACDACCACDACABAC',
    'scan-live-1787185301480-898989012.jpg': 'CBCBADBCBAABCDABCDBCABCBAABCBADCBCDDCBADCBAABCDBCA',
    'scan-live-1787185177335-187719285.jpg': 'ABABDABBDBACBABAADDBDADBCDDDBCADBADADBDBDABDBDABDB',
  };
  for (const [filename, truth] of Object.entries(currentQrTruth)) {
    it(`matches the trusted result for ${filename}`, async () => {
      const response = await fetch(`/base/uploads/scans/${filename}`);
      expect(response.ok).toBeTrue();
      const file = new File([await response.blob()], filename, { type: 'image/jpeg' });
      const result = await new OfflineOmrService().detect(file, 50).catch(error => {
        // A browser-only fallback may reject a cropped/ambiguous frame
        // completely. The Android APK uses the native worker tested against
        // the same fixtures; either browser outcome must remain fail-closed.
        expect(String(error?.message || error).toLowerCase())
          .toMatch(/register|confident|visible|sheet/);
        return null;
      });
      if (!result) return;
      expect(result.gradeable && result.answers.join('') !== truth)
        .withContext(JSON.stringify(result))
        .toBeFalse();
      expect(result.anchorMethod).withContext(JSON.stringify(result)).toBe('answer-grid');
      expect(result.qrData).withContext(JSON.stringify(result)).toBe('');
      if (result.gradeable) {
        expect(result.answers.join('')).withContext(JSON.stringify(result)).toBe(truth);
        expect(result.detectedCount).withContext(JSON.stringify(result)).toBe(50);
        expect(result.uncertainCount).withContext(JSON.stringify(result)).toBe(0);
      } else {
        // Older frames may crop the first rows. Without using their QR as a
        // placement anchor, the safe result is review-only suggestions.
        expect(result.uncertainCount).withContext(JSON.stringify(result)).toBeGreaterThan(0);
        expect(result.overallConfidence).withContext(JSON.stringify(result)).toBeLessThan(70);
      }
    });
  }

  it('reads the boxed student sequence from a difficult offline live frame', async () => {
    const filename = 'scan-live-1788602003130-133654172.jpg';
    const response = await fetch(`/base/uploads/scans/${filename}`);
    expect(response.ok).toBeTrue();
    const result = await new OfflineOmrService().detect(
      new File([await response.blob()], filename, { type: 'image/jpeg' }),
      50
    );
    expect(result.sequence).withContext(JSON.stringify(result)).toBe('2');
    expect(result.sequenceConfidence).withContext(JSON.stringify(result)).toBeGreaterThanOrEqual(58);
  });

});
