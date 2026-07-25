/**
 * 抖歌 - Songloft 沉浸式音乐发现插件
 *
 * 设计原则：
 * 1. 仅在 Discovery Session 中学习用户行为。
 * 2. 长期偏好、当前 Session 偏好和宿主收藏分层保存，互不覆盖。
 * 3. 推荐池是插件自己的候选池；/api/pool/next 会一次性取出队列批次，避免重复消费。
 * 4. Songloft storage 只保存字符串，所有复杂状态都显式 JSON 序列化。
 */

/* ─── Router ─── */
function createRouter() {
  const routes = [];
  return {
    get(path, handler) { routes.push({ method: 'GET', path, handler }); },
    post(path, handler) { routes.push({ method: 'POST', path, handler }); },
    handle(req) {
      for (const route of routes) {
        if (route.method === req.method && route.path === req.path) return route.handler(req);
      }
      return jsonResponse({ error: 'Not Found' }, 404);
    }
  };
}

function jsonResponse(data, status) {
  return {
    statusCode: status || 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  };
}

function parseBody(req) {
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

function parseQuery(qs) {
  const params = {};
  if (!qs) return params;
  const text = qs.startsWith('?') ? qs.slice(1) : qs;
  for (const pair of text.split('&')) {
    const index = pair.indexOf('=');
    const rawKey = index >= 0 ? pair.slice(0, index) : pair;
    const rawValue = index >= 0 ? pair.slice(index + 1) : '';
    if (rawKey) params[decodeURIComponent(rawKey)] = decodeURIComponent(rawValue);
  }
  return params;
}

/* ─── Constants ─── */
const PROFILE_VERSION = 4;
const POOL_SIZE = 100;
const QUEUE_BATCH = 20;
const HISTORY_LIMIT = 1000;
const LIBRARY_TTL = 5 * 60 * 1000;
const FAVORITE_TTL = 2 * 60 * 1000;
const FAVORITE_PLAYLIST_ID = 1;
const RADIO_FAVORITE_PLAYLIST_ID = 2;
const FAVORITE_SCORE_BOOST = 10;
const LIKED_SCORE_BOOST = 16;
const RECENT_PLAY_PENALTY = 28;
const RECENT_QUEUE_PENALTY = 32;
const RECENT_FAVORITE_QUEUE_PENALTY = 44;
const RECENT_PLAY_WINDOW = 80;
const RECENT_QUEUE_LIMIT = 160;
const QUEUE_COOLDOWN_WINDOW = 60;
const FAVORITE_QUEUE_COOLDOWN_WINDOW = 100;
const BATCH_FAVORITE_RATIO = 0.2;

function createDefaultConfig() {
  return {
    version: 2,
    source: { type: 'library', label: '本地所有音频' },
    scope: {
      includeTypes: ['local'],
      excludeTypes: ['remote', 'radio'],
      excludePaths: []
    }
  };
}

const STORAGE_KEYS = {
  config: 'config',
  profile: 'longTermInterest',
  pool: 'pool',
  session: 'activeSession',
  history: 'history',
  favorites: 'favoriteCache'
};

const BEHAVIOR_WEIGHTS = {
  start: 0,
  favorite: 12,
  unfavorite: -12,
  like: 7,
  unlike: -7,
  dislike: -14,
  undislike: 7,
  complete: 5,
  play80: 3,
  skip: -2,
  quickSkip: -10,
  prev: -1,
  next: -1,
  repeat: 8,
  search: 20
};

/* ─── Runtime state ─── */
let libraryCache = null;
let libraryCacheTime = 0;
let state = {
  config: null,
  longTermInterest: createPreferenceModel(),
  pool: [],
  session: null,
  history: [],
  processedEventIds: new Set(),
  hostFavorites: new Set(),
  favoriteSyncedAt: 0,
  favoriteSyncFailed: false
};

/* ─── Storage ─── */
function createPreferenceModel() {
  return {
    version: PROFILE_VERSION,
    artists: {},
    albums: {},
    genres: {},
    years: {},
    decades: {},
    languages: {},
    styles: {},
    types: {},
    formats: {},
    durationBuckets: {},
    folders: {},
    songs: {},
    evidence: 0,
    updatedAt: 0
  };
}

const MODEL_DIMENSIONS = [
  'artists',
  'albums',
  'genres',
  'years',
  'decades',
  'languages',
  'styles',
  'types',
  'formats',
  'durationBuckets',
  'folders',
  'songs'
];

function createFeatureEntry() {
  return {
    score: 0,
    positive: 0,
    negative: 0,
    count: 0,
    lastAction: '',
    lastUpdated: 0,
    liked: false,
    disliked: false
  };
}

function numericEntry(value) {
  const entry = createFeatureEntry();
  entry.score = Number(value) || 0;
  entry.lastUpdated = Date.now();
  return entry;
}

function normalizeModel(raw) {
  const model = createPreferenceModel();
  if (!raw || typeof raw !== 'object') return model;

  for (const dimension of MODEL_DIMENSIONS) {
    const source = raw[dimension] && typeof raw[dimension] === 'object' ? raw[dimension] : {};
    for (const key of Object.keys(source)) {
      const value = source[key];
      model[dimension][String(key)] = typeof value === 'number'
        ? numericEntry(value)
        : Object.assign(createFeatureEntry(), value || {}, {
          score: Number(value && value.score) || 0,
          positive: Number(value && value.positive) || 0,
          negative: Number(value && value.negative) || 0,
          count: Number(value && value.count) || 0,
          lastUpdated: Number(value && value.lastUpdated) || Date.now()
        });
    }
  }
  model.version = PROFILE_VERSION;
  model.evidence = Number(raw.evidence) || 0;
  model.updatedAt = Number(raw.updatedAt) || 0;
  return model;
}

function parseStored(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function storageGet(key, fallback) {
  try {
    return parseStored(await songloft.storage.get(key), fallback);
  } catch (e) {
    songloft.log.warn('Storage read failed: ' + key + ' - ' + e.message);
    return fallback;
  }
}

async function storageSet(key, value) {
  await songloft.storage.set(key, JSON.stringify(value));
}

async function loadState() {
  const storedConfig = await storageGet(STORAGE_KEYS.config, null);
  state.config = storedConfig ? normalizeConfig(storedConfig) : null;
  const storedProfile = await storageGet(STORAGE_KEYS.profile, null);
  const needsPoolRefresh = !storedProfile || Number(storedProfile.version) !== PROFILE_VERSION;
  state.longTermInterest = normalizeModel(storedProfile);
  state.pool = normalizePool(await storageGet(STORAGE_KEYS.pool, []));
  state.pool = state.pool.filter(isRecommendableSong);
  if (needsPoolRefresh) state.pool = [];
  state.history = await storageGet(STORAGE_KEYS.history, []);
  if (!Array.isArray(state.history)) state.history = [];
  state.processedEventIds = new Set(state.history.map(item => item.eventId).filter(Boolean));

  const cachedFavorites = await storageGet(STORAGE_KEYS.favorites, null);
  if (cachedFavorites && Array.isArray(cachedFavorites.ids)) {
    state.hostFavorites = new Set(cachedFavorites.ids.map(normalizeId));
    state.favoriteSyncedAt = Number(cachedFavorites.syncedAt) || 0;
  }

  const savedSession = await storageGet(STORAGE_KEYS.session, null);
  if (savedSession && savedSession.active) state.session = normalizeSession(savedSession);
}

async function saveConfig() { await storageSet(STORAGE_KEYS.config, state.config); }
async function saveProfile() { await storageSet(STORAGE_KEYS.profile, state.longTermInterest); }
async function savePool() { await storageSet(STORAGE_KEYS.pool, state.pool); }
async function saveSession() { await storageSet(STORAGE_KEYS.session, state.session); }
async function saveFavoritesCache() {
  await storageSet(STORAGE_KEYS.favorites, {
    ids: Array.from(state.hostFavorites),
    syncedAt: state.favoriteSyncedAt
  });
}
async function saveHistory() {
  if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
  await storageSet(STORAGE_KEYS.history, state.history);
}

/* ─── Normalization ─── */
function normalizeId(value) {
  return value === null || value === undefined ? '' : String(value);
}

function keyOf(value) {
  return String(value || '').trim().toLowerCase();
}

function songId(song) { return normalizeId(song && song.id); }

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function normalizeConfig(raw) {
  const base = createDefaultConfig();
  if (!raw || typeof raw !== 'object') return base;
  const source = raw.source && typeof raw.source === 'object' ? Object.assign({}, base.source, raw.source) : base.source;
  const rawScope = raw.scope && typeof raw.scope === 'object' ? raw.scope : {};
  const hasExplicitScope = Array.isArray(rawScope.includeTypes) || Array.isArray(rawScope.excludeTypes) || Array.isArray(rawScope.excludePaths);
  const scope = {
    includeTypes: Array.from(new Set((Array.isArray(rawScope.includeTypes) && rawScope.includeTypes.length
      ? rawScope.includeTypes : base.scope.includeTypes).map(value => String(value)))),
    excludeTypes: Array.from(new Set((Array.isArray(rawScope.excludeTypes)
      ? rawScope.excludeTypes : (hasExplicitScope ? [] : base.scope.excludeTypes)).map(value => String(value)))),
    excludePaths: Array.from(new Set((Array.isArray(rawScope.excludePaths) ? rawScope.excludePaths : [])
      .map(normalizePath).filter(Boolean)))
  };

  // 迁移 1.1.0 以前的 source.type=all 配置：默认范围改为本地音频。
  if (source.type === 'all') {
    source.type = 'library';
    source.label = '本地所有音频';
  }
  return { version: 2, source, scope };
}

function effectiveConfig(config) {
  return normalizeConfig(config || createDefaultConfig());
}

function normalizeSong(song) {
  const inferredType = song && song.type
    ? String(song.type)
    : (song && (song.is_live || song.live) ? 'radio' : (song && song.url && !song.file_path ? 'remote' : 'local'));
  return {
    id: songId(song),
    type: inferredType,
    title: song && song.title || '',
    artist: song && song.artist || '',
    album: song && song.album || '',
    genre: song && song.genre || '',
    year: Number(song && (song.year || song.release_year || song.releaseYear)) || 0,
    language: song && (song.language || song.lang) || '',
    style: song && (song.style || song.mood) || '',
    duration: Number(song && song.duration) || 0,
    format: song && song.format || '',
    bit_rate: Number(song && (song.bit_rate || song.bitRate)) || 0,
    sample_rate: Number(song && (song.sample_rate || song.sampleRate)) || 0,
    is_video: Boolean(song && (song.is_video || song.isVideo)),
    plugin_entry_path: song && (song.plugin_entry_path || song.pluginEntryPath) || '',
    cover_url: song && (song.cover_url || song.source_cover_url) || '',
    source_cover_url: song && song.source_cover_url || '',
    url: song && song.url || '',
    file_path: song && song.file_path || ''
  };
}

function normalizePool(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(Boolean).map(item => Object.assign(normalizeSong(item), {
    reason: item.reason || '',
    recommendation: item.recommendation && typeof item.recommendation === 'object'
      ? item.recommendation
      : {
        reason: item.reason || '为你探索本地音乐库',
        algorithm: '规则推荐 · 长期兴趣与本次兴趣混合',
        factors: []
      },
    score: Number(item.score) || 0,
    isFavorite: Boolean(item.isFavorite),
    addedAt: Number(item.addedAt) || Date.now()
  }));
}

function normalizeSession(raw) {
  const session = Object.assign(createSession(), raw || {});
  session.interest = normalizeModel(raw && raw.interest);
  session.behaviors = Array.isArray(session.behaviors) ? session.behaviors : [];
  session.seenIds = Array.isArray(session.seenIds) ? session.seenIds.map(normalizeId) : [];
  session.recentQueueIds = Array.isArray(session.recentQueueIds) ? session.recentQueueIds.map(normalizeId).filter(Boolean) : [];
  return session;
}

/* ─── Library and sources ─── */
async function getLibrary() {
  const now = Date.now();
  if (libraryCache && now - libraryCacheTime < LIBRARY_TTL) return libraryCache;
  const result = await songloft.songs.list({ limit: 100000, offset: 0 });
  const songs = result && (result.items || result.songs || result) || [];
  libraryCache = Array.isArray(songs) ? songs.map(normalizeSong) : [];
  libraryCacheTime = now;
  songloft.log.info('Library loaded: ' + libraryCache.length + ' songs');
  return libraryCache;
}

function filterBySource(songs, config) {
  const normalized = effectiveConfig(config);
  const source = normalized.source;
  let filtered = songs;
  if (source && source.type === 'favorites') filtered = filtered.filter(song => state.hostFavorites.has(song.id));
  if (source.type === 'playlist') {
    const ids = new Set((source.songIds || []).map(normalizeId));
    filtered = filtered.filter(song => ids.has(song.id));
  }
  const value = keyOf(source.value);
  if (source.type === 'artist') filtered = filtered.filter(song => keyOf(song.artist).includes(value));
  if (source.type === 'album') filtered = filtered.filter(song => keyOf(song.album).includes(value));
  if (source.type === 'genre') filtered = filtered.filter(song => keyOf(song.genre).includes(value));
  if (source.type === 'folder') filtered = filtered.filter(song => normalizePath(song.file_path).includes(normalizePath(source.value)));

  const scope = normalized.scope;
  const includeTypes = new Set(scope.includeTypes || []);
  const excludeTypes = new Set(scope.excludeTypes || []);
  const excludePaths = (scope.excludePaths || []).map(normalizePath).filter(Boolean);
  return filtered.filter(song => {
    const type = String(song.type || 'local');
    if (includeTypes.size && !includeTypes.has(type)) return false;
    if (excludeTypes.has(type)) return false;
    const path = normalizePath(song.file_path);
    return !excludePaths.some(excluded => path === excluded || path.startsWith(excluded + '/') || path.includes(excluded));
  });
}

async function getSourceSongs(config) {
  const library = await getLibrary();
  const source = config && config.source;
  if (source && source.type === 'playlist' && source.id) {
    const result = await songloft.playlists.getSongs(source.id, { limit: 100000, offset: 0 });
    const songs = result && (result.items || result.songs || result) || [];
    // 歌单接口已经完成了来源筛选，这里只应用本地/远程类别和排除目录规则。
    const scopeOnlyConfig = Object.assign({}, config || {}, {
      source: { type: 'library', label: '歌单范围' }
    });
    return Array.isArray(songs) ? filterBySource(songs.map(normalizeSong), scopeOnlyConfig) : [];
  }
  return filterBySource(library, config);
}

async function getAvailableSources() {
  const songs = await getLibrary();
  const config = effectiveConfig(state.config);
  const localSongs = songs.filter(song => song.type === 'local');
  const sources = [
    { type: 'library', label: '本地所有音频', count: localSongs.length },
    { type: 'favorites', label: '用户收藏', count: songs.filter(song => state.hostFavorites.has(song.id)).length }
  ];

  const playlistsResult = await songloft.playlists.list();
  const playlists = playlistsResult && (playlistsResult.items || playlistsResult.playlists || playlistsResult) || [];
  for (const playlist of (Array.isArray(playlists) ? playlists : [])) {
    sources.push({
      type: 'playlist',
      label: playlist.name || playlist.title || ('歌单 ' + playlist.id),
      id: playlist.id,
      count: playlist.song_count || playlist.songCount || 0
    });
  }

  const artists = {}, genres = {}, folders = {};
  for (const song of songs) {
    if (song.artist) artists[song.artist] = (artists[song.artist] || 0) + 1;
    if (song.genre) genres[song.genre] = (genres[song.genre] || 0) + 1;
    if (song.file_path) {
      const parts = song.file_path.replace(/\\/g, '/').split('/');
      if (parts.length >= 2) folders[parts.slice(0, Math.min(3, parts.length - 1)).join('/')] =
        (folders[parts.slice(0, Math.min(3, parts.length - 1)).join('/')] || 0) + 1;
    }
  }
  for (const pair of Object.entries(artists).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    sources.push({ type: 'artist', label: pair[0], value: pair[0], count: pair[1] });
  }
  for (const pair of Object.entries(genres).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    sources.push({ type: 'genre', label: pair[0], value: pair[0], count: pair[1] });
  }
  for (const pair of Object.entries(folders).sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    sources.push({ type: 'folder', label: pair[0], value: pair[0], count: pair[1] });
  }
  const folderOptions = Object.entries(folders)
    .sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
    .map(pair => ({ path: normalizePath(pair[0]), label: pair[0], count: pair[1] }));
  const typeCounts = {};
  for (const song of songs) typeCounts[song.type] = (typeCounts[song.type] || 0) + 1;
  return {
    sources,
    config,
    total: songs.length,
    typeCounts,
    folderOptions
  };
}

/* ─── Preference model ─── */
function getEntry(model, dimension, key) {
  if (!key) return null;
  if (!model[dimension][key]) model[dimension][key] = createFeatureEntry();
  return model[dimension][key];
}

function featureScore(entry, now) {
  if (!entry) return 0;
  const ageDays = entry.lastUpdated ? Math.max(0, (now - entry.lastUpdated) / 86400000) : 0;
  const decay = Math.pow(0.992, Math.min(ageDays, 365));
  return (Number(entry.score) || 0) * decay;
}

function boundedFeatureScore(entry, now, scale) {
  if (!entry) return 0;
  const raw = featureScore(entry, now);
  const magnitude = Math.abs(raw);
  if (!magnitude) return 0;
  const count = Math.max(0, Number(entry.count) || 0);
  const confidence = count > 0 ? 0.45 + 0.55 * (1 - Math.exp(-count / 4)) : 0.45;
  return (raw / (magnitude + scale)) * confidence;
}

function splitFeatureValues(value) {
  return Array.from(new Set(String(value || '')
    .split(/[,，;；/|·]+/)
    .map(keyOf)
    .filter(Boolean)));
}

function decadeOf(year) {
  const numeric = Number(year) || 0;
  if (numeric < 1000 || numeric > 3000) return '';
  return String(Math.floor(numeric / 10) * 10) + '年代';
}

function durationBucket(duration) {
  const seconds = Number(duration) || 0;
  if (!seconds) return '';
  if (seconds < 120) return '2分钟以内';
  if (seconds < 240) return '2-4分钟';
  if (seconds < 360) return '4-6分钟';
  return '6分钟以上';
}

function folderBucket(filePath) {
  const path = normalizePath(filePath);
  if (!path) return '';
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 1) return '';
  return parts.slice(Math.max(0, parts.length - 3), -1).join('/');
}

function songFeatures(song) {
  const year = Number(song && song.year) || 0;
  const typeValues = [];
  if (song && song.type) typeValues.push(keyOf(song.type));
  if (song && song.is_video) typeValues.push('video');
  return {
    artists: splitFeatureValues(song && song.artist),
    albums: splitFeatureValues(song && song.album),
    genres: splitFeatureValues(song && song.genre),
    years: year ? [String(year)] : [],
    decades: decadeOf(year) ? [decadeOf(year)] : [],
    languages: splitFeatureValues(song && song.language),
    styles: splitFeatureValues(song && song.style),
    types: Array.from(new Set(typeValues.filter(Boolean))),
    formats: splitFeatureValues(song && song.format),
    durationBuckets: durationBucket(song && song.duration) ? [durationBucket(song.duration)] : [],
    folders: folderBucket(song && song.file_path) ? [folderBucket(song.file_path)] : [],
    songs: song && song.id ? [song.id] : []
  };
}

const DIMENSION_SCORE_WEIGHTS = {
  artists: 18,
  albums: 7,
  genres: 12,
  years: 3,
  decades: 7,
  languages: 8,
  styles: 10,
  types: 2,
  formats: 2,
  durationBuckets: 3,
  folders: 3,
  songs: 15
};

const DIMENSION_UPDATE_WEIGHTS = {
  artists: 1,
  albums: 0.6,
  genres: 0.65,
  years: 0.25,
  decades: 0.45,
  languages: 0.5,
  styles: 0.65,
  types: 0.12,
  formats: 0.12,
  durationBuckets: 0.2,
  folders: 0.2,
  songs: 0.8
};

function modelScoreDetails(model, song) {
  const details = {};
  if (!model || !song) return { total: 0, dimensions: details };
  const now = Date.now();
  const features = songFeatures(song);
  let total = 0;
  for (const dimension of MODEL_DIMENSIONS) {
    const values = features[dimension] || [];
    if (!values.length) continue;
    const rawScores = values.map(value =>
      boundedFeatureScore(model[dimension] && model[dimension][value], now, dimension === 'artists' ? 4 : 3));
    const average = rawScores.reduce((sum, value) => sum + value, 0) / rawScores.length;
    const contribution = average * (DIMENSION_SCORE_WEIGHTS[dimension] || 0);
    details[dimension] = contribution;
    total += contribution;
  }
  return { total, dimensions: details };
}

function modelScore(model, song) {
  return modelScoreDetails(model, song).total;
}

function updateFeature(model, dimension, key, weight, type, now) {
  const entry = getEntry(model, dimension, key);
  if (!entry) return;
  entry.score += weight;
  entry.count += 1;
  entry.lastAction = type;
  entry.lastUpdated = now;
  if (weight >= 0) entry.positive += Math.abs(weight);
  else entry.negative += Math.abs(weight);
}

function updateModel(model, song, weight, type) {
  if (!model || !song) return;
  if (!weight && type === 'start') return;
  const now = Date.now();
  const features = songFeatures(song);
  for (const dimension of MODEL_DIMENSIONS) {
    const values = features[dimension] || [];
    if (!values.length) continue;
    const dimensionWeight = weight * (DIMENSION_UPDATE_WEIGHTS[dimension] || 0);
    const perValueWeight = dimensionWeight / Math.sqrt(values.length);
    for (const value of values) updateFeature(model, dimension, value, perValueWeight, type, now);
  }

  const songEntry = getEntry(model, 'songs', song.id);
  if (songEntry) {
    if (type === 'like') { songEntry.liked = true; songEntry.disliked = false; }
    if (type === 'unlike') songEntry.liked = false;
    if (type === 'dislike') { songEntry.disliked = true; songEntry.liked = false; }
    if (type === 'undislike') songEntry.disliked = false;
  }
  model.evidence = (Number(model.evidence) || 0) + 1;
  model.updatedAt = now;
}

function isExplicitlyDisliked(song) {
  const entry = state.longTermInterest.songs[normalizeId(song && song.id)];
  return Boolean(entry && entry.disliked && !entry.liked);
}

function isRecommendableSong(song) {
  return Boolean(song && song.id && !isExplicitlyDisliked(song));
}

function getSessionWeight() {
  if (!state.session || !state.session.active) return 0;
  const evidence = Number(state.session.interest.evidence) || 0;
  if (!evidence) return 0;
  const base = Math.min(0.58, 0.22 + Math.log1p(evidence) * 0.1);
  return Math.min(0.68, base + sessionDriftBoost());
}

function sessionDriftBoost() {
  if (!state.session || !state.session.interest || state.session.interest.evidence < 4) return 0;
  const dimensions = ['artists', 'genres', 'languages', 'styles', 'decades'];
  let compared = 0;
  let disagreements = 0;
  for (const dimension of dimensions) {
    const entries = Object.entries(state.session.interest[dimension] || {})
      .filter(pair => Math.abs(featureScore(pair[1], Date.now())) > 0)
      .sort((a, b) => Math.abs(featureScore(b[1], Date.now())) - Math.abs(featureScore(a[1], Date.now())))
      .slice(0, 3);
    for (const pair of entries) {
      compared++;
      const sessionSignal = featureScore(pair[1], Date.now());
      const longSignal = featureScore(state.longTermInterest[dimension][pair[0]], Date.now());
      if ((sessionSignal > 0 && longSignal <= 0) || (sessionSignal < 0 && longSignal > 0)) disagreements++;
    }
  }
  return compared && disagreements / compared >= 0.5 ? 0.1 : 0;
}

function playbackEvents(history) {
  const list = Array.isArray(history) ? history : [];
  const firstStart = list.find(item => item && item.type === 'start');
  const firstStartTime = firstStart ? Number(firstStart.time) || 0 : Infinity;
  const seen = new Set();
  const events = [];
  for (const item of list) {
    if (!item) continue;
    const isNewStart = item.type === 'start';
    const isLegacyPlay = Number(item.time) < firstStartTime && (item.type === 'next' || item.type === 'complete');
    if (!isNewStart && !isLegacyPlay) continue;
    const key = item.playbackId || item.eventId || (item.songId + ':' + item.time + ':' + item.type);
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(item);
  }
  return events;
}

function getRecentCount(id) {
  let count = 0;
  for (const item of playbackEvents(state.history).slice(-RECENT_PLAY_WINDOW)) {
    if (normalizeId(item.songId) === id) count++;
  }
  return count;
}

function recentQueueDistance(id) {
  const targetId = normalizeId(id);
  const queueIds = state.session && Array.isArray(state.session.recentQueueIds)
    ? state.session.recentQueueIds
    : [];
  for (let i = queueIds.length - 1; i >= 0; i--) {
    if (normalizeId(queueIds[i]) === targetId) return queueIds.length - 1 - i;
  }
  return Infinity;
}

function getRecentQueuePenalty(id) {
  const distance = recentQueueDistance(id);
  if (!Number.isFinite(distance)) return 0;
  const isFavorite = state.hostFavorites.has(normalizeId(id));
  const windowSize = isFavorite ? FAVORITE_QUEUE_COOLDOWN_WINDOW : QUEUE_COOLDOWN_WINDOW;
  if (distance >= windowSize) return 0;
  const basePenalty = isFavorite ? RECENT_FAVORITE_QUEUE_PENALTY : RECENT_QUEUE_PENALTY;
  return Math.round(basePenalty * (1 - distance / windowSize));
}

function getExplorationRatio() {
  const longEvidence = Number(state.longTermInterest.evidence) || 0;
  if (longEvidence < 10) return 0.35;
  if (sessionDriftBoost() > 0) return 0.25;
  if (longEvidence < 60) return 0.22;
  return 0.15;
}

function stableJitter(id) {
  const seed = String(id) + ':' + String(state.session && state.session.id || 'history');
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000 * 1.2;
}

function scoreCandidate(song) {
  const sessionWeight = getSessionWeight();
  const longDetails = modelScoreDetails(state.longTermInterest, song);
  const sessionDetails = state.session ? modelScoreDetails(state.session.interest, song) : { total: 0, dimensions: {} };
  const longScore = longDetails.total;
  const sessionScore = sessionDetails.total;
  const preferenceScore = longScore * (1 - sessionWeight) + sessionScore * sessionWeight;
  const songEntry = state.longTermInterest.songs[song.id];
  const favoriteBoost = state.hostFavorites.has(song.id) ? FAVORITE_SCORE_BOOST : 0;
  const likedBoost = songEntry && songEntry.liked ? LIKED_SCORE_BOOST : 0;
  const recentPenalty = getRecentCount(song.id) * RECENT_PLAY_PENALTY;
  const recentQueuePenalty = getRecentQueuePenalty(song.id);
  const dislikePenalty = isExplicitlyDisliked(song) ? 120 : 0;
  const featureContributions = {};
  for (const dimension of MODEL_DIMENSIONS) {
    featureContributions[dimension] =
      (Number(longDetails.dimensions[dimension]) || 0) * (1 - sessionWeight) +
      (Number(sessionDetails.dimensions[dimension]) || 0) * sessionWeight;
  }
  return {
    score: preferenceScore + favoriteBoost + likedBoost - recentPenalty - recentQueuePenalty - dislikePenalty + stableJitter(song.id),
    longScore,
    sessionScore,
    sessionWeight,
    favoriteBoost,
    likedBoost,
    recentPenalty,
    recentQueuePenalty,
    dislikePenalty,
    featureContributions
  };
}

function buildRecommendation(song, detail, mode) {
  const session = state.session && state.session.interest;
  const artist = keyOf(song.artist);
  const genre = keyOf(song.genre);
  const album = keyOf(song.album);
  const features = songFeatures(song);
  const factors = [];
  let reason = '';
  if (mode === 'explore') {
    reason = '探索推荐，用于发现不同于既有偏好的音乐';
    factors.push('探索新鲜度');
  } else if (state.hostFavorites.has(song.id)) {
    reason = '这首歌已被你收藏';
    factors.push('用户收藏');
  } else if (session && boundedFeatureScore(session.artists[artist], Date.now(), 4) > 0.18) {
    reason = '本次播放中，你对 ' + (song.artist || '该歌手') + ' 的反馈更积极';
    factors.push('本次歌手偏好');
  } else if (session && boundedFeatureScore(session.genres[genre], Date.now(), 3) > 0.18) {
    reason = '本次播放中，你更偏好 ' + (song.genre || '这类音乐');
    factors.push('本次类别偏好');
  } else if (session && features.styles.some(value => boundedFeatureScore(session.styles[value], Date.now(), 3) > 0.18)) {
    reason = '本次播放中，你对 ' + (song.style || '相近风格') + ' 的反馈更积极';
    factors.push('本次风格偏好');
  } else if (session && features.languages.some(value => boundedFeatureScore(session.languages[value], Date.now(), 3) > 0.18)) {
    reason = '本次播放中，你更偏好 ' + (song.language || '相近语种') + ' 歌曲';
    factors.push('本次语种偏好');
  } else if (boundedFeatureScore(state.longTermInterest.artists[artist], Date.now(), 4) > 0.18) {
    reason = '历史记录显示你经常对 ' + (song.artist || '该歌手') + ' 给出积极反馈';
    factors.push('长期歌手偏好');
  } else if (boundedFeatureScore(state.longTermInterest.genres[genre], Date.now(), 3) > 0.18) {
    reason = '历史记录显示你更偏好 ' + (song.genre || '这类音乐');
    factors.push('长期类别偏好');
  } else if (features.styles.some(value => boundedFeatureScore(state.longTermInterest.styles[value], Date.now(), 3) > 0.18)) {
    reason = '这首歌符合你长期偏好的 ' + (song.style || '音乐风格');
    factors.push('长期风格偏好');
  } else if (features.languages.some(value => boundedFeatureScore(state.longTermInterest.languages[value], Date.now(), 3) > 0.18)) {
    reason = '这首歌的语种与你的长期听歌偏好相近';
    factors.push('长期语种偏好');
  } else if (features.decades.some(value => boundedFeatureScore(state.longTermInterest.decades[value], Date.now(), 3) > 0.18)) {
    reason = '这首歌来自你过去反馈较好的年代';
    factors.push('年代偏好');
  } else if (boundedFeatureScore(state.longTermInterest.albums[album], Date.now(), 3) > 0.18) {
    reason = '来自你过去反馈较好的专辑《' + song.album + '》';
    factors.push('长期专辑偏好');
  } else {
    reason = '结合本地音乐库与近期播放记录选出';
    factors.push('兴趣匹配');
  }
  const factorLabels = {
    artists: '歌手匹配',
    albums: '专辑匹配',
    genres: '流派匹配',
    years: '年份匹配',
    decades: '年代匹配',
    languages: '语种匹配',
    styles: '风格匹配',
    types: '类型匹配',
    formats: '格式偏好',
    durationBuckets: '时长偏好',
    folders: '目录倾向'
  };
  Object.entries(detail.featureContributions || {})
    .filter(pair => pair[0] !== 'songs' && pair[1] > 0.8)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .forEach(pair => {
      const label = factorLabels[pair[0]];
      if (label && !factors.includes(label)) factors.push(label);
    });
  if (detail.likedBoost) factors.push('已喜欢');
  if (detail.recentPenalty || detail.recentQueuePenalty) factors.push('近期重复抑制');
  const sessionPercent = Math.round(detail.sessionWeight * 100);
  const longPercent = 100 - sessionPercent;
  return {
    reason,
    factors: factors.slice(0, 5),
    mode,
    algorithm: '混合规则推荐：长期兴趣 ' + longPercent + '% + 本次兴趣 ' + sessionPercent +
      '%；探索比例 ' + Math.round(getExplorationRatio() * 100) +
      '%；综合歌手、专辑、流派、年代、语种、风格、类型、格式、时长和目录，并应用时间衰减、近期去重与多样性约束'
  };
}

/* ─── Host favorites ───
 * Songloft 的收藏由两个内置歌单表示：普通歌曲为 1，电台为 2。
 * 这里复用歌曲库 Plus 已验证的 playlists SDK 路径，不再绕过宿主调用 Subsonic REST。
 */
function unwrapSongList(result) {
  const songs = result && (result.items || result.songs || result) || [];
  return Array.isArray(songs) ? songs : [];
}

async function readFavoritePlaylist(playlistId) {
  try {
    const result = await songloft.playlists.getSongs(playlistId, { limit: 100000, offset: 0 });
    return { ok: true, songs: unwrapSongList(result) };
  } catch (error) {
    return { ok: false, songs: [], error: error && error.message ? error.message : String(error) };
  }
}

async function syncHostFavorites(force) {
  if (!force && state.favoriteSyncedAt && Date.now() - state.favoriteSyncedAt < FAVORITE_TTL) {
    return { ok: !state.favoriteSyncFailed, stale: state.favoriteSyncFailed, ids: Array.from(state.hostFavorites) };
  }
  try {
    const results = await Promise.all([
      readFavoritePlaylist(FAVORITE_PLAYLIST_ID),
      readFavoritePlaylist(RADIO_FAVORITE_PLAYLIST_ID)
    ]);
    if (!results.some(item => item.ok)) {
      throw new Error(results.map(item => item.error).filter(Boolean).join('；') || '无法读取宿主收藏歌单');
    }
    const ids = [];
    for (const result of results) {
      for (const song of result.songs) {
        const id = normalizeId(song && song.id);
        if (id) ids.push(id);
      }
    }
    state.hostFavorites = new Set(ids);
    state.favoriteSyncedAt = Date.now();
    state.favoriteSyncFailed = results.some(item => !item.ok);
    await saveFavoritesCache();
    return {
      ok: true,
      stale: state.favoriteSyncFailed,
      ids: Array.from(state.hostFavorites),
      warning: results.filter(item => !item.ok).map(item => item.error).join('；')
    };
  } catch (e) {
    state.favoriteSyncFailed = true;
    songloft.log.warn('Favorite sync failed: ' + e.message);
    return { ok: false, stale: true, ids: Array.from(state.hostFavorites), error: e.message };
  }
}

async function updateHostFavorite(song, action) {
  const id = Number(song && song.id);
  if (!id) throw new Error('歌曲 ID 无效，无法同步收藏');
  const playlistId = song && song.type === 'radio'
    ? RADIO_FAVORITE_PLAYLIST_ID
    : FAVORITE_PLAYLIST_ID;
  if (action === 'add') return songloft.playlists.addSongs(playlistId, [id]);
  return songloft.playlists.removeSongs(playlistId, [id]);
}

/* ─── Pool ─── */
function shuffleArray(array) {
  const copy = array.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
  }
  return copy;
}

