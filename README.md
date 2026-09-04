# AcadCheck

AcadCheck is an Ionic/Angular, Node.js, MySQL, OpenCV, and ONNX system for
creating answer keys, printing answer sheets, scanning 50-question
multiple-choice forms, grading them, and reviewing classroom statistics.

## Included features

- Live camera and uploaded-image scanning
- Perspective-corrected 50-by-4 OMR detection
- Blank, single-mark, and multiple-mark handling
- Confidence scoring and fail-closed rejection of unreliable scans
- Manual answer-key selection before scanning
- Handwritten student sequence recognition from two structured digit boxes
- Answer-key sheet generation from `backend/templates/Answer-Sheet.docx`
- Pending/printed answer-sheet workflow
- Result reprinting
- Per-question classroom statistics and charts
- Android/Capacitor and optional Raspberry Pi camera support

## Answer-sheet identity area

Every newly generated answer sheet has two `STUDENT SEQUENCE NO.` boxes and no
QR code. Students write one digit per box. For sequence 1, write `01` or leave
the first box blank and write `1` in the second. Sequence numbers range from 1
to 99. The operator selects the answer key manually before scanning; AcadCheck
uses only the handwritten sequence to select the student in that key's classroom.

## Prerequisites

- Node.js 20 or newer
- npm
- MySQL or MariaDB
- Python 3.10 or newer
- Windows for direct server-side score printing
- Android Studio only when building the Android application

## Fresh installation

### 1. Install frontend dependencies

```powershell
npm ci
```

### 2. Install backend dependencies

```powershell
cd backend
npm ci
cd ..
```

### 3. Install scanner runtime dependencies

Windows:

```powershell
python -m venv .scanner-venv
.\.scanner-venv\Scripts\Activate.ps1
pip install -r ml-training\requirements-runtime.txt
```

Linux:

```bash
python3 -m venv .scanner-venv
source .scanner-venv/bin/activate
pip install -r ml-training/requirements-runtime.txt
```

Set `OMR_PYTHON` in `backend/.env` to the Python executable
from this environment.

### 4. Configure the backend

```powershell
Copy-Item backend\.env.example backend\.env
```

Edit `backend/.env`, especially:

- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`
- `JWT_SECRET`
- `OMR_PYTHON`
- `OMR_OPENCV_THREADS=1`, `OMR_MAX_PENDING_REQUESTS=2`, and
  `TESSERACT_POOL_SIZE=1` on a one-vCPU Droplet
- `PI_CAMERA_URL` when using the Raspberry Pi camera service
- `NODE_ENV=production` for a deployed server
- `CORS_ORIGINS` only when a separate trusted web/app origin calls the API
- `BOOTSTRAP_ADMIN_TOKEN` while creating the first administrator

Never commit `backend/.env`.

### 5. Create the database

Import `acadcheck_db.sql` into MySQL. The backend automatically applies all
files in `backend/migrations/` at startup.

Example:

```powershell
mysql -u root -p < acadcheck_db.sql
```

The public schema intentionally contains no default account. The first account
is an administrator and requires the one-time `BOOTSTRAP_ADMIN_TOKEN`. With the
backend running, create it from an administrator-controlled terminal:

```powershell
$headers = @{ 'X-Bootstrap-Token' = '<value from backend/.env>' }
$body = @{
  first_name = 'System'; last_name = 'Administrator'
  email = 'admin@example.edu'; username = 'admin'
  password = '<a unique password of at least 12 characters>'
} | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/auth/register `
  -Headers $headers -ContentType 'application/json' -Body $body
```

Remove `BOOTSTRAP_ADMIN_TOKEN` from `.env` after the first account exists.
Later accounts are created by an authenticated administrator. Public
registration remains disabled unless `PUBLIC_REGISTRATION=true`; even when it
is enabled, public users can only receive the `teacher` role.

### 6. Start AcadCheck

Backend:

```powershell
cd backend
npm start
```

Frontend, in another terminal:

```powershell
npm start
```

The frontend normally runs at `http://localhost:8100` and proxies API requests
to the backend at `http://localhost:3000`.

Before deployment, run the production preflight. It checks the secret,
runtime files, Python/OpenCV, the OMR worker, database schema, administrator
bootstrap state, and migrations without modifying grades:

```powershell
npm run verify:deploy
```

This single gate runs the browser unit tests, scanner contract tests,
production frontend build, and backend preflight.

The running service exposes `GET /api/health` for liveness and
`GET /api/ready` for database/scanner readiness. Configure the service manager
or reverse proxy to send traffic only when `/api/ready` returns HTTP 200.

## Production/frontend build

```powershell
npm run build
```

The generated `www/` directory is intentionally excluded from Git. Rebuild it
after cloning or before packaging the application.

For Android:

```powershell
npm run build
npx cap sync android
npx cap open android
```

## Scanner runtime resources

The repository includes the files required at runtime:

- `backend/models/bubble-classifier.onnx`
- `backend/models/digit-classifier.onnx`
- `backend/models/text-recognizer.onnx`
- `backend/eng.traineddata`
- `backend/scan-calibration.json`
- `backend/bubble-calibration.json`
- `ml-training/fast_omr_worker.py`
- `ml-training/reference_images/`

The handwritten digit model is a true 10-class model. Its reproducible training
script is `ml-training/train_handwritten_digit_classifier.py`; training data and
checkpoints remain ignored.

## Validation

Frontend type checking:

```powershell
npx tsc --noEmit
```

Backend syntax:

```powershell
node --check backend\server.js
node --check backend\answer-sheet-generator.js
```

Python syntax:

```powershell
python -m py_compile ml-training\fast_omr_worker.py
```

## Security and repository hygiene

The Git repository excludes:

- `.env` files and signing keys
- `node_modules` and Python virtual environments
- uploaded answer sheets and score images
- training datasets and checkpoints
- generated frontend and Android build output
- local IDE settings

Review `git status` and `git diff --cached` before every push.

For an internet or campus-network deployment:

- Terminate HTTPS at a maintained reverse proxy and set `TRUST_PROXY=true`.
- Keep `CORS_ORIGINS` empty for same-origin hosting, or list only exact trusted
  origins separated by commas.
- Do not expose `uploads/` through the reverse proxy. Answer sheets are served
  only through authenticated, owner-scoped API routes.
- Back up MySQL and test restoration before the first live examination.
- Run `npm audit --omit=dev` in both the project and `backend` directories.

## Additional documentation

- `QUICK_START.md`
- `docs/SCANNER_ENGINEERING_REPORT.md`
- `docs/ONNX_OPERATION_GUIDE.md`
- `raspberry-pi-camera/SETUP_GUIDE.md`
