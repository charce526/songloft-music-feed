/**
 * 抖歌 - Songloft 沉浸式音乐发现插件
 * Backend: 推荐引擎、兴趣模型、Session 管理、推荐池维护
 */

/* ─── Router ─── */
function createRouter() {
  const routes = [];
  return {
    get(path, handler) { routes.push({ method: 'GET', path, handler }); },
    post(path, handler) { routes.push({ method: 'POST', path, handler }); },
    handle(req) {
      for (const r of routes) {
        if (r.method === req.method && r.path === req.path) {
          return r.handler(req);
        }
      }
      return { statusCode: 404, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Not Found' }) };
    }
  };
}

function jsonResponse(data, status) {
  return { statusCode: status || 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function parseBody(req) {
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

function parseQuery(qs) {
  const params = {};
  if (!qs) return params;
  const s = qs.startsWith('?') ? qs.slice(1) : qs;
  for (const pair of s.split('&')) {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v || '');
  }
  return params;
}

/* ─── State ─── */
const POOL_SIZE = 100;
const QUEUE_BATCH = 20;
const EXPLORATION_RATIO = 0.15;

let libraryCache = null;
let libraryCacheTime = 0;
const LIBRARY_TTL = 5 * 60 * 1000;

let state = {
  config: null,
  longTermInterest: null,
  pool: [],
  session: null,
  history: []
};

/* ─── Storage helpers ─── */
async function loadState() {
  try {
    state.config = await songloft.storage.get('config') || null;
    state.longTermInterest = await songloft.storage.get('longTermInterest') || { artists: {}, albums: {}, genres: {}, songs: {} };
    state.pool = await songloft.storage.get('pool') || [];
    state.history = await songloft.storage.get('history') || [];
    const savedSession = await songloft.storage.get('activeSession');
    if (savedSession && savedSession.active) {
      state.session = savedSession;
    }
  } catch (e) {
    songloft.log.error('Failed to load state:', e);
  }
}

async function saveConfig() {
  await songloft.storage.set('config', state.config);
}

async function saveLongTermInterest() {
  await songloft.storage.set('longTermInterest', state.longTermInterest);
}

async function savePool() {
  await songloft.storage.set('pool', state.pool);
}

async function saveSession() {
  await songloft.storage.set('activeSession', state.session);
}

async function saveHistory() {
  if (state.history.length > 500) state.history = state.history.slice(-500);
  await songloft.storage.set('history', state.history);
}

/* ─── Library ─── */
async function getLibrary() {
  const now = Date.now();
  if (libraryCache && (now - libraryCacheTime) < LIBRARY_TTL) return libraryCache;
  const songs = await songloft.songs.list({ limit: 100000, offset: 0 });
  libraryCache = songs.items || songs.songs || songs || [];
  libraryCacheTime = now;
  songloft.log.info('Library loaded: ' + libraryCache.length + ' songs');
  return libraryCache;
}

function filterBySource(songs, config) {
  if (!config || !config.source) return songs;
  const src = config.source;
  if (src.type === 'all') return songs;
  if (src.type === 'playlist') {
    return songs.filter(s => (src.songIds || []).includes(s.id));
  }
  if (src.type === 'artist') {
    return songs.filter(s => (s.artist || '').toLowerCase().includes(src.value.toLowerCase()));
  }
  if (src.type === 'album') {
    return songs.filter(s => (s.album || '').toLowerCase().includes(src.value.toLowerCase()));
  }
  if (src.type === 'genre') {
    return songs.filter(s => (s.genre || '').toLowerCase().includes(src.value.toLowerCase()));
  }
  if (src.type === 'folder') {
    return songs.filter(s => (s.file_path || '').replace(/\\/g, '/').includes(src.value));
  }
  return songs;
}

/* ─── Sources ─── */
async function getAvailableSources() {
  const songs = await getLibrary();
  const sources = [{ type: 'all', label: '全部音乐', count: songs.length }];

  const playlists = await songloft.playlists.list();
  const plist = playlists.items || playlists.playlists || playlists || [];
  for (const pl of plist) {
    sources.push({ type: 'playlist', label: pl.name || pl.title || ('歌单 ' + pl.id), id: pl.id, count: pl.song_count || pl.songCount || 0 });
  }

  const artists = {};
  const genres = {};
  const folders = {};
  for (const s of songs) {
    if (s.artist) artists[s.artist] = (artists[s.artist] || 0) + 1;
    if (s.genre) genres[s.genre] = (genres[s.genre] || 0) + 1;
    if (s.file_path) {
      const parts = s.file_path.replace(/\\/g, '/').split('/');
      if (parts.length >= 2) {
        const folder = parts.slice(0, -1).join('/');
        const topFolder = parts.length >= 3 ? parts.slice(0, 3).join('/') : folder;
        folders[topFolder] = (folders[topFolder] || 0) + 1;
      }
    }
  }

  const topArtists = Object.entries(artists).sort((a, b) => b[1] - a[1]).slice(0, 20);
  for (const [name, count] of topArtists) {
    sources.push({ type: 'artist', label: name, value: name, count });
  }

  const topGenres = Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [name, count] of topGenres) {
    sources.push({ type: 'genre', label: name, value: name, count });
  }

  return sources;
}

/* ─── Interest Model ─── */
function getInterestScore(interest, song) {
  let score = 0;
  const artist = (song.artist || '').toLowerCase();
  const album = (song.album || '').toLowerCase();
  const genre = (song.genre || '').toLowerCase();

  if (artist && interest.artists[artist]) score += interest.artists[artist];
  if (album && interest.albums[album]) score += interest.albums[album];
  if (genre && interest.genres[genre]) score += interest.genres[genre];
  if (interest.songs[song.id]) score += interest.songs[song.id] * 0.5;

  return score;
}

function updateInterest(interest, song, weight) {
  const artist = (song.artist || '').toLowerCase();
  const album = (song.album || '').toLowerCase();
  const genre = (song.genre || '').toLowerCase();

  if (artist) interest.artists[artist] = (interest.artists[artist] || 0) + weight;
  if (album) interest.albums[album] = (interest.albums[album] || 0) + weight;
  if (genre) interest.genres[genre] = (interest.genres[genre] || 0) + weight;
  interest.songs[song.id] = (interest.songs[song.id] || 0) + weight * 0.3;
}

function decayInterest(interest, factor) {
  for (const key of Object.keys(interest.artists)) {
    interest.artists[key] *= factor;
    if (Math.abs(interest.artists[key]) < 0.1) delete interest.artists[key];
  }
  for (const key of Object.keys(interest.albums)) {
    interest.albums[key] *= factor;
    if (Math.abs(interest.albums[key]) < 0.1) delete interest.albums[key];
  }
  for (const key of Object.keys(interest.genres)) {
    interest.genres[key] *= factor;
    if (Math.abs(interest.genres[key]) < 0.1) delete interest.genres[key];
  }
  for (const key of Object.keys(interest.songs)) {
    interest.songs[key] *= factor;
    if (Math.abs(interest.songs[key]) < 0.1) delete interest.songs[key];
  }
}

/* ─── Recommendation Pool ─── */
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function initPool(sourceSongs) {
  const shuffled = shuffleArray(sourceSongs);
  const selected = shuffled.slice(0, POOL_SIZE);
  state.pool = selected.map(s => ({
    id: s.id,
    title: s.title,
    artist: s.artist,
    album: s.album,
    genre: s.genre,
    duration: s.duration,
    cover_url: s.cover_url || s.source_cover_url || '',
    url: s.url || '',
    file_path: s.file_path || '',
    reason: '随机探索',
    addedAt: Date.now()
  }));
  await savePool();
  songloft.log.info('Pool initialized with ' + state.pool.length + ' songs');
}

async function refillPool(count, sourceSongs) {
  if (!sourceSongs) sourceSongs = filterBySource(await getLibrary(), state.config);
  const poolIds = new Set(state.pool.map(p => p.id));
  const historyIds = new Set(state.history.slice(-200).map(h => h.songId));
  const candidates = sourceSongs.filter(s => !poolIds.has(s.id) && !historyIds.has(s.id));

  if (candidates.length === 0) return;

  const sessionInterest = state.session ? state.session.interest : { artists: {}, albums: {}, genres: {}, songs: {} };
  const scored = candidates.map(s => {
    const ltScore = getInterestScore(state.longTermInterest, s);
    const sessScore = getInterestScore(sessionInterest, s);
    const total = ltScore * 0.6 + sessScore * 0.4;
    return { song: s, score: total };
  });

  scored.sort((a, b) => b.score - a.score);

  const explorationCount = Math.max(1, Math.floor(count * EXPLORATION_RATIO));
  const interestCount = count - explorationCount;

  const interestPicks = scored.slice(0, Math.min(interestCount * 3, scored.length));
  const selected = shuffleArray(interestPicks).slice(0, interestCount);

  const remaining = scored.filter(s => !selected.includes(s));
  const explorationPicks = shuffleArray(remaining).slice(0, explorationCount);
  selected.push(...explorationPicks);

  for (const item of selected) {
    const s = item.song;
    const reason = buildReason(s, item.score);
    state.pool.push({
      id: s.id,
      title: s.title,
      artist: s.artist,
      album: s.album,
      genre: s.genre,
      duration: s.duration,
      cover_url: s.cover_url || s.source_cover_url || '',
      url: s.url || '',
      file_path: s.file_path || '',
      reason,
      addedAt: Date.now()
    });
  }

  if (state.pool.length > POOL_SIZE * 1.5) {
    state.pool = state.pool.slice(0, POOL_SIZE);
  }
  await savePool();
}

function buildReason(song, score) {
  const sessionInterest = state.session ? state.session.interest : null;
  const lt = state.longTermInterest;

  if (score <= 0) return '随机探索，发现新音乐';

  const artist = (song.artist || '').toLowerCase();
  const genre = (song.genre || '').toLowerCase();

  if (sessionInterest && sessionInterest.artists[artist] && sessionInterest.artists[artist] > 3) {
    return '本次探索中你喜欢 ' + song.artist;
  }
  if (lt.artists[artist] && lt.artists[artist] > 10) {
    return '因为你常听 ' + song.artist;
  }
  if (sessionInterest && sessionInterest.genres[genre] && sessionInterest.genres[genre] > 3) {
    return '本次探索中你偏好' + (song.genre || '这类风格');
  }
  if (lt.genres[genre] && lt.genres[genre] > 8) {
    return '因为你喜欢' + (song.genre || '这类风格');
  }
  if (lt.albums[(song.album || '').toLowerCase()] && lt.albums[(song.album || '').toLowerCase()] > 5) {
    return '来自你喜欢的专辑《' + song.album + '》';
  }
  return '根据你的听歌偏好推荐';
}

/* ─── Session ─── */
function createSession() {
  return {
    id: 'session_' + Date.now(),
    startTime: Date.now(),
    endTime: null,
    active: true,
    interest: { artists: {}, albums: {}, genres: {}, songs: {} },
    behaviors: [],
    playedCount: 0,
    likedCount: 0,
    dislikedCount: 0,
    completeCount: 0,
    skipCount: 0,
    quickSkipCount: 0,
    favoriteCount: 0
  };
}

/* ─── Behavior Processing ─── */
const BEHAVIOR_WEIGHTS = {
  favorite: 10,
  like: 6,
  dislike: -12,
  undislike: 4,
  complete: 5,
  play80: 3,
  skip: -2,
  quickSkip: -10,
  prev: -1,
  next: -1,
  repeat: 8,
  search: 20
};

async function processBehavior(behavior) {
  const { type, songId, song, position, duration } = behavior;
  const weight = BEHAVIOR_WEIGHTS[type] || 0;

  if (!song && songId) {
    const lib = await getLibrary();
    const found = lib.find(s => s.id === songId);
    if (found) behavior.song = found;
  }

  const targetSong = behavior.song;
  if (!targetSong) return;

  if (state.session && state.session.active) {
    state.session.behaviors.push({
      type,
      songId: targetSong.id,
      time: Date.now(),
      position: position || 0,
      duration: duration || targetSong.duration || 0
    });
    updateInterest(state.session.interest, targetSong, weight);

    if (type === 'like') state.session.likedCount++;
    if (type === 'dislike') state.session.dislikedCount++;
    if (type === 'complete') { state.session.completeCount++; state.session.playedCount++; }
    if (type === 'next') { state.session.skipCount++; state.session.playedCount++; }
    if (type === 'quickSkip') state.session.quickSkipCount++;
    if (type === 'favorite') state.session.favoriteCount++;
    await saveSession();
  }

  updateInterest(state.longTermInterest, targetSong, weight * 0.3);

  if (type === 'dislike') {
    state.pool = state.pool.filter(p => p.id !== targetSong.id);
    await savePool();
    await refillPool(1);
  }

  state.history.push({
    songId: targetSong.id,
    type,
    time: Date.now()
  });
  await saveHistory();

  if (state.history.length % 20 === 0) {
    decayInterest(state.longTermInterest, 0.98);
    await saveLongTermInterest();
  }
}

/* ─── API Routes ─── */
const router = createRouter();

router.get('/api/sources', async () => {
  try {
    const sources = await getAvailableSources();
    return jsonResponse({ sources });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/config', async (req) => {
  try {
    const body = parseBody(req);
    state.config = body;
    await saveConfig();

    if (body.source) {
      const lib = await getLibrary();
      let sourceSongs = lib;
      if (body.source.type === 'playlist' && body.source.id) {
        const plSongs = await songloft.playlists.getSongs(body.source.id, { limit: 100000, offset: 0 });
        sourceSongs = plSongs.items || plSongs.songs || plSongs || [];
      } else {
        sourceSongs = filterBySource(lib, body);
      }
      state.pool = [];
      await initPool(sourceSongs);
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/config', async () => {
  return jsonResponse({ config: state.config, hasPool: state.pool.length > 0 });
});

router.post('/api/session/start', async () => {
  try {
    if (state.session && state.session.active) {
      return jsonResponse({ session: state.session });
    }
    state.session = createSession();
    await saveSession();

    if (state.pool.length < QUEUE_BATCH) {
      const lib = await getLibrary();
      const sourceSongs = filterBySource(lib, state.config);
      await refillPool(POOL_SIZE - state.pool.length, sourceSongs);
    }

    return jsonResponse({ session: state.session });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/session/end', async () => {
  try {
    if (state.session) {
      state.session.active = false;
      state.session.endTime = Date.now();
      await saveSession();

      decayInterest(state.longTermInterest, 0.995);
      await saveLongTermInterest();
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/session', async () => {
  return jsonResponse({ session: state.session });
});

router.get('/api/pool/next', async (req) => {
  try {
    const query = parseQuery(req.query);
    const count = parseInt(query.count) || QUEUE_BATCH;
    const batch = state.pool.slice(0, count);

    if (state.pool.length < POOL_SIZE * 0.5) {
      const lib = await getLibrary();
      const sourceSongs = filterBySource(lib, state.config);
      await refillPool(POOL_SIZE - state.pool.length, sourceSongs);
    }

    return jsonResponse({ songs: batch, poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/pool/consume', async (req) => {
  try {
    const body = parseBody(req);
    const songId = body.songId;
    if (songId) {
      state.pool = state.pool.filter(p => p.id !== songId);
      await savePool();
      await refillPool(1);
    }
    return jsonResponse({ poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/behavior', async (req) => {
  try {
    const body = parseBody(req);
    await processBehavior(body);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/favorite', async (req) => {
  try {
    const body = parseBody(req);
    const { songId, action } = body;
    const hostUrl = await songloft.plugin.getHostUrl();
    const token = await songloft.plugin.getToken();
    const headers = { 'Authorization': 'Bearer ' + token };

    if (action === 'add') {
      const res = await fetch(hostUrl + '/rest/star?id=' + encodeURIComponent(songId) + '&v=1.16.1&c=MusicFeed&f=json', {
        method: 'POST', headers
      });
      songloft.log.info('Star response: ' + res.status);
      await processBehavior({ type: 'favorite', songId });
      return jsonResponse({ ok: true, favorited: true });
    } else {
      const res = await fetch(hostUrl + '/rest/unstar?id=' + encodeURIComponent(songId) + '&v=1.16.1&c=MusicFeed&f=json', {
        method: 'POST', headers
      });
      songloft.log.info('Unstar response: ' + res.status);
      return jsonResponse({ ok: true, favorited: false });
    }
  } catch (e) {
    songloft.log.error('Favorite error: ' + e.message);
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/favorites', async () => {
  try {
    const hostUrl = await songloft.plugin.getHostUrl();
    const token = await songloft.plugin.getToken();
    const res = await fetch(hostUrl + '/rest/getStarred?v=1.16.1&c=MusicFeed&f=json', {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!res.ok) return jsonResponse({ ids: [] });
    const data = await res.json();
    const starred = data['subsonic-response'] && data['subsonic-response'].starred;
    const songs = (starred && starred.song) || [];
    const ids = songs.map(s => s.id);
    return jsonResponse({ ids });
  } catch (e) {
    songloft.log.error('Get favorites error: ' + e.message);
    return jsonResponse({ ids: [] });
  }
});

router.get('/api/stats', async () => {
  const session = state.session;
  /* 从 history 计算历次统计 */
  const hist = state.history;
  const allTime = { played: 0, liked: 0, disliked: 0, complete: 0, skip: 0, quickSkip: 0, favorite: 0 };
  for (const h of hist) {
    if (h.type === 'next' || h.type === 'complete') allTime.played++;
    if (h.type === 'like') allTime.liked++;
    if (h.type === 'dislike') allTime.disliked++;
    if (h.type === 'complete') allTime.complete++;
    if (h.type === 'next') allTime.skip++;
    if (h.type === 'quickSkip') allTime.quickSkip++;
    if (h.type === 'favorite') allTime.favorite++;
  }
  return jsonResponse({
    poolSize: state.pool.length,
    historyCount: hist.length,
    session: session ? {
      active: session.active,
      playedCount: session.playedCount || 0,
      likedCount: session.likedCount || 0,
      dislikedCount: session.dislikedCount || 0,
      completeCount: session.completeCount || 0,
      skipCount: session.skipCount || 0,
      quickSkipCount: session.quickSkipCount || 0,
      favoriteCount: session.favoriteCount || 0,
      duration: session.endTime ? session.endTime - session.startTime : Date.now() - session.startTime
    } : null,
    allTime: allTime,
    topArtists: Object.entries(state.longTermInterest.artists).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0]),
    topGenres: Object.entries(state.longTermInterest.genres).sort((a, b) => b[1] - a[1]).slice(0, 5).map(e => e[0])
  });
});

router.post('/api/pool/shuffle', async () => {
  try {
    state.pool = shuffleArray(state.pool);
    await savePool();
    return jsonResponse({ ok: true, songs: state.pool.slice(0, QUEUE_BATCH) });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

/* ─── Lifecycle ─── */
globalThis.onInit = async () => {
  songloft.log.info('抖歌 1.0.5 initializing...');
  await loadState();
  songloft.log.info('抖歌 initialized. Pool: ' + state.pool.length + ', History: ' + state.history.length);
};

globalThis.onDeinit = async () => {
  if (state.session && state.session.active) {
    state.session.active = false;
    state.session.endTime = Date.now();
    await saveSession();
  }
  songloft.log.info('抖歌 deactivated');
};

globalThis.onHTTPRequest = async (req) => {
  return router.handle(req);
};
