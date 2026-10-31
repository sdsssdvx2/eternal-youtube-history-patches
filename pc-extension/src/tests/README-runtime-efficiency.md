# PC runtime efficiency regression scope

`pc-runtime-efficiency-selftest.mjs` protects the long-session fixes introduced in PC v0.10.14:

- playback event handlers use cached settings instead of storage IPC on every `timeupdate`;
- reused YouTube `<video>` elements have old listeners detached before rebinding;
- presentation-only setting changes keep the watched/progress ledger cache;
- DOM mutation bursts schedule one debounced scan instead of separately rebinding video watchers;
- native progress/layout probing is skipped when it cannot affect threshold matching;
- the SPA lifecycle watchdog backs off after startup/navigation and sleeps while the tab is hidden.

These checks are intentionally static and run as part of the existing page-profile regression test, so both PR validation and deterministic PC release packaging exercise the same contract.
