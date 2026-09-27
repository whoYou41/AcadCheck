# Epson L120 USB score printing

## Current layout: 1.2.28-l120.4 (Android code 34)

Install dist/AcadCheck-L120-long-bond.apk as an update to the existing app.
The page is full-width long bond, **8.5 x 13 inches**, not A4 or 8.5 x 14 legal.
Load the **bottom/QR-code edge first**, using the same printable face and paper
guide alignment as the successful L120 test. Do not cut the sheet in half.

The score targets the space immediately right of the **right-hand form's
ANSWER SHEET heading** on the project's two-column template. Its box on the
upright full sheet begins 7.05 inches from the left and 2.00 inches from the
top, and measures 0.95 x 0.30 inch. The text is horizontal and upright after
bottom-first feeding. The test button prints 50/50 at exactly the same place
as a saved score, without an extra test caption. Use a spare copy of the form
to verify alignment before printing on completed originals.

These coordinates follow the supplied photo and project template; physical
printer offsets and scaling of a differently printed form still need checking.
The application does not locate the paper's heading dynamically during printing.

## Connection and auto-print

1. Turn on the L120 and connect its printer cable through the Android USB OTG adapter.
2. Select Epson L120 via USB OTG, tap Find printer and Connect, then grant USB access.
3. Load a spare full long-bond form bottom/QR first and use Print test page.
4. With Auto Print enabled, each saved score goes directly to USB without a
   per-page confirmation, even if the older system-dialog destination was saved.

Disconnecting the cable clears the selected connection. Printer attachment is
not proof of successful paper output. A failed or partial job is never replayed
automatically and never falls back to a dialog. Check the printer and clear any
partial job before a manual retry.

## Implementation and verification

- ScorePrintLayout.java defines the physical page and heading-side box, with
  the 180-degree coordinate/glyph transformation required by bottom-first feed.
- EscP2Encoder.java emits long-bond ESC/P2 variable-drop rasters. It compensates
  for staggered colour heads and skips blank bands.
- UsbPrintOutput.java sends 1 KiB chunks with a 30-second transfer timeout and
  five-minute submission deadline; confirmed short writes resume at their offset.
- UsbPrinterPlugin.java renders the score; the same renderer serves test and auto-print.

Protocol reference: https://gimp-print.sourceforge.io/reference-html/c463.html
L120 geometry: Gutenprint model 80 and its C82 ink layout. No new USB protocol
change is included in this placement update; the user confirmed that l120.2
printed correctly. The historical python-epson license remains in the APK.

Run the Android testDebugUnitTest task and assembleDebug after building the
production UI and running npx cap sync android. Tests independently decode raster
commands to check ink registration, long-bond dimensions, edge pixels, page eject,
PackBits and transport failures. The layout test checks the bottom-first inverse
transform, horizontal orientation and separation from title/name fields.
Physical placement on the user's printer remains a device acceptance check.
