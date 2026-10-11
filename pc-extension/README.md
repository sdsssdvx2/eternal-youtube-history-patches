# Eternal YouTube History — PC extension

`src/` is the canonical source for the unpacked Chrome extension.

## Install / update an existing unpacked extension

1. Download the matching `eternal-youtube-history-pc-vX.Y.Z.zip` asset from the `pc-vX.Y.Z` GitHub release.
2. Open the ZIP and copy the contents of its `extension/` directory over the directory Chrome is already loading for Eternal YouTube History.
3. Open `chrome://extensions` and press **Reload** on Eternal YouTube History.

Do **not** remove the extension just to update it. Keeping the same unpacked-extension directory preserves the normal Chrome extension identity/storage path and avoids unnecessary setup work.

## Release model

- The version is read from `src/manifest.json`.
- GitHub Actions validates the manifest and every JavaScript file, then builds the ZIP from `src/`.
- PC release tags use `pc-vX.Y.Z` so they cannot be confused with Eternal Android patch tags (`vX.Y.Z`).
- PC releases are deliberately published with `make_latest=false`; `/releases/latest` remains reserved for the Android Eternal patch release used by the automated Morphe builder.

No Worker URL, API token, signing key, or private watch-history data belongs in this source tree.
