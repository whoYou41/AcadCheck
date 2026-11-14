'use strict';

const PAGE_WIDTH = 3060;
const PAGE_HEIGHT = 4680;
const MARK_SIZE = 18;
const ROW_TOP = 1208;
const ROW_STEP = 83;
const COLUMN_X = [300, 1008, 1680, 2480];

function buildScoreSheetOverlaySvg(scoreText, questionResults = []) {
  const score = String(scoreText ?? '').trim();
  if (!/^\d{1,3}\/\d{1,3}$/.test(score)) throw new Error('A valid score is required');
  const escaped = score.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[character]));
  const marks = (Array.isArray(questionResults) ? questionResults : []).flatMap(result => {
    const questionNumber = Number(result?.questionNumber ?? result?.question_number);
    if (!Number.isInteger(questionNumber) || questionNumber < 1 || questionNumber > 50) return [];
    const correct = result?.isCorrect === true || Number(result?.isCorrect) === 1 || result?.is_correct === true || Number(result?.is_correct) === 1;
    const column = questionNumber <= 25 ? 0 : 1;
    const y = ROW_TOP + ((questionNumber - 1) % 25) * ROW_STEP;
    const color = correct ? '#16833b' : '#d52b2b';
    return [COLUMN_X[column + 2]].map(x => correct
      ? `<path d="M ${x - 16} ${y + 2} l 10 10 l 22 -27" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`
      : `<path d="M ${x - MARK_SIZE} ${y - MARK_SIZE} l ${MARK_SIZE * 2} ${MARK_SIZE * 2} M ${x + MARK_SIZE} ${y - MARK_SIZE} l ${-MARK_SIZE * 2} ${MARK_SIZE * 2}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round"/>`);
  }).join('');
  const label = `<text x="2794" y="3985" transform="rotate(90 2794 3985)" text-anchor="middle" dominant-baseline="central" font-family="Arial,sans-serif" font-size="78" font-weight="700" fill="none" stroke="#d52b2b" stroke-width="4">${escaped}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">${marks}${label}</svg>`;
}

module.exports = { buildScoreSheetOverlaySvg };
