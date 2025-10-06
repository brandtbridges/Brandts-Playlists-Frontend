# Brandt's Playlists — Frontend

## What it is

A small, personal, browser-based player for Plex playlists. It lists your playlists, renders tracks, and plays audio via a same‑origin backend proxy to avoid CORS/mixed‑content. It includes simple transport controls (Play/Pause/Next/Prev), optional Shuffle, an album‑cover stage that can switch to a lightweight canvas visualizer, and resilient playback that refreshes short‑lived stream tickets automatically. The project is intentionally small and non‑commercial.

---

## How it works ([https://www.brandtbridges.com/music](https://www.brandtbridges.com/music?playlist=62899))

### High‑level flow
1. **Bootstrap**
   - On page load the UI shows a blocking overlay (“Loading playlists…”), preloads a placeholder cover image, and fetches the playlist list from the backend proxy (`/plexproxy/api/playlists`).

2. **Playlist selection**
   - The playlist `<select>` is populated. Selecting a playlist (or the initial default) fetches its detail from `/plexproxy/api/playlist/:id`.
   - The response is normalized into an internal `tracks[]` array (title, artist, album, cover URL, and a Plex **ratingKey**/id). Cover URLs are rewritten to same‑origin paths (e.g., `/plexproxy/photo/:/transcode?...`) for safe loading.

3. **Rendering**
   - The track list is rendered as rows (title plus optional artist/album line).
   - The page title and a “Now Playing” line reflect the active track.
   - The timeline area includes elapsed/remaining time, a progress bar, buffer bar, and a draggable scrub handle (with ARIA + keyboard support).

4. **Playback (on Play or row click)**
   - The player **mints a short‑lived ticket** for the chosen track via `GET /plexproxy/api/stream/for/:ratingKey`.
   - The `<audio>` element’s `src` is set to `/plexproxy/api/stream/:ticket?rk=:ratingKey` and playback starts.
   - Media Session metadata (title/artist/album/art) updates for OS‑level controls/lock screen (when supported).

5. **Visualizer**
   - Clicking the cover or canvas cycles modes: `cover` → `bars` → `wave` → `radial` → `cover`.
   - The visualizer uses the Web Audio API (`AudioContext` + `AnalyserNode`) and draws on a `<canvas>` sized to the content column; colors are chosen to be legible on a dark background.

6. **Shuffle and order**
   - Order is either sequential or Fisher‑Yates shuffled. Toggling Shuffle **preserves the current track** and reshuffles the remainder.
   - `Next`/`Prev` move within the current order.

7. **Ticket lifecycle & resilience**
   - **Prewarm:** ~7s before a track ends, the player pre‑mints a ticket for the next track to reduce start latency.
   - **Auto‑refresh:** On `error`, `stalled`, or visible buffering pauses, the player requests a **fresh ticket**, seeks back to the prior position, and resumes.
   - **Burst‑failure breaker:** If multiple failures occur in a short window, the player pauses the “doom‑loop,” performs a deliberate refresh, and resumes once healthy.
   - **Per‑track cool‑off:** Tracks that fail repeatedly are temporarily marked “bad” and skipped for a cool‑down period.
   - **Watchdog:** If the media element reports “playing” but time doesn’t advance for several seconds, the player refreshes the ticket and resumes.

8. **Scrubbing & accessibility**
   - Pointer drag on the timeline updates the UI live; the actual seek is applied on pointer up (to avoid excessive network seeks while dragging).
   - Keyboard shortcuts: Space or “K” toggles play/pause; Arrow keys/PageUp/PageDown/Home/End adjust position. ARIA attributes expose min/max/now to assistive tech.

9. **Overlays and status**
   - A lightweight overlay is shown for blocking operations (“Loading playlists…”, “Loading playlist…”, “Loading track…”, “Buffering…”) and removed on `canplay/canplaythrough`.
   - A small status line surfaces non‑blocking messages or errors.

10. **Query param sync**
    - The active playlist id is mirrored in `?playlist=<id>` without reloading the page. Loading the app with a matching query param auto‑selects that playlist.

### Backend contract the FE relies on
- `GET /plexproxy/api/playlists` → `{ playlists: [ { id, title } ] }`
- `GET /plexproxy/api/playlist/:id` → `{ title, count, tracks: [ { ratingKey, title, artist, album, thumb|artUrl } ] }`
- `GET /plexproxy/api/stream/for/:ratingKey` → `{ ticket: "<opaque>" }`
- `GET /plexproxy/api/stream/:ticket?rk=:ratingKey` → audio stream (same origin)

> The FE does not require stream URLs in playlist detail; it mints tickets on demand per selected track.
