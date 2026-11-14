# Offline Android APK

The installable app is `dist/AcadCheck-offline-debug.apk`, version 1.2.38 (code 45).
It is a debug-signed ARM64 APK for Android 7 or later. The versioned copy is
`dist/AcadCheck-offline-1.2.38-debug.apk`; SHA-256 sidecars accompany both files.
Install it over the previous debug APK to preserve local data; do not uninstall
or clear app storage.

Version 1.2.28 fixes the native inference crash caused by changing uncertain-row
counts, improves shifted sequence-box recognition, keeps first-frame confirmation
through brief alignment misses, and prevents stale results from remaining ready.
The versioned copy is `dist/AcadCheck-offline-1.2.28-debug.apk`.
See [release validation](../RELEASE_1.2.28.md) for measured results and device limits.

Version 1.2.29 starts detection on the first usable camera frame, processes only
the newest waiting frame, improves detail retries, and reduces native image
statistics overhead. See [scanner validation](../RELEASE_1.2.29.md). The versioned
package is `dist/AcadCheck-offline-1.2.29-debug.apk`.

Version 1.2.30 fixes diagonal corner ordering and sideways sheets at the frame
edge. Printed question-layout verification prevents reversed answer lanes.
The native plugin also rejects overlapping reads to prevent stale-frame backlogs.
The version 1.2.30 package was `dist/AcadCheck-offline-1.2.30-debug.apk`.
See [release validation](../RELEASE_1.2.30.md) for condition coverage and phone-test limits.

## Use on a phone

Version 1.2.27 strengthens handwritten sequence detection by confirming a
plausible digit read across two registered frames. It also keeps a verified
100% scan stable through transient focus/registration misses and releases the
previous-sheet barrier after confirmed removal, changed answers, or a confirmed
sequence change. These fixes work in browser/Windows offline mode even when a
native sheet fingerprint is unavailable.

Version 1.2.26 includes offline stable-scan recovery, faster sequence confirmation,
and interactive feature walkthroughs. It uses the same production
application bundle as the setup installer. Closing and reopening the Android app
continues to use its existing Capacitor application storage; installing this APK
over the previous debug build preserves that data.

Version 1.2.24 removes the dark-mode control and forces the interface and charts
to use the light theme, including after upgrading from a saved dark preference.
When sign-in cannot reach the network, API server, or localhost, the login card
now shows a clear connection warning and keeps Continue in Offline Mode visible.
The APK and Windows setup use the same application bundle.

Version 1.2.23 adds answer-ring-axis registration for diagonal sheets whose top
or bottom paper edges are outside the camera frame. It deskews the visible grid,
models perspective-varying row spacing, fits both 25-row blocks together, and
rejects a registration if either block slips toward an adjacent A-D lane. The
saved 1440x810 failure frame now reads all 50 answers at 99% and sequence `0003`
at 96% sequence confidence. See [alignment validation](SCANNER_VALIDATION_1.2.23.md).

Version 1.2.22 recalibrates the displayed score as verified answer confidence,
while retaining capture quality and all lighting, registration, geometry and
localization rejection gates. It also permits fully shaded uniform sheets to
use the current-frame ring fast path. See [confidence and speed validation](SCANNER_VALIDATION_1.2.22.md).

Version 1.2.21 reads side-heavy and partially shaded bubbles with a second,
wider interior measurement that must agree with the embedded classifier. It
also fixes the native handwritten sequence threshold so the known `0003`
capture is read as student 3 instead of requesting manual student selection.
See [current validation and phone-test limits](SCANNER_VALIDATION_1.2.21.md).

Version 1.2.20 stabilizes tracking against a verified reference, checks current
ring patches before reusing grid positions, and independently registers changed
answer content. Uncertain frames cannot poison the tracking cache or replace a
completed scan display while waiting for sheet removal. See [current validation
and phone-test limits](SCANNER_VALIDATION_1.2.20.md).

Version 1.2.19 fixes row-phase selection on small camera images, reduces local
lighting/sequence processing, and retains detail frames through confirmation.
Offline progress now counts resolved rows. The USB printer panel has wrapping
text and responsive touch controls. See [validation and device-test limits](SCANNER_VALIDATION_1.2.19.md).

Version 1.2.18 applies the existing AcadCheck green graduation-cap logo to
launcher icons (legacy, round, adaptive and themed) and startup screens.


