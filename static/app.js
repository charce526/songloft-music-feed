/**
 * 抖歌 - Frontend
 * 沉浸式音乐发现：抖音式卡片堆叠滑动、播放控制、推荐展示
 */
/* global SongloftPlugin */
(function () {
'use strict';

/* ─── SDK Bridge ─── */
const hasSDK = typeof SongloftPlugin !== 'undefined' && SongloftPlugin !== null;

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
  if (hasSDK && SongloftPlugin.apiGet) return SongloftPlugin.apiGet(path);
  const base = pluginBasePath();
  const t = token();
  const headers = {};
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(base + path, { headers });
  return res.json();
}

async function apiPost(path, body) {
  if (hasSDK && SongloftPlugin.apiPost) return SongloftPlugin.apiPost(path, body);
  const base = pluginBasePath();
  const t = token();
  const headers = { 'Content-Type': 'application/json' };
  if (t) headers.Authorization = 'Bearer ' + t;
  const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return res.json();
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
    try { await p.setQueue(ids, { startIndex: startIndex || 0 }); } catch (e) { console.warn('[MusicFeed] setQueue failed', e); }
  },

  async play(id) {
    const p = this.player();
    if (!p) return;
    try { if (id) await p.play(id); else await p.play(); } catch (e) {}
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
    if (!p || !p.seek) return;
    try { await p.seek(seconds); } catch (e) {}
  },

  onState(cb) {
    const p = this.player();
    if (!p || !p.onStateChange) return () => {};
    return p.onStateChange(cb);
  }
};

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
const reasonText = $('reason-text');
const reasonBar = $('reason-bar');
const progressFill = $('progress-fill');
const progressThumb = $('progress-thumb');
const progressTime = $('progress-time');
const durationTime = $('duration-time');
const progressBar = $('progress-bar');
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
    const sources = data.sources || [];
    sourceList.innerHTML = '';

    if (sources.length === 0) {
      sourceList.innerHTML = '<p style="text-align:center;color:var(--text-dim);padding:20px;">未找到音乐来源</p>';
      return;
    }

    for (const src of sources) {
      const item = document.createElement('div');
      item.className = 'source-item';
      const typeLabel = { all: '全部', playlist: '歌单', artist: '歌手', genre: '风格', folder: '文件夹', album: '专辑' }[src.type] || src.type;
      item.innerHTML = '<div><span class="source-name">' + escHtml(src.label) + '</span></div>' +
        '<div style="display:flex;align-items:center;gap:8px;"><span class="source-type">' + typeLabel + '</span>' +
        '<span class="source-count">' + (src.count || 0) + '首</span></div>';
      item.addEventListener('click', () => selectSource(src));
      sourceList.appendChild(item);
    }
  } catch (e) {
    sourceList.innerHTML = '<p style="text-align:center;color:#ff6b6b;padding:20px;">加载失败: ' + escHtml(e.message || '未知错误') + '</p>';
  }
}

async function selectSource(src) {
  sourceList.innerHTML = '<div class="loading-spinner"></div>';
  try {
    await apiPost('/api/config', { source: src });
    showToast('已设置：' + src.label);
    sourcePanel.classList.add('hidden');
  } catch (e) {
    showToast('设置失败: ' + (e.message || ''));
    loadSources();
  }
}

$('btn-settings').addEventListener('click', function () {
  sourcePanel.classList.remove('hidden');
  loadSources();
});
$('btn-close-source').addEventListener('click', () => sourcePanel.classList.add('hidden'));
sourcePanel.querySelector('.stats-backdrop').addEventListener('click', () => sourcePanel.classList.add('hidden'));