function poolItem(song, detail, mode) {
  const item = normalizeSong(song);
  item.score = Number(detail && detail.score) || 0;
  item.isFavorite = state.hostFavorites.has(item.id);
  item.recommendation = buildRecommendation(item, detail || scoreCandidate(item), mode || 'interest');
  item.reason = item.recommendation.reason;
  item.addedAt = Date.now();
  return item;
}

function favoriteCapForBatch(count) {
  return Math.max(1, Math.floor(Math.max(1, count) * BATCH_FAVORITE_RATIO));
}

function markQueuedSongs(songs) {
  if (!state.session || !state.session.active || !Array.isArray(songs) || !songs.length) return false;
  if (!Array.isArray(state.session.recentQueueIds)) state.session.recentQueueIds = [];
  const queueIds = state.session.recentQueueIds.map(normalizeId).filter(Boolean);
  for (const song of songs) {
    const id = normalizeId(song && song.id);
    if (!id) continue;
    const existingIndex = queueIds.indexOf(id);
    if (existingIndex >= 0) queueIds.splice(existingIndex, 1);
    queueIds.push(id);
  }
  state.session.recentQueueIds = queueIds.slice(-RECENT_QUEUE_LIMIT);
  return true;
}

function pickBatchFromPool(requested) {
  state.pool = state.pool.filter(isRecommendableSong);
  const selected = [];
  const selectedIndices = new Set();
  const favoriteCap = favoriteCapForBatch(requested);
  let favoriteCount = 0;

  for (let i = 0; i < state.pool.length && selected.length < requested; i++) {
    const item = state.pool[i];
    if (!item) continue;
    const isFavorite = state.hostFavorites.has(normalizeId(item.id)) || Boolean(item.isFavorite);
    if (isFavorite && favoriteCount >= favoriteCap) continue;
    selected.push(item);
    selectedIndices.add(i);
    if (isFavorite) favoriteCount++;
  }

  for (let i = 0; i < state.pool.length && selected.length < requested; i++) {
    if (selectedIndices.has(i)) continue;
    selected.push(state.pool[i]);
    selectedIndices.add(i);
  }

  state.pool = state.pool.filter((_, index) => !selectedIndices.has(index));
  return selected;
}