Version 1.2.17 adds embedded Epson L3210 USB OTG score printing. Open Exam
Scanner, select **Epson L3210 via USB OTG**, connect and approve USB access, then
print a blank A4 test page before using real answer sheets. See
[USB printing setup and hardware-test limits](USB_PRINTING.md).
This first integration build still requires a physical phone/printer test.


Version 1.2.16 locates the paper's long axis and rectifies a bounded crop before
matching fixed print on tilted sheets. This avoids an outline warp that can fit
a plausible grid in the wrong position. Upright sheets retain their established
registration path to avoid unnecessary resampling. Sideways transforms are
mapped back to the original camera coordinates, and normal-size diagonal frames
retain source detail rather than being decoded at half resolution. Batched
bubble statistics and exact histogram percentiles reduce repeated computation
without changing the sampled pixels or weakening grading gates.

Version 1.2.15 corrects residual lane tilt before fitting A-D spacing and uses
the full affine grid to assign rings, including the bottom rows. Normal/detail
capture resolution changes retain valid tracking with the correct transforms.
Healthy tracking reuses reference features for up to two seconds, avoiding
repeated extraction. A temporarily unreadable ring can preserve recent matching
evidence for up to eight seconds; it contributes no confirmation vote. Two
complete identical maps are still required. Conflicting marks, missing geometry,
critical quality failures, changed students or expired evidence reset confirmation.

Version 1.2.14 fixed storage-mode switching. Signing in explicitly exits Offline
Mode. The cached scanner page reads the current authentication mode, reloads
references and preferences after switching, and clears pending frames and IDs
from the previous mode. Online scans use the authenticated database API;
offline grades use device storage. An online failure never falls back to a local
save. Switching modes does not erase previously saved offline data.

1. Copy the APK to the phone, open it, allow installation from that source if
   Android prompts, and choose Install/Update.
2. Open AcadCheck and select Offline Mode. Create/select a local classroom,
   student, and answer key. Cloud-only records are not automatically available
   in the separate offline database.
3. For Upload, select the answer-sheet image or take a photo with the phone.
   Detection and grading run on the phone with no internet or Pi connection.
4. For the Pi camera, keep the phone and the existing Pi on the same local Wi-Fi.
   Enter the Pi's existing address, for example
   `http://192.168.254.104:5000`, and use Test Connection. Start the scanner.
   Internet access is unnecessary, but the local Wi-Fi connection is required.
5. Review any uncertain reading. Verified blank and multiple-mark rows score
   zero. Saved grades and reports stay in the app's local storage.

Offline Auto Scan is enabled by default. Auto Grade & Save also defaults on and
uses the handwritten sequence to select the unique student in the selected
classroom. A verified native result must agree across two camera frames before
automatic grading. After saving, the sheet-removal
barrier prevents duplicate grades and permits the next sheet after a short
half-second cooldown.

The Pi camera remains active through grading and connection retries until the
operator presses Stop Camera. Navigating away pauses network polling; returning
to the scanner resumes it automatically.

Auto Print can be enabled beside Auto Grade & Save. Android defaults to direct
Epson L3210 USB printing through the embedded encoder. Connect the printer from
the scanner first. The optional Android print dialog destination preserves the
previous system-print-service path and requires confirming each job.
Offline desktop browsers send the score to the Windows default printer through
the local AcadCheck backend and fall back to the browser print dialog if that
printer is unavailable.

The scanner reloads local students whenever it is reopened or its answer-key
classroom changes. New offline students receive the next unused sequence in
their classroom. Version 1.2.5 also migrates older local records, normalizes
legacy field and ID formats, and repairs duplicate sequences created by earlier
offline builds. A classroom without local students is identified explicitly in
the selector.

Leave the Student selector on **Auto-detect from sheet sequence** for automatic
student selection. Choosing a named student is a manual override. The scanner
shows an active-mode note whenever automatic selection is enabled.

The APK uses its LocalCamera native plugin for discovery, status, capture, and restart.
Each request uses the connected Wi-Fi (or Ethernet) network explicitly, even if
Android selects cellular for internet access. Requests have native deadlines,
support cancellation, reject redirects, and validate camera image responses.
This avoids WebView CORS/cookie restrictions for local HTTP camera requests and
keeps account tokens away from the Pi. The direct address must be a private IP or
local hostname; the APK does not call a nonexistent `/api/camera` at localhost.

