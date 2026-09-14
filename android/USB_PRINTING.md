# Epson L3210 USB printing

This build embeds an ESC/P-R score-printing engine and an Android USB host
transport in AcadCheck. Users do not install another printing application.
This is an initial hardware-test build: command encoding and application routing
are tested locally; actual L3210 output has not yet been verified on a phone.

## Install and test

1. Install/update `dist/AcadCheck-offline-debug.apk` (1.2.18, code 21). Keep
   existing app data by updating the installed debug APK.
2. Turn on the Epson L3210. Connect its existing USB-A to USB-B printer cable
   to a USB-C OTG adapter on an Android phone which supports USB host mode.
   A USB 3.0 socket on the adapter does not change the printer's USB 2.0 interface.
3. Open Exam Scanner. Under Print destination, choose **Epson L3210 via USB OTG**.
4. Tap **Find printer**, then **Connect**, and allow Android's USB access prompt.
   If several Epson printers are attached, select the L3210.
5. Load a blank A4 sheet and tap **Print test page**. Expect a red outlined
   `50/50` score and a small test caption near the lower-right corner.
6. Verify paper feed, color, rotation and position against your answer sheet
   before using actual student sheets.
7. Use **Print Result Again**, or enable **Auto Print** to submit the score
   after saving a grade. Insert the correct physical sheet before grading.
   Offline grades print without internet, a computer, or the Pi print service.
   Online grades are fetched from the existing authenticated API and then
   printed by the phone.
8. Disconnecting the cable clears the connection. Reconnect inside AcadCheck;
   failed jobs are never automatically replayed.

The **Android print dialog** destination preserves the previous printing path
when explicitly selected. It is not needed for the direct USB path.

## Scope and limits

- Epson vendor ID 0x04b8 plus an exact L3210 model identification is required.
  Model identification uses the IEEE 1284 device ID when available and the USB
  product descriptor as a fallback.
- The first profile prints one A4 score label per job: plain paper, normal
  quality, color RGB, 360 dpi, 3 mm margins. It is not a general PDF/photo driver,
  printer scanner integration, ink monitor, or maintenance tool.
- Class 7, subclass 1, USB printer protocols 1/2 with bulk output are supported.
  A printer exposing only protocol 3 (IEEE 1284.4) requires additional transport
  work; the app will not write unframed data to that interface.
- The app distinguishes **USB data submitted** from **paper physically printed**.
  Successful bulk transfers do not prove completion. Check the page; model-specific
  job-completion monitoring has not been implemented.
- Standard USB printer paper/error status is checked when firmware supplies it.
  Transfer failures and disconnection stop the job, with no automatic retry or
  switch to a different destination. A partial job may remain in the printer:
  check/cancel it on the printer before attempting another print.
- USB permission can need renewal after disconnection. Permission requests have
  a 60-second deadline. Bulk submission has a 90-second total deadline and
  bounded individual transfers.
- No attached phone/emulator was available during development. USB permission,
  OTG compatibility, printer interface descriptors, firmware acceptance,
  physical margins, and repeated prints remain device acceptance checks.
- Existing APK platform/ABI limitations still apply; see OFFLINE_APK.md.

## Implementation

- `UsbPrinterPlugin.java`: discovery, permission, exact model validation,
  interface ownership, bounded USB transfers, basic status, attach/detach events,
  A4 score rasterization.
- `EscPrEncoder.java`: pure Java ESC/P-R serialization with RGB PackBits rows.
  Only a small score bitmap is allocated; white page rows compress compactly.
- `UsbPrinterPolicy.java`: printer ID and score validation.
- `usb-printer.service.ts`: Ionic bridge, status, exclusive operations, honest
  submission reporting.
- Scanner: explicit destination, discovery/connect/disconnect/test controls,
  native online/offline score printing and historical-result routing.

The encoder is adapted from the MIT-licensed
[python-epson](https://github.com/ezrec/python-epson/tree/59e61905dd56a0cfdd162c39cc4d23cc24eba90c)
ESC/P-R protocol implementation. Its full copyright and permission notice ships
inside the APK at `assets/licenses/python-epson.txt`. No Epson proprietary SDK,
third-party APK, or desktop executable is bundled.

## Verification

Run `npm run test:ci` and, from `android`,
`./gradlew.bat :app:testDebugUnitTest`. New tests cover full A4 command framing,
RGB encoding and row coordinates, stopping on output failure, model identity,
invalid scores, historical score totals, online/offline routing, duplicate
submission prevention, and refresh failures after an accepted submission.

Then build `npm run build -- --configuration production`, run
`npx cap sync android`, and build `./gradlew.bat :app:assembleDebug`.
Copy the APK from `android/app/build/outputs/apk/debug/app-debug.apk` to
`dist/AcadCheck-offline-debug.apk`.

Device acceptance must include denial/approval of USB permission, unplugging
during submission, paper-out, several consecutive pages, and a manual reprint
of a different saved record. Do not treat a passing mocked/encoding test as a
successful physical print.
