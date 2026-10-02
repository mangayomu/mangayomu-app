# Reader remediation plan index

**Decision:** manual camera actions pause autoplay. A tap without a real camera action does not pause it.

Read plans in order. Do not start a later plan while an earlier plan has failing functional checks.

| Plan | Findings covered | Outcome |
| --- | --- | --- |
| [01 Playback, camera, and reveal](./reader-01-playback-camera-reveal-2026-07-21.md) | 1, 2, 3 | One reliable autoplay beat and a continuous long-pan reveal. |
| [02 Navigation, preferences, and analysis validity](./reader-02-navigation-analysis-validity-2026-07-21.md) | 4, 5, 6, 7, 8, 13, 15 | Stale work cannot navigate, mutate cache, or publish after disposal. |
| [03 Resource limits, performance, and verification](./reader-03-resources-performance-verification-2026-07-21.md) | 9, 10, 11, 12, 14, 16, 17, 18, 19, 20, 21 | Bounded work, measured event handling, and Reader-level functional coverage. |
| [04 Reader maintainability](./reader-04-maintainability-2026-07-21.md) | 22, 23, 24, 25, 26, 27, 28 | Safe cleanup after behaviour is covered. |

## Finding coverage notes

- **Finding 3:** Director already creates geometric coverage locations for pages without OCR balloons. Plan 01 still adds a Reader guard for an unexpected empty location list; it does not rewrite Director as though the reported scenario were proven.
- **Finding 28:** the statement that `Reader.bub.js` broadly mixes `var`, `let`, and `const` is inaccurate. The plan retains only the justified teardown/style checks.

## Shared completion gate

For each plan:

1. Update or add its functional fullfill first when the expected behaviour is unclear.
2. Implement the smallest change that satisfies its invariant.
3. Run that plan’s fullfills and the existing affected controller fullfills.
4. Perform one browser check against the running Reader after Plans 01–03.
5. Do not combine a refactor with a behaviour change.

## Commands

Run from `mangayomu-app`:

```sh
node fullfill/panel-playback-scheduler.mjs
node fullfill/reader-playback-controller.mjs
node fullfill/panel-reveal-controller.mjs
node fullfill/panel-camera-executor.mjs
node fullfill/panel-page-analysis.mjs
node fullfill/panel-reader-controller.mjs
node fullfill/reader-image-preload.mjs
node fullfill/reader-playback-orchestration.mjs
```

`reader-playback-orchestration.mjs` is created by Plan 03.
