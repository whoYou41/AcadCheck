# Scanner validation: APK 1.2.19 (code 22)

The detector now ranks row-phase candidates by total unique ring and row
support before edge support. This fixes a small-sheet case where a few
header/footer circles shifted the grid by two rows. Mark classification and
minimum geometry/registration thresholds remain unchanged.

Broad illumination filtering now uses a float separable blur, rounded back to
an 8-bit background. Sequence-field scoring reduces each strip in one NumPy
operation. The live camera retains its 1920-pixel detail profile through
confirmation instead of alternating back to an undersampled frame. The UI
shows resolved rows independently of the confidence score, and still requires
two matching fresh reads before automatic grading.

## Validation on the development computer

- 107 Angular tests and 10 Android JVM tests passed.
- Production web build, Capacitor sync, `:app:assembleDebug`, and
  `:app:assembleDebugAndroidTest` passed. Instrumentation tests were compiled;
  they were not run on a phone.
- Five source photographs reduced to a small sheet in a 1440x810 frame:
  all 50 answers correct and gradeable on both initial and tracked reads
  (10 frames). The reproduced all-D case improved from 45 to 50 correct rows.
- Rotated/displaced photographs: all 18 initial/tracked frames correct.
  Mixed 1440/1920 capture tracking and pixel-statistics regressions passed.
- Broad normal-photo matrix: 44/45 single frames fully gradeable; the remaining
  rotated all-C image has one uncertain row in both the original and updated
  detector. This matrix therefore does not meet its strict 99% sheet gate.
- Partial-border matrix: all answer candidates correct across 55 valid images;
  53/55 immediately gradeable. Two all-C crops retain one uncertain row,
  identically in the original detector. All 15 genuinely incomplete-sheet
  negative controls rejected, with zero confident negative misgrades.
- Blank rows, multiple marks, and moderately faint marks passed. Faint second
  marks and borderline marks still abstain as expected. Registration and
  tracking invariants passed. Heavy blur can still prevent registration.

Identical 1440x810 JPEG-86 camera frames with local sequence detection enabled
averaged **404.1 ms before / 300.7 ms after** across six tracked reads per
version (about 26% faster). All compared reads were exact and gradeable.
These are desktop measurements using OpenCV 5.0.0 with two threads, not phone
latency measurements. The APK uses its existing bundled OpenCV 4.5.1.48.

The monolithic full benchmark stopped without a result; the normal, state,
registration, and per-photo partial sections were run separately instead.
An unrestricted Gradle instrumentation task also encountered a pre-existing
Kotlin duplicate-class conflict in the generated Cordova library test APK;
the app-scoped APK and test tasks above pass.

## Mobile layout and hardware limits

An isolated headless rendering of the actual USB card, stylesheet and Ionic
components at 320, 360, 390 and 768 pixels showed no horizontal overflow.
Buttons measured 46 pixels high, stacking into one column at 320 pixels.

No Android phone was connected through ADB. Actual phone latency, the supplied
physical sheet, and an Epson L3210 USB print still require device verification.
The AcadCheck launcher/startup logo and embedded USB printing are retained.
