/// <reference path="./kino.d.ts" />
// Spotify para Kino · apiVersion 8
//
// - Autenticación: cookie sp_dc de open.spotify.com → token de acceso vía
//   https://open.spotify.com/get_access_token
// - Catálogo y reproducción: Spotify Web API (api.spotify.com/v1/)
// - El token se renueva automáticamente y se guarda en kino.storage (TTL real).

const API = "https://api.spotify.com/v1/";
const TOKEN_URL = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player";
const ANON_TOKEN_URL = "https://open.spotify.com/get_access_token?reason=transport&productType=web_player";
const ORIGIN = "https://open.spotify.com";
const WEB_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0";
const VERSION = "0.1.8-debug";

// Flag en memoria: evita que requests paralelos intenten fetchToken() cuando ya sabemos que falla
let _tokenFailed = false;
let _tokenFailedAt = 0;
const TOKEN_FAIL_TTL = 30000; // 30s de cooldown antes de reintentar

// ---------------------------------------------------------------------------------------------
// Token de acceso (derivado de la cookie sp_dc, caduca ~1 hora)
// ---------------------------------------------------------------------------------------------

function savedSpDc() {
  const raw = String(kino.config.get("sp_dc") || "").trim();
  if (!raw) return "";
  // Log raw para debug (primeros 60 chars)
  kino.log("sp_dc raw (60):", JSON.stringify(raw.slice(0, 60)));
  // format:"header" puede guardar múltiples formatos:
  // 1. "AQD3abc..."           → valor crudo (pegado manual)
  // 2. "sp_dc=AQD3abc..."     → nombre=valor
  // 3. "sp_dc=AQD3abc; sp_key=..." → header completo con múltiples cookies
  // 4. "Cookie: sp_dc=AQD3abc..." → header HTTP completo
  // 5. "sp_dc=AQD3abc%3D..." → valor URL-encoded
  const mEq = /(?:^|[;,\s])sp_dc=([^;,\s]+)/.exec(raw);
  if (mEq) {
    let val = mEq[1];
    // Decodificar si está URL-encoded
    try { if (val.includes("%")) val = decodeURIComponent(val); } catch(e) {}
    kino.log("sp_dc extraído:", val.slice(0, 20) + "...");
    return val;
  }
  // Sin "=" → es el valor crudo directamente
  if (!raw.includes("=")) {
    kino.log("sp_dc crudo:", raw.slice(0, 20) + "...");
    return raw;
  }
  kino.log("sp_dc: no se pudo extraer el valor del raw");
  return "";
}

function sessionActive(s) {
  if (s && s.sessionOff === true) return false;
  return !!savedSpDc() || (s && s.linkedNow === true);
}

async function fetchToken(spDc) {
  if (!spDc) return null;

  // Si ya sabemos que falló recientemente, no reintentar (evita race conditions)
  if (_tokenFailed && Date.now() - _tokenFailedAt < TOKEN_FAIL_TTL) return null;

  // Revisar cache
  try {
    const cached = kino.storage.get("sp_token");
    if (cached) {
      const e = JSON.parse(cached);
      if (e && e.token && e.exp && e.exp - Date.now() > 60000) {
        _tokenFailed = false;
        return e.token;
      }
    }
  } catch (err) {}

  const headers = {
    "User-Agent": WEB_UA,
    Referer: ORIGIN + "/",
    Origin: ORIGIN,
    Accept: "application/json",
    Cookie: "sp_dc=" + spDc
  };

  kino.log("fetchToken: enviando Cookie sp_dc=" + spDc.slice(0, 20) + "... len=" + spDc.length);
  let r;
  try {
    r = await kino.fetch(TOKEN_URL, { headers, cookies: false, timeoutMs: 10000 });
  } catch (e) {
    kino.log("sp_dc: error de red al obtener token:", e && e.message || "timeout");
    _tokenFailed = true; _tokenFailedAt = Date.now();
    return null;
  }

  kino.log("fetchToken: HTTP " + r.status);
  if (!r.ok) {
    kino.log("sp_dc inválida o expirada (HTTP " + r.status + "), cerrando sesión");
    _tokenFailed = true; _tokenFailedAt = Date.now();
    try { kino.config.set("sp_dc", ""); } catch (e) {}
    try { kino.storage.remove("sp_token"); } catch (e) {}
    return null;
  }

  const d = r.json();
  if (!d.accessToken || d.isAnonymous) {
    kino.log("sp_dc sin sesión activa, cerrando sesión");
    _tokenFailed = true; _tokenFailedAt = Date.now();
    try { kino.config.set("sp_dc", ""); } catch (e) {}
    try { kino.storage.remove("sp_token"); } catch (e) {}
    return null;
  }

  // Token válido
  _tokenFailed = false;
  const exp = d.accessTokenExpirationTimestampMs || (Date.now() + 3600000);
  try {
    kino.storage.set("sp_token", JSON.stringify({ token: d.accessToken, exp }),
      { ttlMs: Math.max(60000, exp - Date.now() - 30000) });
  } catch (e) {}
  return d.accessToken;
}

async function getAccessToken() {
  if (_tokenFailed && Date.now() - _tokenFailedAt < TOKEN_FAIL_TTL) return null;
  const spDc = savedSpDc();
  if (!spDc) return null;
  return fetchToken(spDc);
}

async function authHeaders() {
  const token = await getAccessToken();
  if (!token) return {};
  return { Authorization: "Bearer " + token };
}

// ---------------------------------------------------------------------------------------------
// Llamadas a la Web API
// ---------------------------------------------------------------------------------------------

function locale() {
  const parts = String(kino.lang || "es-US").split(/[-_]/);
  return { lang: (parts[0] || "es").toLowerCase(), country: (parts[1] || "US").toUpperCase() };
}

async function sp(path, opts) {
  const o = opts || {};
  const token = await getAccessToken();
  if (!token) throw kino.error("auth_required", "spotify no token: " + path);
  const headers = Object.assign(
    { "User-Agent": WEB_UA, Accept: "application/json" },
    { Authorization: "Bearer " + token }
  );
  const sep = path.includes("?") ? "&" : "?";
  const { country } = locale();
  const url = API + path + (o.noMarket ? "" : sep + "market=" + country);
  const r = await kino.fetch(url, {
    headers,
    cookies: false,
    timeoutMs: o.timeoutMs || 15000
  });
  if (r.status === 401) {
    // token expirado: limpiar ambas cachés y reintentar una vez
    try { kino.storage.remove("sp_token"); } catch (e) {}
    try { kino.storage.remove("sp_anon_token"); } catch (e) {}
    const headers2 = Object.assign(
      { "User-Agent": WEB_UA, Accept: "application/json" },
      await authHeaders()
    );
    const r2 = await kino.fetch(url, { headers: headers2, cookies: false, timeoutMs: o.timeoutMs || 15000 });
    if (!r2.ok) throw kino.error("auth_required", "spotify " + path + " " + r2.status, {
      userMessage: "La sesión de Spotify venció. Vincula tu cuenta de nuevo."
    });
    return r2.json();
  }
  if (r.status === 429) throw kino.error("rate_limited", "spotify " + path + " 429");
  if (!r.ok) throw kino.error("unavailable", "spotify " + path + " " + r.status);
  return r.json();
}

