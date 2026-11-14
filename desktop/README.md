# AcadCheck Desktop for Windows

The desktop edition packages the Angular UI, Node backend, native backend
dependencies, and OMR Python worker into a normal Windows installer. End users
do not need Node.js, npm, or Python.

MySQL 8 or MariaDB remains the persistent database for signed-in accounts.
For those features, install and start MySQL, then import `acadcheck_db.sql`.
Offline Mode and its native scanner work without that database. AcadCheck creates this per-user
configuration file on first launch:

```text
%APPDATA%\AcadCheck\config\backend.env
```

Edit its `DB_USER`, `DB_PASSWORD`, and other database values when the local
database does not use the defaults. Restart the backend from the AcadCheck menu
after editing. The first account created from the login screen becomes the
administrator; the desktop proxy supplies its generated one-time bootstrap
token only to that local registration request.

Build the installer from PowerShell:

```powershell
npm ci
npm --prefix backend ci
.scanner-venv\Scripts\python.exe -m pip install -r desktop/requirements-runtime.txt
npm run desktop:installer
```

Use Python 3.12 or newer for the pinned Windows packaging runtime.
The first build installs PyInstaller into `.scanner-venv` if required. The
installer is written to `dist-desktop\`. Use `npm run desktop:verify` for the
desktop unit tests, Angular production build, scanner executable check, and an
unpacked application smoke build.

The current matching installer is `dist-desktop\AcadCheck-Setup-1.2.38.exe`.
Windows Offline Mode now uses the bundled native scanner without requiring
MySQL or internet access. It shares Android's native detection and validation
logic. Both installers include immediate frame scheduling, detail recovery,
exact image-statistics optimizations, and verified diagonal/sideways registration.
See `RELEASE_1.2.30.md` for validation
and device-test limits. Database-backed accounts still require MySQL/MariaDB.

User data is not stored in Program Files. Configuration, scans, and logs live
under `%APPDATA%\AcadCheck`. Closing AcadCheck and installing an update preserve
that data. The Windows uninstaller removes the folder when AcadCheck is
uninstalled.
