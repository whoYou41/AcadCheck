const fs = require('fs');
const path = require('path');

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

module.exports = { resolveScannerPython };
