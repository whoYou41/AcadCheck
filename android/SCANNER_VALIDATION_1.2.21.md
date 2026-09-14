# Scanner validation: APK 1.2.21 (code 24)

## Findings and changes

- Answer classification sampled only the central 8-pixel-radius disk. A mark
  shaded mainly on one side could therefore look blank even though it was
  visible in the complete bubble patch. The detector now also measures a
  10-pixel-radius interior and accepts that recovery only when its lane agrees
  with the embedded CNN, no competing mark exists, and physical ink evidence
  is present.
- The Android digit reader used raw Otsu thresholding while the working server
  reader retains strokes through a bounded `Otsu + 12` threshold. This caused
  the included failed capture `0003` to find all four boxes but misread the
  first zero and return no student. Native preprocessing now uses the same
  bounded threshold and reads that capture as sequence 3 at 92% confidence.
- True blank, multiple-mark, faint-second-mark and borderline-mark cases remain
  fail-closed. Two matching live frames are still required before automatic
  grading or saving.

## Results

- Four live scanner tests pass, including 48 motion/exposure/blur/resolution
  frames, tracking-cache safety, changed-mark handling, partial side shading,
  and the `0003` native sequence regression.
- Feature-statistics, small-sheet, mixed-resolution recovery, 18 rotated or
  displaced frames, state fixtures and geometry invariants pass.
- 108 Ionic tests pass, including offline scanning, student matching and USB
  printer behavior.
- The broad real-photo suite retains its known conservative result: 44 of 45
  transformed frames are immediately gradeable. The all-C image rotated -3
  degrees abstains instead of forcing an answer.

## Android verification

- The production Ionic build and Capacitor Android sync complete successfully.
- `:app:assembleDebug`, ten JVM tests, and Android instrumentation-test
  compilation complete successfully. Instrumentation was compiled but not run
  because no phone was connected.
- APK badging reports `io.ionic.starter`, version 1.2.21 (code 24), Android 7+
  and ARM64. Its nested Python bytecode exactly matches the generated scanner
  build and contains both bubble and digit models.
- Distribution APK SHA-256:
  `33B14FA0ABC821DAA11B8A1855453A42AC6F2BA7EFAD52A2F9900E418E1B85F7`.

## Device limit

These checks run on desktop OpenCV and during Android compilation. A physical
phone and the user's original answer sheet were not connected, so camera speed
and accuracy on that exact sheet still require an install-over test. A displayed
100% means every row was resolved consistently; it is not an unconditional
accuracy guarantee for blurred, obscured or badly lit images.
