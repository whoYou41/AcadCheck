param(
  [string]$PythonExecutable = ''
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runtimeDir = Join-Path $projectRoot 'desktop-runtime'
$workDir = Join-Path $projectRoot '.tmp\pyinstaller'
$workerSource = Join-Path $projectRoot 'ml-training\fast_omr_worker.py'

if ([string]::IsNullOrWhiteSpace($PythonExecutable)) {
  $venvPython = Join-Path $projectRoot '.scanner-venv\Scripts\python.exe'
  $PythonExecutable = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { 'python' }
}

& $PythonExecutable -c "import cv2,numpy; assert cv2.__version__ == '5.0.0' and numpy.__version__ == '2.5.1', 'Install the pinned scanner runtime before packaging'"
if ($LASTEXITCODE -ne 0) {
  throw 'The selected Python runtime must match the tested OpenCV and NumPy versions. Install desktop\requirements-runtime.txt first.'
}

$hasPyInstaller = & $PythonExecutable -c "import importlib.util; print('yes' if importlib.util.find_spec('PyInstaller') else 'no')"
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the selected Python runtime.' }
if ($hasPyInstaller.Trim() -ne 'yes') {
  Write-Host 'Installing the desktop worker build dependency...'
  & $PythonExecutable -m pip install -r (Join-Path $PSScriptRoot 'requirements-build.txt')
  if ($LASTEXITCODE -ne 0) { throw 'Could not install PyInstaller.' }
}

New-Item -ItemType Directory -Force -Path $runtimeDir, $workDir | Out-Null
& $PythonExecutable -m PyInstaller `
  --noconfirm `
  --clean `
  --onefile `
  --name acadcheck-omr-worker `
  --distpath $runtimeDir `
  --workpath $workDir `
  --specpath $workDir `
  $workerSource
if ($LASTEXITCODE -ne 0) { throw 'The bundled OMR worker build failed.' }

$workerExe = Join-Path $runtimeDir 'acadcheck-omr-worker.exe'
& $workerExe --runtime-info
if ($LASTEXITCODE -ne 0) { throw 'The bundled OMR worker failed its runtime check.' }
Write-Host "Bundled scanner ready: $workerExe"
