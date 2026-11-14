function validateScore(text: string): string {
  const value = String(text || '').trim();
  if (!/^\d{1,3}\/\d{1,3}$/.test(value)) throw new Error('A valid score is required');
  return value;
}

export interface ScoreSheetQuestionResult {
  questionNumber: number;
  isCorrect: boolean;
}

const PAGE_WIDTH = 3060;
const PAGE_HEIGHT = 4680;
const QUESTION_MARK_SIZE = 18;
const QUESTION_ROW_TOP = 1208;
const QUESTION_ROW_STEP = 83;
const QUESTION_COLUMN_X = [300, 1008, 1680, 2480];

function questionMarkSvg(results: ScoreSheetQuestionResult[]): string {
  return results
    .filter(result => Number.isInteger(result.questionNumber) && result.questionNumber >= 1 && result.questionNumber <= 50)
    .map(result => {
      const column = result.questionNumber <= 25 ? 0 : 1;
      const row = (result.questionNumber - 1) % 25;
      const y = QUESTION_ROW_TOP + row * QUESTION_ROW_STEP;
      const xPositions = [QUESTION_COLUMN_X[column + 2]];
      const color = result.isCorrect ? '#16833b' : '#d52b2b';
      return xPositions.map(x => result.isCorrect
        ? '<path d="M ' + (x - 16) + ' ' + (y + 2) + ' l 10 10 l 22 -27" fill="none" stroke="' + color + '" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>'
        : '<path d="M ' + (x - QUESTION_MARK_SIZE) + ' ' + (y - QUESTION_MARK_SIZE) + ' l ' + (QUESTION_MARK_SIZE * 2) + ' ' + (QUESTION_MARK_SIZE * 2) + ' M ' + (x + QUESTION_MARK_SIZE) + ' ' + (y - QUESTION_MARK_SIZE) + ' l ' + (-QUESTION_MARK_SIZE * 2) + ' ' + (QUESTION_MARK_SIZE * 2) + '" fill="none" stroke="' + color + '" stroke-width="7" stroke-linecap="round"/>').join('');
    }).join('');
}

export function buildScoreSheetOverlayDataUrl(scoreText: string, results: ScoreSheetQuestionResult[] = []): string {
  const score = validateScore(scoreText);
  const escapedScore = score.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]!));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + PAGE_WIDTH + '" height="' + PAGE_HEIGHT + '" viewBox="0 0 ' + PAGE_WIDTH + ' ' + PAGE_HEIGHT + '">' + questionMarkSvg(results) + '<text x="2794" y="3985" transform="rotate(90 2794 3985)" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="78" font-weight="700" fill="none" stroke="#d52b2b" stroke-width="4">' + escapedScore + '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