function selectDiverse(ranked, count) {
  if (count <= 0) return [];
  const selected = [];
  const counts = { artist: {}, genre: {}, language: {}, decade: {} };
  const caps = {
    artist: Math.max(2, Math.ceil(count * 0.25)),
    genre: Math.max(3, Math.ceil(count * 0.45)),
    language: Math.max(4, Math.ceil(count * 0.65)),
    decade: Math.max(3, Math.ceil(count * 0.55))
  };
  for (const item of ranked) {
    const song = item.song || item;
    const features = songFeatures(song);
    const keys = {
      artist: features.artists[0] || '',
      genre: features.genres[0] || '',
      language: features.languages[0] || '',
      decade: features.decades[0] || ''
    };
    if (Object.keys(keys).some(dimension =>
      keys[dimension] && (counts[dimension][keys[dimension]] || 0) >= caps[dimension])) continue;
    selected.push(item);
    for (const dimension of Object.keys(keys)) {
      const key = keys[dimension];
      if (key) counts[dimension][key] = (counts[dimension][key] || 0) + 1;
    }
    if (selected.length >= count) break;
  }
  if (selected.length < count) {
    const selectedIds = new Set(selected.map(item => normalizeId((item.song || item).id)));
    for (const item of ranked) {
      if (selectedIds.has(normalizeId((item.song || item).id))) continue;
      selected.push(item);
      if (selected.length >= count) break;
    }
  }
  return selected;
}

