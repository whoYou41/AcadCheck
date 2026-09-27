# AcadCheck 1.2.30 detection improvements

Validated 24 September 2026. Android version code: 37.

## Changes

- Fixed diagonal corner ordering: selecting corners independently by coordinate sums could select the same vertex twice near 45 degrees. Corners now follow the perimeter with deterministic ordering.
- Rotated outlines now bound a printed-template search. Verified printed questions establish row and A-D column identity before grading, preventing a rotated outline from reversing answer lanes. Ring-only registration is limited to the existing near-upright path.
- Sideways sheets retain their original-frame orientation and transform even when the paper edge is clipped. Their contour can bound a print search, but cannot bypass print, answer visibility, row-phase, or full-grid verification.
- Complete diagonal outlines are tried before the less reliable ring-axis crop, avoiding unnecessary failed searches.
- Android rejects overlapping native scan requests, including across activity recreation. This prevents old frames accumulating behind the active read. The latch clears on success, failure, or rejected submission.
- Both installers retain immediate fresh-frame scheduling, newest-frame processing, automatic detail retries, strict confidence validation, and the shared native detector introduced in 1.2.29.

## Validation

- 155 application tests, 11 desktop tests, 16 Android JVM tests, 3 numeric-statistics tests, 8 native stability tests, and 3 expanded condition tests passed.
- Full benchmark: 45 normal and 55 readable partial-document variants; all 5,000 question decisions matched their labels. All 15 missing-content controls were rejected. Blank, multiple, faint-mark, and registration-invariant checks passed.
- Final Windows PC worker timings: normal-sheet average 678.730 ms, p95 912.291 ms; warm persistent-worker average wall time 793.633 ms. The existing full-benchmark latency gates passed. Partial-document recovery averaged 1,106.440 ms, with a 3,350.956 ms maximum. These exclude camera transfer, multi-frame confirmation, and saving; they are not phone timings.
- Expanded conditions: 65 transformed variants from five physical captures, with 100 valid-frame checks including tracked reads. Angles covered 45, 90, 135, 180, 225, 270, and 315 degrees, plus dimming, additive fading, and gradients of shadow. Seven detail retries were exercised. 99 of 100 final valid-frame checks were accepted with exact answers; one faded all-C capture retained an uncertain row and required review. No accepted initial or retry frame was wrong. Four blank/covered/severely blurred controls were rejected.
- The final compiled Windows worker passed the backend accuracy, restart, and concurrency contract. The actual packaged Windows renderer passed 18 offline reads across five original captures plus diagonal/sideways regressions. Corrupt input was rejected; the renderer had no Node access. This test deliberately used an unavailable database.
- APK assembly, app instrumentation-test APK assembly, and signature verification passed. The APK is debug-signed, ARM64, Android 7+. All 141 production JavaScript files match between Android and Windows, the generated Android worker matches the shared source, and the packaged Windows worker matches the validated executable.
- System deployment preflight passed after starting the existing local MySQL/MariaDB server: database connection, required tables, 18 migrations, runtime files, models, and scanner warmup. Signed-in features still require a running database; native offline scanning does not.

These are finite tests derived from five labeled physical captures. Visibility alone cannot guarantee readable marks under blur, glare, occlusion, or low contrast; ambiguous captures continue to require review. No Android device was connected, so actual phone camera behavior, phone latency, and physical printing were not tested. The instrumentation APK was built, not run. Windows validation exercised the packaged executable, not an interactive installation wizard.

Existing Angular stylesheet/CommonJS warnings and Gradle deprecations did not prevent the application builds. Use app-scoped Gradle tasks below; a broad all-modules instrumentation build also attempts generated Cordova library test APKs with unrelated duplicate Kotlin dependencies.

## Artifacts and reports

- [Windows installer](dist-desktop/AcadCheck-Setup-1.2.30.exe)
- [Android APK](dist/AcadCheck-offline-1.2.30-debug.apk), also copied to `dist/AcadCheck-offline-debug.apk`
- [Full benchmark](docs/scanner-validation-1.2.30.json)
- [Expanded condition results](docs/scanner-conditions-1.2.30.json)
- [Packaged Windows offline checks](docs/scanner-windows-offline-1.2.30.json)
- [System readiness](docs/scanner-readiness-1.2.30.json)
- [Release checks and SHA-256 hashes](docs/scanner-release-artifacts-1.2.30.json)

Install updates over existing installations to retain local data. Avoid uninstalling or clearing app storage.

```powershell
npm run test:ci
npm run desktop:test
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_fast_statistics.py -v
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_live_stability.py -v
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_conditions.py -v
$env:OMR_OPENCV_THREADS = '2'
.scanner-venv/Scripts/python.exe ml-training/benchmark_fast_omr.py --summary
$env:OMR_WORKER_EXECUTABLE = (Resolve-Path desktop-runtime/acadcheck-omr-worker.exe).Path
node backend/test-fast-omr-contract.js
node desktop/offline-omr.integration.js dist-desktop/win-unpacked/AcadCheck.exe
node backend/deployment-preflight.js
./android/gradlew.bat -p android :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest --console=plain
```
