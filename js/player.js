/* ============================================
 * Plex Playlist Player (modular, readable)
 * ============================================
 * Sections:
 * 1) Config / Constants
 * 2) Element Refs & State
 * 3) UI Helpers (status, now playing, control icons)
 * 4) URL Helpers
 * 5) Data Fetch
 * 6) Normalization (playlist → tracks[])
 * 7) Rendering (playlist list)
 * 8) Cover Handling (placeholder-first)
 * 9) Order / Shuffle
 * 10) Playback
 * 11) Wire-up (events)
 * 12) Boot (init)
 */

/* --------------------------------------------
 * 1) CONFIG / CONSTANTS
 * ------------------------------------------ */
const API_BASE          = '/plexproxy/api';            // same-origin proxy base
const PLAYLIST_ID       = 62899;                       // set your playlist id
const SHOW_INDEX        = true;                        // show numeric index in list
const PLACEHOLDER_COVER = '/assets/icons/cover-placeholder.png'; // 320x320 placeholder

const PLAYLISTS_ENDPOINT = `${API_BASE}/playlists`;  // e.g., /plexproxy/api/playlists
const $selPlaylist = document.getElementById('playlistSelect');

// Preload placeholder (snappy first paint)
(() => { const i = new Image(); i.src = PLACEHOLDER_COVER; })();

// --- Visualizer config/state ---
const ENABLE_VIZ = true;
const VIZ_MODES = ['cover', 'bars', 'wave', 'radial'];
let vizModeIndex = 0;
let audioCtx = null, sourceNode = null, analyser = null, vizRaf = 0;
const PAGE_BG = '#0F1115';
function fillBg(ctx){
  const c = ctx.canvas;
  ctx.fillStyle = PAGE_BG;
  ctx.fillRect(0, 0, c.width, c.height);
}

/* --------------------------------------------
 * 2) ELEMENT REFS & STATE
 * ------------------------------------------ */
const $status = document.getElementById('status');
const $list   = document.getElementById('list');
const $audio  = document.getElementById('audio');
const $now    = document.getElementById('now');

const $btnPrev    = document.getElementById('prevBtn');
const $btnNext    = document.getElementById('nextBtn');
const $btnPlay    = document.getElementById('playPauseBtn');
const $btnShuffle = document.getElementById('shuffleBtn');
const $cover      = document.getElementById('cover');
const $viz = document.getElementById('visualizer');
const $vizCanvas = document.getElementById('vizCanvas');
const $vizCaption = document.getElementById('vizCaption');

// --- Timeline refs ---
const $elapsed     = document.getElementById('timeElapsed');
const $remaining   = document.getElementById('timeRemaining');
const $scrubTrack  = document.getElementById('scrubTrack');
const $scrubPlayed = document.getElementById('scrubPlayed');
const $scrubBuffer = document.getElementById('scrubBuffer');
const $scrubHandle = document.getElementById('scrubHandle');

// --- Debug switch (flip to false to mute quickly)
const DEBUG = true;
const D = (...args) => DEBUG && console.debug('[PlexPlayer]', ...args);

// Decode audio ready/network states for readable logs
function rs() {
  const r = $audio.readyState, n = $audio.networkState;
  const rMap = {0:'HAVE_NOTHING',1:'HAVE_METADATA',2:'HAVE_CURRENT_DATA',3:'HAVE_FUTURE_DATA',4:'HAVE_ENOUGH_DATA'};
  const nMap = {0:'NETWORK_EMPTY',1:'NETWORK_IDLE',2:'NETWORK_LOADING',3:'NETWORK_NO_SOURCE'};
  return { readyState: rMap[r] ?? r, networkState: nMap[n] ?? n };
}

function fmtTime(sec) {
  if (!isFinite(sec)) return '0:00';
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const ss = String(s % 60).padStart(2, '0');
  return `${m}:${ss}`;
}

let tracks = [];   // normalized items
let order  = [];   // play order (array of track indexes)
let cursor = -1;   // current position within 'order'
let shuffleOn = false;
let lastBlobUrl = null; // for embedded-art paths (reserved for future)

// ---- Advance guards ----
let advancing = false;           // prevents re-entrant next()
let switchingTrack = false;      // true while we’re intentionally switching
let consecutiveAdvanceFailures = 0;
const MAX_CONSECUTIVE_FAILS = 4;
let errorRecovering = false;     // from earlier fix

async function safeAdvance(reason = 'auto') {
  if (advancing) { D('safeAdvance: SKIP re-entry', { reason, cursor }); return; }
  advancing = true; switchingTrack = true;
  D('safeAdvance: ENTER', { reason, cursor });

  try {
    await next(); // (or prev() if you call it with user-prev)
  } catch (err) {
    D('safeAdvance: ERROR', { reason, err });
  } finally {
    switchingTrack = false; advancing = false;
    D('safeAdvance: EXIT', { reason, cursor });
  }
}


function updateMediaSessionMetadata(t){
  if (!('mediaSession' in navigator) || !t) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title:  t.title  || '',
      artist: t.artist || '',
      album:  t.album  || '',
      artwork: (t.coverUrl || t.artUrl)
        ? [{ src: (t.coverUrl || t.artUrl), sizes: '320x320', type: 'image/jpeg' }]
        : []
    });
  } catch {}
}


/* --------------------------------------------
 * 3) UI HELPERS (status, now, control icon states)
 * ------------------------------------------ */
// --- Track normalizer (drop near helpers) ---

