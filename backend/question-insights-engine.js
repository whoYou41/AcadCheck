'use strict';

const MODEL_VERSION = 'acadcheck-hybrid-diagnostic-v1';
const VALID_ANSWERS = new Set(['A', 'B', 'C', 'D']);

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map(value => (value - average) ** 2)));
}

function pearsonCorrelation(xs, ys) {
  if (xs.length !== ys.length || xs.length < 5) return null;
  const xMean = mean(xs);
  const yMean = mean(ys);
  const xDeviation = standardDeviation(xs);
  const yDeviation = standardDeviation(ys);
  if (xDeviation === 0 || yDeviation === 0) return null;
  const covariance = mean(xs.map((value, index) => (value - xMean) * (ys[index] - yMean)));
  return clamp(covariance / (xDeviation * yDeviation), -1, 1);
}

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { low: 0, high: 100 };
  const proportion = successes / total;
  const denominator = 1 + (z ** 2 / total);
  const center = (proportion + (z ** 2 / (2 * total))) / denominator;
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) / total) + (z ** 2 / (4 * total ** 2))
  ) / denominator;
  return {
    low: round(100 * clamp(center - margin), 1),
    high: round(100 * clamp(center + margin), 1),
  };
}

function normalizedEntropy(counts) {
  const values = Object.values(counts).map(Number).filter(value => value > 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!total || values.length < 2) return 0;
  const entropy = -values.reduce((sum, value) => {
    const probability = value / total;
    return sum + probability * Math.log(probability);
  }, 0);
  return round(100 * entropy / Math.log(values.length), 1);
}

function normalizeRow(row) {
  const selected = String(row.detected_answer || '').trim().toUpperCase();
  const correctAnswer = String(row.correct_answer || '').trim().toUpperCase();
  const rawCorrect = row.is_correct;
  return {
    scanId: String(row.scanned_test_id ?? row.scanId ?? ''),
    questionNumber: Number(row.question_number ?? row.questionNumber),
    selected: VALID_ANSWERS.has(selected) ? selected : 'Blank',
    correctAnswer: VALID_ANSWERS.has(correctAnswer) ? correctAnswer : '',
    isCorrect: rawCorrect === true || rawCorrect === 1 || rawCorrect === '1',
    confidence: Number.isFinite(Number(row.confidence)) ? clamp(Number(row.confidence), 0, 100) : null,
  };
}

function euclideanSquared(left, right) {
  return left.reduce((sum, value, index) => sum + ((value - right[index]) ** 2), 0);
}

function centroid(vectors) {
  if (!vectors.length) return [];
  return vectors[0].map((_, index) => mean(vectors.map(vector => vector[index])));
}

function clusterQuestions(stats) {
  if (!stats.length) return [];
  const featureKeys = ['wrongRate', 'lowDiscrimination', 'topDistractorRate', 'answerEntropy', 'blankRate', 'lowConfidenceRate'];
  const rawVectors = stats.map(item => featureKeys.map(key => Number(item._features[key] || 0)));
  const columns = featureKeys.map((_, index) => rawVectors.map(vector => vector[index]));
  const averages = columns.map(mean);
  const deviations = columns.map(column => standardDeviation(column) || 1);
  const vectors = rawVectors.map(vector => vector.map((value, index) => (value - averages[index]) / deviations[index]));
  const clusterCount = stats.length >= 9 ? 3 : stats.length >= 4 ? 2 : 1;

  if (clusterCount === 1) {
    return stats.map(item => ({ id: 0, label: item._baseRisk >= 0.6 ? 'review' : item._baseRisk >= 0.35 ? 'monitor' : 'on-track' }));
  }

  const rankedIndexes = stats
    .map((item, index) => ({ index, risk: item._baseRisk }))
    .sort((left, right) => left.risk - right.risk)
    .map(item => item.index);
  let centers = Array.from({ length: clusterCount }, (_, index) => {
    const rank = Math.round(index * (rankedIndexes.length - 1) / (clusterCount - 1));
    return [...vectors[rankedIndexes[rank]]];
  });
  let assignments = new Array(stats.length).fill(-1);

  for (let iteration = 0; iteration < 50; iteration += 1) {
    const nextAssignments = vectors.map(vector => {
      let best = 0;
      for (let index = 1; index < centers.length; index += 1) {
        if (euclideanSquared(vector, centers[index]) < euclideanSquared(vector, centers[best])) best = index;
      }
      return best;
    });
    if (nextAssignments.every((value, index) => value === assignments[index])) break;
    assignments = nextAssignments;
    centers = centers.map((current, centerIndex) => {
      const members = vectors.filter((_, vectorIndex) => assignments[vectorIndex] === centerIndex);
      return members.length ? centroid(members) : current;
    });
  }

  const severityOrder = centers
    .map((_, centerIndex) => ({
      centerIndex,
      risk: mean(stats.filter((__, index) => assignments[index] === centerIndex).map(item => item._baseRisk)),
    }))
    .sort((left, right) => left.risk - right.risk);
  const labels = clusterCount === 3 ? ['on-track', 'monitor', 'review'] : ['on-track', 'review'];
  const labelByCluster = new Map(severityOrder.map((item, index) => [item.centerIndex, labels[index]]));
  return assignments.map(id => ({ id, label: labelByCluster.get(id) }));
}

