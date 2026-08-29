const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function resolveScannerPython(...environmentNames) {
  for (const name of environmentNames) {
    const configured = String(process.env[name] || '').trim();
    if (configured) return configured;
  }

  const executableParts = process.platform === 'win32'
    ? ['Scripts', 'python.exe']
    : ['bin', 'python'];
  const candidates = [
    path.join(ROOT, '.scanner-venv', ...executableParts),
    path.join(ROOT, 'ml-training', 'venv', ...executableParts),
  ];
  const bundled = candidates.find(candidate => fs.existsSync(candidate));
  if (bundled) return bundled;

  return process.platform === 'win32' ? 'python' : 'python3';
}

function inspectScannerRuntime(...environmentNames) {
  const executable = resolveScannerPython(...environmentNames);
  const probe = spawnSync(
    executable,
    [
      '-c',
      'import json,platform,cv2,numpy;print(json.dumps({"pythonVersion":platform.python_version(),"openCvVersion":cv2.__version__,"numpyVersion":numpy.__version__}))',
    ],
    {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
    }
  );
  if (probe.error) {
    return { available: false, executable, reason: probe.error.message };
  }
  if (probe.status !== 0) {
    const detail = String(probe.stderr || probe.stdout || `exit code ${probe.status}`).trim();
    return { available: false, executable, reason: detail.slice(0, 500) };
  }
  try {
    const versions = JSON.parse(String(probe.stdout || '').trim());
    return { available: true, executable, ...versions };
  } catch (error) {
    return { available: false, executable, reason: `invalid runtime probe output: ${error.message}` };
  }
}

module.exports = { resolveScannerPython, inspectScannerRuntime };
