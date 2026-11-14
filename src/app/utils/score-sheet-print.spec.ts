import { buildScoreSheetOverlayDataUrl } from './score-sheet-print';

describe('answer-sheet score printing', () => {
  it('prints the saved score without question marks or correctness data', () => {
    const url = buildScoreSheetOverlayDataUrl('26/50');
    const svg = decodeURIComponent(url.split(',')[1]);
    expect(svg).toContain('26/50');
    expect(svg).not.toContain('<path');
    expect(svg).not.toContain('#16833b');
  });

  it('renders check and X symbols beside their saved question numbers', () => {
    const svg = decodeURIComponent(buildScoreSheetOverlayDataUrl('1/2', [
      { questionNumber: 1, isCorrect: true },
      { questionNumber: 26, isCorrect: false },
    ]).split(',')[1]);
    expect(svg).toContain('M 1664 1210 l 10 10 l 22 -27');
    expect(svg).toContain('M 2462 1190 l 36 36 M 2498 1190 l -36 36');
    expect(svg).toContain('#16833b');
    expect(svg).toContain('#d52b2b');
    expect(svg).toContain('1/2');
  });

  it('rejects an invalid score', () => {
    expect(() => buildScoreSheetOverlayDataUrl('not-a-score')).toThrowError('A valid score is required');
  });
});
