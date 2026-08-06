/* Verification for app/js/occultation/night.js — P0-02 night windows.
 * Run: node tools/test_night.js
 *
 * The reference boundary instants below are frozen UTC checks for the same
 * geometric solar-centre convention used by this module: no atmospheric
 * refraction, no solar-disc radius, and DUT1 = 0. They are intentionally
 * independent of the host machine's local time zone and system clock.
 */
const path = require('path');
const APP = path.join(__dirname, '..', 'app', 'js');

global.SAT = {};
require(path.join(APP, 'occultation', 'night.js'));
const N = SAT.occultation.night;

let failures = 0;
function ok(name, condition, detail) {
  if (!condition) failures++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '   ' + detail : ''}`);
}
function near(name, got, want, toleranceMs) {
  const errorMs = Math.abs(got - want);
  ok(name, errorMs <= toleranceMs,
    `${new Date(got).toISOString()} vs ${new Date(want).toISOString()} ` +
    `(error ${(errorMs / 1000).toFixed(3)} s, tolerance ${toleranceMs / 1000} s)`);
}
function nearNumber(name, got, want, tolerance, unit) {
  const error = Math.abs(got - want);
  ok(name, error <= tolerance,
    `${Number(got).toFixed(8)} vs ${Number(want).toFixed(8)} ${unit || ''} ` +
    `(error ${error.toExponential(2)}, tolerance ${tolerance})`);
}
function throws(name, fn) {
  let thrown = false;
  try { fn(); } catch (e) { thrown = true; }
  ok(name, thrown);
}
function localParts(ms, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, calendar: 'gregory', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = {};
  f.formatToParts(new Date(ms)).forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

const SITE = { latDeg: -37.8136, lonDeg: 144.9631, altM: 30 };
const COMMON = { site: SITE, timeZone: 'Australia/Melbourne', sunAltitudeLimitDeg: -12 };

console.log('\n[1] API and pure-state boundary');
ok('night API is attached', !!N && typeof N.windowsForDate === 'function');
ok('night module does not create SAT.state', SAT.state === undefined);
const winter = N.windowsForDate(Object.assign({}, COMMON, { localDate: '2026-07-23' }));
ok('Melbourne winter returns one normal window', winter.length === 1 && winter[0].kind === 'normal');
ok('window is ordered', winter[0].startMs < winter[0].endMs);
ok('window carries the requested altitude limit', winter[0].sunAltitudeLimitDeg === -12);

console.log('\n[2] Melbourne winter and summer, including DST');
const winterWindow = winter[0];
near('winter twilight start', winterWindow.startMs, Date.parse('2026-07-23T08:25:59.924Z'), 1000);
near('winter twilight end', winterWindow.endMs, Date.parse('2026-07-23T20:27:02.554Z'), 1000);
ok('winter start formats in Melbourne standard time',
  localParts(winterWindow.startMs, COMMON.timeZone) === '2026-07-23 18:25:59');
ok('winter end is the following local civil date',
  localParts(winterWindow.endMs, COMMON.timeZone) === '2026-07-24 06:27:02');

const summer = N.windowsForDate(Object.assign({}, COMMON, { localDate: '2026-01-23' }));
ok('Melbourne summer returns one normal window', summer.length === 1 && summer[0].kind === 'normal');
near('summer twilight start', summer[0].startMs, Date.parse('2026-01-23T10:45:58.606Z'), 1000);
near('summer twilight end', summer[0].endMs, Date.parse('2026-01-23T18:18:21.363Z'), 1000);
ok('summer start observes DST',
  localParts(summer[0].startMs, COMMON.timeZone) === '2026-01-23 21:45:58');
ok('summer end observes DST on the next local date',
  localParts(summer[0].endMs, COMMON.timeZone) === '2026-01-24 05:18:21');
ok('summer night is shorter than winter night',
  summer[0].endMs - summer[0].startMs < winterWindow.endMs - winterWindow.startMs);

console.log('\n[3] Boundary residuals and date semantics');
for (const window of [winterWindow, summer[0]]) {
  nearNumber('start solves the requested solar altitude',
    N.sunAltitudeDeg(SITE, window.startMs), -12, 1e-5, 'deg');
  nearNumber('end solves the requested solar altitude',
    N.sunAltitudeDeg(SITE, window.endMs), -12, 1e-5, 'deg');
}
const utcDay = N.windowsForDate({
  site: { latDeg: 0, lonDeg: 0 }, localDate: '2026-02-28', timeZone: 'UTC',
  sunAltitudeLimitDeg: -12,
});
ok('Gregorian date increment handles February', utcDay.length === 1);

console.log('\n[4] High latitude no-night and polar-night cases');
const polarSite = { latDeg: 80, lonDeg: 0, altM: 0 };
const noNight = N.describeDate({
  site: polarSite, localDate: '2026-06-21', timeZone: 'UTC', sunAltitudeLimitDeg: -12,
});
ok('polar day is explicitly no-night', noNight.kind === 'no-night' && noNight.windows.length === 0);
const polarNight = N.describeDate({
  site: polarSite, localDate: '2026-12-21', timeZone: 'UTC', sunAltitudeLimitDeg: -12,
});
ok('polar night has its dedicated kind',
  polarNight.kind === 'polar-night' && polarNight.windows.length === 1 &&
  polarNight.windows[0].kind === 'polar-night');
near('polar-night starts at local midnight',
  polarNight.windows[0].startMs, Date.parse('2026-12-21T00:00:00Z'), 0);
near('polar-night ends at next local midnight',
  polarNight.windows[0].endMs, Date.parse('2026-12-22T00:00:00Z'), 0);

console.log('\n[5] Validation and aliases');
const aliasInput = Object.assign({}, COMMON, { localDate: '2026-07-23' });
ok('nightWindows is the array alias', N.nightWindows(aliasInput).length === 1);
ok('windowForDate returns the canonical window',
  N.windowForDate(aliasInput).kind === 'normal');
throws('invalid local date rejected', () => N.windowsForDate(Object.assign({}, COMMON, { localDate: '2026-02-30' })));
throws('invalid IANA time zone rejected', () => N.windowsForDate(Object.assign({}, COMMON, {
  localDate: '2026-07-23', timeZone: 'Not/A_Time_Zone',
})));
throws('invalid latitude rejected', () => N.windowsForDate({
  site: { latDeg: 91, lonDeg: 0 }, localDate: '2026-07-23', timeZone: 'UTC',
}));
throws('invalid twilight limit rejected', () => N.windowsForDate({
  site: { latDeg: 0, lonDeg: 0 }, localDate: '2026-07-23', timeZone: 'UTC',
  sunAltitudeLimitDeg: -91,
}));

console.log(failures ? `\n${failures} FAILURE(S)\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