function diagnoseQuestion(item, cluster, mixedExamScope) {
  const discrimination = item.discriminationIndex;
  let code = 'developing';
  let label = 'Developing understanding';

  if (item.lowConfidenceRate >= 25 && item.averageScanConfidence !== null && item.averageScanConfidence < 65) {
    code = 'scan_quality';
    label = 'Verify scan quality';
  } else if (
    item.attempts >= 8 && discrimination !== null && discrimination < 0.05
    && item.correctRate >= 20 && item.correctRate <= 90
  ) {
    code = 'possible_item_issue';
    label = 'Possible item issue';
  } else if (item.topDistractor?.rate >= 25 && item.wrongRate >= 30) {
    code = 'shared_misconception';
    label = 'Shared misconception';
  } else if (item.correctRate < 50) {
    code = 'learning_gap';
    label = 'Learning gap';
  } else if (item.correctRate >= 75) {
    code = 'mastery';
    label = 'Mastery';
  }

  const sampleStrength = clamp(item.attempts / 20);
  const scanStrength = item.averageScanConfidence === null ? 0.75 : item.averageScanConfidence / 100;
  let confidence = 100 * (0.15 + (0.55 * sampleStrength) + (0.2 * scanStrength) + (0.1 * (discrimination === null ? 0 : 1)));
  if (mixedExamScope) confidence *= 0.4;
  confidence = round(clamp(confidence, 0, 100), 0);

  const signals = [
    `${item.correctRate}% correct (95% interval ${item.correctRateInterval.low}–${item.correctRateInterval.high}%)`,
  ];
  if (discrimination !== null) signals.push(`discrimination ${discrimination.toFixed(2)}`);
  if (item.topDistractor?.rate >= 20) signals.push(`${item.topDistractor.rate}% chose ${item.topDistractor.answer}`);
  if (item.blankRate >= 5) signals.push(`${item.blankRate}% blank`);
  if (item.lowConfidenceRate >= 10) signals.push(`${item.lowConfidenceRate}% low-confidence scans`);

  let explanation;
  if (mixedExamScope) {
    explanation = 'Multiple exams are combined, so this diagnosis is preliminary. Select one exam for valid item-level interpretation.';
  } else if (code === 'scan_quality') {
    explanation = 'Low-confidence marks may be influencing this result. Verify the affected sheets before changing instruction.';
  } else if (code === 'possible_item_issue') {
    explanation = 'This item does not separate stronger and weaker overall performers as expected. Check the answer key, wording, and option clarity.';
  } else if (code === 'shared_misconception') {
    explanation = `${item.topDistractor.rate}% selected ${item.topDistractor.answer}${item.correctAnswer ? ` instead of ${item.correctAnswer}` : ''}, indicating a consistent misconception worth addressing.`;
  } else if (code === 'learning_gap') {
    explanation = 'The model found a broad learning gap. Reteach the underlying concept and use a short follow-up check.';
  } else if (code === 'mastery') {
    explanation = 'Most students answered correctly. Use this item as a bridge to a more challenging application.';
  } else {
    explanation = 'Performance is mixed. Reinforce the concept with a worked example and check understanding again.';
  }

  return {
    code,
    label,
    riskScore: round(100 * clamp(item._baseRisk + (cluster.label === 'review' ? 0.05 : 0)), 0),
    confidence,
    evidenceLevel: confidence >= 75 ? 'strong' : confidence >= 50 ? 'moderate' : 'preliminary',
    cluster: cluster.label,
    signals,
    explanation,
  };
}