async function refillPool(count, sourceSongs) {
  if (count <= 0) return;
  if (!sourceSongs) sourceSongs = await getSourceSongs(state.config);
  const inPool = new Set(state.pool.map(item => item.id));
  const candidates = sourceSongs.filter(song => isRecommendableSong(song) && !inPool.has(song.id));
  if (candidates.length === 0) return;

  const ranked = candidates.map(song => ({ song, detail: scoreCandidate(song) }));
  ranked.sort((a, b) => b.detail.score - a.detail.score);
  const explorationCount = ranked.length > 2 ? Math.max(1, Math.floor(count * getExplorationRatio())) : 0;
  const interestCount = Math.max(0, Math.min(count, count - explorationCount));
  const selected = selectDiverse(ranked, interestCount).map(item => Object.assign({ mode: 'interest' }, item));

  const selectedIds = new Set(selected.map(item => item.song.id));
  const exploration = ranked.filter(item => !selectedIds.has(item.song.id));
  for (const item of shuffleArray(exploration).slice(0, explorationCount)) {
    selected.push(Object.assign({ mode: 'explore' }, item));
  }
  const ordered = shuffleArray(selected);

  for (const item of ordered) state.pool.push(poolItem(item.song, item.detail, item.mode));
  if (state.pool.length > POOL_SIZE) state.pool = state.pool.slice(0, POOL_SIZE);
  await savePool();
}