function normalizeTrack(it, i){
  const id =
    it?.id ?? it?.ratingKey ?? it?.key ?? it?.guid ??
    it?.raw?.id ?? it?.raw?.ratingKey ?? it?.raw?.key ?? it?.raw?.guid ?? null;

  const src =
    it?.streamUrl ?? it?.src ??
    it?.raw?.streamUrl ?? it?.raw?.url ?? it?.raw?.mediaUrl ?? it?.raw?.href ?? null;

  // keep any previously computed coverUrl, else derive from raw if present
  const coverUrl = it?.coverUrl ??
                   toProxiedPlexUrl(it?.raw?.artUrl ?? it?.raw?.thumb ?? it?.raw?.image ?? it?.raw?.art ?? null);

  const title  = it?.title ?? it?.raw?.title ?? it?.raw?.name ?? `Track ${i+1}`;
  const artist = it?.artist ?? it?.raw?.artist ?? it?.raw?.artistName ?? '';
  const album  = it?.album ?? it?.raw?.album ?? '';

  return { ...it, id, src, title, artist, album, coverUrl };
}


function updateBufferBar() {
  const d = $audio.duration;
  if (!isFinite(d) || d <= 0) {
    $scrubBuffer.style.width = '0%';
    return;
  }
  let end = 0;
  const br = $audio.buffered;
  for (let i = 0; i < br.length; i++) end = Math.max(end, br.end(i));
  const pct = Math.max(0, Math.min(1, end / d));
  $scrubBuffer.style.width = `${pct * 100}%`;
}

function updateTimeline(forceNow) {
  const d  = $audio.duration || 0;
  const ct = (forceNow ?? $audio.currentTime) || 0;
  const p  = d ? ct / d : 0;

  $scrubPlayed.style.width = `${p * 100}%`;
  $scrubHandle.style.left  = `${p * 100}%`;
  $elapsed.textContent     = fmtTime(ct);
  $remaining.textContent   = `-${fmtTime(Math.max(0, d - ct))}`;

  // ARIA
  $scrubHandle.setAttribute('aria-valuemin', '0');
  $scrubHandle.setAttribute('aria-valuemax', String(Math.floor(d || 0)));
  $scrubHandle.setAttribute('aria-valuenow', String(Math.floor(ct || 0)));
}

let dragging = false;
let wasPlayingBeforeDrag = false;

function pctFromClientX(clientX) {
  const rect = $scrubTrack.getBoundingClientRect();
  if (!rect.width) return 0;
  let p = (clientX - rect.left) / rect.width;
  return Math.min(1, Math.max(0, p));
}
function applyScrubFromClientX(clientX) {
  const d = $audio.duration || 0;
  const p = pctFromClientX(clientX);
  const t = p * d;
  // Live UI during drag
  updateTimeline(t);
  return { p, t };
}

$scrubTrack?.addEventListener('pointerdown', (e) => {
  if (!isFinite($audio.duration) || $audio.duration <= 0) return;
  dragging = true;
  wasPlayingBeforeDrag = !$audio.paused;
  try { $audio.pause(); } catch {}
  $scrubTrack.setPointerCapture?.(e.pointerId);
  const { t } = applyScrubFromClientX(e.clientX);
  // Don't set currentTime until pointerup to avoid heavy network seeks while dragging
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  applyScrubFromClientX(e.clientX);
});

window.addEventListener('pointerup', async (e) => {
  if (!dragging) return;
  dragging = false;
  const { t } = applyScrubFromClientX(e.clientX);
  try {
    $audio.currentTime = t;
    // If we were playing, resume (your $audio 'play' listener will re-sync UI/visualizer)
    if (wasPlayingBeforeDrag) await $audio.play();
  } catch (err) {
    showStatus(`Seek failed: ${err?.message ?? err}`, 'error');
  }
});

function showStatus(msg, type='info'){
  $status.textContent = msg;
  $status.className = 'status show' + (type==='error' ? ' error' : '');
}
function clearStatus(){ $status.textContent=''; $status.className='status'; }

function setPlayStateUI(isPlaying){
  $btnPlay.classList.toggle('icon--play',  !isPlaying);
  $btnPlay.classList.toggle('icon--pause',  isPlaying);
  $btnPlay.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
  $btnPlay.setAttribute('aria-pressed', isPlaying ? 'true' : 'false');
}
function setShuffleStateUI(isOn){
  $btnShuffle.classList.toggle('icon--shuffle-off', !isOn);
  $btnShuffle.classList.toggle('icon--shuffle-on',  isOn);
  $btnShuffle.setAttribute('aria-pressed', isOn ? 'true' : 'false');
}

function setNowPlaying(trackIndex){
  const t = tracks[trackIndex];
  if (!t){ $now.style.display='none'; $now.textContent=''; return; }
  const tArtist = (t && typeof t.artist === 'string') ? t.artist : '';
  $now.style.display='block';
  $now.textContent = `Now Playing: ${t.title}${tArtist ? ' — ' + tArtist : ''}`;
  document.title = "Brandt's Playlists [" + `${t.title}${tArtist ? ' — ' + tArtist : ''}` + "]";
}

function setActiveRowByTrackIndex(trackIndex){
  [...$list.querySelectorAll('.row')].forEach(r => r.classList.remove('active'));
  const r = $list.querySelector(`.row[data-index="${trackIndex}"]`);
  if (r) r.classList.add('active');
}

// Overlay refs
const $blocker = document.getElementById('blocker');
const $blockerLabel = document.getElementById('blockerLabel');

function showOverlay(msg = 'Loading…'){
  if ($blockerLabel) $blockerLabel.textContent = msg;
  if ($blocker){
    $blocker.classList.remove('hidden');
    $blocker.setAttribute('aria-busy', 'true');
  }
}

function hideOverlay(){
  if ($blocker){
    $blocker.classList.add('hidden');
    $blocker.setAttribute('aria-busy', 'false');
  }
}

