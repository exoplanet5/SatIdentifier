/* Verification for post-search event filtering and quantitative sorting. */
const assert = require('assert');
const path = require('path');

global.SAT = {
  util: { fmtDate: (date) => date.toISOString(), el: () => ({}) },
  occultation: {}, state: { occultation: { events: [], stats: {}, status: 'idle' } },
  bus: { on: () => {}, emit: () => {} },
};
require(path.join(__dirname, '..', 'app', 'js', 'occultation', 'events-ui.js'));
const UI = SAT.occultation.eventsUI;
const state = {
  updatedAtMs: 1,
  options: { satelliteTags: ['leo', 'payload', 'geo', 'debris'] },
  events: [
    { eventId: 'b', cls: 'geo', orbitClass: 'geo', type: 'DEB', nominalSeparationArcsec: 4.2 },
    { eventId: 'a', cls: 'leo', orbitClass: 'leo', type: 'PAY', nominalSeparationArcsec: 1.1 },
    { eventId: 'c', cls: 'leo', orbitClass: 'leo', type: 'R/B', nominalSeparationArcsec: 0.2 },
  ],
};
assert.deepStrictEqual(UI.filterEvents(state).map((event) => event.eventId), ['b', 'a']);
UI.setSort('nominalSeparationArcsec');
assert.deepStrictEqual(UI.sortEvents(UI.filterEvents(state)).map((event) => event.eventId), ['a', 'b']);
console.log('event post-search filters and quantitative sorting passed');