Offline browsers served over HTTP connect directly to the Pi and preserve the
entered camera address. HTTPS browsers retain the backend bridge to avoid mixed
content restrictions. Bridged requests establish and renew their own offline
session, including before discovery completes. The development proxy preserves
the browser Host header so local offline sessions pass the origin check.

Preview polling owns frame capture and backs off when the camera is unavailable;
auto-detection waits for fresh preview frames instead of issuing extra requests.
Connection failures discard old confidence, overlays, and pending detection
results. Discovering a warming camera schedules recovery so scanning can resume.
Version 1.2.8 keeps the last good preview through two brief capture delays,
then shows reconnecting only after three consecutive transport failures. The
Android read timeout now completes before the UI timeout, preventing abandoned
native requests from overlapping later polls. Discovery probes the configured
Pi first and limits fallback probes to two at a time.

Version 1.2.9 removes the fixed dark camera viewport. The live image now keeps
its natural aspect ratio, the scan progress and LIVE state sit above it, and
detection or connection messages sit below it. Answer labels remain aligned
over the shaded bubbles inside the image.

Version 1.2.10 removes the duplicate inactive-camera panel, keeps the last live
frame visible during retries and grading, verifies offline answers and sequence
numbers across two frames, and recognizes a stable new sheet even when its short
identity fingerprint is similar to the previously graded sheet.

Version 1.2.11 confirms a complete single-choice answer map across three frames
when the native reader reports only borderline row confidence, while preserving
hard failures for geometry and image quality. It also keeps honest per-row label
confidence, removes Dashboard from offline navigation and direct access, and adds
bottom safe-area spacing to every page.

Version 1.2.12 accepts a complete borderline answer map after two matching fresh
frames, keeps the current sheet's auto-selected student through an intermittent
sequence OCR miss, and clears that student at the verified sheet boundary. Direct
Pi captures use a validated 1280/q84 profile, faster offline polling, and shorter
connection probes. Strong complete-grid edge evidence can also recover a marginal
QR row-phase registration without weakening partial-sheet rejection.

Version 1.2.13 fixes first-use discovery accidentally disabled by saving a default
address before checking preferences. Startup recovery begins after 1.5 seconds
without a first frame; two independent probes can use a healthy IP immediately
without waiting for an unrelated hostname timeout. Health callbacks cannot cancel
an active capture or override a newer successful image. The UI shows Connecting
until an image loads, with a visible placeholder when no preview exists.

The first preview uses 960/q80 and is excluded from grading. Subsequent frames
use 1440/q86; unresolved detail requests 1920/q92 automatically. Short preview
delays preserve matching answer evidence, and unfinished native scans cannot pile
up after retries. Temporal acceptance requires valid native row and quality data;
missing or contradictory payloads remain ungradeable. Auto-selected students are
retained only for a recent matching sheet, and a verified replacement keeps its
newly recognized student. A saved grade remains committed if refreshing details
fails. Stop Camera works during processing. The screen stays awake while the
scanner is visible, and camera intent survives app background/foreground changes.
Python starts on the OMR executor instead of blocking application startup.

The Pi serves its existing `/status` and `/capture` endpoints. There is no Pi OMR
installation, new Pi endpoint, or Pi package to deploy.

## Detector and rebuild

The native Capacitor plugin runs the shared Python/OpenCV worker on a background
queue. Templates, bubble verification, and handwritten-sequence OCR are
prewarmed. Live frames carry the existing session/frame IDs so verified
geometry can be tracked across frames.
Every new frame still passes the worker's geometry and quality checks. Uploads
use the same worker without borrowing camera-session state.

Every classically blank row is now checked by the bubble classifier in one
batch. A faint mark is recovered only when the model and image evidence agree;
otherwise the row requires review. Automatic grading also requires two
identical frames whenever a blank or multiple mark would score zero. The web
offline fallback bundles and uses the same bubble model.

Gradle copies the current `ml-training/fast_omr_worker.py`, versioned registration
templates, and the bubble and digit ONNX models into generated Android
sources for every build. Do not manually copy detector files into
`app/src/main/python`; only the Android wrapper belongs there.

From the repository root:

```powershell
npm run test:ci
npm run build -- --configuration production
npx cap sync android
cd android
.\gradlew.bat :app:assembleDebug
```

