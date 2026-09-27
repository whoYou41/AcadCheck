# AcadCheck 1.2.29 scanner improvements

Built on 22 September; final Windows packaging validation on 23 September 2026. Android version code: 36.

## Changes

- Windows Offline Mode now uses the bundled native OpenCV scanner, including printed-template registration, current-frame grid verification, bubble classification, sequence recognition, and tracking. It no longer relies on the browser fallback inside the installed Windows app. This path works without MySQL or internet access and shares the Android result-validation contract.
- A selected answer key and enabled Auto Scan now request an OMR-resolution first camera image. Detection starts on frame arrival and immediately consumes the newest waiting frame after a read finishes. Superseded frames are discarded instead of queued. A timer remains for cooldown and selection recovery.
- Actual in-flight reads stay serialized across camera stop/restart. Stopped, hidden, or obsolete sessions cannot start another concurrent scan or publish a stale result. Existing repeated-frame confirmation and duplicate-save protection remain.
- Both camera routes retain 1920-pixel detail when rows are unresolved, including uncertain native rows. Detail resets after confirmed sheet removal. Windows online previews retain that resolution through preprocessing.
- Image percentiles use exact 256-bin OpenCV histograms without expanding image pixels into int64 arrays. Inputs above the exact float32 counting range retain integer histograms. Pixel-statistics regression tests verify unchanged values.
- Native results with missing, coerced, nonfinite, negative, or out-of-range confidence values cannot become gradeable or acquire temporal confirmation.
- Windows packaging configures the native bridge to find its bundled backend dependencies, including Sharp, in the installer vendor directory.
- The desktop preload exposes only warmup and scan operations. Main-process handlers accept requests only from the application's own main frame, validate inputs, reject overlapping scans, and use the existing bounded worker/recovery protocol.

## Validation

- 155 application tests passed, including first-frame scheduling, latest-frame backpressure, stop/restart handling, native confidence integrity, and Windows offline routing.
- 11 desktop unit tests passed, including bridge access restrictions, input validation, initialization recovery, and concurrency.
- 3 pixel-statistics tests and 8 native live-stability tests passed. Coverage includes changing inference batches, camera motion, full-size JPEGs, faint marks, sequence-field drift, and invalid content.
- Full scanner benchmark: 45 normal and 55 readable partial-document variants; all 5,000 question decisions matched the labeled truth. All 15 missing-content controls were rejected, with zero confident misgrades. Blank/multiple/faint-mark cases and registration invariants passed.
- Normal-image processing averaged 689.342 ms; p95 was 939.248 ms. These are Windows PC worker timings, excluding camera transfer and save latency. The full benchmark passed its existing latency gates.
- The newly compiled Windows worker passed the backend scanner contract.
- Both development and packaged Windows application renderers invoked the compiled offline scanner with an unavailable database. All five source sheets passed on both initial and tracked reads; corrupt input was rejected and renderer Node access remained disabled.
- Android production asset synchronization, APK assembly, and all 16 JVM tests passed. APK signature verification passed (debug signer, ARM64, Android 7+). The generated Android worker matches the shared Python source byte for byte.

The finite image benchmark derives from five labeled physical captures; it does not establish universal accuracy. Confidence remains an evidence score, not a guarantee. Uncertain or unreadable rows must still be corrected or reviewed. No Android phone was connected, so on-device timing, real camera transfer, and physical printing were not tested. Ordinary browsers retain the existing browser detector.

The production build has existing stylesheet-budget/CommonJS warnings, and Gradle reports deprecations. Neither prevented compilation or packaging.

## Files and repeatable checks

- Android: `dist/AcadCheck-offline-1.2.29-debug.apk` (also `dist/AcadCheck-offline-debug.apk`).
- Windows: `dist-desktop/AcadCheck-Setup-1.2.29.exe`.
- Accuracy and timing report: [scanner-validation-1.2.29.json](docs/scanner-validation-1.2.29.json).
- Packaged Windows offline check: [scanner-windows-offline-1.2.29.json](docs/scanner-windows-offline-1.2.29.json).
- Package hashes: [scanner-release-artifacts-1.2.29.json](docs/scanner-release-artifacts-1.2.29.json).

```powershell
npm run test:ci
npm run desktop:test
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_fast_statistics.py -v
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_live_stability.py -v
$env:OMR_OPENCV_THREADS = '2'
.scanner-venv/Scripts/python.exe ml-training/benchmark_fast_omr.py --summary
$env:OMR_WORKER_EXECUTABLE = (Resolve-Path desktop-runtime/acadcheck-omr-worker.exe).Path
node backend/test-fast-omr-contract.js
node desktop/offline-omr.integration.js
node desktop/offline-omr.integration.js dist-desktop/win-unpacked/AcadCheck.exe
```
