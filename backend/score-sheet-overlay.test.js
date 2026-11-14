const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScoreSheetOverlaySvg } = require('./score-sheet-overlay');

test('score overlay retains the score when no per-question outcomes are supplied', () => {
  const svg = buildScoreSheetOverlaySvg('26/50');
  assert.match(svg, /26\/50/);
  assert.doesNotMatch(svg, /<path|#16833b/);
});

test('correct and wrong outcomes render check and X symbols at their question rows', () => {
  const svg = buildScoreSheetOverlaySvg('1/2', [
    { questionNumber: 1, isCorrect: true },
    { questionNumber: 26, isCorrect: false },
  ]);
  assert.match(svg, /<path d="M 1664 1210 l 10 10 l 22 -27"[^>]*stroke="#16833b"/);
  assert.match(svg, /<path d="M 2462 1190 l 36 36 M 2498 1190 l -36 36"[^>]*stroke="#d52b2b"/);
  assert.match(svg, /<text[^>]*>1\/2<\/text>/);
});

test('invalid score is rejected', () => {
  assert.throws(() => buildScoreSheetOverlaySvg('no score'), /valid score/);
});