async function safe(label, fn, fallback) {
  try { return await fn(); } catch (e) {
    kino.log(label + ":", (e && e.code) || "error");
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// Mapeo de objetos Spotify → items de Kino
// ---------------------------------------------------------------------------------------------

function hideExplicit() {
  return kino.config.get("hideExplicit") === true;
}

function bigImage(images) {
  if (!images || !images.length) return undefined;
  const sorted = images.slice().sort((a, b) => (b.width || 0) - (a.width || 0));
  const u = sorted[0].url;
  return u && u.startsWith("https://") ? u.slice(0, 2048) : undefined;
}

function trackItem(t) {
  if (!t || !t.id) return null;
  if (hideExplicit() && t.explicit) return null;
  const badges = ["Canción"];
  if (t.explicit) badges.push("Explícito");
  const artists = (t.artists || []).map(a => a.name).join(", ");
  const album = t.album;
  return {
    id: "t." + t.id,
    ref: "t:" + t.id,
    ids: { spotify: t.id },
    title: (t.name || "Canción").slice(0, 200),
    artist: artists.slice(0, 200),
    poster: bigImage(album && album.images),
    year: album && album.release_date ? album.release_date.slice(0, 4) : undefined,
    runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined,
    badges: badges.slice(0, 3),
    kind: "music"
  };
}

function albumItem(a) {
  if (!a || !a.id) return null;
  const artists = (a.artists || []).map(x => x.name).join(", ");
  const kind = a.album_type === "single" ? "Sencillo" : a.album_type === "ep" ? "EP" : "Álbum";
  return {
    id: "b." + a.id,
    ref: "b:" + a.id,
    title: (a.name || "Álbum").slice(0, 200),
    artist: artists.slice(0, 200),
    poster: bigImage(a.images),
    year: a.release_date ? a.release_date.slice(0, 4) : undefined,
    badges: [kind],
    kind: "music"
  };
}

function playlistItem(p) {
  if (!p || !p.id) return null;
  return {
    id: "p." + p.id,
    ref: "p:" + p.id,
    title: (p.name || "Lista").slice(0, 200),
    artist: (p.owner && p.owner.display_name) || "",
    poster: bigImage(p.images),
    badges: ["Lista"],
    kind: "music"
  };
}

function artistItem(a) {
  if (!a || !a.id) return null;
  return {
    id: "a." + a.id,
    ref: "a:" + a.id,
    title: (a.name || "Artista").slice(0, 200),
    poster: bigImage(a.images),
    badges: ["Artista"],
    kind: "music"
  };
}

function parseRef(ref) {
  const m = /^([tbpa]):([A-Za-z0-9]+)$/.exec(String(ref || ""));
  return m ? { type: m[1], id: m[2] } : null;
}

// ---------------------------------------------------------------------------------------------
// Capacidades principales
// ---------------------------------------------------------------------------------------------

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  if (query && query.within) return null;

  const { country, lang } = locale();
  const data = await sp(
    "search?q=" + encodeURIComponent(q) +
    "&type=track,album,artist,playlist&limit=20&market=" + country, { noMarket: true }
  );

  const out = [];
  const seen = new Set();

  const add = (item) => {
    if (!item || seen.has(item.ref)) return;
    seen.add(item.ref);
    out.push(item);
  };

  for (const a of (data.artists && data.artists.items) || []) add(artistItem(a));
  for (const t of (data.tracks && data.tracks.items) || []) { const i = trackItem(t); if (i) add(i); }
  for (const a of (data.albums && data.albums.items) || []) { const i = albumItem(a); if (i) add(i); }
  for (const p of (data.playlists && data.playlists.items) || []) { const i = playlistItem(p); if (i) add(i); }

  return out.slice(0, 80);
}

async function featuredRows() {
  // browse/* endpoints requieren auth desde 2024; usamos search con géneros populares
  const genres = [
    { id: "pop", q: "genre:pop year:2024-2025", label: "Pop" },
    { id: "reggaeton", q: "genre:reggaeton", label: "Reggaetón & Urbano" },
    { id: "rock", q: "genre:rock", label: "Rock" },
    { id: "electronica", q: "genre:electronic", label: "Electrónica" },
    { id: "latin", q: "genre:latin", label: "Latin" }
  ];
  const { country } = locale();
  const rows = [];

  // Top charts — playlist global conocida, siempre accesible con token de usuario
  const [global50, viral50] = await Promise.all([
    safe("featured", () => sp("playlists/37i9dQZEVXbMDoHDwVN2tF"), null),
    safe("new_releases", () => sp("playlists/37i9dQZEVXbLiRSasKsNU9"), null)
  ]);
  if (global50 && global50.tracks) {
    const items = (global50.tracks.items || []).map(x => x.track ? trackItem(x.track) : null).filter(Boolean).slice(0, 25);
    if (items.length) rows.push({ id: "sp-global", title: "Global Top 50", items, genre: "musica" });
  }
  if (viral50 && viral50.tracks) {
    const items = (viral50.tracks.items || []).map(x => x.track ? trackItem(x.track) : null).filter(Boolean).slice(0, 25);
    if (items.length) rows.push({ id: "sp-viral", title: "Viral 50", items, genre: "musica" });
  }

  // Géneros vía search (funciona con cualquier token autenticado)
  for (const g of genres) {
    const data = await safe("genre_" + g.id, () => sp(
      "search?q=" + encodeURIComponent(g.q) + "&type=track&limit=20&market=" + country, { noMarket: true }
    ), null);
    if (data && data.tracks) {
      const items = (data.tracks.items || []).map(trackItem).filter(Boolean).slice(0, 20);
      if (items.length) rows.push({ id: "sp-genre-" + g.id, title: g.label, items, genre: "musica" });
    }
  }
  return rows;
}

async function libraryRows() {
  const rows = [];
  const [liked, playlists, albums] = await Promise.all([
    safe("liked", () => sp("me/tracks?limit=50"), null),
    safe("playlists", () => sp("me/playlists?limit=50"), null),
    safe("albums", () => sp("me/albums?limit=50"), null)
  ]);

  if (liked && liked.items) {
    const items = liked.items.map(x => x.track ? trackItem(x.track) : null).filter(Boolean).slice(0, 50);
    if (items.length) rows.push({ id: "sp-liked", title: "Canciones que te gustan", items, ref: "liked:", genre: "musica" });
  }
  if (playlists && playlists.items) {
    const items = playlists.items.map(playlistItem).filter(Boolean).slice(0, 50);
    if (items.length) rows.push({ id: "sp-playlists", title: "Tus playlists", items, genre: "musica" });
  }
  if (albums && albums.items) {
    const items = albums.items.map(x => x.album ? albumItem(x.album) : null).filter(Boolean).slice(0, 50);
    if (items.length) rows.push({ id: "sp-albums", title: "Álbumes guardados", items, genre: "musica" });
  }
  return rows;
}

export async function home() {
  if (!savedSpDc()) return [];
  const [lib, main] = await Promise.all([
    safe("lib", libraryRows, []),
    safe("featured", featuredRows, [])
  ]);
  return lib.concat(main).slice(0, 20);
}

const TAB_HOME = "inicio";
const TAB_EXPLORE = "explorar";
const TAB_CHARTS = "tendencias";
const TAB_LIBRARY = "biblioteca";

function sectionTabs() {
  const tabs = [
    { id: TAB_HOME, label: "Para ti" },
    { id: TAB_EXPLORE, label: "Explorar" },
    { id: TAB_CHARTS, label: "Tendencias" }
  ];
  if (savedSpDc()) tabs.push({ id: TAB_LIBRARY, label: "Biblioteca" });
  return tabs;
}

function heroOf(rows) {
  const pool = [];
  for (const r of rows) for (const it of r.items) if (it.poster) pool.push(it);
  if (!pool.length) return null;
  const it = pool[Math.floor(Date.now() / 86400000) % Math.min(pool.length, 12)];
  return {
    title: it.title.slice(0, 200),
    image: it.poster,
    text: (it.artist ? "De " + it.artist + ". " : "") + "Tu selección de hoy en Spotify."
  };
}

export async function section(arg) {
  const tabs = sectionTabs();
  const wanted = arg && arg.tab;
  const tab = tabs.some(t => t.id === wanted) ? wanted : TAB_HOME;
  const { country } = locale();
  let rows = [];

  if (tab === TAB_HOME || tab === TAB_EXPLORE) {
    if (!savedSpDc()) return { tabs, tab, rows: [], hero: null, _noAuth: true };
    rows = await safe("featured_rows", featuredRows, []);
  } else if (tab === TAB_CHARTS) {
    // Playlist "Global Top 50" de Spotify
    const charts = await safe("charts", () => sp("playlists/37i9dQZEVXbMDoHDwVN2tF"), null);
    if (charts) {
      const items = ((charts.tracks && charts.tracks.items) || [])
        .map(x => x.track ? trackItem(x.track) : null).filter(Boolean).slice(0, 50);
      if (items.length) rows.push({ id: "sp-charts", title: "Global Top 50", items, genre: "musica" });
    }
    // Top 50 regional (US por defecto)
    const regional = await safe("regional", () => sp("playlists/37i9dQZEVXbLiRSasKsNU9"), null);
    if (regional) {
      const items = ((regional.tracks && regional.tracks.items) || [])
        .map(x => x.track ? trackItem(x.track) : null).filter(Boolean).slice(0, 50);
      if (items.length) rows.push({ id: "sp-regional", title: "Top 50 regional", items, genre: "musica" });
    }
  } else if (tab === TAB_LIBRARY) {
    rows = await safe("lib", libraryRows, []);
  }

  const answer = { tabs, tab, rows: rows.slice(0, 20) };
  const hero = tab === TAB_LIBRARY ? null : heroOf(answer.rows);
  if (hero) answer.hero = hero;
  return answer;
}

export async function categories() {
  // browse/categories fue deprecado en 2024; devolvemos géneros estáticos
  const genres = [
    { id: "pop", name: "Pop" },
    { id: "reggaeton", name: "Reggaetón" },
    { id: "rock", name: "Rock" },
    { id: "hiphop", name: "Hip-Hop" },
    { id: "electronic", name: "Electrónica" },
    { id: "latin", name: "Latin" },
    { id: "rnb", name: "R&B" },
    { id: "indie", name: "Indie" },
    { id: "metal", name: "Metal" },
    { id: "jazz", name: "Jazz" },
    { id: "classical", name: "Clásica" },
    { id: "country", name: "Country" }
  ];
  return genres.map(g => ({
    id: "g." + g.id,
    title: g.name,
    ref: "g:" + g.id,
    poster: undefined
  }));
}

export async function browse(ref, cursor) {
  // Handle genre ref "g:pop" → search
  const gr = /^g:([A-Za-z0-9_-]+)$/.exec(String(ref || ""));
  if (gr) {
    const { country } = locale();
    const data = await safe("genre_browse", () => sp(
      "search?q=" + encodeURIComponent("genre:" + gr[1]) + "&type=track&limit=50&market=" + country, { noMarket: true }
    ), null);
    const items = data && data.tracks ? (data.tracks.items || []).map(trackItem).filter(Boolean) : [];
    return { items };
  }
  const p = parseRef(ref);
  if (!p) return { items: [] };

  if (p.type === "p") {
    const offset = cursor ? parseInt(cursor, 10) || 0 : 0;
    const data = await sp("playlists/" + p.id + "/tracks?limit=100&offset=" + offset);
    const items = (data.items || []).map(x => x.track ? trackItem(x.track) : null).filter(Boolean);
    const total = data.total || 0;
    const next = offset + 100 < total ? String(offset + 100) : null;
    return next ? { items, next } : { items };
  }
  if (p.type === "b") {
    const data = await sp("albums/" + p.id + "/tracks?limit=50");
    const albumData = await safe("album_meta", () => sp("albums/" + p.id), null);
    const imgs = albumData && albumData.images;
    const items = (data.items || []).map(t => {
      if (!t || !t.id) return null;
      if (hideExplicit() && t.explicit) return null;
      const artists = (t.artists || []).map(a => a.name).join(", ");
      return {
        id: "t." + t.id, ref: "t:" + t.id, ids: { spotify: t.id },
        title: (t.name || "").slice(0, 200),
        artist: artists.slice(0, 200),
        poster: bigImage(imgs),
        runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined,
        badges: t.explicit ? ["Canción", "Explícito"] : ["Canción"],
        kind: "music"
      };
    }).filter(Boolean);
    return { items };
  }
  if (p.type === "c") {
    const data = await safe("cat_pl", () => sp("browse/categories/" + p.id + "/playlists?limit=20"), null);
    const items = data && data.playlists ? (data.playlists.items || []).map(playlistItem).filter(Boolean) : [];
    return { items };
  }
  if (p.type === "a") {
    const [topTracks, albums] = await Promise.all([
      safe("top_tracks", () => sp("artists/" + p.id + "/top-tracks"), null),
      safe("artist_albums", () => sp("artists/" + p.id + "/albums?limit=20&include_groups=album,single"), null)
    ]);
    const tracks = ((topTracks && topTracks.tracks) || []).map(trackItem).filter(Boolean);
    const albs = ((albums && albums.items) || []).map(albumItem).filter(Boolean);
    return { items: [...tracks, ...albs] };
  }
  return { items: [] };
}

export async function episodes(ref) {
  const p = parseRef(ref);
  if (!p) throw kino.error("not_found", "ref no válido");

  if (p.type === "t") {
    const t = await sp("tracks/" + p.id);
    const cover = bigImage(t.album && t.album.images) || "https://misc.scdn.co/liked-songs/liked-songs-300.jpg";
    return {
      series: { title: t.name || "Canción", poster: cover, backdrop: cover },
      episodes: [{
        season: 1, number: 1, ref: String(ref),
        title: t.name || "Canción", still: cover,
        runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined
      }]
    };
  }
  if (p.type === "b") {
    const albumData = await sp("albums/" + p.id);
    const head = {
      title: albumData.name || "Álbum",
      poster: bigImage(albumData.images),
      year: albumData.release_date ? albumData.release_date.slice(0, 4) : undefined,
      overview: (albumData.artists || []).map(a => a.name).join(", ")
    };
    const tracks = (albumData.tracks && albumData.tracks.items) || [];
    return {
      series: { title: head.title, poster: head.poster, backdrop: head.poster, overview: head.overview, year: head.year },
      episodes: tracks.map((t, i) => ({
        season: 1, number: i + 1, ref: "t:" + t.id,
        title: t.name || "Pista " + (i + 1),
        still: head.poster,
        runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined
      }))
    };
  }
  if (p.type === "p") {
    const pl = await sp("playlists/" + p.id);
    const head = {
      title: pl.name || "Playlist",
      poster: bigImage(pl.images),
      overview: pl.description || ""
    };
    const tracks = ((pl.tracks && pl.tracks.items) || [])
      .map(x => x.track).filter(Boolean);
    return {
      series: { title: head.title, poster: head.poster, backdrop: head.poster, overview: head.overview },
      episodes: tracks.slice(0, 500).map((t, i) => ({
        season: 1, number: i + 1, ref: "t:" + t.id,
        title: t.name || "Canción",
        still: bigImage(t.album && t.album.images) || head.poster,
        runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined
      }))
    };
  }
  if (p.type === "a") {
    const [artist, topTracks] = await Promise.all([
      sp("artists/" + p.id),
      sp("artists/" + p.id + "/top-tracks")
    ]);
    const head = {
      title: artist.name || "Artista",
      poster: bigImage(artist.images),
      overview: artist.genres ? artist.genres.join(", ") : ""
    };
    const tracks = (topTracks.tracks || []);
    if (!tracks.length) throw kino.error("not_found", "artista sin pistas", { userMessage: "No se encontraron canciones de este artista." });
    return {
      series: { title: head.title, poster: head.poster, backdrop: head.poster, overview: head.overview },
      episodes: tracks.slice(0, 50).map((t, i) => ({
        season: 1, number: i + 1, ref: "t:" + t.id,
        title: t.name || "Canción",
        still: bigImage(t.album && t.album.images) || head.poster,
        runtimeMinutes: t.duration_ms ? Math.max(1, Math.round(t.duration_ms / 60000)) : undefined
      }))
    };
  }
  throw kino.error("not_found", "tipo de ref no soportado");
}

// ---------------------------------------------------------------------------------------------
// Reproducción: Spotify Connect via browser capture + fallback preview URL
// ---------------------------------------------------------------------------------------------

export async function resolve(ref) {
  const p = parseRef(ref);
  if (!p || p.type !== "t") throw kino.error("not_found", "ref de pista no válido");

  const canBrowse = !!(kino.browser && typeof kino.browser.capture === "function");

  // Primero intentamos capturar el stream del navegador oculto (más completo)
  if (canBrowse) {
    try {
      const page = await kino.browser.capture(
        "https://open.spotify.com/track/" + p.id,
        { match: "audio.*scdn\\.co|audio.*spotify", timeoutMs: 25000 }
      );
      const all = page.media || [];
      const audio = all.filter(m => /audio/.test(m.url) || /scdn\.co/.test(m.url));
      if (audio.length) {
        const best = audio[0];
        return {
          url: best.url,
          mime: best.mime || "audio/mpeg",
          headers: best.headers || {},
          label: "Spotify"
        };
      }
    } catch (e) {
      kino.log("spotify browser capture:", e.code || "error");
    }
  }

  // Fallback: preview_url (30 s) si está disponible
  const track = await safe("track_meta", () => sp("tracks/" + p.id), null);
  if (track && track.preview_url) {
    return {
      url: track.preview_url,
      mime: "audio/mpeg",
      label: "Vista previa (30 s)",
      userMessage: "Solo disponible como vista previa de 30 segundos. Instala Spotify o vincula tu cuenta para escuchar completo."
    };
  }

  throw kino.error("unavailable", "spotify sin stream", {
    userMessage: "No se pudo reproducir esta canción. Vincula tu cuenta o abre Spotify directamente."
  });
}

// ---------------------------------------------------------------------------------------------
// Ajustes: estado de sesión
// ---------------------------------------------------------------------------------------------

async function accountDisplayName() {
  try {
    const data = await sp("me");
    return (data.display_name || data.id || "").slice(0, 60) || null;
  } catch (e) {
    if (e && e.code === "auth_required") return null;
    throw e;
  }
}

export async function settingsStatus() {
  const spDc = savedSpDc();
  if (!spDc) return { linked: "Sin sesión: usas Spotify como invitado con contenido limitado" };
  // Forzar renovación (ignorar cache) para mostrar estado real
  try { kino.storage.remove("sp_token"); } catch (e) {}
  _tokenFailed = false;
  const token = await fetchToken(spDc);
  if (!token) {
    // fetchToken ya limpió sp_dc y logueó el motivo
    return { linked: "Cookie sp_dc expirada o inválida — vincula tu cuenta de nuevo" };
  }
  try {
    const name = await accountDisplayName();
    return { linked: name ? "Sesión activa como " + name : "Sesión activa" };
  } catch (e) {
    return { linked: "Sesión activa (no se pudo obtener el nombre)" };
  }
}

export async function action(key) {
  await null;
  if (key !== "logout") return null;
  try { kino.storage.remove("sp_token"); } catch (e) {}
  try { kino.storage.remove("sp_anon_token"); } catch (e) {}
  return { message: "Sesión cerrada", clearSettings: ["sp_dc"] };
}

export async function validateSettings(values) {
  await null;
  const spDc = String(values.sp_dc || "").trim();
  if (!spDc) return null; // sin cookie: invitado
  if (spDc.length < 20) return { sp_dc: "El valor no parece una cookie sp_dc válida." };
  // Forzar renovación de token con la cookie nueva
  try { kino.storage.remove("sp_token"); } catch (e) {}
  const r = await kino.fetch(TOKEN_URL, {
    headers: { "User-Agent": WEB_UA, Cookie: "sp_dc=" + spDc, Referer: ORIGIN + "/", Origin: ORIGIN },
    cookies: false,
    timeoutMs: 10000
  });
  if (!r.ok) return { sp_dc: "Spotify rechazó esta cookie. Cópiala de nuevo." };
  const d = r.json();
  if (!d.accessToken || d.isAnonymous) return { sp_dc: "Esta cookie no tiene sesión activa. Inicia sesión en open.spotify.com, copia la cookie sp_dc y pégala aquí." };
  return null;
}

// =============================================================================================
// UI SCREEN
// =============================================================================================

const SEARCH_ACTION = { ui: [{ show: "search_loading_card" }, { focus: "search_loading_card" }], event: "do_search" };

let lastInstalled = {};

function parseItemType(ref, badges) {
  const r = String(ref || "");
  const m = /^([tpba]):/.exec(r);
  const type = m ? m[1] : "t";
  const b = badges || [];
  const isArtist = type === "a" || b.includes("Artista");
  const isAlbum = type === "b" || type === "p" || b.includes("Álbum") || b.includes("Lista");
  return { type, isArtist, isAlbum, isTrack: !isArtist && !isAlbum };
}

function renderMusicTile(item, idx, prefix) {
  prefix = prefix || "tr_";
  const meta = parseItemType(item.ref, item.badges);
  const title = String(item.title || "").slice(0, 200);
  const initials = title.slice(0, 2).toUpperCase();
  let subtitle = "";
  if (meta.isArtist) subtitle = "Artista";
  else if (meta.isAlbum) subtitle = item.artist ? item.artist + " · " + (item.badges && item.badges[0] || "Lista") : (item.badges && item.badges[0] || "Lista");
  else subtitle = item.artist ? item.artist + " · Canción" : "Canción";

  const onTap = (meta.isArtist || meta.isAlbum)
    ? { go: { title: { ref: item.ref, kind: "music", id: item.id, title } } }
    : { go: { play: { ref: item.ref, kind: "music", id: item.id, title } } };

  return {
    type: "ListTile",
    key: prefix + idx,
    title,
    subtitle,
    leading: { type: "CircleAvatar", image: item.poster || "", radius: 24, text: initials },
    trailing: { type: "Icon", name: meta.isArtist ? "person" : meta.isAlbum ? "list" : "play" },
    onTap
  };
}

function loginCard() {
  const canBrowser = !!(kino.visualBrowser && kino.visualBrowser.available);
  return {
    type: "SingleChildScrollView",
    key: "lib_guest_scroll",
    children: [{
      type: "Column",
      key: "lib_guest_col",
      padding: 16,
      gap: 16,
      children: [
        {
          type: "banner",
          key: "guest_banner",
          role: "info",
          title: "Estás en Modo Invitado",
          text: "Vincula tu cuenta de Spotify para ver tus canciones guardadas, playlists y álbumes."
        },
        ...(canBrowser ? [{
          type: "Card",
          key: "card_browser_login",
          padding: 16,
          variant: "filled",
          children: [
            { type: "Text", key: "bl_title", text: "Iniciar sesión con el navegador", style: "h3" },
            { type: "Text", key: "bl_desc", text: "Kino abrirá una ventana para que inicies sesión con Spotify. No tienes que copiar nada.", color: "muted" },
            {
              type: "ElevatedButton",
              key: "btn_link_browser",
              labelText: "Vincular cuenta Spotify",
              labelTextEn: "Link Spotify account",
              icon: "person",
              onPressed: "link_account"
            }
          ]
        }] : []),
        {
          type: "Card",
          key: "card_manual_login",
          padding: 16,
          variant: "outlined",
          children: [
            { type: "Text", key: "ml_title", text: "Vinculación manual (cookie sp_dc)", style: "h3" },
            { type: "Text", key: "ml_step1", text: "1. Abre open.spotify.com en un navegador de escritorio e inicia sesión." },
            { type: "Text", key: "ml_step2", text: "2. Abre las Herramientas de Desarrollador (F12) → Aplicación → Cookies → open.spotify.com." },
            { type: "Text", key: "ml_step3", text: "3. Copia el valor de la cookie llamada sp_dc." },
            { type: "Text", key: "ml_step4", text: "4. Pégala aquí y pulsa Vincular:" },
            { type: "TextField", key: "spDcInput", labelText: "Pegar sp_dc aquí", hintText: "AQD3...", maxLines: 2 },
            { type: "ElevatedButton", key: "btn_save_spdc", labelText: "Vincular Cuenta", icon: "check", onPressed: "save_spdc" }
          ]
        }
      ]
    }]
  };
}

export async function screen({ state, route, device, size, lang, installed }) {
  lastInstalled = installed || {};
  const s = state || {};
  const tab = s.tab || "trending";

  let bodyNode;

  if (tab === "trending") {
    const rails = s.rails || [];
    const filter = s.trendFilter || "all";
    const featuredHero = s.heroItem || (rails[0] && rails[0].items && rails[0].items[0]);
    const children = [];

    if (s.trendingLoaded && s.railsAuth !== sessionActive(s)) {
      children.push({
        type: "Card", key: "card_reload_home", padding: 16, variant: "outlined",
        children: [
          { type: "Text", key: "reload_txt", text: sessionActive(s) ? "Tu cuenta está vinculada. Recarga para ver tu música." : "Cerraste sesión. Actualiza el Inicio." },
          { type: "ElevatedButton", key: "btn_reload", labelText: "Actualizar", icon: "refresh", onPressed: "refresh_screen" }
        ]
      });
    }

    if (featuredHero) {
      children.push({
        type: "heroCard", key: "hero_trend",
        title: "Tendencias en Spotify",
        text: featuredHero.title ? "Destacado: " + featuredHero.title : "Descubre música en Spotify",
        image: featuredHero.poster || "",
        buttons: [{ type: "Button", key: "hero_btn_search", variant: "secondary", icon: "search", labelText: "Buscar música", labelTextEn: "Search music", onPressed: "open_search" }]
      });
    }

    children.push({
      type: "Card", key: "trend_filter_card", padding: 8, variant: "outlined",
      children: [{
        type: "SingleChildScrollView", key: "trend_filter_scroll", direction: "horizontal",
        children: [{
          type: "Chips", key: "trend_filter", value: filter, onChange: "filter_trending",
          options: [
            { value: "all", label: "Todo", labelEn: "All" },
            { value: "songs", label: "Canciones", labelEn: "Songs" },
            { value: "artists", label: "Artistas", labelEn: "Artists" },
            { value: "albums", label: "Álbumes y Listas", labelEn: "Albums & Lists" }
          ]
        }]
      }]
    });

    if (!s.trendingLoaded || !rails.length) {
      children.push({ type: "Skeleton", key: "skel_trend", variant: "list", rows: 8, padding: 12 });
    } else if (filter === "all") {
      rails.forEach((rail, idx) => {
        if (rail.items && rail.items.length) {
          children.push({ type: "titleRail", key: "rail_" + idx, title: rail.title, items: rail.items });
        }
      });
    } else {
      const filteredItems = [];
      const seen = new Set();
      for (const r of rails) {
        for (const it of r.items || []) {
          if (!it.ref || seen.has(it.ref)) continue;
          seen.add(it.ref);
          const meta = parseItemType(it.ref, it.badges);
          if (filter === "songs" && meta.isTrack) filteredItems.push(it);
          if (filter === "artists" && meta.isArtist) filteredItems.push(it);
          if (filter === "albums" && meta.isAlbum) filteredItems.push(it);
        }
      }
      if (filteredItems.length) {
        children.push({ type: "titleRail", key: "rail_filtered", title: filter === "songs" ? "Canciones" : filter === "artists" ? "Artistas" : "Álbumes y Playlists", items: filteredItems.slice(0, 30) });
        children.push({ type: "Card", key: "filtered_list_card", padding: 8, variant: "outlined", children: filteredItems.slice(0, 20).map((it, idx) => renderMusicTile(it, idx, "flt_")) });
      } else {
        children.push({ type: "emptyState", key: "trend_empty", title: "Sin resultados en esta categoría", text: "Selecciona otra categoría arriba.", icon: "filter_list" });
      }
    }

    bodyNode = { type: "SingleChildScrollView", key: "trend_scroll", children: [{ type: "Column", key: "trend_col", gap: 16, padding: 12, children }] };

  } else if (tab === "search") {
    const rawResults = s.searchResults || [];
    const filter = s.searchFilter || "all";
    const tracks = [], others = [];
    for (const it of rawResults) {
      const meta = parseItemType(it.ref, it.badges);
      if (meta.isTrack) tracks.push(it); else others.push(it);
    }
    const artists = [], albums = [];
    for (const it of others) (parseItemType(it.ref, it.badges).isArtist ? artists : albums).push(it);
    const shownTracks = filter === "artists" || filter === "albums" ? [] : tracks;
    const shownOthers = filter === "all" ? others : filter === "songs" ? [] : filter === "artists" ? artists : albums;

    const children = [
      {
        type: "Row", key: "search_top_row",
        children: [
          { type: "TextButton", key: "btn_close_search", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back", onPressed: "close_search" },
          { type: "Text", key: "search_top_title", text: "Buscar en Spotify", textEn: "Search Spotify", style: "h3" }
        ]
      },
      {
        type: "Card", key: "search_card", padding: 12, variant: "outlined",
        children: [
          { type: "TextField", key: "searchQuery", kind: "search", labelText: "Buscar en Spotify", labelTextEn: "Search Spotify", hintText: "Canción, artista, álbum o playlist...", onSubmitted: SEARCH_ACTION, trailingIcon: "search", trailingLabel: "Buscar", trailingLabelEn: "Search", onTrailingTap: SEARCH_ACTION },
          { type: "Text", key: "search_hint", text: "Busca canciones, artistas, álbumes y playlists.", style: "caption", color: "muted" }
        ]
      },
      {
        type: "Card", key: "search_filter_card", padding: 8, variant: "outlined",
        children: [{
          type: "SingleChildScrollView", key: "search_filter_scroll", direction: "horizontal",
          children: [{ type: "Chips", key: "search_filter", value: filter, onChange: "filter_search", options: [
            { value: "all", label: "Todo", labelEn: "All" },
            { value: "songs", label: "Canciones", labelEn: "Songs" },
            { value: "artists", label: "Artistas", labelEn: "Artists" },
            { value: "albums", label: "Álbumes", labelEn: "Albums" }
          ]}]
        }]
      },
      { type: "Card", key: "search_loading_card", padding: 24, align: "center", hidden: true, canRequestFocus: true,
        children: [{ type: "CircularProgressIndicator", key: "search_cpi", text: "Buscando en Spotify...", textEn: "Searching Spotify..." }] }
    ];

    if (s.searching) {
      children.push({ type: "Skeleton", key: "skel_search", variant: "list", rows: 6, padding: 12 });
    } else if (rawResults.length && (shownTracks.length || shownOthers.length)) {
      if (shownOthers.length) children.push({ type: "titleRail", key: "sr_rail_others", title: "Artistas y Álbumes encontrados", items: shownOthers.slice(0, 20) });
      if (shownTracks.length) {
        children.push({ type: "titleRail", key: "sr_rail_tracks", title: "Canciones destacadas", items: shownTracks.slice(0, 20) });
        children.push({ type: "Card", key: "sr_tracks_card", padding: 8, variant: "outlined", children: [
          { type: "Text", key: "sr_tracklist_head", text: "Lista de Canciones", style: "h4" },
          ...shownTracks.slice(0, 15).map((item, idx) => renderMusicTile(item, idx, "sr_t_"))
        ]});
      }
    } else if (s.searched) {
      children.push({ type: "emptyState", key: "sr_empty", title: "Sin resultados", text: "Prueba con otra palabra.", icon: "search" });
    } else {
      const recRails = (s.rails || []).slice(0, 2);
      if (recRails.length) {
        recRails.forEach((r, idx) => {
          if (r.items && r.items.length) children.push({ type: "titleRail", key: "sr_rec_rail_" + idx, title: "Recomendado: " + r.title, items: r.items.slice(0, 15) });
        });
      } else {
        children.push({ type: "emptyState", key: "sr_init", title: "Buscador de Spotify", text: "Escribe cualquier canción, artista o playlist y pulsa Buscar.", icon: "music" });
      }
    }

    bodyNode = { type: "SingleChildScrollView", key: "search_scroll", children: [{ type: "Column", key: "search_col", gap: 16, padding: 12, children }] };

  } else if (tab === "ai") {
    const aiList = s.aiTracks || [];
    const children = [
      {
        type: "heroCard", key: "hero_ai",
        title: "Playlist Inteligente con IA",
        text: "Describe cualquier momento o estilo musical y la IA creará una selección real y personalizada.",
        image: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?auto=format&fit=crop&w=1200&q=80"
      },
      {
        type: "Card", key: "ai_card", padding: 14, variant: "filled",
        children: [
          { type: "Text", key: "ai_t1", text: "¿Qué te apetece escuchar?", style: "h3" },
          { type: "Text", key: "ai_desc", text: "Toca una idea rápida o escribe tu propia descripción:", color: "muted" },
          {
            type: "Chips", key: "ai_quick_chips", onChange: "quick_ai_prompt",
            options: [
              { value: "Rock clásico legendario de los 70 y 80", label: "Rock Clásico", labelEn: "Classic Rock" },
              { value: "Éxitos de reggaetón y pop latino 2024", label: "Pop & Urbano", labelEn: "Pop & Urban" },
              { value: "Lo-Fi relajante y chill para estudiar concentrado", label: "Lo-Fi Chill", labelEn: "Lo-Fi Chill" },
              { value: "Música electrónica energizante para entrenar en el gym", label: "Gym & Workout", labelEn: "Gym & Workout" },
              { value: "Synthwave y retrowave de noche en la ciudad", label: "Synthwave 80s", labelEn: "Synthwave 80s" }
            ]
          },
          { type: "TextField", key: "aiPrompt", labelText: "Escribe tu idea temática", labelTextEn: "What music do you want today?", hintText: "Ej. Baladas acústicas melancólicas para un día lluvioso", maxLines: 3, onSubmit: "generate_ai", trailingIcon: "magic", trailingLabel: "Crear", trailingLabelEn: "Create", onTrailingTap: "generate_ai" },
          { type: "ElevatedButton", key: "btn_ai_exec", labelText: "Generar Playlist con IA", labelTextEn: "Generate AI Playlist", icon: "magic", onPressed: "generate_ai" }
        ]
      }
    ];

    if (s.aiLoading) {
      children.push({ type: "Skeleton", key: "skel_ai", variant: "list", rows: 6, padding: 12 });
    } else if (aiList.length) {
      children.push({ type: "titleRail", key: "ai_rail_results", title: "Selección creada por la IA", items: aiList });
      children.push({ type: "Card", key: "ai_list_card", padding: 8, variant: "outlined", children: [
        { type: "Text", key: "ai_list_title", text: "Canciones en tu Lista", style: "h4" },
        ...aiList.map((item, idx) => renderMusicTile(item, idx, "ai_it_"))
      ]});
    } else {
      children.push({ type: "emptyState", key: "ai_init", title: "Tu DJ Personal con Inteligencia Artificial", text: "Toca una sugerencia rápida o escribe cualquier descripción.", icon: "magic" });
    }

    bodyNode = { type: "SingleChildScrollView", key: "ai_scroll", children: [{ type: "Column", key: "ai_col", gap: 16, padding: 12, children }] };

  } else if (tab === "library") {
    const rawLib = s.libraryItems || [];
    const filter = s.libFilter || "all";
    const hasSess = sessionActive(s);

    if (hasSess) {
      const tracks = [], playlists = [], albums = [];
      for (const it of rawLib) {
        const meta = parseItemType(it.ref, it.badges);
        if (meta.isTrack) tracks.push(it);
        else if (it.ref && it.ref.startsWith("p:")) playlists.push(it);
        else albums.push(it);
      }

      const children = [
        {
          type: "Card", key: "lib_user_card", padding: 14, variant: "outlined",
          children: [{
            type: "ListTile", key: "lib_user_tile",
            title: "Mi Biblioteca Spotify",
            subtitle: rawLib.length ? "Conectado · " + rawLib.length + " elementos" : "Conectado a tu cuenta de Spotify",
            leading: { type: "CircleAvatar", key: "lib_avatar", radius: 24, icon: "music" },
            trailing: { type: "Icon", key: "lib_open_account", name: "arrow_forward" },
            onTap: "switch_screen_tab_account"
          }]
        }
      ];

      children.push({
        type: "Card", key: "lib_filter_card", padding: 8, variant: "outlined",
        children: [{
          type: "SingleChildScrollView", key: "lib_filter_scroll", direction: "horizontal",
          children: [{ type: "Chips", key: "lib_filter", value: filter, onChange: "filter_library", options: [
            { value: "all", label: "Todo", labelEn: "All" },
            { value: "playlists", label: "Playlists", labelEn: "Playlists" },
            { value: "albums", label: "Álbumes", labelEn: "Albums" },
            { value: "tracks", label: "Me gusta", labelEn: "Liked" }
          ]}]
        }]
      });

      if (!s.libraryLoaded) {
        children.push({ type: "Skeleton", key: "skel_lib", variant: "list", rows: 8, padding: 12 });
      } else if (rawLib.length) {
        if ((filter === "all" || filter === "playlists") && playlists.length) children.push({ type: "titleRail", key: "lib_rail_pl", title: "Tus playlists", items: playlists });
        if ((filter === "all" || filter === "albums") && albums.length) children.push({ type: "titleRail", key: "lib_rail_al", title: "Álbumes guardados", items: albums });
        if ((filter === "all" || filter === "tracks") && tracks.length) {
          children.push({ type: "titleRail", key: "lib_rail_tr", title: "Canciones que te gustan", items: tracks.slice(0, 20) });
          children.push({ type: "Card", key: "lib_tracks_card", padding: 8, variant: "outlined", children: [
            { type: "Text", key: "lib_t_head", text: "Tus Temas Favoritos", style: "h4" },
            ...tracks.slice(0, 15).map((item, idx) => renderMusicTile(item, idx, "lib_t_"))
          ]});
        }
      } else {
        children.push({ type: "emptyState", key: "lib_empty", title: "No se encontraron elementos", text: "Comprueba que tienes canciones guardadas en Spotify y vuelve a sincronizar.", icon: "music" });
      }

      bodyNode = { type: "SingleChildScrollView", key: "lib_scroll", children: [{ type: "Column", key: "lib_col", gap: 16, padding: 12, children }] };
    } else {
      bodyNode = loginCard();
    }

  } else {
    // tab === "account"
    const hasSess = sessionActive(s);
    const sessionBad = hasSess && s.accountChecked && !s.accountName;
    bodyNode = {
      type: "SingleChildScrollView", key: "acc_scroll",
      children: [{
        type: "Column", key: "acc_col", padding: 16, gap: 16,
        children: [
          {
            type: "Card", key: "card_account", padding: 16, variant: "outlined",
            children: [
              {
                type: "ListTile", key: "acc_status_tile",
                title: "Cuenta de Spotify", titleEn: "Spotify account",
                subtitle: !hasSess ? "Modo invitado (sin sesión)" : sessionBad ? "Spotify no reconoce esta sesión" : s.accountName ? "Sesión activa como " + s.accountName : "Sesión activa y sincronizada",
                leading: { type: "CircleAvatar", key: "acc_avatar", radius: 24, icon: !hasSess ? "person" : sessionBad ? "info" : "check" },
                trailing: { type: "Icon", key: "acc_status_icon", name: !hasSess ? "info" : sessionBad ? "info" : "check" }
              },
              ...(hasSess ? [
                { type: "ElevatedButton", key: "btn_linked", labelText: "Cuenta vinculada", labelTextEn: "Account linked", icon: "check", enabled: false },
                { type: "TextButton", key: "btn_logout", labelText: "Cerrar sesión", labelTextEn: "Log out", onPressed: "logout_session" }
              ] : [
                {
                  type: "ElevatedButton", key: "btn_go_link",
                  labelText: "Vincular cuenta Spotify",
                  labelTextEn: "Link Spotify account",
                  icon: "person",
                  onPressed: "switch_screen_tab_library"
                }
              ])
            ]
          },
          {
            type: "settings", key: "acc_settings_form",
            keys: ["about", "account", "sp_dc", "linked", "logout", "content", "hideExplicit"],
            onSaved: "settings_saved"
          },
          {
            type: "Card", key: "card_about", padding: 16, variant: "outlined",
            children: [{
              type: "ListTile", key: "about_tile",
              title: "Acerca de Spotify para Kino", titleEn: "About Spotify for Kino",
              subtitle: "Versión " + VERSION + " · Creado por JuandreXter",
              leading: { type: "CircleAvatar", key: "about_avatar", radius: 24, icon: "info" },
              dense: true
            }]
          }
        ]
      }]
    };
  }

  const tabs = tab !== "search" ? {
    type: "TabBar", key: "sp_tab_bar", value: tab, onChanged: "switch_screen_tab",
    tabs: [
      { value: "trending", label: "Explorar", labelEn: "Explore" },
      { value: "ai", label: "Playlist IA", labelEn: "AI Playlist" },
      { value: "library", label: "Mi Música", labelEn: "My Music" },
      { value: "account", label: "Ajustes", labelEn: "Settings" }
    ]
  } : null;

  if (tabs && bodyNode && bodyNode.children && bodyNode.children[0] && bodyNode.children[0].children) {
    bodyNode.children[0].children.unshift(tabs);
  }

  return {
    type: "Scaffold",
    key: "sp_main_scaffold",
    floatingActionButton: tab !== "search" ? {
      type: "FloatingActionButton", key: "fab_search", icon: "search",
      labelText: "Buscar música", labelTextEn: "Search music", onPressed: "open_search"
    } : null,
    onBack: tab === "search" ? "close_search" : null,
    appBar: tab === "search" ? {
      type: "AppBar", mergeWithKinoBar: true,
      leading: { type: "IconButton", key: "search_back", icon: "arrow_back", labelText: "Volver", labelTextEn: "Back", onPressed: "close_search" },
      title: "Buscar", titleEn: "Search"
    } : null,
    body: bodyNode
  };
}

async function checkSession(s) {
  const spDc = savedSpDc();
  if (!spDc) { s.accountChecked = false; s.accountName = ""; return; }
  try {
    const name = await accountDisplayName();
    s.accountName = name || "";
    s.accountChecked = true;
  } catch (e) {
    s.accountChecked = false;
  }
}

export async function screenEvent({ name, arg, value, state, route, device, lang, installed }) {
  lastInstalled = installed || {};
  const s = Object.assign({}, state || {});

  if (name === "open" || name === "refresh_screen" || name === "account_linked") {
    if (name === "open") kino.log("Spotify v" + VERSION + " · Creado por JuandreXter");
    if (name === "account_linked") { _tokenFailed = false; _tokenFailedAt = 0; try { kino.storage.remove("sp_token"); } catch(e) {} }
    s.sessionOff = false;
    s.linkedNow = false;
    await checkSession(s);
    try {
      if (!savedSpDc()) {
        s.rails = []; s.heroItem = null; s.trendingLoaded = true; s.railsAuth = false;
        s.libraryItems = []; s.libraryLoaded = true;
        return { state: s };
      }
      const rows = await safe("featured_rows", featuredRows, []);
      const libRows = await safe("lib", libraryRows, []);
      const all = [...libRows, ...rows];
      const rails = [];
      const seenTitles = new Set();
      for (const r of all) {
        if (!r || !r.items || !r.items.length) continue;
        if (seenTitles.has(r.title)) continue;
        seenTitles.add(r.title);
        rails.push({ title: r.title, items: r.items.slice(0, 25) });
      }
      s.rails = rails;
      s.heroItem = rails[0] && rails[0].items && rails[0].items[0] || null;
      s.trendingLoaded = true;
      s.railsAuth = sessionActive(s);
      if (savedSpDc()) {
        const lItems = [];
        for (const r of libRows) for (const it of r.items) if (it.ref && !lItems.some(x => x.ref === it.ref)) lItems.push(it);
        s.libraryItems = lItems;
        s.libraryLoaded = true;
      } else {
        s.libraryLoaded = true;
      }
    } catch (e) {
      s.trendingLoaded = true;
      s.railsAuth = sessionActive(s);
      s.libraryLoaded = true;
    }
    return { state: s };
  }

  if (name === "open_search") { s.prevTab = s.tab !== "search" ? s.tab : (s.prevTab || "trending"); s.tab = "search"; return { state: s }; }
  if (name === "close_search") { s.tab = s.prevTab || "trending"; return { state: s }; }

  if (name === "switch_screen_tab") {
    s.tab = value || "trending";
    if (s.tab === "library" && savedSpDc()) {
      s.libraryLoaded = false;
      try {
        const rows = await safe("lib", libraryRows, []);
        s.libraryItems = rows.flatMap(r => r.items || []);
      } catch (e) { s.libraryItems = []; }
      s.libraryLoaded = true;
    }
    return { state: s };
  }

  if (name === "switch_screen_tab_account") { s.tab = "account"; return { state: s }; }
  if (name === "switch_screen_tab_library") { s.tab = "library"; s.libraryLoaded = false; return { state: s }; }
  if (name === "filter_trending") { s.trendFilter = value || "all"; return { state: s }; }
  if (name === "filter_search") { s.searchFilter = value || "all"; return { state: s }; }
  if (name === "filter_library") { s.libFilter = value || "all"; return { state: s }; }

  if (name === "quick_ai_prompt") {
    const prompt = String(value || "").trim();
    if (prompt) { if (!s.inputs) s.inputs = {}; s.inputs.aiPrompt = prompt; return screenEvent({ name: "generate_ai", value: prompt, state: s, route, device, lang }); }
    return { state: s };
  }

  if (name === "save_spdc") {
    let raw = String(value || arg || (s.inputs && (s.inputs.spDcInput || s.inputs.sp_dc)) || "").trim();
    if (!raw) return { toast: "Pega tu cookie sp_dc antes de vincular" };
    if (raw.length < 20) return { toast: "El valor no parece una cookie sp_dc válida" };
    // Forzar renovación del token con la cookie nueva
    _tokenFailed = false; _tokenFailedAt = 0;
    try { kino.storage.remove("sp_token"); } catch (e) {}
    s.tab = "library";
    s.libraryLoaded = false;
    return { config: { sp_dc: raw }, state: s, toast: "¡Cuenta vinculada con éxito!" };
  }

  if (name === "link_account") {
    if (!(kino.visualBrowser && kino.visualBrowser.available)) {
      return { state: s, toast: "Este aparato no permite vincular con el navegador. Usa la opción manual." };
    }
    const r = await kino.visualBrowser.open({
      url: "https://accounts.spotify.com/es/login?continue=" + encodeURIComponent("https://open.spotify.com/"),
      title: "Spotify",
      userAgent: "browser",
      doneWhen: { cookies: ["sp_dc"] },
      collect: {
        cookies: ["sp_dc"],
        storeAs: { setting: "sp_dc", format: "header", thenEvent: "account_linked" }
      },
      timeoutMs: 600000
    });
    kino.log("visualBrowser result:", JSON.stringify({ status: r.status, stored: r.stored, keys: r.stored ? Object.keys(r) : [] }));
    if (r.stored) {
      // Leer lo que se guardó para diagnóstico
      const savedRaw = String(kino.config.get("sp_dc") || "").trim();
      kino.log("sp_dc guardado por visualBrowser (80):", JSON.stringify(savedRaw.slice(0, 80)));
    }
    if (r.status === "done" && r.stored) return { state: Object.assign({}, s, { linkedNow: true, sessionOff: false }), toast: "Cuenta vinculada" };
    return { state: s, toast: r.status === "closed" ? "No se vinculó la cuenta" : "No se pudo vincular la cuenta" };
  }

  if (name === "do_search" || name === "searched") {
    const q = String(value || arg || (s.inputs && (s.inputs.searchQuery || s.inputs.search)) || "").trim();
    if (!q) return { toast: "Escribe algo para buscar", ui: [{ hide: "search_loading_card" }] };
    s.searching = true; s.searched = true; s.lastQuery = q;
    try {
      const rawResults = await search({ q });
      s.searchResults = (Array.isArray(rawResults) ? rawResults : []).slice(0, 50);
    } catch (e) { s.searchResults = []; }
    s.searching = false;
    return { state: s, ui: [{ hide: "search_loading_card" }] };
  }

  if (name === "generate_ai") {
    const prompt = String(value || arg || (s.inputs && (s.inputs.aiPrompt || s.inputs.prompt)) || "").trim();
    if (!prompt) return { toast: "Escribe tu idea para la playlist" };
    if (typeof kino.ai !== "object" || typeof kino.ai.ask !== "function") return { toast: "Kino AI no está disponible en este dispositivo" };
    s.aiLoading = true;
    try {
      const system = "You are a professional music curator. Return ONLY a valid JSON array of 5 to 7 song recommendations for the given user request. Each array element MUST be an object with string fields \"title\" and \"artist\". Do not include markdown codeblocks, notes, or explanations.";
      const res = await kino.ai.ask({ prompt, system, json: true, maxChars: 1200 });
      if (!res || !res.ok) { s.aiLoading = false; return { state: s, toast: res && res.error || "Error al consultar a la IA" }; }
      let list = [];
      try { const p = JSON.parse((res.text || "").replace(/```json/gi, "").replace(/```/g, "").trim()); list = Array.isArray(p) ? p : (p.songs || p.tracks || p.items || []); } catch (e) {}
      const tracks = [];
      for (const song of list.slice(0, 7)) {
        if (!song || !song.title) continue;
        try {
          const found = await search({ q: song.title + (song.artist ? " " + song.artist : "") });
          const items = Array.isArray(found) ? found : [];
          const track = items.find(x => x.ref && x.ref.startsWith("t:")) || items[0];
          if (track && !tracks.some(x => x.ref === track.ref)) tracks.push(track);
        } catch (err) {}
      }
      s.aiTracks = tracks;
    } catch (e) { kino.log("generate_ai error:", e && e.message); }
    s.aiLoading = false;
    return { state: s };
  }

  if (name === "logout_session") {
    try { kino.storage.remove("sp_token"); } catch (e) {}
    try { kino.storage.remove("sp_anon_token"); } catch (e) {}
    return { state: Object.assign({}, s, { libraryItems: [], linkedNow: false, sessionOff: true }), clearSettings: ["sp_dc"], toast: "Sesión cerrada" };
  }

  if (name === "settings_saved") {
    const keys = value && Array.isArray(value.keys) ? value.keys : [];
    if (keys.includes("logout") || (value && value.action) === "logout") {
      s.libraryItems = []; s.libraryLoaded = true;
    } else if (keys.includes("sp_dc")) {
      s.libraryLoaded = false;
      if (savedSpDc()) {
        try { const rows = await safe("lib", libraryRows, []); s.libraryItems = rows.flatMap(r => r.items || []); } catch (e) { s.libraryItems = []; }
      } else { s.libraryItems = []; }
      s.libraryLoaded = true;
    }
    return { state: s, toast: (!value || value.ok !== false) ? "Ajustes guardados" : "Revisa los ajustes" };
  }

  return { state: s };
}

// =============================================================================================
// PANEL DEL REPRODUCTOR
// =============================================================================================

export async function panel(context) {
  const c = context || {};
  const currentTab = c.tab || "info";
  const p = parseRef(c.ref);
  const trackId = p && p.type === "t" ? p.id : "";
  const isScreen = (c.features || []).includes("screen");

  if (isScreen) {
    let rootNode;
    if (currentTab === "info" && trackId) {
      const track = await safe("panel_track", () => sp("tracks/" + trackId), null);
      const artists = track ? (track.artists || []).map(a => a.name).join(", ") : "";
      const album = track && track.album;
      rootNode = {
        type: "SingleChildScrollView", key: "p_info_scroll",
        children: [{
          type: "Column", key: "p_info_col", padding: 16, gap: 12,
          children: track ? [
            { type: "Text", key: "p_track_name", text: track.name || "", style: "h3" },
            { type: "Text", key: "p_track_artist", text: artists, color: "muted" },
            album ? { type: "Text", key: "p_track_album", text: "Álbum: " + album.name, style: "caption", color: "muted" } : null,
            { type: "Text", key: "p_track_dur", text: "Duración: " + (track.duration_ms ? Math.floor(track.duration_ms / 60000) + " min " + String(Math.round((track.duration_ms % 60000) / 1000)).padStart(2, "0") + " s" : "—"), style: "caption", color: "muted" },
            track.explicit ? { type: "Text", key: "p_track_expl", text: "Contenido explícito", style: "caption", color: "muted" } : null
          ].filter(Boolean) : [
            { type: "emptyState", key: "p_no_info", title: "Sin información", text: "No se encontró información de esta pista.", icon: "music" }
          ]
        }]
      };
    } else {
      rootNode = { type: "emptyState", key: "p_empty", title: "Sin datos", text: "Reproduce una canción para ver información.", icon: "music" };
    }

    return {
      format: "screen",
      title: "Spotify",
      accent: "#1DB954",
      tabs: [{ id: "info", label: "Info", labelEn: "Info" }],
      tab: currentTab,
      root: rootNode
    };
  }

  return {
    presentation: "panel",
    title: "Spotify",
    tabs: [{ id: "info", label: "Info", labelEn: "Info" }],
    tab: currentTab,
    elements: [{ type: "section", title: "Spotify" }, { type: "status", text: "Plugin de Spotify v" + VERSION }]
  };
}

export async function panelAction(event) {
  return null;
}

export async function playerEvent(event, context) {
  return null;
}
