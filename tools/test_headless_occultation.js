/* End-to-end contract test for the browser-independent P0-11 runner. */
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const output = path.join('/private/tmp', 'satidentifier-headless-regression.json');
const csv = output.replace(/\.json$/i, '') + '.csv';
const command = [
  path.join(__dirname, 'run_occultation_headless.js'),
  '--catalogue', path.join(__dirname, 'fixtures', 'p0_10_catalog.tle'),
  '--stars', path.join(ROOT, 'app', 'assets', 'stars_m9.bin'),
  '--date', '2026-07-20', '--timezone', 'Australia/Melbourne',
  '--lat', '-37.8136', '--lon', '144.9631', '--alt', '31',
  '--output', output,
];

const stdout = childProcess.execFileSync(process.execPath, command, {
  cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
});
const finished = stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line))
  .find((row) => row.type === 'finished');
assert(finished, 'headless runner must emit a finished record');
assert.strictEqual(finished.complete, true);
assert(finished.stats.discovery.deferred > 0);
assert.strictEqual(finished.stats.search.candidateLimit, null);
assert.strictEqual(finished.stats.search.candidateLimitReached, false);
assert.strictEqual(finished.stats.events.evaluatedEvents, finished.stats.search.candidates);
assert(fs.existsSync(output), 'JSON output must be written');
assert(fs.existsSync(csv), 'CSV output must be written');
const report = JSON.parse(fs.readFileSync(output, 'utf8'));
assert.strictEqual(report.config.mode, 'headless-complete');
assert.strictEqual(report.config.pass.deferExactPasses, true);
assert.strictEqual(report.config.stars.maxTotalCandidates, null);
console.log('headless complete search contract passed');