// Wait until the cover image "settles" (load/error) or timeout
function whenImageSettles(img, timeoutMs = 1200){
  return new Promise(resolve => {
    let settled = false;
    const done = () => { if (settled) return; settled = true; cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(to); if (img){ img.onload = null; img.onerror = null; } };
    const to = setTimeout(done, timeoutMs);
    if (!img){ done(); return; }
    img.onload = done; img.onerror = done;
  });
}


async function ensureAudioGraph(){
  if (!ENABLE_VIZ) return;
  if (!audioCtx){
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  if (audioCtx.state === 'suspended'){
    try { await audioCtx.resume(); } catch {}
  }
  if (!sourceNode){
    // Can only create one MediaElementSource per <audio> element
    sourceNode = audioCtx.createMediaElementSource($audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.85;
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
}


function resizeVizCanvas() {
  if (!$vizCanvas) return;

  // Use the page's content container width (centered column), fallback to body
  const content = document.querySelector('.wrap') || document.body;
  const rect = content.getBoundingClientRect();

  // Set CSS size first so layout/centering are correct
  const cssW = Math.max(1, Math.floor(rect.width));
  const cssH = Math.max(1, $cover?.clientHeight || 320); // keep the 320px stage height

  $vizCanvas.style.width = `${cssW}px`;
  $vizCanvas.style.height = `${cssH}px`;

  // Backing store size (HiDPI)
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  $vizCanvas.width  = Math.floor(cssW * dpr);
  $vizCanvas.height = Math.floor(cssH * dpr);
}

// drawing routines
function drawBars(ctx, data) {
  const { width, height } = ctx.canvas;
  fillBg(ctx);
  const n = data.length / 2;                // drop highest freqs
  const barGap = 2 * (window.devicePixelRatio || 1);
  const barW = Math.max(8, (width / n) - barGap);
  for (let i = 0; i < n; i++){
    const v = data[i] / 255;               // 0..1
    const h = Math.max(2, v * height);
    const x = i * (barW + barGap);
    const y = height - h;
    ctx.fillStyle = i % 5 === 0 ? '#4490CA' : '#263E69';
    ctx.fillRect(x, y, barW, h);
  }
}

function drawWave(ctx, data) {
  const { width, height } = ctx.canvas;
  fillBg(ctx);
  ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
  ctx.strokeStyle = '#4490CA';
  ctx.beginPath();
  const step = Math.max(1, Math.floor(data.length / width));
  for (let x = 0, i = 0; x < width; x++, i += step){
    const v = (data[i] - 128) / 128;       // -1..1
    const y = height/2 + v * (height/2) * 0.9;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function drawRadial(ctx, data) {
  const { width, height } = ctx.canvas;
  fillBg(ctx);
  const cx = width/2, cy = height/2;
  const radius = Math.min(cx, cy) * 1.25;
  const bars = 64;  //96
  data.length = 420;
  ctx.save();
  ctx.translate(cx, cy);
  for (let i=0;i<bars;i++){
    const idx = Math.floor(i * (data.length / bars));
    const v = data[idx] / 255;             // 0..1
    const len = radius * 0.35 + v * radius * 0.65;
    const angle = (i / bars) * Math.PI * 2;
    ctx.rotate(angle);
    ctx.fillStyle = i % 3 === 0 ? '#4490CA' : '#263E69';
    ctx.fillRect(0, -2, len, 4);
    ctx.rotate(-angle);
  }
  ctx.restore();
}

// render loop + mode switching
function setVizCaption(mode){
  if ($vizCaption) $vizCaption.textContent = 
    mode === 'bars' ? 'Bars' :
    mode === 'wave' ? 'Wave' :
    mode === 'radial' ? 'Radial' : '';
}

function stopVizLoop(){
  if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = 0; }
}

async function startVizLoop(){
  if (!ENABLE_VIZ) return;
  await ensureAudioGraph();

  // Ensure layout is painted before sizing (canvas is absolute/full-bleed)
  await new Promise(r => requestAnimationFrame(r));
  resizeVizCanvas();

  const ctx = $vizCanvas?.getContext('2d'); // alpha:true (default)
  if (!ctx || !analyser) return;

  const mode = VIZ_MODES[vizModeIndex];
  const isBars = mode === 'bars' || mode === 'radial';
  const buf = isBars ? new Uint8Array(analyser.frequencyBinCount)
                     : new Uint8Array(analyser.fftSize);

  function frame(){
    const now = VIZ_MODES[vizModeIndex];
    if (now === 'bars' || now === 'radial'){
      analyser.getByteFrequencyData(buf);
      if (now === 'bars') drawBars(ctx, buf); else drawRadial(ctx, buf);
    } else if (now === 'wave'){
      analyser.getByteTimeDomainData(buf);
      drawWave(ctx, buf);
    } else {
      // back to cover
      stopVizLoop(); return;
    }
    vizRaf = requestAnimationFrame(frame);
  }
  vizRaf = requestAnimationFrame(frame);
}

function setVizMode(mode){
  const idx = VIZ_MODES.indexOf(mode);
  if (idx === -1) return;
  vizModeIndex = idx;

  const isCover = (mode === 'cover');

  // Toggle art image and overlay canvas ONLY; controls remain intact
  if ($cover) {
    $cover.style.visibility = isCover ? 'visible' : 'hidden';
  }
  if ($vizCanvas) {
    if (isCover) {
      $vizCanvas.hidden = true;
      stopVizLoop();
    } else {
      $vizCanvas.hidden = false;
      // Kick off after layout
      requestAnimationFrame(() => { void startVizLoop(); });
    }
  }
}

function cycleVizMode(){
  const next = (vizModeIndex + 1) % VIZ_MODES.length;
  setVizMode(VIZ_MODES[next]);
}

function showTrackOverlay(title = 'Loading track…') { showOverlay(title); }
function hideTrackOverlay() { hideOverlay(); }

/* --------------------------------------------
 * 4) URL HELPERS
 * ------------------------------------------ */
// Replace your current version with this throw-on-fail version
async function playTrackWithRetries(track, maxAttempts = 2) {
  let attempt = 0, lastErr = null;
  showTrackOverlay('Loading track…');

  while (attempt < maxAttempts) {
    attempt++;
    try {
      if (!track?.id) throw new Error('Missing ratingKey (track.id)');
      // Always JIT mint + include rk for server self-heal
      const freshUrl = await getFreshStreamUrlById(track.id);

      // Hard reset element to kill any stale pipeline before setting src
      try { $audio.pause(); } catch {}
      $audio.removeAttribute('src');
      $audio.load();

      $audio.src = freshUrl;
      await $audio.play();
      setPlayStateUI(true);
      hideTrackOverlay();
      return; // success
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, Math.min(1500 * attempt, 3000)));
    }
  }

  hideTrackOverlay();
  throw lastErr ?? new Error('Track failed after retries');
}

/* async function getFreshStreamUrlById(ratingKey) {
  D('ticket: fetch', { ratingKey });
  const res = await fetch(`${API_BASE}/stream/for/${encodeURIComponent(ratingKey)}`, { cache: 'no-store' });
  D('ticket: response', { status: res.status, ok: res.ok });
  if (!res.ok) throw new Error(`stream ticket ${res.status}`);
    const { ticket } = await res.json();
  D('ticket: ok', { ratingKey, ticketLen: ticket?.length });
  let result = `${API_BASE}/stream/${ticket}?rk=${encodeURIComponent(ratingKey)}`;
  return result;
} */

async function getFreshStreamUrlById(ratingKey) {
  const res = await fetch(`${API_BASE}/stream/for/${encodeURIComponent(ratingKey)}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`stream ticket ${res.status}`);
  const { ticket } = await res.json();
  return `${API_BASE}/stream/${ticket}?rk=${encodeURIComponent(ratingKey)}`;
}

// Ensure streams go through our proxy; if we know ratingKey, attach rk= for server self-heal.
function toProxiedStreamUrl(original, ratingKey) {
  if (!original || typeof original !== 'string') return original;

  // Already proxied? ensure rk is present when we have it
  if (original.startsWith(`${API_BASE}/stream/`)) {
    if (ratingKey) {
      const u = new URL(original, location.origin);
      if (!u.searchParams.has('rk')) u.searchParams.set('rk', ratingKey);
      return u.pathname + u.search + u.hash;
    }
    return original;
  }

  // Match legacy /api/stream/{ticket}
  const m = original.match(/\/api\/stream\/([^?&#]+)/i);
  if (m) return `${API_BASE}/stream/${m[1]}${ratingKey ? `?rk=${encodeURIComponent(ratingKey)}` : ''}`;

  // If it's a bare-looking ticket string, proxy it and append rk if known
  if (/^[A-Za-z0-9._-]{8,}$/.test(original))
    return `${API_BASE}/stream/${original}${ratingKey ? `?rk=${encodeURIComponent(ratingKey)}` : ''}`;

  return original;
}

// Only make URLs same-origin; do not reshape queries (preserve Plex-provided cover URLs).
function toProxiedPlexUrl(input){
  if (!input) return null;
  const s = String(input);
  if (s.startsWith('/plexproxy/')) return s;         // already proxied
  const abs = s.match(/^https?:\/\/[^/]+(\/.*)$/i);  // absolute PMS URL → strip host
  if (abs) return `/plexproxy${abs[1]}`;
  if (s.startsWith('/')) return `/plexproxy${s}`;    // raw PMS relative
  return s;  // blob:, data:, etc.
}

// Read a query param (e.g., ?playlist=12345)
function getQueryParam(name) {
  return new URL(window.location.href).searchParams.get(name);
}

// Update/insert a query param without reloading the page
function setQueryParam(name, value) {
  const u = new URL(window.location.href);
  if (value == null) u.searchParams.delete(name);
  else u.searchParams.set(name, value);
  history.replaceState(null, '', u.toString());
}

// Convert a raw playlist object into { id, title }
function normalizePlaylistSummary(item, i) {
  const idRaw = item?.id ?? item?.key ?? item?.ratingKey ?? item?.guid ?? (i != null ? `pl-${i}` : '');
  const titleRaw = item?.title ?? item?.name ?? `Playlist ${i + 1}`;
  const id = String(idRaw);
  const title = String(titleRaw);
  return id && title ? { id, title } : null;
}

// Extract an array of {id,title} from arbitrary JSON shapes
function extractPlaylists(root) {
  // Candidate arrays we might find
  const arrays = [];
  if (Array.isArray(root)) arrays.push(root);
  if (Array.isArray(root.playlists)) arrays.push(root.playlists);
  if (Array.isArray(root.items)) arrays.push(root.items);
  if (Array.isArray(root.results)) arrays.push(root.results);

  // Deep scan as a fallback (similar approach as your extractPlaylist)
  (function deep(o) {
    if (!o || typeof o !== 'object') return;
    for (const v of Object.values(o)) {
      if (Array.isArray(v) && v.length) arrays.push(v);
      else if (v && typeof v === 'object') deep(v);
    }
  })(root);

  // Score arrays by how many entries look like playlists (have title + some id-ish key)
  let best = null, bestScore = -Infinity;
  for (const arr of arrays) {
    if (!Array.isArray(arr) || !arr.length) continue;
    const sample = arr.slice(0, Math.min(10, arr.length));
    const score = sample.reduce((s, it) => {
      const hasTitle = !!(it?.title || it?.name);
      const hasId = !!(it?.id || it?.key || it?.ratingKey || it?.guid);
      return s + (hasTitle ? 1 : 0) + (hasId ? 1 : 0);
    }, 0);
    if (score > bestScore) { bestScore = score; best = arr; }
  }

  const raw = best ?? [];
  const normalized = raw.map((it, i) => normalizePlaylistSummary(it, i)).filter(Boolean);

  // Deduplicate by id
  const out = [];
  const seen = new Set();
  for (const p of normalized) {
    if (!seen.has(p.id)) { out.push(p); seen.add(p.id); }
  }
  return out;
}

/* --------------------------------------------
 * 5) DATA FETCH
 * ------------------------------------------ */
async function fetchJson(url){
  const res  = await fetch(url, { headers:{ 'Accept':'application/json' }, cache:'no-store' });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}. Body: ${text.slice(0,300)}`);
  try { return JSON.parse(text); }
  catch(e){ throw new Error(`JSON parse error: ${e.message}`); }
}

/* --------------------------------------------
 * 6) NORMALIZATION (playlist → tracks[])
 * ------------------------------------------ */
function scoreTrackLike(o){
  if (!o || typeof o!=='object') return -10;
  let s=0; if (o.title||o.name||o.track) s+=2;
  if (o.artist||o.artistName||o.album) s+=1;
  if (o.streamUrl||o.url||o.mediaUrl||o.href) s+=3;
  if (o.id||o.key||o.ratingKey||o.guid) s+=1.5;
  if (typeof o.duration==='number') s+=0.5;
  return s;
}

function normalizeItem(item, i){
  const title = (item.title ?? item.name ?? item.track ?? `Track ${i+1}`).toString().trim();
  let src = item.streamUrl ?? item.url ?? item.mediaUrl ?? item.href
         ?? item.id ?? item.key ?? item.ratingKey ?? item.guid ?? '';
  src = toProxiedStreamUrl(String(src));
  const artist = (item.artist ?? item.artistName ?? '').toString();
  const album  = (item.album ?? '').toString();

  // NEW: surface id now so later stages don't have to spelunk raw
  const id = item.id ?? item.ratingKey ?? item.key ?? item.guid ?? null;

  const rawCover = item.artUrl ?? item.thumb ?? item.image ?? item.art ?? null;
  const coverUrl = toProxiedPlexUrl(rawCover);

  return { id, title, src, artist, album, raw: item, coverUrl };
}

function extractPlaylist(root){
  const candidates = [];
  if (Array.isArray(root))               candidates.push(root);
  if (Array.isArray(root.items))         candidates.push(root.items);
  if (Array.isArray(root.tracks))        candidates.push(root.tracks);
  if (Array.isArray(root.entries))       candidates.push(root.entries);
  if (Array.isArray(root.results))       candidates.push(root.results);
  if (root.playlist && typeof root.playlist==='object'){
    const p = root.playlist;
    if (Array.isArray(p.items))   candidates.push(p.items);
    if (Array.isArray(p.tracks))  candidates.push(p.tracks);
    if (Array.isArray(p.entries)) candidates.push(p.entries);
    if (Array.isArray(p.results)) candidates.push(p.results);
  }
  (function deep(o){
    if (!o || typeof o!=='object') return;
    for (const v of Object.values(o)){
      if (Array.isArray(v) && v.length) candidates.push(v);
      else if (v && typeof v==='object') deep(v);
    }
  })(root);

  let best=null,bestScore=-Infinity;
  for (const arr of candidates){
    if (!Array.isArray(arr) || !arr.length) continue;
    const sample = arr.slice(0, Math.min(10, arr.length));
    const avg = sample.reduce((s,x)=>s+scoreTrackLike(x),0)/sample.length;
    if (avg>bestScore){ bestScore=avg; best=arr; }
  }
  const title = root.title ?? root.name ?? root.playlist?.title ?? root.playlist?.name ?? '';
  const out   = (best ?? []).map((it,i)=>normalizeItem(it,i));
  return { title, tracks: out, debug:{ candidateCount:candidates.length, bestScore, bestLen:(best??[]).length } };
}

/* --------------------------------------------
 * 7) RENDERING (playlist rows)
 * ------------------------------------------ */
function renderList(){
  $list.innerHTML='';
  tracks.forEach((t,i)=>{
    const row  = document.createElement('div'); row.className='row'; row.dataset.index=String(i);
    const left = document.createElement('div');
    const right= document.createElement('div');
    const title= document.createElement('div'); title.className='title';
    title.textContent = SHOW_INDEX ? `${String(i+1).padStart(2,'0')}. ${t.title}` : t.title;
    const meta = document.createElement('div'); meta.className='meta';
    meta.textContent = [ (typeof t.artist==='string'?t.artist:''), t.album ].filter(Boolean).join(' • ');
    left.appendChild(title); if (meta.textContent) left.appendChild(meta);
    //right.className='meta'; right.textContent='Click to play';
    row.appendChild(left); row.appendChild(right);
    row.addEventListener('click', ()=>playTrackIndex(i));
    $list.appendChild(row);
  });
}

/* --------------------------------------------
 * 8) COVER HANDLING (placeholder-first)
 * ------------------------------------------ */
function setCoverSrc($img, url) {
  if (!$img) return;

  const isPlaceholder = !url || url.trim() === '' || url === PLACEHOLDER_COVER;
  let s = isPlaceholder ? PLACEHOLDER_COVER : url;
  if (s.includes('&amp;')) s = s.replace(/&amp;/g, '&');

  // Apply placeholder class if needed
  if (isPlaceholder) {
    $img.classList.add('placeholder');
  } else {
    $img.classList.remove('placeholder');
  }

  $img.src = s;
}

// Prefer Plex-provided art; otherwise stay on placeholder (no layout shift)
function showCoverFor(track){
  if (!$cover) return;
  const url = track?.coverUrl ? String(track.coverUrl).replace(/&amp;/g, '&') : '';
  setCoverSrc($cover, url || PLACEHOLDER_COVER);
}

/* --------------------------------------------
 * 9) ORDER / SHUFFLE
 * ------------------------------------------ */
function makeSequentialOrder(n){ return Array.from({length:n},(_,i)=>i); }
function fisherYatesShuffle(arr){ const a=arr.slice(); for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function rebuildOrder(keepTrackIndex=null){
  if (!tracks.length){ order=[]; cursor=-1; return; }
  if (shuffleOn){
    const base = makeSequentialOrder(tracks.length).filter(i=>i!==keepTrackIndex);
    const shuf = fisherYatesShuffle(base);
    order = keepTrackIndex!=null ? [keepTrackIndex, ...shuf] : shuf; cursor=0;
  } else {
    order = makeSequentialOrder(tracks.length);
    cursor = keepTrackIndex!=null ? order.indexOf(keepTrackIndex) : -1;
  }
}

/* --------------------------------------------
 * 10) PLAYBACK
 * ------------------------------------------ */
async function playByOrderPosition(pos) {
  if (pos < 0 || pos >= order.length) return;

  cursor = pos;
  const trackIndex = order[cursor];
  const t = tracks[trackIndex];

  D('playByOrderPosition: select', {
    pos, trackIndex,
    id: t?.id, title: t?.title, artist: t?.artist,
    shuffleOn, orderLen: order.length, rs: rs()
  });

  clearStatus();
  setActiveRowByTrackIndex(trackIndex);
  setNowPlaying(trackIndex);
  showCoverFor(t);

  const hasId = !!t?.id;
  const legacySrc = toProxiedStreamUrl(t?.src, t?.id);
  if (!hasId && (!legacySrc || !legacySrc.startsWith(`${API_BASE}/stream/`))) {
    D('playByOrderPosition: INVALID src', { hasId, legacySrc });
    showStatus('Selected track missing a valid stream URL.', 'error');
    return;
  }

  try {
    D('playByOrderPosition: start retries', { id: t?.id });
    await playTrackWithRetries(t);
    consecutiveAdvanceFailures = 0;
    D('playByOrderPosition: started', { id: t?.id, rs: rs(), currentSrc: $audio.currentSrc });
  } catch (err) {
    consecutiveAdvanceFailures++;
    D('playByOrderPosition: FAILED', { id: t?.id, err, consecutiveAdvanceFailures, rs: rs() });
    hideTrackOverlay();
    showStatus(`Track failed: ${err?.message ?? err}`, 'error');

    if (consecutiveAdvanceFailures >= MAX_CONSECUTIVE_FAILS) {
      try { $audio.pause(); } catch {}
      showStatus(`Stopped after ${consecutiveAdvanceFailures} consecutive errors.`, 'error');
      return;
    }
    void safeAdvance('retry-skip');
  }
}

function playTrackIndex(trackIndex){
  const pos = order.indexOf(trackIndex);
  if (pos===-1) return;
  playByOrderPosition(pos);
}
function playPause(){
  if (!$audio.src){
    const start = cursor>=0 ? cursor : 0;
    playByOrderPosition(start);
    return;
  }
  if ($audio.paused){ $audio.play().catch(e=>showStatus(e.message,'error')); setPlayStateUI(true); }
  else { $audio.pause(); setPlayStateUI(false); }
}

async function next() {
  if (!order?.length) { D('next: no order'); return; }
  const nextPos = (cursor + 1) % order.length;
  D('next: switching', { from: cursor, to: nextPos, len: order.length });
  try { $audio.pause(); } catch {}
  $audio.removeAttribute('src'); setPlayStateUI(false);
  await playByOrderPosition(nextPos);
}

async function prev() {
  if (!order?.length) { D('prev: no order'); return; }
  const prevPos = (cursor - 1 + order.length) % order.length;
  D('prev: switching', { from: cursor, to: prevPos, len: order.length });
  try { $audio.pause(); } catch {}
  $audio.removeAttribute('src'); setPlayStateUI(false);
  await playByOrderPosition(prevPos);
}

function toggleShuffle(){
  const hadCursor = (cursor >= 0 && order[cursor] != null);
  const currentTrackIndex = hadCursor ? order[cursor] : null;
  const turningOn = !shuffleOn;

  shuffleOn = !shuffleOn;
  setShuffleStateUI(shuffleOn);
  rebuildOrder(currentTrackIndex);

  if (turningOn && currentTrackIndex != null) {
    // After shuffling, move to the NEXT item in the shuffled order
    const nextPos = order.length > 1 ? 1 : 0;
    playByOrderPosition(nextPos);
  } else {
    // Turning shuffle OFF: keep playing current track; do not restart.
    if (currentTrackIndex != null) setActiveRowByTrackIndex(currentTrackIndex);
  }}


/* --------------------------------------------
 * 11) WIRE-UP (events)
 * ------------------------------------------ */
$btnShuffle.addEventListener('click', toggleShuffle);
$btnPlay.addEventListener('click', playPause);
$btnNext?.addEventListener('click', () => {
  if (advancing) return;              // <-- add this guard
  void safeAdvance('user-next');
});
$btnPrev?.addEventListener('click', () => {
  if (advancing) return;              // <-- add this guard
  void safeAdvance('user-prev');
});

// --- Play/Pause keyboard toggle (Space / K) ---
const heldKeys = new Set();
const isTypingContext = () => {
  const el = document.activeElement;
  return el && (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
};
const isOverlayVisible = () => !!$blocker && !$blocker.classList.contains('hidden');

async function togglePlayPause() {
  if (isOverlayVisible()) return;          // don't fight track loading
  try {
    if ($audio.paused) {
      if (!$audio.src) {
        // no source yet? start current/first track
        const startPos = (cursor >= 0 ? cursor : 0);
        await playByOrderPosition(startPos);
      } else {
        await $audio.play();
      }
    } else {
      $audio.pause();
    }
  } catch (err) {
    showStatus(`Play/pause failed: ${err?.message ?? err}`, 'error');
  }
}

document.addEventListener('keydown', (e) => {
  // Prevent auto-repeat from toggling multiple times
  if (heldKeys.has(e.code)) return;
  heldKeys.add(e.code);

  if (isTypingContext()) return;

  // Space or 'k' toggles play/pause
  if (e.code === 'Space' || e.key?.toLowerCase() === 'k') {
    e.preventDefault(); // stop page scroll on Space
    void togglePlayPause();
  }
});

document.addEventListener('keyup', (e) => {
  heldKeys.delete(e.code);
});

$audio.addEventListener('play',  ()=>setPlayStateUI(true));
$audio.addEventListener('pause', ()=>setPlayStateUI(false));
$audio.addEventListener('ended', () => {
  stopVizLoop();
  if (!switchingTrack) void safeAdvance('ended');
});

$audio.addEventListener('error', async () => {
  // Do nothing if we’re intentionally switching or already advancing
  if (switchingTrack || advancing || errorRecovering) return;

  const t = tracks?.[order?.[cursor] ?? -1];
  if (!t) return;

  errorRecovering = true;
  const resumeAt = $audio.currentTime || 0;
  try {
    showTrackOverlay('Recovering stream…');
    const fresh = t.id ? await getFreshStreamUrlById(t.id) : toProxiedStreamUrl(t.src, t.id);
    if (!fresh) throw new Error('No stream URL');
    $audio.src = fresh;
    if (resumeAt > 0) { try { $audio.currentTime = resumeAt; } catch {} }
    await $audio.play();
  } catch (err) {
    showStatus(`Stream error: ${err?.message ?? err}`, 'error');
    try { $audio.pause(); } catch {}
    // IMPORTANT: no auto-next here; ended/safeAdvance or user will decide
  } finally {
    hideTrackOverlay();
    errorRecovering = false;
  }
});


// Playlist dropdown change → stop current, show overlay, load new list, auto-start first track
// Playlist dropdown change → stop current, show overlay, load new list, auto-start first track
$selPlaylist?.addEventListener('change', async (e) => {
  const id = e.target.value;

  // Keep URL in sync (no reload)
  setQueryParam('playlist', id);

  // Stop current playback and clear source/state
  try { $audio.pause(); } catch {}
  $audio.removeAttribute('src');
  setPlayStateUI(false);

  // Show blocking overlay and reset art while switching
  showOverlay('Loading playlist…');
  setCoverSrc($cover, PLACEHOLDER_COVER);

  // Clear old order/cursor to avoid stale indices during load
  cursor = -1;
  order = [];

  try {
    // Load and auto-start first track of the new list (respects shuffle state)
    await loadPlaylistById(id, { autoStart: true });

    // Allow one frame to paint, then wait for cover to settle (short timeout)
    await new Promise(r => requestAnimationFrame(r));
    await whenImageSettles($cover, 800);
  } catch (err) {
    console.error('[PlexPlayer] playlist switch failed:', err);
    showStatus(`Failed to load playlist: ${err?.message ?? err}`, 'error');
  } finally {
    // Always remove overlay
    hideOverlay();
  }
}); // <— closes addEventListener


function populatePlaylistSelect(playlists, selectedId) {
  if (!$selPlaylist) return;
  $selPlaylist.innerHTML = '';
  playlists.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    if (p.id === selectedId) opt.selected = true;
    $selPlaylist.appendChild(opt);
  });
}

async function loadPlaylistById(playlistId, opts = { autoStart: false }) {
  showStatus('Loading playlist…');
  try {
    const data = await fetchJson(`${API_BASE}/playlist/${encodeURIComponent(playlistId)}`);
    const { title, tracks: ts0, debug } = extractPlaylist(data);

    // Normalize every item to ensure we have ratingKey in t.id
    let ts = ts0.map(normalizeTrack);

    // Keep only items that have a ratingKey (id) — we JIT-mint stream URLs
    ts = ts.filter(t => !!t.id);

    // Keep the global; DO NOT re-filter by pre-minted src here
    tracks = ts;

    if (tracks.length === 0) {
      console.warn('[PlexPlayer] No tracks extracted.', debug, 'Sample:', data);
      showStatus('No tracks found in this playlist (see console).', 'error');
      return;
    }

    if (title) document.title = `${title} — Plex Playlist Player`;
    renderList();
    rebuildOrder(null);
    setPlayStateUI(!$audio.paused);
    setShuffleStateUI(shuffleOn);
    clearStatus();

    if (opts?.autoStart) {
      // play the first item in the current order (shuffled or sequential)
      playByOrderPosition(0);
    }
  } catch (err) {
    showStatus(`Error loading playlist: ${err.message}`, 'error');
  }
}

async function loadPlaylistsAndInit() {
  showStatus('Loading playlists…');
  try {
    const data = await fetchJson(PLAYLISTS_ENDPOINT);
    const playlists = extractPlaylists(data);
    if (!playlists.length) {
      showStatus('No playlists available from server.', 'error');
      return;
    }

    // Pick initial playlist: ?playlist=… → else first item
    const qsId = getQueryParam('playlist');
    const initialId = qsId && playlists.some(p => p.id === qsId) ? qsId : playlists[0].id;

    populatePlaylistSelect(playlists, initialId);
    setQueryParam('playlist', initialId);  // keep URL in sync
    clearStatus();

    // Ensure cover placeholder is visible before loading tracks
    setCoverSrc($cover, PLACEHOLDER_COVER);

    await loadPlaylistById(initialId);
  } catch (err) {
    showStatus(`Error loading playlists: ${err.message}`, 'error');
  }
}

// Tap to cycle modes (works from both art and visualizer)
$cover?.addEventListener('click', cycleVizMode);
$vizCanvas?.addEventListener('click', cycleVizMode);

window.addEventListener('resize', () => {
  if ($vizCanvas?.hidden) return;
  resizeVizCanvas();
});

// If you used the event-driven start from earlier:
// Already present: keep these enhanced
$audio.addEventListener('play', async () => {
  setPlayStateUI(true);
  // If a visualizer mode is active, begin drawing
  if (!$vizCanvas?.hidden && VIZ_MODES[vizModeIndex] !== 'cover') {
    try { await ensureAudioGraph(); } catch {}
    void startVizLoop();
  }
});


$audio.addEventListener('pause', () => { setPlayStateUI(false); stopVizLoop(); });

// Network stall / waiting: show a small overlay and try to resume
$audio.addEventListener('stalled', () => { showTrackOverlay('Buffering…'); });
$audio.addEventListener('waiting', () => { showTrackOverlay('Buffering…'); });
$audio.addEventListener('canplay', () => { hideTrackOverlay(); });
$audio.addEventListener('canplaythrough', () => { hideTrackOverlay(); });

// Hard error during streaming: refresh ticket and resume at same position
$audio.addEventListener('error', async () => {
  const t = tracks?.[order?.[cursor] ?? -1];
  if (!t) return;
  const resumeAt = $audio.currentTime || 0;
  try {
    const fresh = t.id ? await getFreshStreamUrlById(t.id) : toProxiedStreamUrl(t.src, t.id);
    if (!fresh) throw new Error('No stream URL');
    $audio.src = fresh;
    if (resumeAt > 0) {
      // seek back to where we left
      try { $audio.currentTime = resumeAt; } catch {}
    }
    await $audio.play();
    hideTrackOverlay();
  } catch {}
});

// When a track is near the end, pre-warm next ticket (very cheap)
$audio.addEventListener('timeupdate', () => {
  if (!$audio.duration || !$audio.currentTime) return;
  const remaining = $audio.duration - $audio.currentTime;
  if (remaining < 7) {
    const nextIdx = (cursor + 1) % order.length;
    const nt = tracks?.[order?.[nextIdx] ?? -1];
    if (nt?.id && !nt._prewarmed) {
      nt._prewarmed = true;
      // Fire-and-forget to mint a ticket server-side
      fetch(`${API_BASE}/stream/for/${encodeURIComponent(nt.id)}`, { cache: 'no-store' }).catch(()=>{});
    }
  }
});

$audio.addEventListener('durationchange', () => { updateTimeline(); updateBufferBar(); });
$audio.addEventListener('timeupdate',      () => { if (!dragging) updateTimeline(); });
$audio.addEventListener('progress',        () => { updateBufferBar(); });


audio.addEventListener('stalled',        () => D('audio:stalled',        rs()));
$audio.addEventListener('waiting',        () => D('audio:waiting',        rs()));
$audio.addEventListener('loadstart',      () => D('audio:loadstart',      rs()));
$audio.addEventListener('canplay',        () => D('audio:canplay',        rs()));
$audio.addEventListener('canplaythrough', () => D('audio:canplaythrough', rs()));
$audio.addEventListener('playing',        () => D('audio:playing',        rs()));


// When a new track is loaded/started (e.g., inside playByOrderPosition)
document.addEventListener('visibilitychange', () => {
  // cheap refresh when returning to tab
  if (!document.hidden) { updateTimeline(); updateBufferBar(); }
});

// Handle offline/online transitions gracefully
window.addEventListener('online', async () => {
  // If we were stalled, nudge playback
  const t = tracks?.[order?.[cursor] ?? -1];
  if (t && $audio.paused) {
    try { await playTrackWithRetries(t, 2); } catch {}
  }
});

window.addEventListener('unhandledrejection', e => {
  D('unhandledrejection', { reason: e.reason });
});

$scrubHandle?.addEventListener('keydown', (e) => {
  const d = $audio.duration || 0;
  if (!isFinite(d) || d <= 0) return;

  // Step sizes
  const stepSec  = 5;
  const pageSec  = Math.max(1, d * 0.10);

  let target = null;
  if (e.key === 'ArrowRight') target = ($audio.currentTime || 0) + stepSec;
  else if (e.key === 'ArrowLeft') target = ($audio.currentTime || 0) - stepSec;
  else if (e.key === 'PageUp') target = ($audio.currentTime || 0) + pageSec;
  else if (e.key === 'PageDown') target = ($audio.currentTime || 0) - pageSec;
  else if (e.key === 'Home') target = 0;
  else if (e.key === 'End') target = d - 0.01;

  if (target == null) return;

  e.preventDefault();
  target = Math.max(0, Math.min(d, target));
  try {
    $audio.currentTime = target;
    updateTimeline(target);
  } catch {}
});

// On init, start in cover mode explicitly
setVizMode('cover');

/* --------------------------------------------
 * 12) BOOT (init)
 * ------------------------------------------ */
// --- Boot (IIFE style) ---
;(function init(){
  // Block the UI immediately on first paint
  showOverlay('Loading playlists…');

  // Ensure the cover slot is visible (prevents layout shift)
  setCoverSrc($cover, PLACEHOLDER_COVER);

  (async () => {
    try {
      // 1) Fetch playlists, populate <select>, load initial playlist & render
      await loadPlaylistsAndInit();

      // 2) Allow one animation frame for DOM paint, then wait for cover settle (or timeout)
      await new Promise(r => requestAnimationFrame(r));
      await whenImageSettles($cover, 1200);
    } catch (err) {
      console.error('[PlexPlayer] init failed:', err);
      showStatus(`Initialization error: ${err?.message ?? err}`, 'error');
    } finally {
      // 3) Remove the blocking overlay regardless of success/failure
      hideOverlay();
    }
  })();
})();