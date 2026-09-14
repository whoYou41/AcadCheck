# AcadCheck 1.2.24 release

Both distribution packages contain the same production web application and
offline scanner engine.

## Changes

- Removed the dark-mode menu control and forced light rendering for the app and
  charts. Startup clears a dark preference saved by an older version.
- Added an inline sign-in warning when the internet, API server, or localhost
  cannot be reached. The message explains what to check and points directly to
  Continue in Offline Mode.
- Updated Android to version 1.2.24 (code 27) and the Windows application to
  version 1.2.24.

## Artifacts

- Android: `dist/AcadCheck-offline-debug.apk`
  - SHA-256: `CDEEBD7E8CF6EC292093F1A6DA6FB6C778DDEF7D403BDD2696265298FA5344B3`
  - Package: `io.ionic.starter`
  - Android 7+, ARM64
- Windows: `dist-desktop/AcadCheck-Setup-1.2.24.exe`
  - SHA-256: `ECA215DADC0598E408E0A5074577BC7F2A43219837B82AC8E22037CBDD69A47B`
  - Product version: 1.2.24

## Validation

- 111 Ionic application tests passed, including the light-only migration and
  unreachable-network/server sign-in cases.
- Four Electron desktop shell tests and 10 Android JVM tests passed.
- The Angular production build, Capacitor sync, Android application APK,
  Android instrumentation-test APK, scanner executable, and NSIS setup all
  completed successfully.
- Android package metadata, launcher icon resource, signature, architecture,
  and version were verified after copying the distributable APK.

No Android phone was attached, so camera behavior and timing remain covered by
the scanner fixtures and desktop reference tests rather than a physical-device
run. The Windows installer is not code-signed and may show a Windows SmartScreen
prompt on first launch.
