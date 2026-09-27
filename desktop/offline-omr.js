'use strict';

function assertScannerSender(event, mainWindow, origin) {
  if (!mainWindow || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
    || event.senderFrame !== mainWindow.webContents.mainFrame
    || new URL(event.senderFrame.url).origin !== origin) {
    throw new Error('Scanner requests are limited to the AcadCheck window');
  }
}

function createOfflineOmr(getWorker) {
  let busy = false;
  let warmup = null;
  return {
    async prewarm() {
      if (!warmup) {
        warmup = getWorker().prewarmAdaptiveWorker().then(result => {
          if (!result.success) throw new Error('The bundled offline scanner could not initialize');
          return { ready: true, engine: 'acadcheck-native-opencv-v1' };
        }).catch(error => { warmup = null; throw error; });
      }
      return warmup;
    },
    async scan(options = {}) {
      if (!options || typeof options !== 'object') throw new Error('Scanner options are required');
      const { imageBase64, questionCount, trackingSessionId, frameId } = options;
      if (typeof imageBase64 !== 'string' || !imageBase64.length
        || imageBase64.length > 32 * 1024 * 1024
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
        || imageBase64.length % 4 !== 0) throw new Error('A valid JPEG or PNG image is required');
      if (!Number.isInteger(questionCount) || questionCount < 1 || questionCount > 50) {
        throw new Error('The offline scanner supports 1 to 50 questions');
      }
      if (trackingSessionId != null && (typeof trackingSessionId !== 'string' || trackingSessionId.length > 160)) {
        throw new Error('Invalid scanner tracking session');
      }
      if (trackingSessionId && (!/^\d+$/.test(String(frameId))
        || !Number.isSafeInteger(Number(frameId)) || Number(frameId) < 1)) {
        throw new Error('Invalid scanner frame identifier');
      }
      if (busy) throw new Error('The offline scanner is already reading a frame');
      busy = true;
      try {
        // Finish an existing warmup before starting a scan, without queueing
        // multiple image requests against the process-wide DNN state.
        if (warmup) await warmup;
        const result = await getWorker().detectAdaptiveForm(Buffer.from(imageBase64, 'base64'), {
          useCnn: true, detectSequence: true, includeDiagnostics: false,
          includeOverlayGeometry: true,
          ...(trackingSessionId ? { trackingSessionId: `desktop:${trackingSessionId}`, frameId: Number(frameId) } : {}),
        });
        const response = {};
        for (const key of [
          'success', 'gradeable', 'geometryVerified', 'answers', 'confidenceScores',
          'markedLetters', 'rowStates', 'averageConfidence', 'qualityMetrics',
          'sheetPresence', 'presenceConfidence', 'sheetFingerprint',
          'sheetFingerprintVersion', 'overlayGeometry', 'processingMs', 'reason',
        ]) if (key in result) response[key] = result[key];
        for (const key of ['sequence', 'sequenceCandidate', 'sequenceConfidence',
          'sequenceRawDigits', 'sequenceBoxCount', 'sequenceDigitConfidences']) {
          if (key in (result.qualityMetrics || {})) response[key] = result.qualityMetrics[key];
        }
        return response;
      } finally {
        busy = false;
      }
    },
  };
}

module.exports = { assertScannerSender, createOfflineOmr };