async function initPool(sourceSongs) {
  state.pool = [];
  await refillPool(POOL_SIZE, sourceSongs);
  songloft.log.info('Pool initialized with ' + state.pool.length + ' songs');
}

async function checkoutPool(count) {
  const requested = Math.max(1, Math.min(QUEUE_BATCH, count || QUEUE_BATCH));
  state.pool = state.pool.filter(isRecommendableSong);
  if (state.pool.length < requested) await refillPool(POOL_SIZE - state.pool.length);
  const batch = pickBatchFromPool(requested);
  const queueMarked = markQueuedSongs(batch);
  await savePool();
  if (queueMarked) await saveSession();
  if (state.pool.length < Math.floor(POOL_SIZE * 0.5)) await refillPool(POOL_SIZE - state.pool.length);
  return batch;
}

async function releaseSongs(songs) {
  if (!Array.isArray(songs) || !songs.length) return;
  const existing = new Set(state.pool.map(item => item.id));
  for (const raw of songs) {
    const item = normalizeSong(raw);
    if (!isRecommendableSong(item)) continue;
    if (item.id && !existing.has(item.id)) {
      state.pool.push(poolItem(item, scoreCandidate(item), 'interest'));
      existing.add(item.id);
    }
  }
  if (state.pool.length > POOL_SIZE) state.pool = state.pool.slice(0, POOL_SIZE);
  await savePool();
}

