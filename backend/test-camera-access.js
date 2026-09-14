const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
process.env.ACADCHECK_SERVER_UNIT_TEST = '1';
process.env.NODE_ENV = 'test';
// Reproduce an existing deployment allow-list without the Angular dev port.
process.env.CORS_ORIGINS = 'http://localhost:3000';
const {
  isTrustedOfflineCameraRequest,
  normalizeOfflineScoreText,
} = require('./server').__liveSheetStateTest;
const request = (origin, host, ip = '127.0.0.1', fetchSite = 'same-origin') => ({
  ip, headers: {}, get(name) { return { origin, host, 'sec-fetch-site': fetchSite }[name]; },
});
assert.equal(isTrustedOfflineCameraRequest(request('http://localhost:8100', 'localhost:3000')), false,
  'a rewritten proxy host reproduces the rejected offline session');
assert.equal(isTrustedOfflineCameraRequest(request('http://localhost:8100', 'localhost:8100')), true,
  'preserving the dev browser host must authorize its local camera session');
assert.equal(isTrustedOfflineCameraRequest(request('http://192.168.254.20:8100', '192.168.254.20:8100', '192.168.254.30')), true);
assert.equal(isTrustedOfflineCameraRequest(request('https://evil.example', 'localhost:8100')), false);
assert.equal(isTrustedOfflineCameraRequest(request('http://localhost:8100', 'localhost:8100', '8.8.8.8')), false);
assert.equal(isTrustedOfflineCameraRequest(request('http://localhost:8100', 'localhost:8100', '127.0.0.1', 'cross-site')), false);
assert.equal(normalizeOfflineScoreText('39/50'), '39/50');
assert.equal(normalizeOfflineScoreText(' 04/050 '), '4/50');
assert.equal(normalizeOfflineScoreText('51/50'), null);
assert.equal(normalizeOfflineScoreText('1/0'), null);
assert.equal(normalizeOfflineScoreText('<script>/50'), null);
const proxy = JSON.parse(fs.readFileSync(path.join(__dirname, '../proxy.conf.json'), 'utf8'));
assert.equal(proxy['/api'].changeOrigin, false, 'the development proxy must preserve the browser host');
console.log('Offline camera proxy/trust regressions passed.');
