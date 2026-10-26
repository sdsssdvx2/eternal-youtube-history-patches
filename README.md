# Eternal YouTube History — Morphe add-on v0.2.0 source overlay

This source overlay is the Android client for the Eternal D1 central ledger.
It targets the current Morphe third-party add-on API instead of maintaining a full RVX/YouTube fork.

## Available patch

<!-- PATCHES_START EXPANDED -->
> **[v1.8.0](https://github.com/sdsssdvx2/eternal-youtube-history-patches/releases/tag/v1.8.0)**&nbsp;&nbsp;•&nbsp;&nbsp;`main`&nbsp;&nbsp;•&nbsp;&nbsp;1 patches total
<details open>
<summary>📦 YouTube&nbsp;&nbsp;•&nbsp;&nbsp;1 patch</summary>
<br>

**🎯 Supported versions:**

| 21.20.405 | 21.16.256 | 20.51.39 | 20.21.37 |
| :---: | :---: | :---: | :---: |

| 💊&nbsp;Patch | 📜&nbsp;Description | ⚙️&nbsp;Options |
|----------|----------------|-----------|
| [Eternal YouTube History](#eternal-youtube-history) | Writes Android YouTube watch/progress directly to your private Eternal D1 ledger and can style watched thumbnails or hide watched feed cards from the local cache. |  |

</details>

<!-- PATCHES_END -->

## Implemented

### Direct Android recording

- Morphe `AddOnApi` video-id/new-video/time callbacks are used.
- A watch is accepted after **actual forward playback time** reaches the configured threshold (default 5 seconds); seeking forward does not instantly satisfy the threshold.
- One precise Android watch event is created per playback session.
- Duplicate video-id callbacks from Morphe do not create duplicate sessions/events.
- Video title, channel, channel id, exact watch start and maximum progress are sent to the existing Eternal Worker/D1.
- Progress writes are bucketed (default every 5 percentage points) to avoid excessive D1 writes.
- Failed uploads stay in a durable Android SQLite outbox.

### Server-first cache

- D1 remains the source of truth.
- Android downloads the video ledger once, stores a minimal local SQLite cache, then consumes `/v1/changes` revision deltas.
- Feed decisions use an in-memory `videoId -> max progress` cache; **no request to Cloudflare is made per card**.
- The SQLite merge uses Android-compatible `INSERT OR IGNORE` + `UPDATE`, avoiding dependence on newer SQLite UPSERT syntax.

### Watched-card hiding

v0.2 adds the first mobile visual mode: **hide watched feed cards**.

- Home
- Search
- Subscriptions
- Related/under-video cards
- common Shorts card/shelf layouts

The patch injects a conservative pre-filter into Morphe's existing Litho filter entry point and reuses Morphe's public video-id extraction helper.
It excludes child components such as thumbnail/metadata/avatar/overflow so the decision is made on whole video cards.

Settings:

- `시청한 피드 카드 숨기기`
- `숨김 최소 진행률(%)`
  - `0`: any Eternal watch record hides the card.
  - `1-100`: only records whose real progress is known and at least the threshold are hidden.

The hide hook requires the selected official Morphe patch set to include the normal Litho filtering hook. If it is absent, direct D1 recording still works; only feed hiding has no effect.

## Not implemented yet

**Dimming** is intentionally not claimed yet. Hiding can return an empty Litho component through the existing stable filter path; dimming requires modifying the rendered View/component and needs a different hook. It will be added only after that hook is verified against current Morphe/YouTube builds.

## Intended publishing flow

1. Create a new repository from `MorpheApp/morphe-patches-template`.
2. Repository name: `eternal-youtube-history-patches`.
3. Keep it public; the repository contains no Eternal token or private history.
4. Copy `overlay/` over the template repository root.
5. The overlay already points to `sdsssdvx2/eternal-youtube-history-patches`.
6. Keep the template Gradle wrapper, package files, `.releaserc`, generator utility and other files not replaced by the overlay.
7. Enable GitHub Actions write permission for releases.
8. Commit with a semantic `feat:` message. The release workflow checks out the current official Morphe sources and publishes the patch bundle.
9. Add that repository/release as a remote patch source in Morphe Manager.

The current SinAble716/RVX app should remain installed until the Morphe build is independently installed and verified.

## Phone configuration after patching

In Morphe YouTube settings → Eternal YouTube History:

- enable Eternal direct sync;
- enter the same Worker URL used by the PC extension;
- enter the private Eternal connection token locally on the phone;
- leave D1 local cache enabled;
- optionally enable watched-card hiding and choose its progress threshold.

Never commit the Worker token to GitHub and never send it to another person.

## Update model

The Eternal patch source can be updated independently and Morphe Manager can refresh remote sources. A new YouTube base version still requires an intentional patch action, but with Shizuku/Sui/root the post-patch install step can be automated. This removes the current Obtainium workflow of repeatedly opening the app and retrying an already-built RVX APK update.
