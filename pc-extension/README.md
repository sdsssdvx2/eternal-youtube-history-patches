# Eternal YouTube History — PC extension

This directory is the canonical release ledger for the unpacked Chrome extension used with Eternal YouTube History.

- `latest.json` is the single source of truth for the current PC release version, file and SHA-256.
- `releases/` stores the exact ZIP distributed to the user. The ZIP contains the extension source plus the matching Worker source/setup files.
- GitHub Actions verifies the ZIP checksum and `extension/manifest.json` version, then publishes a `pc-v<version>` GitHub Release.

## Updating an existing unpacked install

Do not remove the extension. Extract the ZIP, copy the contents of its `extension` directory over the existing extension directory, then press Reload on `chrome://extensions`. Chrome local storage/IndexedDB remains intact.

The PC and Android release numbers are intentionally independent: PC uses `0.x.x`; the Morphe/Eternal Android patch uses `1.x.x`.
