# Scanner validation: APK 1.2.20 (code 23)

## Findings and changes

- Tracking previously chained each frame's homography into the next. It now
  measures motion from a fixed verified frame and checks forward/backward
  optical-flow agreement to reject unreliable matches.
- The prior reference descriptor refresh ran every two seconds, adding roughly
  150-180 ms on affected desktop frames. The reference is retained while
  tracking remains valid and rebuilt after fresh independent registration.
- Verified ring positions can now be checked against current printed-ring
  patches without rerunning global circle detection and periodic grid fitting.
  All 50 rows, both blocks, all edges and current calibration thresholds must
  pass. Every answer is still classified from the current image.
- Uncertain frames and out-of-order frames cannot overwrite a verified cache.
  Material changes to the answer pixels require independent registration;
  a bounded global adjustment distinguishes mild exposure/focus changes from
  local edits. Regression tests caught old tracked reads that missed a faint
  added mark; the new path correctly abstains on those fixtures.
- After a completed scan, unstable frames no longer replace the completed
  display while the sheet-removal barrier is active. Current images continue
  checking for removal/replacement. The display shows percentage of rows
  resolved, while acceptance still requires two matching fresh frames.

## Results

- 108 Angular tests passed, including preservation of the completed display
  during an uncertain frame and during a temporary native read failure.
- Live regression: 48 camera variants across three source photographs with
  movement, exposure changes, blur and 1440/1920 resolution transitions.
  All 48 retained correct answer candidates; 47 were immediately gradeable.
  Every source completed on its first two frames. One later all-C frame
  conservatively retained an uncertain row instead of asserting certainty.
- Changed/erased marks, faint second marks, missing edge rows, stale frame IDs,
  stricter calibration and tracking-cache preservation passed.
- Mixed-resolution recovery, 18 rotated/displaced camera frames and registration
  invariants passed. The broad cold-image checks retain the previously recorded
  limitations: 44/45 normal photographs and 53/55 border-cropped photographs
  immediately gradeable; the other frames abstain. All 15 incomplete-sheet
  negative controls rejected. These strict broad sheet-rate gates are therefore
  not all green; see the previous version's report for the matching limitations.
- Steady-sheet desktop comparison against 1.2.19: twelve tracked reads per
  version at 1440x810/JPEG 86, with sequence detection enabled, averaged
  **249.8 ms before / 107.9 ms after** (about 57% faster). Every compared answer
  was correct and gradeable. This isolates processing; it does not include
  phone hardware, camera transport or the user's physical sheet.

## Android verification

Build the production web assets, run `npx cap sync android`, then run
`:app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest`.
The app's ten JVM tests pass. Instrumentation tests include repeated reads
through the packaged Python/OpenCV engine, but were compiled only; no phone
was connected for execution. Desktop OMR tests use OpenCV 5.0.0 with two
threads. Android retains its bundled OpenCV 4.5.1.48.

Install `dist/AcadCheck-offline-debug.apk` over the previous APK to retain local
data. The existing app logo and embedded Epson USB printing are retained.
100% completion means all rows were resolved; camera images cannot provide a
guarantee of absolute accuracy under every focus, lighting or motion condition.