async function rerankPool() {
  if (!state.pool.length) return;
  const interest = [];
  const exploration = [];
  for (const raw of state.pool) {
    const song = normalizeSong(raw);
    if (!isRecommendableSong(song)) continue;
    const detail = scoreCandidate(song);
    const mode = raw && raw.recommendation && raw.recommendation.mode === 'explore' ? 'explore' : 'interest';
    const item = poolItem(song, detail, mode);
    if (mode === 'explore') exploration.push(item);
    else interest.push(item);
  }
  interest.sort((a, b) => b.score - a.score);
  exploration.sort((a, b) => stableJitter(a.id) - stableJitter(b.id));
  const diverseInterest = selectDiverse(interest, interest.length);
  const next = [];
  const gap = Math.max(3, Math.round(1 / getExplorationRatio()));
  while (diverseInterest.length || exploration.length) {
    const shouldExplore = exploration.length && (next.length + 1) % gap === 0;
    if (shouldExplore || !diverseInterest.length) next.push(exploration.shift());
    else next.push(diverseInterest.shift());
  }
  state.pool = next.slice(0, POOL_SIZE);
  await savePool();
}

/* ─── Session and behavior ─── */
function createSession() {
  return {
    id: 'session_' + Date.now(),
    startTime: Date.now(),
    endTime: null,
    active: true,
    interest: createPreferenceModel(),
    behaviors: [],
    seenIds: [],
    recentQueueIds: [],
    playedCount: 0,
    likedCount: 0,
    dislikedCount: 0,
    completeCount: 0,
    skipCount: 0,
    quickSkipCount: 0,
    favoriteCount: 0
  };
}

