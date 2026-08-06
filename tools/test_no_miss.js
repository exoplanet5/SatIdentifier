/* P0-10 verification: optimized occultation candidates must contain dense truth. */
'use strict';

const assert = require('assert');
const { runBenchmark } = require('./no_miss_benchmark.js');

(async () => {
  const report = await runBenchmark();
  assert.strictEqual(report.optimized.truncated, false, 'optimized run must be complete');
  assert.ok(report.optimized.passes > 0, 'benchmark must discover passes');
  assert.ok(report.optimized.candidateRecords > 0, 'benchmark must return star candidates');
  assert.ok(report.bruteForce.uniqueCandidatePairs > 0, 'brute-force truth must be non-empty');
  assert.strictEqual(report.comparison.optimizedSuperset, true,
    'optimized candidate set must contain every brute-force pair');
  assert.ok(report.optimized.propagations > 0 && report.bruteForce.propagations > 0,
    'both paths must report propagation counts');
  assert.ok(report.optimized.wallMs >= 0 && report.bruteForce.wallMs >= 0,
    'both paths must report elapsed time');
  assert.ok(report.memory.peak.rssBytes >= report.memory.before.rssBytes,
    'memory record must retain a non-decreasing RSS peak');

  const c = report.comparison;
  console.log(`  PASS  optimized ⊇ bruteForce (${report.bruteForce.uniqueCandidatePairs} truth, ` +
    `${report.optimized.uniqueCandidatePairs} optimized, ${c.extra.length} conservative extras)`);
  console.log(`  PASS  optimized ${report.optimized.propagations} propagations / ` +
    `${report.optimized.wallMs.toFixed(1)} ms; bruteForce ${report.bruteForce.propagations} / ` +
    `${report.bruteForce.wallMs.toFixed(1)} ms`);
  console.log(`  PASS  candidates ${report.optimized.candidateRecords}; distance checks ` +
    `${report.bruteForce.distanceChecks}; peak RSS delta ${report.memory.peakRssDeltaBytes} bytes`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
})().catch((error) => {
  console.error(error.stack || error);
  process.exit(1);
});
