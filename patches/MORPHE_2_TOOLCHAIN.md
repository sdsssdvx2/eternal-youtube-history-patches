# Morphe 2 toolchain contract

Eternal Android patch bundles intended for Morphe Patches v2.0.0 are built with the matching Morphe 2 toolchain family:

- Morphe Patcher: `2.0.0`
- Morphe patches library: `2.1.0-dev.2`
- `app.morphe.patches` Gradle plugin: `2.1.0-dev.1`

Changes to these build dependencies must pass the repository's full Android validation workflow, including compilation and the real server-side YouTube and YouTube Music patch smokes. This file intentionally lives under `patches/` so dependency-only toolchain changes are not able to bypass the existing `pull_request.paths` validation trigger.
