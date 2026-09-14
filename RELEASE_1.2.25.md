# AcadCheck 1.2.25 release

Both distribution packages contain the same production web application and
offline scanner engine.

## Changes

- Fixed Windows offline-data loss after closing AcadCheck. The desktop shell
  now uses the stable private origin `http://127.0.0.1:43127`, so Chromium opens
  the same persistent local database on every launch.
- Added one-time recovery for data left under the random localhost origins used
  by previous desktop versions. AcadCheck checks the prior origins recorded in
  `%APPDATA%\AcadCheck\logs\backend.log` and restores the saved database with the
  most records before showing the window.
- Kept configuration, scans, offline records, and progress under
  `%APPDATA%\AcadCheck` when the app closes or is updated. A normal Windows
  uninstall now removes this application-data folder.
- Updated Android to version 1.2.25 (code 28) and the Windows application to
  version 1.2.25.

## Artifacts

- Android: `dist/AcadCheck-offline-debug.apk`
  - SHA-256: `8DC479E5D3B9BE2BB84D7D66842DE55FB2974057A61B13983B5BF9D408284673`
  - Size: 54,984,227 bytes
  - Package: `io.ionic.starter`
  - Android 7+, ARM64
- Windows: `dist-desktop/AcadCheck-Setup-1.2.25.exe`
  - SHA-256: `707B650897E382AA9943F2F0E16358905AD5212BD6989C85FE6ED18478A58A18`
  - Size: 364,002,475 bytes
  - Product version: 1.2.25

## Validation

- 112 Ionic application tests passed, including reconstruction of classrooms,
  students, and answer keys from the local database after service restart.
- Six Electron shell tests passed for the stable origin and legacy-origin
  selection, along with the existing static server and backend proxy checks.
- A real Electron integration test wrote an offline database, closed AcadCheck,
  launched it again with the same user-data folder, and read back the identical
  database from Chromium storage.
- Ten Android JVM tests passed. The production Angular build, Capacitor sync,
  Android application APK, Android instrumentation-test APK, scanner executable,
  and NSIS setup completed successfully.
- Android package metadata, version, V2 signature, and the stable origin inside
  the packaged Electron application were verified.

No Android phone was attached, so physical camera, storage, and printer behavior
remain device checks. The Windows installer is not code-signed and may show a
Windows SmartScreen prompt on first launch.