function isDuplicateBehavior(eventId) {
  return Boolean(eventId && state.processedEventIds.has(String(eventId)));
}

async function processBehavior(input) {
  const behavior = Object.assign({}, input || {});
  const type = String(behavior.type || '');
  const eventId = behavior.eventId ? String(behavior.eventId) : '';
  if (!type) return;
  if (!state.session || !state.session.active) return;
  if (isDuplicateBehavior(eventId)) return;

  const rawSong = behavior.song || null;
  const requestedId = normalizeId(behavior.songId || (rawSong && rawSong.id));
  const library = await getLibrary();
  const librarySong = library.find(song => song.id === requestedId) || null;
  let targetSong = librarySong || (rawSong ? normalizeSong(rawSong) : null);
  if (!targetSong) return;

  if (eventId) state.processedEventIds.add(eventId);
  const weight = Number(BEHAVIOR_WEIGHTS[type]) || 0;
  const event = {
    eventId: eventId || ('legacy_' + Date.now() + '_' + Math.random()),
    playbackId: behavior.playbackId ? String(behavior.playbackId) : '',
    type,
    songId: targetSong.id,
    title: targetSong.title,
    artist: targetSong.artist,
    album: targetSong.album,
    genre: targetSong.genre,
    year: targetSong.year,
    language: targetSong.language,
    style: targetSong.style,
    songType: targetSong.type,
    format: targetSong.format,
    time: Date.now(),
    position: Number(behavior.position) || 0,
    duration: Number(behavior.duration) || targetSong.duration || 0
  };

  state.session.behaviors.push(event);
  if (state.session.behaviors.length > 300) state.session.behaviors = state.session.behaviors.slice(-300);
  if (weight) {
    updateModel(state.session.interest, targetSong, weight, type);
  }
  if (!state.session.seenIds.includes(targetSong.id)) state.session.seenIds.push(targetSong.id);
  if (type === 'start') state.session.playedCount++;
  if (type === 'like') state.session.likedCount++;
  if (type === 'dislike') state.session.dislikedCount++;
  if (type === 'complete') state.session.completeCount++;
  if (type === 'next') state.session.skipCount++;
  if (type === 'quickSkip') state.session.quickSkipCount++;
  if (type === 'favorite') state.session.favoriteCount++;
  await saveSession();

  if (weight) updateModel(state.longTermInterest, targetSong, weight * 0.3, type);
  state.history.push(event);
  await saveHistory();
  if (weight) await saveProfile();

  if (type === 'dislike') {
    state.pool = state.pool.filter(item => item.id !== targetSong.id && !isExplicitlyDisliked(item));
    await refillPool(1);
  }
  if (weight) await rerankPool();
}

function preferenceIds() {
  const liked = [], disliked = [];
  for (const pair of Object.entries(state.longTermInterest.songs)) {
    const entry = pair[1];
    if (entry && entry.liked) liked.push(pair[0]);
    if (entry && entry.disliked && !entry.liked) disliked.push(pair[0]);
  }
  return { liked, disliked };
}

async function resetPreferenceData() {
  const keepSessionActive = Boolean(state.session && state.session.active);
  state.longTermInterest = createPreferenceModel();
  state.history = [];
  state.processedEventIds = new Set();
  state.session = keepSessionActive ? createSession() : null;
  await saveProfile();
  await saveHistory();
  await saveSession();
  await initPool(await getSourceSongs(state.config));
  return {
    preferences: preferenceIds(),
    session: state.session,
    poolSize: state.pool.length
  };
}

/* ─── API routes ─── */
const router = createRouter();