function buildRecommendations(questionStats, mixedExamScope) {
  if (!questionStats.length) return [];
  if (mixedExamScope) {
    return ['Select a single exam before acting on item-level AI diagnoses; question numbers from different exams are currently combined.'];
  }
  const recommendations = [];
  const ranked = [...questionStats].sort((left, right) => right.diagnostic.riskScore - left.diagnostic.riskScore);
  for (const item of ranked) {
    if (recommendations.length >= 5) break;
    if (item.diagnostic.confidence < 45) continue;
    if (item.diagnostic.code === 'possible_item_issue') {
      recommendations.push(`Review question ${item.questionNumber}'s key and wording; its discrimination index is ${item.discriminationIndex.toFixed(2)}.`);
    } else if (item.diagnostic.code === 'shared_misconception') {
      recommendations.push(`Address question ${item.questionNumber}'s distractor ${item.topDistractor.answer}; ${item.topDistractor.rate}% selected it.`);
    } else if (item.diagnostic.code === 'scan_quality') {
      recommendations.push(`Verify the scans for question ${item.questionNumber}; ${item.lowConfidenceRate}% of marks were read with low confidence.`);
    } else if (item.diagnostic.code === 'learning_gap') {
      recommendations.push(`Reteach the concept assessed by question ${item.questionNumber}; only ${item.correctRate}% answered correctly.`);
    }
  }
  const strongest = [...questionStats]
    .filter(item => item.diagnostic.code === 'mastery')
    .sort((left, right) => right.correctRate - left.correctRate)[0];
  if (strongest && recommendations.length < 5) {
    recommendations.push(`Use question ${strongest.questionNumber} as a mastery anchor; ${strongest.correctRate}% answered correctly.`);
  }
  return recommendations.length ? recommendations : ['Collect more graded responses before making an instructional change.'];
}

