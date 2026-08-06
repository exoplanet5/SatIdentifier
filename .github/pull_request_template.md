## Summary

<!-- State the task ID and the behavioral change. For occultation work, link the
     relevant OCCULTATION_CONTRACT.md section. -->

## Scope guard

- [ ] This change is limited to the task named above.
- [ ] P0-00 changes do not include `runRaw()`, occultation state, night windows,
      probability, ranking, or UI work.
- [ ] P0-01 changes are limited to `runRaw()` and its independent regression
      harness; they do not include occultation state, night windows, probability,
      ranking, or UI work.
- [ ] P0-05 OCCSTAR1 changes are limited to stateless star-candidate search;
      they do not include closest approach, probability, ranking, state, or UI.
- [ ] P0-10 changes include an independent dense-truth comparison and preserve
      `optimizedCandidates ⊇ bruteForceCandidates`; benchmark extras are allowed,
      missing pairs are not.
- [ ] The committed regression fixture is treated as test data, not as a live
      observing catalogue.
- [ ] Production files under `app/js/` are unchanged unless the task explicitly
      authorizes a production implementation.

## Verification

- [ ] `python3 tools/run_tests.py`
- [ ] The test was run without network access.
- [ ] Any fixture or assertion change is described in
      `docs/occultation/IMPLEMENTATION_LOG.md`.

## Evidence / notes

<!-- Include the relevant command output, failure explanation, or follow-up
     task. Do not describe a synthetic fixture result as an observing claim. -->
