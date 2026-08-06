# P0-09 progress — angular diameter and physical contact timing

**Date:** 2026-08-06
**Status:** implemented and verified

## Delivered

- `app/js/occultation/satellite-size.js`
  - resolves explicit, object, RCS, SATCAT-type, and default effective radii;
  - converts physical radius and topocentric range to angular radius/diameter;
  - discloses assumptions and rejects unknown size when requested.
- `app/js/occultation/contact.js`
  - compares exact J2000 satellite directions with a fixed catalogue star;
  - solves `alpha(t) - d(t) = 0` ingress/egress roots by bounded bisection;
  - retains brackets, duration, multiple intervals, clipping, work budgets,
    evaluator failures, and range failures.
- `app/js/occultation/event-assembly.js` and `event-state.js`
  - extend P0-08 events and independent state to `version: 'p0-09'`;
  - preserve P0-08 candidate semantics while adding contact result fields and
    contact statistics.
- `app/index.html` loads the new modules before event assembly.
- `docs/occultation/CONTACT_CONTRACT.md` and `tools/test_contact.js`.

## Acceptance evidence

```text
node --check app/js/occultation/satellite-size.js  PASS
node --check app/js/occultation/contact.js         PASS
node tools/test_contact.js                         PASS
node tools/test_event_state.js                     PASS
python3 tools/run_tests.py                         18/18 PASS
git diff --check                                   PASS
```

The deterministic 10 m / 1000 km synthetic track has an angular radius of
`2.062648 arcsec`; the solver recovers ingress and egress within `0.05 ms` of
the analytic roots and preserves final time brackets. P0-08's synthetic event
remains a complete candidate with an explicit angular-size miss.

## Scope guard

P0-09 does not estimate occultation probability, rank events, model spacecraft
attitude or shape, include stellar angular diameter or seeing, persist event
state, or add UI. A complete contact result is geometric under its disclosed
size prior and is not an observation claim.
