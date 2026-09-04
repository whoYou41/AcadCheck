'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeQuestionResponses, wilsonInterval } = require('./question-insights-engine');

function responseRows(studentCount = 20) {
  const rows = [];
  for (let student = 0; student < studentCount; student += 1) {
    const answers = [
      { correct: student < 18, wrongAnswer: 'B', confidence: 94 },
      { correct: student < 12, wrongAnswer: 'C', confidence: 92 },
      { correct: student < 6, wrongAnswer: 'B', confidence: 91 },
      { correct: student >= 10, wrongAnswer: 'D', confidence: 93 },
      { correct: student < 12, wrongAnswer: 'C', confidence: 40 },
    ];
    answers.forEach((answer, questionIndex) => rows.push({
      scanned_test_id: student + 1,
      question_number: questionIndex + 1,
      detected_answer: answer.correct ? 'A' : answer.wrongAnswer,
      correct_answer: 'A',
      is_correct: answer.correct,
      confidence: answer.confidence,
    }));
  }
  return rows;
}

test('hybrid engine calculates psychometric features and explainable diagnoses', () => {
  const analytics = analyzeQuestionResponses(responseRows(), { examCount: 1 });

  assert.equal(analytics.overview.totalResponses, 20);
  assert.equal(analytics.overview.questionsAnalyzed, 5);
  assert.equal(analytics.overview.model.mode, 'unsupervised-cold-start');
  assert.equal(analytics.overview.model.scopeWarning, null);

  const misconception = analytics.questionStats.find(item => item.questionNumber === 3);
  assert.equal(misconception.diagnostic.code, 'shared_misconception');
  assert.equal(misconception.topDistractor.answer, 'B');
  assert.equal(misconception.topDistractor.rate, 70);

  const itemIssue = analytics.questionStats.find(item => item.questionNumber === 4);
  assert.equal(itemIssue.diagnostic.code, 'possible_item_issue');
  assert.ok(itemIssue.discriminationIndex < 0);

  const scanIssue = analytics.questionStats.find(item => item.questionNumber === 5);
  assert.equal(scanIssue.diagnostic.code, 'scan_quality');
  assert.equal(scanIssue.lowConfidenceRate, 100);
  assert.match(scanIssue.diagnostic.explanation, /verify/i);
});

test('mixed exams lower confidence and produce a validity warning', () => {
  const singleExam = analyzeQuestionResponses(responseRows(), { examCount: 1 });
  const mixedExams = analyzeQuestionResponses(responseRows(), { examCount: 2 });

  assert.match(mixedExams.overview.model.scopeWarning, /Select one exam/i);
  assert.ok(mixedExams.overview.model.averageConfidence < singleExam.overview.model.averageConfidence);
  assert.match(mixedExams.recommendations[0], /single exam/i);
});

test('Wilson intervals reflect sample uncertainty', () => {
  const small = wilsonInterval(1, 1);
  const large = wilsonInterval(20, 20);
  assert.ok(small.low < large.low);
  assert.equal(small.high, 100);
  assert.equal(large.high, 100);
});