function analyzeQuestionResponses(rows, options = {}) {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map(normalizeRow)
    .filter(row => row.scanId && Number.isInteger(row.questionNumber) && row.questionNumber > 0);
  const examCount = Math.max(0, Number(options.examCount || 0));
  const mixedExamScope = examCount > 1;
  const totalsByScan = new Map();
  for (const row of normalized) {
    totalsByScan.set(row.scanId, Number(totalsByScan.get(row.scanId) || 0) + (row.isCorrect ? 1 : 0));
  }

  const grouped = new Map();
  for (const row of normalized) {
    const group = grouped.get(row.questionNumber) || [];
    group.push(row);
    grouped.set(row.questionNumber, group);
  }

  const questionStats = [...grouped.entries()].sort((left, right) => left[0] - right[0]).map(([questionNumber, items]) => {
    const attempts = items.length;
    const correct = items.filter(item => item.isCorrect).length;
    const wrong = attempts - correct;
    const answerDistribution = {};
    for (const item of items) answerDistribution[item.selected] = Number(answerDistribution[item.selected] || 0) + 1;
    const keyedAnswers = [...new Set(items.map(item => item.correctAnswer).filter(Boolean))];
    const correctAnswer = keyedAnswers.length === 1 ? keyedAnswers[0] : '';
    const distractors = Object.entries(answerDistribution)
      .filter(([answer]) => answer !== correctAnswer && answer !== 'Blank')
      .sort((left, right) => Number(right[1]) - Number(left[1]));
    const topDistractorEntry = distractors[0];
    const blankCount = Number(answerDistribution.Blank || 0);
    const confidenceValues = items.map(item => item.confidence).filter(value => value !== null);
    const lowConfidenceCount = confidenceValues.filter(value => value < 65).length;
    const itemScores = items.map(item => item.isCorrect ? 1 : 0);
    const restScores = items.map(item => Number(totalsByScan.get(item.scanId) || 0) - (item.isCorrect ? 1 : 0));
    const discrimination = pearsonCorrelation(itemScores, restScores);
    const correctRate = attempts ? round(100 * correct / attempts, 1) : 0;
    const wrongRate = attempts ? round(100 * wrong / attempts, 1) : 0;
    const topDistractorRate = topDistractorEntry && attempts ? round(100 * Number(topDistractorEntry[1]) / attempts, 1) : 0;
    const blankRate = attempts ? round(100 * blankCount / attempts, 1) : 0;
    const lowConfidenceRate = confidenceValues.length ? round(100 * lowConfidenceCount / confidenceValues.length, 1) : 0;
    const lowDiscrimination = discrimination === null ? 0.35 : clamp((0.2 - discrimination) / 0.5);
    const answerEntropy = normalizedEntropy(answerDistribution);
    const baseRisk =
      (0.4 * wrongRate / 100)
      + (0.22 * lowDiscrimination)
      + (0.12 * topDistractorRate / 100)
      + (0.08 * answerEntropy / 100)
      + (0.09 * blankRate / 100)
      + (0.09 * lowConfidenceRate / 100);
    return {
      questionNumber,
      attempts,
      correct,
      wrong,
      correctRate,
      wrongRate,
      correctRateInterval: wilsonInterval(correct, attempts),
      discriminationIndex: discrimination === null ? null : round(discrimination, 2),
      answerEntropy,
      correctAnswer,
      answerDistribution,
      topDistractor: topDistractorEntry ? {
        answer: topDistractorEntry[0],
        count: Number(topDistractorEntry[1]),
        rate: topDistractorRate,
      } : null,
      blankCount,
      blankRate,
      averageScanConfidence: confidenceValues.length ? round(mean(confidenceValues), 1) : null,
      lowConfidenceRate,
      _features: { wrongRate, lowDiscrimination: 100 * lowDiscrimination, topDistractorRate, answerEntropy, blankRate, lowConfidenceRate },
      _baseRisk: baseRisk,
    };
  });

  const clusters = clusterQuestions(questionStats);
  questionStats.forEach((item, index) => {
    item.diagnostic = diagnoseQuestion(item, clusters[index], mixedExamScope);
    delete item._features;
    delete item._baseRisk;
  });

  const attempted = questionStats.reduce((sum, item) => sum + item.attempts, 0);
  const correctTotal = questionStats.reduce((sum, item) => sum + item.correct, 0);
  const studentResponses = new Set(normalized.map(row => row.scanId)).size;
  const byCorrect = [...questionStats].sort((left, right) => right.correctRate - left.correctRate || right.correct - left.correct);
  const byWrong = [...questionStats].sort((left, right) => right.wrongRate - left.wrongRate || right.wrong - left.wrong);
  const averageModelConfidence = questionStats.length
    ? round(mean(questionStats.map(item => item.diagnostic.confidence)), 0)
    : 0;

  return {
    overview: {
      totalResponses: studentResponses,
      overallCorrectRate: attempted ? round(100 * correctTotal / attempted, 1) : 0,
      questionsAnalyzed: questionStats.length,
      totalAnswers: attempted,
      reliability: studentResponses >= 20 ? 'strong' : studentResponses >= 8 ? 'moderate' : 'preliminary',
      model: {
        name: 'Hybrid psychometric clustering',
        version: MODEL_VERSION,
        mode: 'unsupervised-cold-start',
        averageConfidence: averageModelConfidence,
        trainedWithTeacherLabels: false,
        examCount,
        scopeWarning: mixedExamScope
          ? 'Select one exam for valid item-level diagnoses; the current scope combines different question sets.'
          : null,
      },
    },
    mostCorrect: byCorrect[0] || null,
    mostWrong: byWrong[0] || null,
    difficultQuestions: byWrong.filter(item => item.diagnostic.cluster === 'review' || item.wrongRate >= 50).slice(0, 10),
    recommendations: buildRecommendations(questionStats, mixedExamScope),
    questionStats,
  };
}

module.exports = {
  MODEL_VERSION,
  analyzeQuestionResponses,
  pearsonCorrelation,
  wilsonInterval,
};
