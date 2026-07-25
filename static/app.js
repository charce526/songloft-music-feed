/**
 * 抖歌 - Frontend
 * 沉浸式音乐发现：抖音式卡片堆叠滑动、播放控制、推荐展示
 */
/* global SongloftPlugin */
(function () {
'use strict';

/* ─── SDK Bridge ─── */
const hasSDK = typeof SongloftPlugin !== 'undefined' && SongloftPlugin !== null;
const DEFAULT_COVER_URL = 'static/default-cover.svg';

function token() {
  const q = new URLSearchParams(location.search).get('access_token');
  if (q) return q;
  try { if (hasSDK && SongloftPlugin.getAuthToken) return SongloftPlugin.getAuthToken() || ''; } catch (e) {}
  return '';
}

function serverBasePath() {
  const marker = '/api/v1/jsplugin/';
  const index = window.location.pathname.indexOf(marker);
  return index >= 0 ? window.location.pathname.slice(0, index) : '';
}

function pluginBasePath() {
  const marker = '/api/v1/jsplugin/';
  const index = window.location.pathname.indexOf(marker);
  if (index < 0) return '';
  const rest = window.location.pathname.slice(index + marker.length);
  const entry = rest.split('/')[0];
  return marker + entry;
}

function authUrl(raw) {
  if (!raw) return '';
  try {
    let resolved = raw;
    if (String(raw).startsWith('/')) {
      const base = serverBasePath();
      if (base && !String(raw).startsWith(base + '/')) resolved = base + raw;
    }
    const url = new URL(resolved, window.location.href);
    if (url.origin === window.location.origin) {
      const t = token();
      if (t && !url.searchParams.has('access_token')) url.searchParams.set('access_token', t);
    }
    return url.toString();
  } catch (e) { return raw; }
}

async function apiGet(path) {
  if (hasSDK && SongloftPlugin.apiGet) {
    const data = await SongloftPlugin.apiGet(path);
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  const base = pluginBasePath();
  const t = token();
  const headers = {};
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(base + path, { headers });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}

async function apiPost(path, body) {
  if (hasSDK && SongloftPlugin.apiPost) {
    const data = await SongloftPlugin.apiPost(path, body);
    if (data && data.error) throw new Error(data.error);
    return data;
  }
  const base = pluginBasePath();
  const t = token();
  const headers = { 'Content-Type': 'application/json' };
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || ('Request failed: ' + res.status));
  return data;
}

/* ─── Player Bridge ─── */
const PlayerBridge = {
  _busy: false,
  _queued: false,

  player() { return (hasSDK && SongloftPlugin.player) ? SongloftPlugin.player : null; },

  available() {
    if (!hasSDK) return false;
    const host = SongloftPlugin.host;
    if (host && typeof host.isAvailable === 'function') return Boolean(host.isAvailable());
    return Boolean(this.player());
  },

  async getState() {
    const p = this.player();
    if (!p) return null;
    try { return await p.getState(); } catch (e) { return null; }
  },

  async setQueue(ids, startIndex) {
    const p = this.player();
    if (!p || !p.setQueue) return;
    try {
      await p.setQueue(ids.map(playerId), { startIndex: Number.isFinite(startIndex) ? startIndex : 0 });
      return true;
    } catch (e) {
      console.warn('[MusicFeed] setQueue failed', e);
      return false;
    }
  },

  async play(id) {
    const p = this.player();
    if (!p) return false;
    try { if (id !== undefined && id !== null) await p.play(playerId(id)); else await p.play(); return true; } catch (e) { return false; }
  },

  async togglePlay() {
    const p = this.player();
    if (!p) return;
    if (this._busy) { this._queued = true; return; }
    this._busy = true;
    try { await p.togglePlay(); } catch (e) {}
    setTimeout(() => {
      this._busy = false;
      if (this._queued) { this._queued = false; this.togglePlay(); }
    }, 320);
  },

  async next() {
    const p = this.player();
    if (!p) return;
    try { await p.next(); } catch (e) {}
  },

  async prev() {
    const p = this.player();
    if (!p) return;
    try { await p.prev(); } catch (e) {}
  },

  async seek(seconds) {
    const p = this.player();
    if (!p) return false;
    const value = Math.max(0, Number(seconds) || 0);
    // Official client SDK contract: player.seek(seconds).
    // Keep legacy aliases only as a fallback for older hosts.
    const attempts = [
      ['seek', value],
      ['seekTo', value],
      ['setCurrentTime', value],
      ['setProgress', value]
    ];
    for (const [method, arg] of attempts) {
      if (typeof p[method] !== 'function') continue;
      try {
        await p[method](arg);
        return true;
      } catch (e) {
        console.warn('[MusicFeed] ' + method + ' failed', e);
      }
    }
    return false;
  },

  onState(cb) {
    const p = this.player();
    if (!p || !p.onStateChange) return () => {};
    return p.onStateChange(cb);
  }
};

function playerId(value) {
  const text = normalizeId(value);
  if (/^\d+$/.test(text)) return Number(text);
  return value;
}

/* ─── State ─── */
let currentQueue = [];
let currentIndex = -1;
let currentSong = null;
let isPlaying = false;
let position = 0;
let duration = 0;
let posAnchor = { pos: 0, t: 0, playing: false };
let sessionActive = false;
let favoriteIds = new Set();
let likedIds = new Set();
let dislikedIds = new Set();
let pollTimer = null;
let progressTimer = null;
let coverGeneration = 0;
let favPollTimer = null;
let behaviorSequence = 0;
let reportedMilestones = { songId: '', play80: false, complete: false, navigation: false };
let currentPlaybackId = '';
let pendingSwitch = null;
let switchSequence = 0;
let pendingSeekTarget = null;
let pendingSeekUntil = 0;
let statePollInFlight = false;

/* ─── DOM ─── */
const $ = (id) => document.getElementById(id);
const setupScreen = $('setup-screen');
const feedScreen = $('feed-screen');
const sourceList = $('source-list');
const bgImage = $('bg-image');
const coverImg = $('cover-img');
const coverPlaceholder = $('cover-placeholder');
const coverWrap = $('cover-wrap');
const songTitle = $('song-title');
const songArtist = $('song-artist');
const songAlbum = $('song-album');
const progressTime = $('progress-time');
const durationTime = $('duration-time');
const progressBar = $('progress-bar');
const progressSlider = document.querySelector('.progress-slider');
const progressFill = $('progress-fill');
const progressThumb = $('progress-thumb');
const cardBottomZone = document.querySelector('.card-bottom-zone');
const recommendationPopover = $('recommendation-popover');
const recommendationReason = $('recommendation-reason');
const recommendationAlgorithm = $('recommendation-algorithm');
const recommendationFactors = $('recommendation-factors');
const toast = $('toast');
const statsPanel = $('stats-panel');
const statsBody = $('stats-body');
const playIndicator = $('play-indicator');
const lyricPrev = $('lyric-prev');
const lyricCurrent = $('lyric-current');
const lyricNext = $('lyric-next');

/* Card stack elements */
const cardContainer = $('card-container');
const cardCurrent = $('card-current');
const cardPrev = $('card-prev');
const cardNext = $('card-next');
const prevCoverImg = $('prev-cover-img');
const prevTitle = $('prev-title');
const prevArtist = $('prev-artist');
const nextCoverImg = $('next-cover-img');
const nextTitle = $('next-title');
const nextArtist = $('next-artist');

document.addEventListener('dragstart', function (event) {
  if (event.target && event.target.closest && event.target.closest('.cover-wrap, .mini-cover, .setup-icon')) {
    event.preventDefault();
  }
});

/* ─── Theme ─── */
function applyTheme() {
  try {
    const theme = (hasSDK && SongloftPlugin.getTheme)
      ? SongloftPlugin.getTheme()
      : (new URLSearchParams(location.search).get('theme') || 'dark');
    document.body.setAttribute('data-theme', theme || 'dark');
  } catch (e) {}
}
if (hasSDK && SongloftPlugin.onThemeChange) SongloftPlugin.onThemeChange(applyTheme);
applyTheme();

/* ─── Toast ─── */
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

/* ─── Setup: Source Panel ─── */
const sourcePanel = $('source-panel');

async function loadSources() {
  try {
    const data = await apiGet('/api/sources');
    const configData = await apiGet('/api/config');
    const current = configData.config || { scope: { includeTypes: ['local'], excludeTypes: ['remote', 'radio'], excludePaths: [] } };
    const scope = current.scope || {};
    const excludedTypes = new Set(Array.isArray(scope.excludeTypes) ? scope.excludeTypes : ['remote', 'radio']);
    $('exclude-remote').checked = excludedTypes.has('remote');
    $('exclude-radio').checked = excludedTypes.has('radio');
    const selectedPaths = new Set((scope.excludePaths || []).map(normalizePath));
    const folders = data.folderOptions || [];
    const knownPaths = new Set(folders.map(folder => normalizePath(folder.path)));
    $('custom-exclude-folder').value = Array.from(selectedPaths).filter(path => !knownPaths.has(path)).join(', ');
    sourceList.innerHTML = '';
    if (!folders.length) {
      sourceList.innerHTML = '<p class="range-empty">未发现可排除的本地目录。</p>';
    } else {
      for (const folder of folders) {
        const label = document.createElement('label');
        label.className = 'range-check source-folder-item';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = folder.path;
        checkbox.checked = selectedPaths.has(normalizePath(folder.path));
        label.appendChild(checkbox);
        label.insertAdjacentHTML('beforeend', '<span class="range-check-text"><span>' + escHtml(folder.label) + '</span><small>' + (folder.count || 0) + ' 首</small></span>');
        sourceList.appendChild(label);
      }
    }
    updateRangeSummary(data);
  } catch (e) {
    sourceList.innerHTML = '<p style="text-align:center;color:#ff6b6b;padding:20px;">加载失败: ' + escHtml(e.message || '未知错误') + '</p>';
  }
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
}

function updateRangeSummary(data) {
  const localCount = data && data.typeCounts ? (data.typeCounts.local || 0) : 0;
  const selected = sourceList ? sourceList.querySelectorAll('input[type="checkbox"]:checked').length : 0;
  $('range-summary').textContent = '本地音频 ' + localCount + ' 首 · 已排除目录 ' + selected + ' 个';
}

async function saveRangeSettings() {
  const excludePaths = Array.from(sourceList.querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
  const custom = $('custom-exclude-folder').value.trim();
  if (custom) excludePaths.push(...custom.split(/[,\n]/).map(item => item.trim()).filter(Boolean));
  const config = {
    version: 2,
    source: { type: 'library', label: '本地所有音频' },
    scope: {
      includeTypes: ['local'],
      excludeTypes: [
        $('exclude-remote').checked ? 'remote' : '',
        $('exclude-radio').checked ? 'radio' : ''
      ].filter(Boolean),
      excludePaths: Array.from(new Set(excludePaths.map(normalizePath).filter(Boolean)))
    }
  };
  try {
    await apiPost('/api/config', { config });
    $('custom-exclude-folder').value = '';
    showToast('推荐范围已保存');
    sourcePanel.classList.add('hidden');
  } catch (e) {
    showToast('范围保存失败: ' + (e.message || ''));
    loadSources();
  }
}

$('btn-settings').addEventListener('click', function () {
  sourcePanel.classList.remove('hidden');
  loadSources();
});
$('btn-close-source').addEventListener('click', () => sourcePanel.classList.add('hidden'));
$('btn-save-source').addEventListener('click', saveRangeSettings);
sourceList.addEventListener('change', () => updateRangeSummary());
$('exclude-remote').addEventListener('change', () => updateRangeSummary());
$('exclude-radio').addEventListener('change', () => updateRangeSummary());
sourcePanel.querySelector('.stats-backdrop').addEventListener('click', () => sourcePanel.classList.add('hidden'));

$('btn-start').addEventListener('click', async function () {
  this.textContent = '正在准备...';
  this.disabled = true;
  try {
    const data = await apiGet('/api/config');
    if (!data.config) {
      await apiPost('/api/config', { config: {
        version: 2,
        source: { type: 'library', label: '本地所有音频' },
        scope: { includeTypes: ['local'], excludeTypes: ['remote', 'radio'], excludePaths: [] }
      } });
    }
    await startDiscovery();
  } catch (e) {
    showToast('启动失败: ' + (e.message || ''));
    this.textContent = '开始探索';
    this.disabled = false;
  }
});

/* ─── Discovery Session ─── */
async function startDiscovery() {
  try {
    const data = await apiPost('/api/session/start', {});
    if (data.preferences) applyPreferences(data.preferences);
    if (data.favoriteSync && Array.isArray(data.favoriteSync.ids)) {
      favoriteIds = new Set(data.favoriteSync.ids.map(normalizeId));
    }
    sessionActive = true;
    setupScreen.classList.add('hidden');
    feedScreen.classList.remove('hidden');
    const swipeHint = $('swipe-hint');
    swipeHint.classList.remove('hidden');
    setTimeout(() => swipeHint.classList.add('hidden'), 6000);
    await loadNextBatch();
    startProgressPoll();
    startPlayerStatePoll();
    startFavPoll();
  } catch (e) {
    showToast('启动探索失败');
  }
}

async function endDiscovery() {
  sessionActive = false;
  try {
    const remainingSongs = currentQueue.slice(Math.max(0, currentIndex + 1));
    await apiPost('/api/session/end', { remainingSongs });
  } catch (e) {}
  currentQueue = [];
  currentIndex = -1;
  currentSong = null;
  stopProgressPoll();
  stopPlayerStatePoll();
  stopFavPoll();
  feedScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  const startBtn = $('btn-start');
  startBtn.textContent = '开始探索';
  startBtn.disabled = false;
}

/* ─── Favorite Polling (host sync) ─── */
function startFavPoll() {
  stopFavPoll();
  favPollTimer = setInterval(() => {
    loadFavorites().then(() => updateFavoriteBtn());
  }, 8000);
}

function stopFavPoll() {
  if (favPollTimer) { clearInterval(favPollTimer); favPollTimer = null; }
}

/* ─── Queue Management ─── */
async function loadNextBatch() {
  try {
    const data = await apiGet('/api/pool/next?count=20');
    const songs = data.songs || [];
    if (songs.length === 0) {
      showToast('推荐池为空，正在补充...');
      setTimeout(loadNextBatch, 2000);
      return;
    }
    currentQueue = songs;
    await switchPlayerTo(0);
  } catch (e) {
    if (currentSong) setSongDetailsHidden(false);
    showToast('加载推荐失败');
  }
}

function showSong(index, options) {
  const opts = options || {};
  if (index < 0 || index >= currentQueue.length) return;
  const targetSong = currentQueue[index];
  const sameSong = Boolean(currentSong) &&
    currentIndex === index &&
    normalizeId(currentSong.id) === normalizeId(targetSong && targetSong.id);
  if (sameSong) {
    if (!opts.keepDetailsHidden) setSongDetailsHidden(false);
    if (!opts.deferAdjacent) updateAdjacentCards();
    return;
  }
  if (!opts.keepDetailsHidden) setSongDetailsHidden(false);
  const previousKey = currentSong ? currentIndex + ':' + normalizeId(currentSong.id) : '';
  const nextKey = index + ':' + normalizeId(targetSong && targetSong.id);
  const isNewPlayback = previousKey !== nextKey;
  currentIndex = index;
  currentSong = targetSong;
  if (!currentSong) return;

  songTitle.textContent = currentSong.title || '未知标题';
  songArtist.textContent = currentSong.artist || '未知歌手';
  songAlbum.textContent = currentSong.album || '';

  updateRecommendationInfo();

  duration = songDurationSeconds(currentSong);
  durationTime.textContent = formatTime(duration);
  position = 0;
  if (opts.assumePlaying) isPlaying = true;
  posAnchor = { pos: 0, t: performance.now(), playing: Boolean(opts.assumePlaying && duration > 0) };
  pendingSeekTarget = null;
  pendingSeekUntil = 0;
  progressBar.value = '0';
  renderProgressRatio(0);
  progressTime.textContent = '0:00';
  updatePlayPauseIcon();
  reportedMilestones = { songId: normalizeId(currentSong.id), play80: false, complete: false, navigation: false };
  if (isNewPlayback && sessionActive) {
    currentPlaybackId = 'play:' + Date.now() + ':' + (++behaviorSequence) + ':' + normalizeId(currentSong.id);
    reportBehavior('start', currentSong);
  }

  loadCover(currentSong, opts.previewUrl);
  loadLyrics(currentSong.id);
  if (!opts.deferAdjacent) updateAdjacentCards();
  refreshFavoriteState();

  /* 恢复喜欢按钮常亮状态 */
  const likeBtn = $('btn-like');
  if (likedIds.has(normalizeId(currentSong.id))) likeBtn.classList.add('liked');
  else likeBtn.classList.remove('liked');

  /* 恢复不喜欢按钮常亮状态 */
  const dislikeBtn = $('btn-dislike');
  if (dislikedIds.has(normalizeId(currentSong.id))) dislikeBtn.classList.add('disliked');
  else dislikeBtn.classList.remove('disliked');

}

function setSongDetailsHidden(hidden) {
  if (cardBottomZone) cardBottomZone.classList.toggle('switching', Boolean(hidden));
  if (hidden) {
    lyricLines = [];
    currentLyricIndex = -1;
    lyricPrev.textContent = '';
    lyricCurrent.textContent = '';
    lyricNext.textContent = '';
    progressTime.textContent = '0:00';
    progressBar.value = '0';
    renderProgressRatio(0);
  }
}

function updateRecommendationInfo() {
  const info = currentSong && currentSong.recommendation || {};
  recommendationReason.textContent = recommendationText(info.reason || currentSong && currentSong.reason || '从你的本地音乐库中选出');
  recommendationAlgorithm.textContent = recommendationText(info.algorithm || '规则推荐：结合长期兴趣、本次兴趣与随机探索');
  const factors = Array.isArray(info.factors) ? info.factors : [];
  recommendationFactors.innerHTML = factors.map(item => '<span>' + escHtml(recommendationText(item)) + '</span>').join('');
}

function recommendationText(value) {
  return String(value || '')
    .replace(/宿主收藏/g, '用户收藏')
    .replace(/Songloft 收藏/g, '用户收藏');
}

/* ─── Cover Loading (with race-condition guard) ─── */
function setDefaultCover(gen) {
  if (gen !== undefined && gen !== coverGeneration) return;
  const fallback = authUrl(DEFAULT_COVER_URL);
  coverImg.src = fallback;
  coverPlaceholder.classList.add('hidden');
  bgImage.style.backgroundImage = 'url(' + fallback + ')';
  bgImage.classList.add('loaded');
}

function loadCover(song, previewUrl) {
  const gen = ++coverGeneration;
  const candidates = [previewUrl, song.cover_url, song.source_cover_url];
  if (song.id) candidates.push('/api/v1/songs/' + song.id + '/cover');
  const urls = Array.from(new Set(candidates.filter(Boolean).map(authUrl)));

  coverImg.draggable = false;
  setDefaultCover(gen);

  if (urls.length === 0) {
    return;
  }

  let idx = 0;
  function tryNext() {
    if (gen !== coverGeneration) return;
    if (idx >= urls.length) {
      setDefaultCover(gen);
      return;
    }
    const url = urls[idx];
    const img = new Image();
    img.onload = function () {
      if (gen !== coverGeneration) return;
      coverImg.src = url;
      coverPlaceholder.classList.add('hidden');
      bgImage.style.backgroundImage = 'url(' + url + ')';
      bgImage.classList.add('loaded');
    };
    img.onerror = function () { idx++; tryNext(); };
    img.src = url;
  }
  tryNext();
}

/* ─── Adjacent Card Previews ─── */
function updateAdjacentCards() {
  const prevSong = currentIndex > 0 ? currentQueue[currentIndex - 1] : null;
  const nextSong = currentIndex < currentQueue.length - 1 ? currentQueue[currentIndex + 1] : null;

  if (prevSong) {
    prevTitle.textContent = prevSong.title || '未知标题';
    prevArtist.textContent = prevSong.artist || '';
    loadMiniCover(prevCoverImg, prevSong);
    cardPrev.style.display = '';
  } else {
    cardPrev.style.display = 'none';
  }

  if (nextSong) {
    nextTitle.textContent = nextSong.title || '未知标题';
    nextArtist.textContent = nextSong.artist || '';
    loadMiniCover(nextCoverImg, nextSong);
    cardNext.style.display = '';
  } else {
    cardNext.style.display = 'none';
  }
}

function loadMiniCover(imgEl, song) {
  const candidates = [song.cover_url, song.source_cover_url];
  if (song.id) candidates.push('/api/v1/songs/' + song.id + '/cover');
  const urls = candidates.filter(Boolean).map(authUrl);
  const fallback = authUrl(DEFAULT_COVER_URL);
  imgEl.draggable = false;
  imgEl.onerror = function () {
    imgEl.onerror = null;
    imgEl.src = fallback;
  };
  imgEl.src = urls.length > 0 ? urls[0] : fallback;
}

/* ─── Card Stack Positioning ─── */
const CARD_PEEK = 82;

function resetCardPositions(animate) {
  const dur = animate ? '0.32s cubic-bezier(0.22, 1, 0.36, 1)' : '0s';
  cardCurrent.style.transition = animate ? 'transform ' + dur : 'none';
  cardPrev.style.transition = animate ? 'transform ' + dur + ', opacity ' + dur : 'none';
  cardNext.style.transition = animate ? 'transform ' + dur + ', opacity ' + dur : 'none';

  cardCurrent.style.transform = 'translateY(0)';
  cardPrev.style.transform = 'translateY(-' + CARD_PEEK + '%)';
  cardNext.style.transform = 'translateY(' + CARD_PEEK + '%)';
  cardPrev.style.opacity = '0.85';
  cardNext.style.opacity = '0.85';
}

function beginPendingSwitch(song, index) {
  const request = {
    token: ++switchSequence,
    targetId: normalizeId(song && song.id),
    targetIndex: index,
    confirmed: false,
    viewCommitted: false,
    settleAfter: 0,
    expiresAt: Date.now() + 5000
  };
  pendingSwitch = request;
  return request;
}

function releasePendingSwitchWhenSettled(request) {
  const check = function () {
    if (!pendingSwitch || pendingSwitch.token !== request.token) return;
    const now = Date.now();
    if ((request.confirmed && now >= request.settleAfter) || now >= request.expiresAt) {
      pendingSwitch = null;
      return;
    }
    setTimeout(check, Math.min(500, Math.max(80, request.expiresAt - now)));
  };
  setTimeout(check, 900);
}

function markSwitchViewCommitted(request) {
  if (!pendingSwitch || pendingSwitch.token !== request.token) return;
  request.viewCommitted = true;
  request.settleAfter = Date.now() + 850;
  request.expiresAt = Date.now() + 2800;
  releasePendingSwitchWhenSettled(request);
}

async function switchPlayerTo(index, options) {
  const song = currentQueue[index];
  if (!song) return false;
  const queueIds = currentQueue.map(item => item.id);
  const request = beginPendingSwitch(song, index);
  const queueChanged = await PlayerBridge.setQueue(queueIds, index);
  if (PlayerBridge.available()) {
    if (!queueChanged) {
      const played = await PlayerBridge.play(song.id);
      if (!played) {
        if (pendingSwitch && pendingSwitch.token === request.token) pendingSwitch = null;
        showToast('播放器未能切换歌曲');
        return false;
      }
    }
  }
  if (!pendingSwitch || pendingSwitch.token !== request.token) return false;
  showSong(index, Object.assign({}, options, { assumePlaying: PlayerBridge.available() }));
  markSwitchViewCommitted(request);
  pollPlayerState();
  return true;
}

/* ─── Navigation ─── */
let animating = false;

function goNext(recordBehavior) {
  if (animating) return;
  if (recordBehavior && currentSong) {
    reportBehavior(playbackPosition() < 10 ? 'quickSkip' : 'next', currentSong);
  }
  if (currentSong) reportedMilestones.navigation = true;
  if (currentIndex < currentQueue.length - 1) {
    const targetIndex = currentIndex + 1;
    const targetPreviewUrl = nextCoverImg.currentSrc || nextCoverImg.src || '';
    animating = true;
    setSongDetailsHidden(true);
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardNext.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s ease';
    cardCurrent.style.transform = 'translateY(-' + CARD_PEEK + '%)';
    cardNext.style.transform = 'translateY(0)';
    cardNext.style.opacity = '1';
    setTimeout(async () => {
      let switched = false;
      try {
        switched = await switchPlayerTo(targetIndex, {
          deferAdjacent: true,
          keepDetailsHidden: true,
          previewUrl: targetPreviewUrl
        });
        if (!switched) setSongDetailsHidden(false);
      } catch (e) {
        setSongDetailsHidden(false);
        showToast('切换歌曲失败');
      } finally {
        // The B preview stays untouched while it is centered. Move the
        // already-updated current card into place first, then turn the
        // off-screen adjacent card into C. This prevents B → C → B flashes.
        resetCardPositions(false);
        if (switched) {
          updateAdjacentCards();
          setSongDetailsHidden(false);
        }
        animating = false;
      }
    }, 330);
  } else {
    animating = true;
    setSongDetailsHidden(true);
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardCurrent.style.transform = 'translateY(-' + CARD_PEEK + '%)';
    setTimeout(async () => {
      try {
        await loadNextBatch();
      } finally {
        resetCardPositions(false);
        animating = false;
      }
    }, 330);
  }
}

function goPrev() {
  if (animating) return;
  if (currentSong) {
    reportBehavior('prev', currentSong);
    reportedMilestones.navigation = true;
  }
  if (currentIndex > 0) {
    const targetIndex = currentIndex - 1;
    const targetPreviewUrl = prevCoverImg.currentSrc || prevCoverImg.src || '';
    animating = true;
    setSongDetailsHidden(true);
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardPrev.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s ease';
    cardCurrent.style.transform = 'translateY(' + CARD_PEEK + '%)';
    cardPrev.style.transform = 'translateY(0)';
    cardPrev.style.opacity = '1';
    setTimeout(async () => {
      let switched = false;
      try {
        switched = await switchPlayerTo(targetIndex, {
          deferAdjacent: true,
          keepDetailsHidden: true,
          previewUrl: targetPreviewUrl
        });
        if (!switched) setSongDetailsHidden(false);
      } catch (e) {
        setSongDetailsHidden(false);
        showToast('切换歌曲失败');
      } finally {
        resetCardPositions(false);
        if (switched) {
          updateAdjacentCards();
          setSongDetailsHidden(false);
        }
        animating = false;
      }
    }, 330);
  }
}

function removeQueuedSongAfterCurrent(id) {
  const targetId = normalizeId(id);
  if (!targetId) return;
  const nextQueue = currentQueue.filter((song, index) =>
    index <= currentIndex || normalizeId(song && song.id) !== targetId);
  if (nextQueue.length !== currentQueue.length) {
    currentQueue = nextQueue;
    updateAdjacentCards();
  }
}

/* ─── Touch / Swipe Gestures (TikTok-style drag-follow) ─── */
let touchStartY = 0, touchStartTime = 0, swiping = false, touchMoved = false;
let dragOffsetY = 0;
const SWIPE_THRESHOLD = 70;

function applyDrag(dy) {
  const containerH = cardContainer.offsetHeight || 1;
  const ratio = Math.min(Math.abs(dy) / containerH, 1);

  cardCurrent.style.transform = 'translateY(' + dy + 'px)';

  if (dy < 0) {
    cardNext.style.transform = 'translateY(calc(' + CARD_PEEK + '% + ' + dy + 'px))';
    cardNext.style.opacity = String(0.85 + ratio * 0.15);
    cardPrev.style.transform = 'translateY(-' + CARD_PEEK + '%)';
  } else {
    cardPrev.style.transform = 'translateY(calc(-' + CARD_PEEK + '% + ' + dy + 'px))';
    cardPrev.style.opacity = String(0.85 + ratio * 0.15);
    cardNext.style.transform = 'translateY(' + CARD_PEEK + '%)';
  }
}

cardContainer.addEventListener('touchstart', function (e) {
  if (animating) return;
  if (e.target.closest('.progress-wrap')) return;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
  swiping = true;
  touchMoved = false;
  dragOffsetY = 0;
  cardCurrent.style.transition = 'none';
  cardPrev.style.transition = 'none';
  cardNext.style.transition = 'none';
}, { passive: true });

cardContainer.addEventListener('touchmove', function (e) {
  if (!swiping) return;
  const dy = e.touches[0].clientY - touchStartY;
  if (Math.abs(dy) > 8) touchMoved = true;
  if (!touchMoved) return;
  dragOffsetY = dy;
  applyDrag(dy);
}, { passive: true });

cardContainer.addEventListener('touchend', function (e) {
  if (!swiping) return;
  swiping = false;
  const dy = dragOffsetY;
  const dt = Date.now() - touchStartTime;
  const velocity = Math.abs(dy) / dt;

  const shouldTrigger = Math.abs(dy) > SWIPE_THRESHOLD || (velocity > 0.4 && Math.abs(dy) > 30);

  if (shouldTrigger && touchMoved) {
    if (dy < 0) goNext(true);
    else goPrev();
  } else {
    resetCardPositions(true);
  }
}, { passive: true });

/* Mouse drag for desktop */
let mouseDown = false, mouseStartY = 0, mouseDragging = false;
cardContainer.addEventListener('mousedown', function (e) {
  if (animating) return;
  if (e.target.closest('.progress-wrap')) return;
  if (e.target.closest('button, input, textarea, select, a')) return;
  e.preventDefault();
  mouseDown = true; mouseStartY = e.clientY; mouseDragging = false;
  cardCurrent.style.transition = 'none';
  cardPrev.style.transition = 'none';
  cardNext.style.transition = 'none';
});
document.addEventListener('mousemove', function (e) {
  if (!mouseDown) return;
  const dy = e.clientY - mouseStartY;
  if (Math.abs(dy) > 5) mouseDragging = true;
  if (!mouseDragging) return;
  dragOffsetY = dy;
  applyDrag(dy);
});
document.addEventListener('mouseup', function (e) {
  if (!mouseDown) return;
  mouseDown = false;
  const dy = e.clientY - mouseStartY;
  if (mouseDragging && Math.abs(dy) > SWIPE_THRESHOLD) {
    if (dy < 0) goNext(true); else goPrev();
  } else {
    resetCardPositions(true);
  }
});

/* Keyboard shortcuts */
document.addEventListener('keydown', function (e) {
  if (feedScreen.classList.contains('hidden')) return;
  if (e.target && e.target.closest && e.target.closest('input, textarea, select, button')) return;
  switch (e.key) {
    case 'ArrowUp': goNext(true); break;
    case 'ArrowDown': goPrev(); break;
    case ' ': e.preventDefault(); PlayerBridge.togglePlay(); break;
  }
});

/* ─── Action Buttons ─── */
let favoriteBusy = false;
$('btn-favorite').addEventListener('click', async function () {
  if (!currentSong) return;
  if (favoriteBusy) return;
  favoriteBusy = true;
  this.disabled = true;
  const isFav = favoriteIds.has(normalizeId(currentSong.id));
  try {
    const data = await apiPost('/api/favorite', { songId: currentSong.id, action: isFav ? 'remove' : 'add', song: currentSong });
    if (Array.isArray(data.ids)) favoriteIds = new Set(data.ids.map(normalizeId));
    else if (data.favorited) favoriteIds.add(normalizeId(currentSong.id));
    else favoriteIds.delete(normalizeId(currentSong.id));
    if (data.favorited) showToast('已收藏 ♥');
    else showToast('已取消收藏');
    updateFavoriteBtn();
  } catch (e) { showToast('收藏失败：' + (e.message || '宿主未响应')); }
  finally {
    favoriteBusy = false;
    this.disabled = false;
  }
});

async function sendFeedbackChange(type, song) {
  return apiPost('/api/behavior', {
    type,
    songId: song.id,
    song: behaviorSongPayload(song),
    position,
    duration: duration || song.duration || 0,
    playbackId: currentPlaybackId,
    eventId: 'ui:' + Date.now() + ':' + (++behaviorSequence) + ':' + type + ':' + normalizeId(song.id)
  });
}

$('btn-like').addEventListener('click', async function () {
  if (!currentSong) return;
  const song = currentSong;
  const id = normalizeId(song.id);
  if (likedIds.has(id)) {
    likedIds.delete(id);
    markLikeBtn();
    showToast('已取消喜欢');
    sendFeedbackChange('unlike', song).catch(() => loadPreferences());
  } else {
    if (dislikedIds.has(id)) {
      dislikedIds.delete(id);
      markDislikeBtn();
    }
    likedIds.add(id);
    markLikeBtn();
    showToast('喜欢！以后多推荐类似音乐');
    sendFeedbackChange('like', song).catch(() => loadPreferences());
  }
});

$('btn-dislike').addEventListener('click', async function () {
  if (!currentSong) return;
  const song = currentSong;
  const id = normalizeId(song.id);
  if (dislikedIds.has(id)) {
    dislikedIds.delete(id);
    markDislikeBtn();
    showToast('已取消不喜欢');
    sendFeedbackChange('undislike', song).catch(() => loadPreferences());
  } else {
    if (likedIds.has(id)) {
      likedIds.delete(id);
      markLikeBtn();
    }
    dislikedIds.add(id);
    markDislikeBtn();
    showToast('已标记不喜欢');
    removeQueuedSongAfterCurrent(id);
    goNext(false);
    sendFeedbackChange('dislike', song).catch(() => {
      showToast('喜好保存失败，请稍后重试');
      loadPreferences();
    });
  }
});

$('btn-shuffle').addEventListener('click', async function () {
  showToast('正在随机切换...');
  try {
    const data = await apiPost('/api/pool/shuffle', {});
    if (data.songs && data.songs.length > 0) {
      currentQueue = data.songs;
      await switchPlayerTo(0);
    }
  } catch (e) { showToast('随机失败'); }
});

/* Cover tap = play/pause */
coverWrap.addEventListener('click', function () {
  PlayerBridge.togglePlay();
});

$('btn-exit').addEventListener('click', endDiscovery);

$('btn-stats').addEventListener('click', showStats);
$('stats-tab-session').addEventListener('click', () => { statsTab = 'session'; renderStatsTab(); });
$('stats-tab-history').addEventListener('click', () => { statsTab = 'history'; renderStatsTab(); });
$('btn-close-stats').addEventListener('click', () => statsPanel.classList.add('hidden'));
statsPanel.querySelector('.stats-backdrop').addEventListener('click', () => statsPanel.classList.add('hidden'));

/* 推荐信息只在用户主动点击 i 时显示。 */
$('btn-recommendation-info').addEventListener('click', function (e) {
  e.stopPropagation();
  const willOpen = recommendationPopover.classList.contains('hidden');
  recommendationPopover.classList.toggle('hidden', !willOpen);
  this.setAttribute('aria-expanded', String(willOpen));
});
recommendationPopover.addEventListener('click', e => e.stopPropagation());
document.addEventListener('click', function () {
  recommendationPopover.classList.add('hidden');
  $('btn-recommendation-info').setAttribute('aria-expanded', 'false');
});

/* Progress seek
 * Keep a real range input on top of the custom visuals. Native range behavior
 * is the primary path; explicit pointer/touch/mouse mapping is a WebView
 * fallback. Seeks are coalesced so a drag cannot flood the host bridge.
 */
let progressDragging = false;
let progressGestureActive = false;
let seekTimer = null;
let progressPointerId = null;
let queuedSeekTarget = null;
let seekFlushPromise = null;

function renderProgressRatio(value) {
  const ratio = Math.max(0, Math.min(1, Number(value) || 0));
  const percent = (ratio * 100) + '%';
  if (progressFill) progressFill.style.width = percent;
  if (progressThumb) progressThumb.style.left = percent;
}

function seekFromRange() {
  const ratio = Math.max(0, Math.min(1, Number(progressBar.value) / 1000));
  const seekTo = ratio * (Number(duration) || 0);
  renderProgressRatio(ratio);
  progressTime.textContent = formatTime(Math.floor(seekTo));
  return seekTo;
}

function lockLocalSeek(seekTo) {
  position = seekTo;
  posAnchor = { pos: seekTo, t: performance.now(), playing: isPlaying };
  pendingSeekTarget = seekTo;
  pendingSeekUntil = Date.now() + 4000;
}

function requestHostSeek(seekTo) {
  queuedSeekTarget = seekTo;
  if (seekFlushPromise) return seekFlushPromise;
  seekFlushPromise = (async function () {
    let lastResult = true;
    while (queuedSeekTarget !== null) {
      const target = queuedSeekTarget;
      queuedSeekTarget = null;
      lastResult = await PlayerBridge.seek(target);
    }
    return lastResult;
  })().finally(function () {
    seekFlushPromise = null;
    if (queuedSeekTarget !== null) requestHostSeek(queuedSeekTarget);
  });
  return seekFlushPromise;
}

function scheduleLiveSeek() {
  if (!duration) return;
  clearTimeout(seekTimer);
  seekTimer = setTimeout(function () {
    seekTimer = null;
    const seekTo = seekFromRange();
    lockLocalSeek(seekTo);
    requestHostSeek(seekTo);
  }, 100);
}

async function commitProgressSeek() {
  if (!duration) return false;
  clearTimeout(seekTimer);
  seekTimer = null;
  const seekTo = seekFromRange();
  lockLocalSeek(seekTo);
  const ok = await requestHostSeek(seekTo);
  if (!ok && PlayerBridge.available()) {
    pendingSeekTarget = null;
    pendingSeekUntil = 0;
    showToast('播放器不支持调整进度');
  }
  return ok;
}

function setProgressFromClientX(clientX) {
  if (!duration || !Number.isFinite(Number(clientX))) return;
  const rect = progressSlider.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (Number(clientX) - rect.left) / Math.max(1, rect.width)));
  progressBar.value = String(Math.round(ratio * 1000));
  seekFromRange();
}

function beginProgressDrag(e) {
  if (!duration) {
    duration = songDurationSeconds(currentSong);
    if (duration > 0) durationTime.textContent = formatTime(duration);
  }
  if (!duration) return;
  progressDragging = true;
  progressGestureActive = true;
  progressPointerId = e.pointerId === undefined ? null : e.pointerId;
  if (e.clientX !== undefined) setProgressFromClientX(e.clientX);
  scheduleLiveSeek();
  e.stopPropagation();
}

function moveProgressDrag(e) {
  if (!progressGestureActive ||
      (progressPointerId !== null && e.pointerId !== undefined && e.pointerId !== progressPointerId)) return;
  if (e.clientX !== undefined) setProgressFromClientX(e.clientX);
  scheduleLiveSeek();
  e.stopPropagation();
}

async function finishProgressDrag(e) {
  if (!progressGestureActive && !progressDragging) return;
  if (e && e.clientX !== undefined) setProgressFromClientX(e.clientX);
  progressGestureActive = false;
  progressDragging = false;
  progressPointerId = null;
  if (e) e.stopPropagation();
  await commitProgressSeek();
}

progressBar.addEventListener('input', function (e) {
  if (!duration) return;
  progressDragging = true;
  seekFromRange();
  scheduleLiveSeek();
  e.stopPropagation();
});
progressBar.addEventListener('change', finishProgressDrag);
progressBar.addEventListener('pointerdown', beginProgressDrag);
progressBar.addEventListener('pointermove', moveProgressDrag);
progressBar.addEventListener('pointerup', finishProgressDrag);
progressBar.addEventListener('pointercancel', finishProgressDrag);
progressSlider.addEventListener('pointerdown', beginProgressDrag);
progressSlider.addEventListener('pointermove', moveProgressDrag);
progressSlider.addEventListener('pointerup', finishProgressDrag);
progressSlider.addEventListener('pointercancel', finishProgressDrag);
document.addEventListener('pointermove', moveProgressDrag);
document.addEventListener('pointerup', finishProgressDrag);

/* Older embedded WebViews may expose touch/mouse events without PointerEvent. */
progressBar.addEventListener('touchstart', function (e) {
  const touch = e.touches && e.touches[0];
  beginProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressBar.addEventListener('touchmove', function (e) {
  const touch = e.touches && e.touches[0];
  moveProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressBar.addEventListener('touchend', function (e) {
  const touch = e.changedTouches && e.changedTouches[0];
  finishProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressSlider.addEventListener('touchstart', function (e) {
  const touch = e.touches && e.touches[0];
  beginProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressSlider.addEventListener('touchmove', function (e) {
  const touch = e.touches && e.touches[0];
  moveProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressSlider.addEventListener('touchend', function (e) {
  const touch = e.changedTouches && e.changedTouches[0];
  finishProgressDrag({ clientX: touch && touch.clientX, stopPropagation: () => e.stopPropagation() });
}, { passive: true });
progressBar.addEventListener('mousedown', beginProgressDrag);
progressSlider.addEventListener('mousedown', beginProgressDrag);
document.addEventListener('mousemove', moveProgressDrag);
document.addEventListener('mouseup', finishProgressDrag);

/* ─── UI Helpers ─── */
function updateFavoriteBtn() {
  const btn = $('btn-favorite');
  if (currentSong && favoriteIds.has(normalizeId(currentSong.id))) {
    btn.classList.add('active');
    btn.querySelector('svg').setAttribute('fill', '#ff6b6b');
  } else {
    btn.classList.remove('active');
    btn.querySelector('svg').setAttribute('fill', 'none');
  }
}

/* 每次切歌时刷新收藏状态，保持与宿主同步 */
function refreshFavoriteState() {
  loadFavorites().then(() => updateFavoriteBtn());
}

function markLikeBtn() {
  const btn = $('btn-like');
  if (currentSong && likedIds.has(normalizeId(currentSong.id))) {
    btn.classList.add('liked');
  } else {
    btn.classList.remove('liked');
  }
}

function markDislikeBtn() {
  const btn = $('btn-dislike');
  if (currentSong && dislikedIds.has(normalizeId(currentSong.id))) {
    btn.classList.add('disliked');
  } else {
    btn.classList.remove('disliked');
  }
}

function updatePlayPauseIcon() {
  playIndicator.classList.toggle('hidden', isPlaying);
}

let statsData = null;
let statsTab = 'session';

async function showStats() {
  try {
    statsData = await apiGet('/api/stats');
    statsTab = 'session';
    renderStatsTab();
    statsPanel.classList.remove('hidden');
  } catch (e) { showToast('加载统计失败'); }
}

function renderStatsTab() {
  const data = statsData || {};
  let html = '';
  if (statsTab === 'session') {
    const session = data.session;
    if (!session) {
      html = '<p class="stats-empty">还没有播放记录。</p>';
    } else {
      html += statRow('播放', (session.playedCount || 0) + ' 首');
      html += statRow('完整听完', (session.completeCount || 0) + ' 首');
      html += statRow('跳过', (session.skipCount || 0) + ' 次');
      html += statRow('快速跳过', (session.quickSkipCount || 0) + ' 次');
      html += statRow('喜欢', (session.likedCount || 0) + ' 次');
      html += statRow('不喜欢', (session.dislikedCount || 0) + ' 次');
      html += statRow('收藏', (session.favoriteCount || 0) + ' 次');
      html += statRow('播放时长', formatTime(Math.floor((session.duration || 0) / 1000)));
    }
  } else {
    const history = data.historyStats || data.allTime || {};
    html += statRow('总播放', (history.played || 0) + ' 首');
    html += statRow('完整听完', (history.complete || 0) + ' 首');
    html += statRow('跳过', (history.skip || 0) + ' 次');
    html += statRow('快速跳过', (history.quickSkip || 0) + ' 次');
    html += statRow('喜欢', (history.liked || 0) + ' 次');
    html += statRow('不喜欢', (history.disliked || 0) + ' 次');
    html += statRow('收藏', (history.favorite || 0) + ' 次');
    html += statRow('推荐池', (data.poolSize || 0) + ' 首');
    html += statRow('行为记录', (data.historyCount || 0) + ' 条');
    if (data.topArtists && data.topArtists.length) {
      html += '<div class="stats-section-title stats-subsection">常听歌手</div>';
      html += '<div class="stats-tags">' + data.topArtists.map(formatTopStat).join('、') + '</div>';
    }
    if (data.topGenres && data.topGenres.length) {
      html += '<div class="stats-section-title stats-subsection">常听类别</div>';
      html += '<div class="stats-tags">' + data.topGenres.map(formatTopStat).join('、') + '</div>';
    }
    html += '<div class="stats-reset-zone">';
    html += '<button id="btn-reset-preferences" class="stats-reset" type="button">重置喜好数据</button>';
    html += '<p>清除抖歌的历史播放、喜欢/不喜欢和推荐学习数据；不会删除 Songloft 收藏或推荐范围。</p>';
    html += '</div>';
  }
  statsBody.innerHTML = html;
  $('stats-tab-session').classList.toggle('active', statsTab === 'session');
  $('stats-tab-history').classList.toggle('active', statsTab === 'history');
}

statsBody.addEventListener('click', async function (event) {
  const button = event.target.closest('#btn-reset-preferences');
  if (!button) return;
  const confirmed = window.confirm('确定重置所有喜好与播放历史吗？此操作不能撤销，但不会删除 Songloft 收藏。');
  if (!confirmed) return;
  button.disabled = true;
  try {
    const result = await apiPost('/api/preferences/reset', {});
    applyPreferences(result.preferences || { liked: [], disliked: [] });
    statsData = await apiGet('/api/stats');
    renderStatsTab();
    showToast('喜好数据已重置，将从零开始学习');
    await loadNextBatch();
  } catch (e) {
    showToast('重置失败：' + (e.message || '未知错误'));
    button.disabled = false;
  }
});

function statRow(label, value) {
  return '<div class="stat-row"><span>' + label + '</span><span class="stat-value">' + value + '</span></div>';
}

function formatTopStat(item) {
  if (typeof item === 'string') return escHtml(item);
  return escHtml(item && item.name || '') + '（' + Number(item && item.count || 0) + '）';
}

/* ─── Behavior Reporting ─── */
function reportBehavior(type, song, extra) {
  if (!sessionActive || !song) return;
  const payload = Object.assign({
    type: type,
    songId: song.id,
    song: behaviorSongPayload(song),
    position: position,
    duration: duration || song.duration || 0,
    playbackId: currentPlaybackId,
    eventId: 'ui:' + Date.now() + ':' + (++behaviorSequence) + ':' + type + ':' + normalizeId(song.id)
  }, extra || {});
  apiPost('/api/behavior', payload).catch(() => {});
}

function behaviorSongPayload(song) {
  return {
    id: song.id,
    type: song.type,
    title: song.title,
    artist: song.artist,
    album: song.album,
    genre: song.genre,
    year: song.year,
    language: song.language,
    style: song.style,
    duration: song.duration,
    format: song.format,
    bit_rate: song.bit_rate,
    sample_rate: song.sample_rate,
    is_video: song.is_video,
    file_path: song.file_path
  };
}

/* ─── Lyrics ─── */
let lyricLines = [];
let currentLyricIndex = -1;
let lyricGeneration = 0;

async function loadLyrics(songId) {
  const gen = ++lyricGeneration;
  lyricLines = [];
  currentLyricIndex = -1;
  lyricPrev.textContent = '';
  lyricCurrent.textContent = '';
  lyricNext.textContent = '';

  try {
    const base = serverBasePath();
    const t = token();
    const headers = {};
    if (t) headers.Authorization = 'Bearer ' + t;
    const res = await fetch(base + '/api/v1/songs/' + songId + '/lyric', { headers });
    if (!res.ok) return;
    if (gen !== lyricGeneration) return;
    const text = await res.text();
    if (gen !== lyricGeneration) return;
    let lrcText = text;
    try {
      const data = JSON.parse(text);
      lrcText = data.lyric || data.lrc || data.text || text;
    } catch (e) { /* plain LRC text */ }
    lyricLines = parseLrc(lrcText);
  } catch (e) { /* lyrics are best-effort */ }
}

function parseLrc(text) {
  if (!text) return [];
  const lines = [];
  const regex = /\[(\d{2}):(\d{2})(?:[.:](\d{2,3}))?\]/g;
  for (const raw of text.split('\n')) {
    const timestamps = [];
    let match;
    regex.lastIndex = 0;
    while ((match = regex.exec(raw)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].length === 2 ? match[3] + '0' : match[3], 10) : 0;
      timestamps.push(min * 60 + sec + ms / 1000);
    }
    const content = raw.replace(/\[\d{2}:\d{2}[.:]?\d{0,3}\]/g, '').trim();
    if (timestamps.length && content) {
      for (const t of timestamps) lines.push({ time: t, text: content });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function updateLyricDisplay(pos) {
  if (!lyricLines.length) return;
  let idx = -1;
  for (let i = lyricLines.length - 1; i >= 0; i--) {
    if (pos >= lyricLines[i].time) { idx = i; break; }
  }
  if (idx === currentLyricIndex) return;
  currentLyricIndex = idx;

  lyricPrev.textContent = idx > 0 ? lyricLines[idx - 1].text : '';
  lyricCurrent.textContent = idx >= 0 ? lyricLines[idx].text : '';
  lyricNext.textContent = idx >= 0 && idx < lyricLines.length - 1 ? lyricLines[idx + 1].text : '';
}

/* ─── Position Tracking ─── */
function playbackPosition() {
  if (!posAnchor.playing) return posAnchor.pos;
  const elapsed = (performance.now() - posAnchor.t) / 1000;
  return posAnchor.pos + elapsed;
}

function startProgressPoll() {
  stopProgressPoll();
  progressTimer = setInterval(updateProgress, 500);
}

function stopProgressPoll() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function updateProgress() {
  position = playbackPosition();
  if (duration > 0) {
    if (!progressDragging) {
      const ratio = Math.max(0, Math.min(1, position / duration));
      progressBar.value = String(Math.round(ratio * 1000));
      renderProgressRatio(ratio);
      progressTime.textContent = formatTime(Math.floor(position));
    }
    updateLyricDisplay(position);

    if (position >= duration * 0.98 && isPlaying && !reportedMilestones.complete) {
      reportedMilestones.complete = true;
      reportBehavior('complete', currentSong);
    } else if (position >= duration * 0.8 && isPlaying && !reportedMilestones.play80) {
      reportedMilestones.play80 = true;
      reportBehavior('play80', currentSong);
    }
  }
}

/* ─── Player State Listener ─── */
function firstDefined(source, keys) {
  if (!source) return { key: '', value: undefined };
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return { key, value: source[key] };
  }
  return { key: '', value: undefined };
}

function secondsFromValue(value, key) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  const name = String(key || '').toLowerCase();
  if (name.includes('ms') || name.includes('millisecond')) return num / 1000;
  // Songloft song durations are seconds, but some player bridges expose ms.
  return num > 24 * 60 * 60 ? num / 1000 : num;
}

function songDurationSeconds(song) {
  const field = firstDefined(song, [
    'duration',
    'duration_seconds',
    'durationSeconds',
    'duration_sec',
    'durationMs',
    'duration_ms',
    'length',
    'length_seconds',
    'lengthMs'
  ]);
  return secondsFromValue(field.value, field.key);
}

function stateDurationSeconds(state, song) {
  const field = firstDefined(state, [
    'duration',
    'duration_seconds',
    'durationSeconds',
    'duration_sec',
    'durationMs',
    'duration_ms',
    'total_time',
    'totalTime',
    'total_seconds',
    'length',
    'length_seconds',
    'lengthMs'
  ]);
  return secondsFromValue(field.value, field.key) || songDurationSeconds(song) || songDurationSeconds(currentSong);
}

function statePositionSeconds(state, knownDuration) {
  const field = firstDefined(state, [
    'current_time',
    'currentTime',
    'current_seconds',
    'currentSeconds',
    'current_ms',
    'currentMs',
    'position',
    'position_seconds',
    'positionSeconds',
    'position_ms',
    'positionMs',
    'elapsed',
    'elapsed_time',
    'elapsedTime',
    'elapsed_ms',
    'elapsedMs',
    'played_time',
    'playedTime',
    'time',
    'progress'
  ]);
  if (field.value === undefined || field.value === null) return { hasPosition: false, position: 0 };
  const raw = Number(field.value);
  if (!Number.isFinite(raw)) return { hasPosition: false, position: 0 };
  const key = String(field.key || '').toLowerCase();
  if (key === 'progress' && knownDuration > 0) {
    if (raw >= 0 && raw <= 1) return { hasPosition: true, position: raw * knownDuration };
    if (raw > 1 && raw <= 100 && raw > knownDuration) return { hasPosition: true, position: raw / 100 * knownDuration };
  }
  return { hasPosition: true, position: secondsFromValue(raw, field.key) };
}

function resolveReportedQueueIndex(state) {
  const song = state && (state.current_song ?? state.currentSong) || null;
  const songId = song ? normalizeId(song.id) : '';
  // current_song is authoritative. A host can briefly publish the new song
  // together with an old/currently-rebuilding index; never use both to drive
  // two UI updates.
  if (songId) {
    return currentQueue.findIndex(item => normalizeId(item.id) === songId);
  }
  const rawIndex = state && (state.current_index ?? state.currentIndex);
  const index = Number(rawIndex);
  return Number.isInteger(index) && index >= 0 && index < currentQueue.length ? index : -1;
}

function handlePlayerState(state) {
  if (!state) return;

  const previousPosition = playbackPosition();
  const playing = state.is_playing ?? state.isPlaying ?? state.playing ?? false;
  const song = state.current_song ?? state.currentSong ?? null;
  const dur = stateDurationSeconds(state, song);
  const posState = statePositionSeconds(state, dur || duration);
  const hasPosition = posState.hasPosition;
  const pos = posState.position;
  const reportedSongId = song ? normalizeId(song.id) : '';
  const reportedQueueIndex = resolveReportedQueueIndex(state);

  if (pendingSwitch) {
    if (Date.now() >= pendingSwitch.expiresAt) {
      pendingSwitch = null;
    } else {
      const reachedTarget = reportedSongId
        ? reportedSongId === pendingSwitch.targetId
        : reportedQueueIndex === pendingSwitch.targetIndex;
      if (!reachedTarget) return;
      pendingSwitch.confirmed = true;
      // setQueue can publish the target state before its Promise resolves.
      // Remember the confirmation, but let switchPlayerTo commit the view once.
      if (!pendingSwitch.viewCommitted) return;
    }
  }

  if (!pendingSwitch && reportedQueueIndex >= 0 && reportedQueueIndex !== currentIndex) {
    const prevSong = currentSong;
    if (prevSong && !reportedMilestones.navigation) {
      reportBehavior(previousPosition < 10 ? 'quickSkip' : 'next', prevSong);
    }
    showSong(reportedQueueIndex);
  }

  isPlaying = playing;
  updatePlayPauseIcon();

  if (dur > 0) {
    duration = dur;
    durationTime.textContent = formatTime(duration);
  }
  if (hasPosition && Number.isFinite(pos)) {
    if (progressDragging) {
      // The user's pointer owns the progress display until release.
    } else if (pendingSeekTarget !== null && Date.now() < pendingSeekUntil) {
      if (Math.abs(pos - pendingSeekTarget) <= 1.5) {
        pendingSeekTarget = null;
        pendingSeekUntil = 0;
        posAnchor = { pos, t: performance.now(), playing: isPlaying };
      }
    } else {
      const sameReportedSong = currentSong && (
        (reportedSongId && reportedSongId === normalizeId(currentSong.id)) ||
        (!reportedSongId && (reportedQueueIndex < 0 || reportedQueueIndex === currentIndex))
      );
      const staleBackwardPosition = Boolean(isPlaying && sameReportedSong &&
        previousPosition > 0.75 &&
        pos + 0.75 < previousPosition &&
        (!duration || previousPosition < duration - 3));
      pendingSeekTarget = null;
      pendingSeekUntil = 0;
      posAnchor = { pos: staleBackwardPosition ? previousPosition : pos, t: performance.now(), playing: isPlaying };
    }
  } else {
    posAnchor = { pos: posAnchor.pos, t: performance.now(), playing: isPlaying };
  }
}

PlayerBridge.onState(handlePlayerState);

function startPlayerStatePoll() {
  stopPlayerStatePoll();
  pollPlayerState();
  pollTimer = setInterval(pollPlayerState, 1200);
}

function stopPlayerStatePoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  statePollInFlight = false;
}

async function pollPlayerState() {
  if (statePollInFlight) return;
  statePollInFlight = true;
  try {
    const state = await PlayerBridge.getState();
    if (state) handlePlayerState(state);
  } finally {
    statePollInFlight = false;
  }
}

/* ─── Utilities ─── */
function formatTime(sec) {
  if (!sec || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ─── Init ─── */
async function init() {
  resetCardPositions(false);
  await Promise.all([loadFavorites(), loadPreferences()]);
}

async function loadFavorites() {
  try {
    const data = await apiGet('/api/favorites');
    if (Array.isArray(data.ids)) favoriteIds = new Set(data.ids.map(normalizeId));
  } catch (e) {}
}

async function loadPreferences() {
  try {
    const data = await apiGet('/api/preferences');
    applyPreferences(data);
  } catch (e) {}
}

function applyPreferences(data) {
  if (!data) return;
  likedIds = new Set((data.liked || []).map(normalizeId));
  dislikedIds = new Set((data.disliked || []).map(normalizeId));
  markLikeBtn();
  markDislikeBtn();
}

function normalizeId(value) {
  return value === null || value === undefined ? '' : String(value);
}

init();

})();
