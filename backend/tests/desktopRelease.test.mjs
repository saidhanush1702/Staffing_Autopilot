/** node tests/desktopRelease.test.mjs — pure, no database or network. */
import assert from 'node:assert/strict';
import { compareVersions, parseVersion } from '../utils/semver.js';
import { shapeRelease } from '../controllers/desktopReleaseController.js';

assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), 0);
assert.equal(compareVersions('junk', '0.1.0'), null);
assert.equal(parseVersion(undefined), null);

assert.deepEqual(shapeRelease({ tag_name: 'desktop-v0.1.0', assets: [] }), { status: 'unreleased' });
const r = shapeRelease({
    tag_name: 'desktop-v0.1.0',
    published_at: 'x',
    assets: [{ name: 'SmartApply-0.1.0-setup.exe', browser_download_url: 'u', size: 5 }],
});
assert.equal(r.status, 'ready');
assert.equal(r.version, '0.1.0');
assert.equal(r.windows.url, 'u');
assert.equal(r.mac, null);
console.log('desktopRelease: ok');
