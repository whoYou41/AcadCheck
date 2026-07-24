const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');
const EnhancedScanner = require('./enhanced-scanner');

const DB_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'acadcheck_db',
};

const SCANS_DIR = path.join(__dirname, '../uploads/scans');
const CALIBRATION_OUTPUT = path.join(__dirname, 'bubble-calibration.json');

async function getDb() {
  return mysql.createConnection(DB_CONFIG).promise();
}

async function runScannerOnImage(imageBuffer, answerKey, options = {}) {
  const result = await EnhancedScanner.hybridDetectAnswers(imageBuffer, answerKey, {
    blocksPerRow: options.blocksPerRow,
    questionsPerBlock: options.questionsPerBlock,
    numChoices: 4,
    rectify: false,
  });
  return result;
}

function gradeExam(detectedAnswers, answerKeyArray) {
  let correct = 0;
  const total = answerKeyArray.length;
  for (let i = 0; i < total; i++) {
    if ((detectedAnswers[i] || '').trim().toUpperCase() === (answerKeyArray[i] || '').trim().toUpperCase()) {
      correct++;
    }
  }
  return { correct, total, accuracy: total > 0 ? correct / total : 0 };
}

async function evaluateScan(imageBuffer, answerKey, layout) {
  const key = (answerKey || '').replace(/\s/g, '');
  if (!key || key.length < 4) return null;

  try {
    const result = await runScannerOnImage(imageBuffer, answerKey, layout);
    const detectedAnswers = result.detectedAnswers || [];
    const confidenceScores = result.confidenceScores || [];
    const grade = gradeExam(detectedAnswers, key.split(''));
    const avgConfidence = confidenceScores.length > 0
      ? confidenceScores.reduce((a, b) => a + b, 0) / confidenceScores.length
      : 0;

    return {
      detectedAnswers,
      confidenceScores,
      correct: grade.correct,
      total: grade.total,
      accuracy: grade.accuracy,
      avgConfidence,
      layout,
      details: result.details,
      markedLetters: result.markedLetters || []
    };
  } catch (e) {
    return null;
  }
}

async function evaluateLayout(layout, scans) {
  let totalCorrect = 0;
  let totalQuestions = 0;
  const results = [];
  let failedCount = 0;

  for (const scan of scans) {
    if (!fs.existsSync(scan.file_path)) {
      failedCount++;
      continue;
    }

    const imageBuffer = fs.readFileSync(scan.file_path);
    const key = (scan.answer_key_json || '').replace(/\s/g, '');
    if (!key || key.length < 4) continue;

    const result = await evaluateScan(imageBuffer, key, layout);
    if (!result) {
      failedCount++;
      continue;
    }

    totalCorrect += result.correct;
    totalQuestions += result.total;

    results.push({
      scanId: scan.id,
      filename: scan.filename,
      numQuestions: key.length,
      correct: result.correct,
      accuracy: result.accuracy,
      avgConfidence: result.avgConfidence,
      layout,
      details: result.details
    });
  }

  return {
    layout,
    totalCorrect,
    totalQuestions,
    overallAccuracy: totalQuestions > 0 ? totalCorrect / totalQuestions : 0,
    results
  };
}