router.get('/api/sources', async () => {
  try {
    await syncHostFavorites(false);
    return jsonResponse(await getAvailableSources());
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/config', async () => jsonResponse({ config: state.config, hasPool: state.pool.length > 0 }));

router.post('/api/config', async req => {
  try {
    const body = parseBody(req);
    const nextConfig = normalizeConfig(body.config || { source: body.source, scope: body.scope });
    const oldKey = JSON.stringify(state.config || null);
    const newKey = JSON.stringify(nextConfig);
    state.config = nextConfig;
    await saveConfig();
    if (oldKey !== newKey || !state.pool.length) await initPool(await getSourceSongs(state.config));
    return jsonResponse({ ok: true, config: state.config, poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/session/start', async () => {
  try {
    await syncHostFavorites(true);
    if (!state.config) {
      state.config = createDefaultConfig();
      await saveConfig();
      await initPool(await getSourceSongs(state.config));
    }
    if (!state.session || !state.session.active) {
      state.session = createSession();
      await saveSession();
    }
    if (state.pool.length < QUEUE_BATCH) await refillPool(POOL_SIZE - state.pool.length);
    return jsonResponse({ session: state.session, preferences: preferenceIds(), favoriteSync: {
      ok: !state.favoriteSyncFailed,
      stale: state.favoriteSyncFailed,
      ids: Array.from(state.hostFavorites)
    } });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/session/end', async req => {
  try {
    const body = parseBody(req);
    if (Array.isArray(body.remainingSongs)) await releaseSongs(body.remainingSongs);
    if (state.session) {
      state.session.active = false;
      state.session.endTime = Date.now();
      await saveSession();
    }
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/session', async () => jsonResponse({ session: state.session }));

router.get('/api/preferences', async () => jsonResponse(preferenceIds()));

router.post('/api/preferences/reset', async () => {
  try {
    const result = await resetPreferenceData();
    return jsonResponse(Object.assign({ ok: true }, result));
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.get('/api/favorites', async () => {
  const result = await syncHostFavorites(true);
  return jsonResponse({
    ids: result.ids,
    stale: result.stale,
    syncedAt: state.favoriteSyncedAt,
    warning: result.ok ? (result.warning || '') : (result.error || '收藏状态暂时使用本地缓存')
  });
});

router.post('/api/favorite', async req => {
  try {
    const body = parseBody(req);
    const id = normalizeId(body.songId);
    if (!id || (body.action !== 'add' && body.action !== 'remove')) return jsonResponse({ error: 'Invalid favorite request' }, 400);
    let song = body.song ? normalizeSong(body.song) : null;
    if (!song || !song.id) {
      const library = await getLibrary();
      song = library.find(item => item.id === id) || null;
    }
    if (!song) throw new Error('歌曲不存在，无法同步收藏');
    await updateHostFavorite(song, body.action);
    if (body.action === 'add') state.hostFavorites.add(id);
    else state.hostFavorites.delete(id);
    state.favoriteSyncedAt = Date.now();
    state.favoriteSyncFailed = false;
    await saveFavoritesCache();
    await processBehavior({
      type: body.action === 'add' ? 'favorite' : 'unfavorite',
      eventId: 'favorite:' + id + ':' + Date.now(),
      songId: id,
      song: body.song || null
    });
    return jsonResponse({ ok: true, favorited: body.action === 'add', ids: Array.from(state.hostFavorites) });
  } catch (e) {
    songloft.log.error('Favorite error: ' + e.message);
    return jsonResponse({ error: e.message }, 502);
  }
});

router.get('/api/pool/next', async req => {
  try {
    const count = parseInt(parseQuery(req.query).count, 10) || QUEUE_BATCH;
    const songs = await checkoutPool(count);
    return jsonResponse({ songs, poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

/* Backward-compatible endpoint for old clients. New clients use atomic /api/pool/next. */
router.post('/api/pool/consume', async req => {
  const body = parseBody(req);
  if (body.songId) state.pool = state.pool.filter(item => item.id !== normalizeId(body.songId));
  await savePool();
  return jsonResponse({ poolSize: state.pool.length });
});

router.post('/api/pool/release', async req => {
  try {
    const body = parseBody(req);
    await releaseSongs(body.songs || []);
    return jsonResponse({ ok: true, poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/pool/shuffle', async () => {
  try {
    state.pool = shuffleArray(state.pool);
    const songs = await checkoutPool(QUEUE_BATCH);
    return jsonResponse({ ok: true, songs, poolSize: state.pool.length });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

router.post('/api/behavior', async req => {
  try {
    await processBehavior(parseBody(req));
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
});

function topPlaybackDimensions(events, songMap, field, limit) {
  const counts = {};
  const labels = {};
  for (const event of events) {
    const song = songMap.get(normalizeId(event.songId));
    const raw = event[field] || (song && song[field]) || '';
    const key = keyOf(raw);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
    if (!labels[key]) labels[key] = String(raw).trim();
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || labels[a[0]].localeCompare(labels[b[0]], 'zh-CN'))
    .slice(0, limit)
    .map(pair => ({ name: labels[pair[0]], count: pair[1] }));
}

router.get('/api/stats', async () => {
  const allTime = { played: 0, liked: 0, disliked: 0, complete: 0, skip: 0, quickSkip: 0, favorite: 0 };
  const plays = playbackEvents(state.history);
  allTime.played = plays.length;
  for (const item of state.history) {
    if (item.type === 'like') allTime.liked++;
    if (item.type === 'dislike') allTime.disliked++;
    if (item.type === 'complete') allTime.complete++;
    if (item.type === 'next') allTime.skip++;
    if (item.type === 'quickSkip') allTime.quickSkip++;
    if (item.type === 'favorite') allTime.favorite++;
  }
  const library = await getLibrary();
  const songMap = new Map(library.map(song => [song.id, song]));
  return jsonResponse({
    poolSize: state.pool.length,
    historyCount: state.history.length,
    favoriteSync: { stale: state.favoriteSyncFailed, syncedAt: state.favoriteSyncedAt },
    session: state.session ? {
      active: state.session.active,
      playedCount: state.session.playedCount || 0,
      likedCount: state.session.likedCount || 0,
      dislikedCount: state.session.dislikedCount || 0,
      completeCount: state.session.completeCount || 0,
      skipCount: state.session.skipCount || 0,
      quickSkipCount: state.session.quickSkipCount || 0,
      favoriteCount: state.session.favoriteCount || 0,
      duration: state.session.endTime ? state.session.endTime - state.session.startTime : Date.now() - state.session.startTime
    } : null,
    allTime,
    historyStats: allTime,
    topArtists: topPlaybackDimensions(plays, songMap, 'artist', 5),
    topGenres: topPlaybackDimensions(plays, songMap, 'genre', 5)
  });
});

/* ─── Lifecycle ─── */
globalThis.onInit = async function () {
  songloft.log.info('抖歌 1.4.5 initializing...');
  await loadState();
  await syncHostFavorites(false);
  songloft.log.info('抖歌 initialized. Pool: ' + state.pool.length + ', History: ' + state.history.length);
};

globalThis.onDeinit = async function () {
  if (state.session && state.session.active) {
    state.session.active = false;
    state.session.endTime = Date.now();
    await saveSession();
  }
  await saveProfile();
  await savePool();
  songloft.log.info('抖歌 deactivated');
};

globalThis.onHTTPRequest = async function (req) {
  return router.handle(req);
};
