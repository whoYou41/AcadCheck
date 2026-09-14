# Scanner validation: APK 1.2.22 (code 25)

## Confidence

The prior displayed number mixed capture conditions with answer certainty. A
correct, fully resolved all-D sheet could therefore show about 80% even when
the answer evidence was 99%. This version reports verified answer confidence
from per-row ink evidence (85%) and independently fitted grid geometry (15%).
Lighting, contrast, sharpness, registration and bubble localization remain hard
accept/reject gates. Their weighted diagnostic remains available separately as
`captureQuality`; a low-quality or unresolved frame is still capped and rejected.

Across 48 mobile-style frames with movement, exposure changes, blur, and
1440/1920 resolution changes:

- 47 were immediately gradeable; every one scored at least 95% verified
  confidence (minimum 95.11%, mean 97.33%, maximum 98.67%).
- All 48 retained the correct candidate for every answer row. The remaining
  frame conservatively kept one row uncertain and was not assigned a high
  confidence or accepted.
- Mean per-row answer confidence on gradeable frames was 98.72%.

## Speed

Fully shaded bubbles can reduce printed-ring texture. The old current-frame
ring gate therefore reran slower grid fitting on many correct uniform sheets.
The texture floor was adjusted from 8 to 6 grayscale levels; all row, lane,
edge, correlation, geometry and changed-ink requirements remain in place.

- Fast current-frame verification increased from 17 to 38 of 45 warm frames.
- Fast frames averaged 124.6 ms (124.3 ms median, 131.1 ms p95) on the desktop
  test host.
- All warm frames had a 125.1 ms median. Mean was 217.4 ms because seven frames
  deliberately used safer grid fitting or independent registration; the slow
  recovery tail reached about 1.2 seconds.

## Safety and scope

Changed answers, erased edge rows, missing rows, stale frames, true blanks,
multiple marks, faint second marks, partial shading, sequence `0003`, small
sheets, mixed resolutions, and rotated/displaced frames pass. The broad suite
retains one known all-C rotated frame which abstains instead of guessing.

The production Ionic build, Capacitor sync, APK assembly, ten JVM tests, and
instrumentation-test compilation pass. The nested APK bytecode exactly matches
the tested scanner build and includes the bubble and digit models. APK SHA-256:
`5210FFCF112E16B696BA902F05210E55C29CEFCC34C0EE7A7A553432B12B6850`.

No Android phone was connected. These timings measure the exact Python source
packaged into the ARM64 APK on desktop OpenCV; phone camera transport and CPU
latency can differ. A 95% score describes the verified evidence for an accepted
frame and is not an unconditional guarantee under blur, obstruction, or poor
lighting.
