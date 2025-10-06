# Brandt's Plex Playlists (Thin UI + Minimal API Proxy)

A lightweight, human‑maintainable web player for Plex music playlists.  
Front‑end is plain HTML/CSS/JS; back‑end is ASP.NET Core minimal APIs that safely proxy Plex (token server‑side only). Deployed behind IIS with a `/plexproxy` rewrite for same‑origin calls.

## Features

- **Playlist selector** (header dropdown) — fetches Plex playlists and loads on change.
- **Playback** — sequential/shuffle, prev/next, play/pause, keyboard shortcuts.
- **Shuffle polish** — turning shuffle **ON** reshuffles and advances to the first shuffled “next”; turning **OFF** keeps playing current track.
- **Cover handling** — placeholder (320×320) at boot to avoid layout shift; distinct border color for placeholder; real art keeps default border.
- **PNG control icons** — stateful play/pause and shuffle on/off.
- **Blocking overlay loader** — full‑screen blur + semi‑transparent page‑colored overlay hides the UI until initial load completes.
- **Same‑origin proxy** — `/plexproxy/api/...` avoids CORS/mixed content; Plex token never reaches the browser.

> Optional enhancement (see below): **Audio visualizers** (tap cover to rotate views).

## Architecture

**Front‑end**
- `index.html` — structure (header, media panel, now playing, playlist).
- `css/player.css` — theme tokens, layout, controls, overlay loader styles.
- `js/player.js` — player logic: fetch → normalize → render → playback; UI state; loader; playlist dropdown; shuffle behavior; cover handling.

**Back‑end (Minimal API)**
- `GET /api/playlists` — lists Plex playlists (JSON), cached (TTL ~30s).
- `GET /api/playlist/{id}` — returns tracks with proxied stream URLs.
- `GET /api/stream/{ticket}` — byte‑for‑byte proxy w/ Range support.
- `GET /api/art?path=...` — proxies Plex art (no token leak).

> All server calls run through the IIS site path prefix (e.g., `/plexproxy/api/...`) and use a named `HttpClient("plex")` with token in header.

## Requirements

- Plex Media Server reachable from the proxy (e.g., LAN/Tailscale).
- .NET 8+ for the minimal API project.
- IIS (or Kestrel reverse‑proxied) serving the static site + API under the same host.
- Valid Plex token configured **server‑side** only.

## Configuration

`appsettings.json` (or env/secrets):

{
  "Plex": {
    "BaseUrl": "https://your-pms-or-tailscale-host",
    "Token": "YOUR_PLEX_TOKEN"
  }
}