# Eternal YouTube History — PC extension

`src/` is the canonical source for the unpacked Chrome extension.

## Watched-display and Watch Later controls

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

### One-time bootstrap to v0.9.0 or newer

1. Download the matching `eternal-youtube-history-pc-vX.Y.Z.zip` asset from the `pc-vX.Y.Z` GitHub release.
2. Copy the ZIP's `extension/` directory over the directory Chrome is already loading for Eternal YouTube History. **Do not remove/re-add the extension.**
3. Press **Reload** once in `chrome://extensions` for this bootstrap update.
4. Copy `windows-updater/` beside the installed `extension/` directory and run `Install-EternalPcAutoUpdater.ps1`. If the two directories are siblings, the installer finds `extension/` automatically; otherwise pass `-ExtensionDir` explicitly.

Keeping the same unpacked-extension directory preserves the Chrome extension identity and its existing `chrome.storage` / IndexedDB data.

### Automatic updates after bootstrap

The Windows helper is intentionally not resident software. It registers one per-user Scheduled Task that runs at logon and every six hours, then exits. Each check:

- queries stable `pc-vX.Y.Z` GitHub releases;
- requires the GitHub release asset's SHA-256 digest and verifies the downloaded ZIP;
- verifies that the ZIP tag and `extension/manifest.json` version agree;
- defers replacement while Chrome is running, preventing mixed old/new extension code in one browser session;
- backs up the current extension source;
- mirrors only the packaged `extension/` source into the **same existing directory**;
- rolls back the source backup if post-copy verification fails;
- keeps only the three newest source backups;
- updates its own helper scripts from the verified release bundle.

It never edits the Chrome profile, Eternal API token, `chrome.storage`, IndexedDB, cookies, or browser history. If Chrome is running when a newer release is found, the helper records the pending version and exits without touching the extension files. A later six-hour/logon check applies it while Chrome is closed; the next Chrome start then loads the new version automatically, with no remove/re-add or manual Reload step.

`Uninstall-EternalPcAutoUpdater.ps1` removes only the helper task/files. It does not touch the extension or its data.

## Release model

- The version is read from `src/manifest.json`.
- GitHub Actions runs the Watch Later core/integration self-tests, validates the manifest and JavaScript syntax, and then builds the ZIP from `src/`.
- A Windows CI job parses all updater scripts and performs an offline fixture update, including SHA-256 verification, mirror deletion of a stale file, post-copy version verification, and a bad-digest fail-closed test.
- Release ZIPs contain both `extension/` and `windows-updater/`.
- PC release tags use `pc-vX.Y.Z` so they cannot be confused with Eternal Android patch tags (`vX.Y.Z`).
- PC releases are deliberately published with `make_latest=false`; `/releases/latest` remains reserved for the Android Eternal patch release used by the automated Morphe builder.

No Worker URL, API token, signing key, or private watch-history data belongs in this source tree.
