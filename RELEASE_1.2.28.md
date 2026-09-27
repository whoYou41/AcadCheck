# AcadCheck 1.2.28 scanner validation

Validated on 17 September 2026. Android version code: 31.

## Changes

- Prevented a reproducible persistent OpenCV-DNN process crash when inference batches changed size. Bubble and digit inference now use fixed input sizes; padding is excluded from predictions.
- Kept a recent first confirmation through a temporary alignment miss without counting it as another vote. Confirmations expire, clear on removal or conflicting evidence, and do not display stale alignment as ready.
- Expanded student-sequence box search in both native and browser/Windows offline scanning. Complete border/divider evidence is still required. Failed browser model loads can retry.
- Normalized large raw captures consistently with preview frames and prioritized printed-template alignment for landscape images, fixing raw-photo column drift.
- Recovered a narrowly defined faint mark on a cropped uniform sheet only when independent model margin and ink contrast agree. Ambiguous second marks still require review.
- Supplied explicit model/template paths to the compiled Windows worker; its temporary extraction directory cannot be used as the asset root. Digit model changes also invalidate the worker asset cache.
- Pinned the Windows packaging runtime separately, preserving existing backend Python compatibility.

## Results

| Check | Result |
| --- | --- |
| Normal variants | 45/45 gradeable; 2,250/2,250 answers correct |
| Cropped, rotated and other partial-document variants with all answer patches visible | 55/55 gradeable; 2,750/2,750 answers correct |
| Invalid controls with missing answer content | 15/15 rejected; zero confident misgrades |
| Blank, multiple-mark and faint-mark state cases | All five expected outcomes and answer maps passed |
| Registration/tracking invariants | 13 checks passed |
| Native live regressions | 8 tests passed, including 48 varying camera frames, raw JPEGs, shifted/tilted/dim sequence fields and batch-size crash reproduction |
| UI/browser tests | 129 passed |
| Android JVM tests | 10 passed |
| APK signature | Verified; debug-signed ARM64 |
| Compiled Windows scanner | Backend scanner contract passed using the actual executable |
| Desktop runtime and persistence | 6 tests passed; data persisted across two Electron launches |
| Packaged Windows application | Launched successfully; database and scanner readiness endpoint passed |
| Operational preflight | Passed, including database schema, 18 recorded migrations and scanner warmup |

Normal-image average processing: **736.9 ms**; p95: **972.5 ms**. Persistent worker warm average: **792.8 ms**; cold startup/read: **1185.9 ms**. Harder partial-document average: **1032.0 ms**; maximum: **2645.8 ms**.

Measurements used this Windows PC with a two-thread OpenCV budget. They exclude camera transfer and database save latency. The full benchmark passed its existing accuracy and latency gates. [Raw benchmark results](docs/scanner-validation-1.2.28.json) include every case.

The compiled contract's reported answer-confidence range was 97.62–99.00%. Confidence is a model/geometry score, not a measured probability of correctness. The 100% observed accuracy above applies to this finite fixture set, derived from five labeled physical captures. Sequence tests include 18 transformed views of the known `0003` sample and negative controls; they do not establish accuracy across all handwriting.

## Packages and environment

- Android: `dist/AcadCheck-offline-1.2.28-debug.apk`, also copied to the usual `dist/AcadCheck-offline-debug.apk`; SHA-256 sidecars accompany both.
- Windows: `dist-desktop/AcadCheck-Setup-1.2.28.exe`; SHA-256 sidecar accompanies the final installer.
- [Artifact sizes and SHA-256 checksums](docs/scanner-release-artifacts-1.2.28.json).
- The stopped existing XAMPP database was started using its existing configuration; no schema or account data was changed by the readiness check.
- The APK uses its existing Android OpenCV 4.5.1/NumPy 1.26.2 runtime; the Windows worker uses OpenCV 5.0.0/NumPy 2.5.1. Android source synchronization, compilation, unit tests and signature checks passed.

No Android phone was connected, so on-device instrumentation, real Pi camera acquisition and physical scanning/printing were not exercised. Browser-only offline scanning retains its existing separate detector. This release improves the verified failures but cannot guarantee every visible sheet is readable under arbitrary blur, glare, distance or handwriting.

## Repeat the main checks

```powershell
npm run test:ci
$env:OMR_OPENCV_THREADS = '2'
.scanner-venv/Scripts/python.exe -m unittest discover -s ml-training -p test_offline_live_stability.py -v
.scanner-venv/Scripts/python.exe ml-training/benchmark_fast_omr.py --summary
$env:OMR_WORKER_EXECUTABLE = (Resolve-Path desktop-runtime/acadcheck-omr-worker.exe).Path
node backend/test-fast-omr-contract.js
Remove-Item Env:OMR_WORKER_EXECUTABLE
node backend/deployment-preflight.js
```
