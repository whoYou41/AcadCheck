# Scanner validation: APK 1.2.23 (code 26)

## Reported diagonal and clipped placement

The saved 1440x810 mobile frame reproduces the reported failure: all 50 answer
rows are visible, but the top and bottom paper boundaries are outside the frame
and the white paper merges with the patterned tablecloth during thresholding.
Version 1.2.22 spent about 2.49 seconds on repeated fixed-print registrations
before rejecting the frame.

Version 1.2.23 estimates the paper axis from the repeated answer rings, deskews
the camera image, and isolates a narrow content band before registration. A
perspective-aware quadratic profile finds all 25 physical row positions in each
block even when their spacing grows toward the camera. Both four-lane blocks are
fit together. A per-block alignment gate rejects a candidate before grading if
either block approaches an adjacent A-D lane.

On the reproduced frame, the updated detector:

- returns a gradeable result with all 50 marked answers correct;
- reports 99.0% verified answer confidence;
- reads boxed sequence `0003` as student 3 at 96% sequence confidence; and
- completes in about 1.1 seconds on the desktop validation host after warm-up.

The same frame was transformed to -18, -12, -8, 0, +8, +12, +18, and +25
degrees while keeping the answer content visible. Every transform returned the
exact 50-answer map at 99%. A separate full-page suite passes cold and tracked
reads at 0, +/-15, +/-30, 90, and 180 degrees, plus horizontal displacement.

## Regression and rejection checks

The focused partial-page suite passed all 11 valid captures: 550/550 questions
were correct, every sheet was gradeable, and average processing time was about
861 ms on the desktop host. Cases include cropped top, bottom, left and right
paper borders, a tight answer-area crop, camera rotation, perspective skew, and
uneven lighting.

All three focused negative controls remained safely rejected. They remove top
rows, bottom rows, or one complete 25-row block. No incomplete control produced
a confident grade. The wider rotation/displacement suite passed all 18 cold and
tracked reads. Camera-profile tests read 500/500 answers across ten images and
rejected an empty frame. Offline recovery, live stability, small-sheet, and
fast-statistics suites passed. All 108 Ionic tests and all 10 Android JVM tests
passed. The production Ionic bundle, application APK, and instrumentation-test
APK compiled successfully.

## Packaged APK

- Package: `io.ionic.starter`
- Version: 1.2.23 (code 26), Android 7+ (`minSdkVersion` 24)
- Architecture: ARM64 (`arm64-v8a`)
- APK SHA-256: `752E6B98E25B7CA7A54970F01F4EEAC5E35022A0F5503D50B9B4D2BA38D5FDB7`
- Signing certificate SHA-256: `B21CA4BBD56F1A2BB2FC74CAB57B9E29A66023F8F4373462A27284CD444D4413`

The Android build copied the tested scanner source without modification: all
three source copies have SHA-256
`192C60C6AEC2ADCAF4A61F1324B095BD1AF720F9BEDFE55D2FF6CA118D257114`.
The packaged bytecode contains the ring-lattice and sequence-detector paths,
and the APK contains the bubble model, digit model, and registration templates.

## Scope

Paper borders and corners are optional when all 50 rows and both A-D blocks are
clear. The detector still cannot reconstruct an answer cell hidden outside the
image, covered by an object, or destroyed by blur or glare. It abstains in those
conditions instead of assigning an unsupported answer.

No Android phone was attached for this build. Desktop measurements exercise the
same Python source and model assets copied into the APK, but phone camera and CPU
timing can differ.