async function main() {
  console.log('SCANNER TRAINING FROM UPLOADS/SCANS (FAST MODE)\n');
  console.log('='.repeat(60));

  const db = await getDb();
  const [scans] = await db.query(`
    SELECT st.id, st.filename, st.file_path, ak.answer_key_json, ak.num_questions
    FROM scanned_tests st
    JOIN answer_keys ak ON st.answer_key_id = ak.id
    WHERE st.scan_status = 'completed'
      AND ak.answer_key_json IS NOT NULL
      AND st.file_path IS NOT NULL
      AND st.file_path != ''
    ORDER BY st.id
  `);

  console.log(`Found ${scans.length} scans in database\n`);

  if (scans.length === 0) {
    await db.end();
    return null;
  }

  const layouts = [
    { questionsPerBlock: 25, blocksPerRow: 2 },
    { questionsPerBlock: 10, blocksPerRow: 5 },
  ];

  const allResults = [];
  for (const layout of layouts) {
    console.log(`Testing ${layout.blocksPerRow}x${layout.questionsPerBlock} on sample scans...`);
    const sampleSize = Math.min(12, scans.length);
    const sampledScans = scans.slice(0, sampleSize);
    const result = await evaluateLayout(layout, sampledScans);
    allResults.push(result);
    console.log(`   Overall: ${result.totalCorrect}/${result.totalQuestions} = ${(result.overallAccuracy * 100).toFixed(1)}%`);
  }

  allResults.sort((a, b) => b.overallAccuracy - a.overallAccuracy);

  console.log('\nLayout ranking:');
  for (let i = 0; i < allResults.length; i++) {
    const r = allResults[i];
    console.log(`  ${i + 1}. ${r.layout.blocksPerRow}x${r.layout.questionsPerBlock}: ${(r.overallAccuracy * 100).toFixed(1)}% (${r.totalCorrect}/${r.totalQuestions})`);
  }

  const best = allResults[0];
  const accuracy = best.overallAccuracy;

  console.log(`\nBest layout: ${best.layout.blocksPerRow}x${best.layout.questionsPerBlock}`);
  console.log(`Overall accuracy: ${(accuracy * 100).toFixed(1)}%`);

  const highAccuracy = best.results.filter(r => r.accuracy >= 0.9);
  const midAccuracy = best.results.filter(r => r.accuracy >= 0.5 && r.accuracy < 0.9);
  const lowAccuracy = best.results.filter(r => r.accuracy < 0.5);
  console.log(`Accuracy breakdown:`);
  console.log(`  High (>=90%): ${highAccuracy.length}`);
  console.log(`  Mid (50-90%): ${midAccuracy.length}`);
  console.log(`  Low (<50%): ${lowAccuracy.length}`);

  if (highAccuracy.length > 0) {
    const avgConf = highAccuracy.reduce((a, r) => a + r.avgConfidence, 0) / highAccuracy.length;
    console.log(`  High-accuracy avg confidence: ${avgConf.toFixed(1)}`);
  }

  if (lowAccuracy.length > 0) {
    const avgConf = lowAccuracy.reduce((a, r) => a + r.avgConfidence, 0) / lowAccuracy.length;
    console.log(`  Low-accuracy avg confidence: ${avgConf.toFixed(1)}`);
  }

  let recommendedThresholds;
  if (accuracy >= 0.95) {
    recommendedThresholds = {
      topGapFromSecond: 5,
      topRelativeGap: 2,
      multiMarkGap: 3,
      confidenceHigh: 88,
      confidenceLow: 55,
      qualityGateAccept: 85,
      qualityGateWatch: 65
    };
  } else if (accuracy >= 0.85) {
    recommendedThresholds = {
      topGapFromSecond: 6,
      topRelativeGap: 3,
      multiMarkGap: 4,
      confidenceHigh: 80,
      confidenceLow: 50,
      qualityGateAccept: 78,
      qualityGateWatch: 60
    };
  } else if (accuracy >= 0.7) {
    recommendedThresholds = {
      topGapFromSecond: 8,
      topRelativeGap: 4,
      multiMarkGap: 5,
      confidenceHigh: 72,
      confidenceLow: 45,
      qualityGateAccept: 70,
      qualityGateWatch: 55
    };
  } else {
    recommendedThresholds = {
      topGapFromSecond: 10,
      topRelativeGap: 5,
      multiMarkGap: 6,
      confidenceHigh: 65,
      confidenceLow: 40,
      qualityGateAccept: 65,
      qualityGateWatch: 50
    };
  }

  if (highAccuracy.length > 3 && lowAccuracy.length > 0) {
    const avgHighConf = highAccuracy.reduce((a, r) => a + r.avgConfidence, 0) / highAccuracy.length;
    const avgLowConf = lowAccuracy.reduce((a, r) => a + r.avgConfidence, 0) / lowAccuracy.length;

    if (avgHighConf > avgLowConf + 15) {
      recommendedThresholds.confidenceHigh = Math.round(avgHighConf * 0.92);
      recommendedThresholds.confidenceLow = Math.round(avgLowConf * 1.15);
      recommendedThresholds.qualityGateAccept = Math.round(avgHighConf * 0.88);
      recommendedThresholds.qualityGateWatch = Math.round(avgLowConf * 1.25);
    }
  }

  const calibration = {
    trainedAt: new Date().toISOString(),
    referenceSheets: 0,
    numQuestions: 50,
    numChoices: 4,
    bestLayout: `${best.layout.blocksPerRow}x${best.layout.questionsPerBlock}`,
    bestLayoutDetail: best.layout,
    global: {},
    perSheet: {},
    recommendedThresholds,
    performance: {
      dbScans: {
        overallAccuracy: best.overallAccuracy,
        totalCorrect: best.totalCorrect,
        totalQuestions: best.totalQuestions,
        highAccuracyCount: highAccuracy.length,
        midAccuracyCount: midAccuracy.length,
        lowAccuracyCount: lowAccuracy.length,
        totalScans: best.results.length,
        sampleScans: best.results.map(r => ({
          scanId: r.scanId,
          accuracy: r.accuracy,
          avgConfidence: r.avgConfidence
        }))
      }
    }
  };

  fs.writeFileSync(CALIBRATION_OUTPUT, JSON.stringify(calibration, null, 2));
  console.log(`\nCalibration saved to: ${CALIBRATION_OUTPUT}`);
  console.log('Recommended thresholds:');
  console.log(JSON.stringify(calibration.recommendedThresholds, null, 2));

  await db.end();
  return calibration;
}

module.exports = {
  main,
  trainFromReferenceSheets: main,
  trainFromDbScans: main,
  generateCalibration: main,
  evaluateScan,
  runScannerOnImage,
};