$('btn-start').addEventListener('click', async function () {
  this.textContent = '正在准备...';
  this.disabled = true;
  try {
    const data = await apiGet('/api/config');
    if (!data.config) {
      await apiPost('/api/config', { source: { type: 'all', label: '全部音乐' } });
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
    sessionActive = true;
    setupScreen.classList.add('hidden');
    feedScreen.classList.remove('hidden');
    const swipeHint = $('swipe-hint');
    swipeHint.classList.remove('hidden');
    setTimeout(() => swipeHint.classList.add('hidden'), 6000);
    await loadNextBatch();
    startProgressPoll();
    startFavPoll();
  } catch (e) {
    showToast('启动探索失败');
  }
}

async function endDiscovery() {
  sessionActive = false;
  try { await apiPost('/api/session/end', {}); } catch (e) {}
  stopProgressPoll();
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
    currentIndex = 0;
    const ids = songs.map(s => s.id);
    await PlayerBridge.setQueue(ids, 0);
    showSong(0);
  } catch (e) {
    showToast('加载推荐失败');
  }
}

function showSong(index) {
  if (index < 0 || index >= currentQueue.length) return;
  currentIndex = index;
  currentSong = currentQueue[index];
  if (!currentSong) return;

  songTitle.textContent = currentSong.title || '未知标题';
  songArtist.textContent = currentSong.artist || '未知歌手';
  songAlbum.textContent = currentSong.album || '';

  /* 推荐理由：过滤掉"随机探索"类泛化文案 */
  const reason = currentSong.reason || '';
  const isGenericReason = !reason || reason.indexOf('随机探索') >= 0;
  reasonText.textContent = isGenericReason ? '' : reason;
  reasonBar.style.opacity = isGenericReason ? '0' : '1';
  reasonBar.style.display = isGenericReason ? 'none' : '';

  duration = currentSong.duration || 0;
  durationTime.textContent = formatTime(duration);
  position = 0;
  posAnchor = { pos: 0, t: performance.now(), playing: false };
  progressFill.style.width = '0%';
  progressThumb.style.left = '0%';
  progressTime.textContent = '0:00';

  loadCover(currentSong);
  loadLyrics(currentSong.id);
  updateAdjacentCards();
  refreshFavoriteState();

  /* 恢复喜欢按钮常亮状态 */
  const likeBtn = $('btn-like');
  if (likedIds.has(currentSong.id)) likeBtn.classList.add('liked');
  else likeBtn.classList.remove('liked');

  /* 恢复不喜欢按钮常亮状态 */
  const dislikeBtn = $('btn-dislike');
  if (dislikedIds.has(currentSong.id)) dislikeBtn.classList.add('disliked');
  else dislikeBtn.classList.remove('disliked');

  apiPost('/api/pool/consume', { songId: currentSong.id }).catch(() => {});
}

/* ─── Cover Loading (with race-condition guard) ─── */
function loadCover(song) {
  const gen = ++coverGeneration;
  const candidates = [song.cover_url, song.source_cover_url];
  if (song.id) candidates.push('/api/v1/songs/' + song.id + '/cover');
  const urls = candidates.filter(Boolean).map(authUrl);

  coverPlaceholder.classList.remove('hidden');
  bgImage.classList.remove('loaded');

  if (urls.length === 0) {
    coverImg.src = '';
    return;
  }

  let idx = 0;
  function tryNext() {
    if (idx >= urls.length) return;
    if (gen !== coverGeneration) return;
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
  imgEl.src = urls.length > 0 ? urls[0] : '';
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

/* ─── Navigation ─── */
let animating = false;

function goNext(recordBehavior) {
  if (animating) return;
  if (recordBehavior && currentSong) {
    reportBehavior('next', currentSong);
  }
  if (currentIndex < currentQueue.length - 1) {
    animating = true;
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardNext.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s ease';
    cardCurrent.style.transform = 'translateY(-' + CARD_PEEK + '%)';
    cardNext.style.transform = 'translateY(0)';
    cardNext.style.opacity = '1';
    setTimeout(() => {
      showSong(currentIndex + 1);
      resetCardPositions(false);
      PlayerBridge.play(currentQueue[currentIndex].id);
      animating = false;
    }, 330);
  } else {
    animating = true;
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardCurrent.style.transform = 'translateY(-' + CARD_PEEK + '%)';
    setTimeout(() => {
      resetCardPositions(false);
      loadNextBatch();
      animating = false;
    }, 330);
  }
}

function goPrev() {
  if (animating) return;
  if (currentSong) reportBehavior('prev', currentSong);
  if (currentIndex > 0) {
    animating = true;
    cardCurrent.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
    cardPrev.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.32s ease';
    cardCurrent.style.transform = 'translateY(' + CARD_PEEK + '%)';
    cardPrev.style.transform = 'translateY(0)';
    cardPrev.style.opacity = '1';
    setTimeout(() => {
      showSong(currentIndex - 1);
      resetCardPositions(false);
      PlayerBridge.play(currentQueue[currentIndex].id);
      animating = false;
    }, 330);
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
  if (e.target.closest('.progress-bar')) return;
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
  if (e.target.closest('.progress-bar')) return;
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
  switch (e.key) {
    case 'ArrowUp': goNext(true); break;
    case 'ArrowDown': goPrev(); break;
    case ' ': e.preventDefault(); PlayerBridge.togglePlay(); break;
  }
});

/* ─── Action Buttons ─── */
$('btn-favorite').addEventListener('click', async function () {
  if (!currentSong) return;
  const isFav = favoriteIds.has(currentSong.id);
  try {
    const data = await apiPost('/api/favorite', { songId: currentSong.id, action: isFav ? 'remove' : 'add' });
    if (data.favorited) { favoriteIds.add(currentSong.id); showToast('已收藏 ♥'); }
    else { favoriteIds.delete(currentSong.id); showToast('已取消收藏'); }
    updateFavoriteBtn();
  } catch (e) { showToast('操作失败'); }
});

$('btn-like').addEventListener('click', function () {
  if (!currentSong) return;
  if (likedIds.has(currentSong.id)) {
    likedIds.delete(currentSong.id);
    reportBehavior('unlike', currentSong);
    markLikeBtn();
    showToast('已取消喜欢');
  } else {
    likedIds.add(currentSong.id);
    reportBehavior('like', currentSong);
    markLikeBtn();
    showToast('喜欢！以后多推荐类似音乐');
  }
});

$('btn-dislike').addEventListener('click', function () {
  if (!currentSong) return;
  if (dislikedIds.has(currentSong.id)) {
    dislikedIds.delete(currentSong.id);
    reportBehavior('undislike', currentSong);
    markDislikeBtn();
    showToast('已取消不喜欢');
  } else {
    dislikedIds.add(currentSong.id);
    reportBehavior('dislike', currentSong);
    markDislikeBtn();
    showToast('已标记不喜欢');
    goNext(false);
  }
});

$('btn-shuffle').addEventListener('click', async function () {
  showToast('正在随机切换...');
  try {
    const data = await apiPost('/api/pool/shuffle', {});
    if (data.songs && data.songs.length > 0) {
      currentQueue = data.songs;
      currentIndex = 0;
      const ids = data.songs.map(s => s.id);
      await PlayerBridge.setQueue(ids, 0);
      showSong(0);
    }
  } catch (e) { showToast('随机失败'); }
});

/* Cover tap = play/pause */
coverWrap.addEventListener('click', function () {
  PlayerBridge.togglePlay();
});

$('btn-exit').addEventListener('click', endDiscovery);

$('btn-stats').addEventListener('click', showStats);
$('btn-close-stats').addEventListener('click', () => statsPanel.classList.add('hidden'));
document.querySelector('.stats-backdrop').addEventListener('click', () => statsPanel.classList.add('hidden'));

/* Progress bar seek (touch + mouse drag) */
let progressDragging = false;

function seekFromEvent(clientX) {
  const rect = progressBar.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const seekTo = ratio * duration;
  progressFill.style.width = (ratio * 100) + '%';
  progressThumb.style.left = (ratio * 100) + '%';
  progressTime.textContent = formatTime(Math.floor(seekTo));
  return seekTo;
}

progressBar.addEventListener('touchstart', function (e) {
  if (!duration) return;
  progressDragging = true;
  seekFromEvent(e.touches[0].clientX);
  e.stopPropagation();
}, { passive: true });

progressBar.addEventListener('touchmove', function (e) {
  if (!progressDragging) return;
  seekFromEvent(e.touches[0].clientX);
  e.stopPropagation();
}, { passive: true });

progressBar.addEventListener('touchend', function (e) {
  if (!progressDragging) return;
  progressDragging = false;
  const seekTo = seekFromEvent(e.changedTouches[0].clientX);
  PlayerBridge.seek(seekTo);
  position = seekTo;
  posAnchor = { pos: seekTo, t: performance.now(), playing: isPlaying };
  e.stopPropagation();
}, { passive: true });

progressBar.addEventListener('mousedown', function (e) {
  if (!duration) return;
  progressDragging = true;
  seekFromEvent(e.clientX);
  e.preventDefault();
  e.stopPropagation();
});
document.addEventListener('mousemove', function (e) {
  if (!progressDragging) return;
  seekFromEvent(e.clientX);
});
document.addEventListener('mouseup', function (e) {
  if (!progressDragging) return;
  progressDragging = false;
  const seekTo = seekFromEvent(e.clientX);
  PlayerBridge.seek(seekTo);
  position = seekTo;
  posAnchor = { pos: seekTo, t: performance.now(), playing: isPlaying };
});

/* ─── UI Helpers ─── */
function updateFavoriteBtn() {
  const btn = $('btn-favorite');
  if (currentSong && favoriteIds.has(currentSong.id)) {
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
  if (currentSong && likedIds.has(currentSong.id)) {
    btn.classList.add('liked');
  } else {
    btn.classList.remove('liked');
  }
}

function markDislikeBtn() {
  const btn = $('btn-dislike');
  if (currentSong && dislikedIds.has(currentSong.id)) {
    btn.classList.add('disliked');
  } else {
    btn.classList.remove('disliked');
  }
}

function updatePlayPauseIcon() {
  playIndicator.classList.toggle('hidden', isPlaying);
}

async function showStats() {
  try {
    const data = await apiGet('/api/stats');
    let html = '';

    /* 本次播放 */
    if (data.session) {
      html += '<div class="stats-section-title">本次播放</div>';
      html += statRow('播放', (data.session.playedCount || 0) + ' 首');
      html += statRow('完整听完', (data.session.completeCount || 0) + ' 首');
      html += statRow('跳过', (data.session.skipCount || 0) + ' 次');
      html += statRow('快速跳过', (data.session.quickSkipCount || 0) + ' 次');
      html += statRow('喜欢', (data.session.likedCount || 0) + ' 次');
      html += statRow('不喜欢', (data.session.dislikedCount || 0) + ' 次');
      html += statRow('收藏', (data.session.favoriteCount || 0) + ' 次');
      html += statRow('探索时长', formatTime(Math.floor((data.session.duration || 0) / 1000)));
    }

    /* 历次统计 */
    if (data.allTime) {
      html += '<div class="stats-section-title" style="margin-top:16px;">历次统计</div>';
      html += statRow('总播放', (data.allTime.played || 0) + ' 首');
      html += statRow('完整听完', (data.allTime.complete || 0) + ' 首');
      html += statRow('跳过', (data.allTime.skip || 0) + ' 次');
      html += statRow('快速跳过', (data.allTime.quickSkip || 0) + ' 次');
      html += statRow('喜欢', (data.allTime.liked || 0) + ' 次');
      html += statRow('不喜欢', (data.allTime.disliked || 0) + ' 次');
      html += statRow('收藏', (data.allTime.favorite || 0) + ' 次');
      html += statRow('推荐池', (data.poolSize || 0) + ' 首');
      html += statRow('历史记录', (data.historyCount || 0) + ' 条');
    }

    if (data.topArtists && data.topArtists.length) {
      html += '<div class="stats-section-title" style="margin-top:16px;">常听歌手</div>';
      html += '<div style="font-size:13px;margin-top:4px;">' + data.topArtists.map(escHtml).join('、') + '</div>';
    }
    if (data.topGenres && data.topGenres.length) {
      html += '<div class="stats-section-title" style="margin-top:16px;">偏好风格</div>';
      html += '<div style="font-size:13px;margin-top:4px;">' + data.topGenres.map(escHtml).join('、') + '</div>';
    }
    statsBody.innerHTML = html;
    statsPanel.classList.remove('hidden');
  } catch (e) { showToast('加载统计失败'); }
}

function statRow(label, value) {
  return '<div class="stat-row"><span>' + label + '</span><span class="stat-value">' + value + '</span></div>';
}

/* ─── Behavior Reporting ─── */
function reportBehavior(type, song, extra) {
  const payload = Object.assign({
    type: type,
    songId: song.id,
    song: { id: song.id, title: song.title, artist: song.artist, album: song.album, genre: song.genre, duration: song.duration },
    position: position,
    duration: duration || song.duration || 0
  }, extra || {});
  apiPost('/api/behavior', payload).catch(() => {});
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
      const pct = Math.min(100, (position / duration) * 100);
      progressFill.style.width = pct + '%';
      progressThumb.style.left = pct + '%';
      progressTime.textContent = formatTime(Math.floor(position));
    }
    updateLyricDisplay(position);

    if (position >= duration * 0.98 && isPlaying) {
      reportBehavior('complete', currentSong);
    } else if (position >= duration * 0.8 && position < duration * 0.82 && isPlaying) {
      reportBehavior('play80', currentSong);
    }
  }
}

/* ─── Player State Listener ─── */
PlayerBridge.onState(function (state) {
  if (!state) return;

  const playing = state.is_playing ?? state.isPlaying ?? state.playing ?? false;
  const pos = state.position ?? state.progress ?? state.current_time ?? state.currentTime ?? 0;
  const idx = state.current_index ?? state.currentIndex ?? -1;
  const song = state.current_song ?? state.currentSong ?? null;
  const dur = state.duration ?? (song ? song.duration : 0) ?? 0;

  isPlaying = playing;
  updatePlayPauseIcon();

  if (dur) duration = dur;
  posAnchor = { pos: typeof pos === 'number' ? pos : 0, t: performance.now(), playing: isPlaying };

  if (idx >= 0 && idx !== currentIndex && idx < currentQueue.length) {
    const prevSong = currentSong;
    if (prevSong && posAnchor.pos < 10) {
      reportBehavior('quickSkip', prevSong);
    }
    showSong(idx);
  }

  if (song && currentSong && song.id !== currentSong.id) {
    const found = currentQueue.findIndex(s => s.id === song.id);
    if (found >= 0) showSong(found);
  }
});

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
  loadFavorites();
}

async function loadFavorites() {
  try {
    const data = await apiGet('/api/favorites');
    favoriteIds = new Set(data.ids || []);
  } catch (e) {}
}

init();

})();