The resulting APK is `android/app/build/outputs/apk/debug/app-debug.apk`.
It must be copied to `dist/AcadCheck-offline-debug.apk` when distributing a new
build. Android Studio can open the `android` directory and build the same project.
The pinned build dependencies are Chaquopy 17.0.0, Python 3.10, NumPy 1.26.2, and
OpenCV 4.5.1.48. They are bundled in the APK; no runtime download is needed.

## Verification and limits

- 112 application tests cover mode switching, online/local save separation, offline persistence, result validation, camera
  session creation/renewal, native HTTP routing and JPEG decoding, native
  upload/camera routing, retry backoff, stale results, warm-up recovery,
  invalid/incomplete row maps, sequence-based student selection, stable
  borderline-row confirmation, and strict rejection of critical quality failures.
- Ten native JVM tests cover permitted camera endpoints, rejection of empty or
  HTML image responses, and direct USB printer encoding and policy. The Android instrumentation test APK compiles;
  running those device tests still requires an attached ARM64 phone.
- `python ml-training/test_camera_capture_profiles.py` checks five reference
  photos at both grading profiles: 500/500 answers correct, all ten reads
  gradeable, and an empty frame rejected. These fixtures do not establish
  universal accuracy for unseen sheets, glare, or severe cropping.
- `python ml-training/test_offline_detection_recovery.py` verifies tilted grids,
  genuine spacing mismatch rejection, reference reuse and matching answers across
  1440/1920 capture changes. Current desktop checks use OpenCV 5.0.0; the APK
  runtime is OpenCV 4.5.1.48 and still needs the attached-device tests below.
- `python ml-training/test_offline_flexible_detection.py` checks cold and tracked
  reads at 0, +/-15, +/-30, 90 and 180 degrees, plus horizontal displacement.
  All 18 reads return the complete correct 50-answer map. These are transformed
  reference photographs, not a measurement of every possible camera position.
- `python ml-training/test_offline_fast_statistics.py` verifies exact agreement
  with the previous per-bubble calculation, including fractional pixel centers,
  and NumPy percentile equivalence on constant, random and strided images.
- Saved camera photographs also verify boxed sequences `0001`, `0002`, and the
  earlier failed-capture regression `0003`. The difficult `0002` frame resolves
  its blank rows locally while preserving review for any truly uncertain row.
- The registration invariants pass. The reported clipped diagonal frame reads
  all 50 answers at 99% in about 1.1 seconds after warm-up on the desktop host.
  Timing is hardware-dependent; desktop timings do not establish phone speed.
- The focused partial-page benchmark accepts all 11 valid captures with 550/550
  questions correct and rejects all three incomplete-sheet controls. It covers
  clipped paper borders, a tight answer-area crop, rotation, perspective skew,
  and uneven lighting. This is measured coverage, not universal acceptance.
- APK signature, version, app icon resources, ARM64 libraries, bundled models,
  registration templates, and scanner bytecode are checked. The distributed
  APK SHA-256 is
  `8DC479E5D3B9BE2BB84D7D66842DE55FB2974057A61B13983B5BF9D408284673`.
- The desktop `/api/camera/offline-session` returned HTTP 200 after the proxy
  fix. The saved Pi addresses were unreachable during verification; the backend
  returned HTTP 503 instead of the previous authentication failure.
- No phone/emulator was attached during this build. The real Android runtime,
  camera permissions, local Pi connection, and phone timing still need the
  device check below.

The bundled OpenCV/NumPy libraries have 4 KB ELF alignment. The manifest enables
Android's page-size compatibility mode for devices which support that mode.
This is not native 16 KB alignment or a Play Store release certification.
16 KB devices without compatible loading remain unsupported until the numerical
libraries are rebuilt. See
[Android page-size support](https://developer.android.com/guide/practices/page-sizes)
and [Chaquopy packaging](https://chaquo.com/chaquopy/doc/current/android.html#packaging).

## Device test

Connect an ARM64 phone with USB debugging authorized, then run from `android`:

```powershell
.\gradlew.bat :app:connectedDebugAndroidTest
```

This uses the actual packaged Python/OpenCV runtime to read the five photographs,
check rotated sheets and repeated tracked frames, and reject empty/invalid images. Its small test APK
is only a developer test harness, not another user-installation artifact.

Afterward, turn internet access off while keeping local Wi-Fi enabled. Verify an
upload, a phone-camera photo, a Pi-camera scan, saving a grade, and reopening the
saved result. The matching answer key and student must exist in Offline Mode.
