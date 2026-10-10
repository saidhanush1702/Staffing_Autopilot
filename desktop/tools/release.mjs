/**
 * npm run release -- 0.1.1
 *
 * Bumps desktop/package.json, commits it, and creates the desktop-v<version>
 * tag the release workflow listens for - so the version inside the app and the
 * tag can never disagree. It does NOT push: you push the tag when ready.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage: npm run release -- <major.minor.patch>   e.g. 0.1.1');
    process.exit(1);
}
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });

if (execSync('git status --porcelain').toString().trim()) {
    console.error('Working tree is not clean. Commit or stash first.');
    process.exit(1);
}

const file = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(readFileSync(file, 'utf8'));
pkg.version = version;
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);

run('git add package.json');
run(`git commit -m "chore(desktop): release ${version}"`);
run(`git tag desktop-v${version}`);
console.log(`\nTagged desktop-v${version}. To publish:\n  git push origin HEAD desktop-v${version}`);
