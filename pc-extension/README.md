# Eternal YouTube History — PC extension

`src/` is the canonical source for the unpacked Chrome extension.

## v0.8 watched-display and Watch Later controls

On normal YouTube pages, Eternal injects a compact control into the top masthead:

- **표시** — leave watched cards unchanged.
- **흐림** — dim watched thumbnails/cards using the Eternal D1-backed watch ledger.
- **숨김** — hide watched cards that match the configured progress rule.
- On the **Watch Later** page, **자동** toggles Watch Later auto-cleanup and **60%+ 정리** (or the configured threshold) runs an immediate manual cleanup.

The Watch Later cleanup threshold is configurable in extension options. The safe defaults are:

- auto cleanup **OFF**;
- threshold **60%**;
- videos whose Eternal progress is unknown are **never** eligible for cleanup;
- every removal uses YouTube's exact Watch Later `setVideoId` with `ACTION_REMOVE_VIDEO`;
- manual cleanup shows the candidate count and asks for confirmation before deleting;
- after deletion, Eternal re-reads Watch Later and reports entries that remain instead of assuming a nominal API success means the item disappeared.

Auto cleanup does not create a periodic background alarm. It runs only while YouTube is actually active: a currently playing Watch Later video can be removed once it crosses the configured threshold, and opening the Watch Later page can reconcile older eligible items against the D1-backed local cache.

The options page also includes **현재 YouTube 탭 진단**, which reports the masthead mount, Watch Later bridge state, current cleanup configuration, and recent cleanup summary without exposing the Eternal API token.

## Install / update an existing unpacked extension

1. Download the matching `eternal-youtube-history-pc-vX.Y.Z.zip` asset from the `pc-vX.Y.Z` GitHub release.
2. Open the ZIP and copy the contents of its `extension/` directory over the directory Chrome is already loading for Eternal YouTube History.
3. Open `chrome://extensions` and press **Reload** on Eternal YouTube History.

Do **not** remove the extension just to update it. Keeping the same unpacked-extension directory preserves the normal Chrome extension identity/storage path and avoids unnecessary setup work.

## Release model

- The version is read from `src/manifest.json`.
- GitHub Actions runs the Watch Later core/integration self-tests, validates the manifest and JavaScript syntax, and then builds the ZIP from `src/`.
- The release workflow explicitly verifies that `watch-later-core.js` is present in the packaged extension.
- PC release tags use `pc-vX.Y.Z` so they cannot be confused with Eternal Android patch tags (`vX.Y.Z`).
- PC releases are deliberately published with `make_latest=false`; `/releases/latest` remains reserved for the Android Eternal patch release used by the automated Morphe builder.

No Worker URL, API token, signing key, or private watch-history data belongs in this source tree.
