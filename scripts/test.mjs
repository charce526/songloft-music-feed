/**
 * 轻量级插件行为测试：在 Node VM 中模拟 Songloft 的 storage、歌曲库和宿主收藏接口。
 * 这个测试不依赖真实 Songloft 实例，主要验证数据持久化、Session 偏好、队列取出和收藏同步。
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const source = readFileSync(join(root, 'src', 'main.js'), 'utf8');
const storage = new Map();
const songs = [
  { id: 1, type: 'local', file_path: '/music/pop/A.mp3', title: 'A', artist: 'Artist A', album: 'Album A', genre: 'Pop', year: 1998, language: '国语', style: '抒情', format: 'flac', duration: 180 },
  { id: 2, type: 'local', file_path: '/music/小说/B.mp3', title: 'B', artist: 'Artist B', album: 'Album B', genre: 'Rock', year: 2008, language: '英语', style: '摇滚', format: 'mp3', duration: 190 },
  { id: 3, type: 'local', file_path: '/music/pop/C.mp3', title: 'C', artist: 'Artist A', album: 'Album C', genre: 'Pop', year: 1996, language: '国语', style: '抒情', format: 'flac', duration: 200 },
  { id: 4, type: 'radio', file_path: '', title: 'D', artist: 'Artist C', album: 'Album D', genre: 'Jazz', year: 2018, language: '英语', style: '爵士', format: 'aac', duration: 210 },
  { id: 5, type: 'remote', url: 'https://example.test/E.mp3', title: 'E', artist: 'Artist D', album: 'Album E', genre: 'Electronic', year: 2024, language: '纯音乐', style: '电子', format: 'mp3', duration: 220 }
];
for (let i = 6; i <= 30; i++) {
  songs.push({
    id: i,
    type: 'local',
    file_path: '/music/library/song-' + i + '.mp3',
    title: 'Song ' + i,
    artist: 'Artist ' + i,
    album: 'Album ' + i,
    genre: i % 2 ? 'Pop' : 'Folk',
    year: 1990 + i,
    language: i % 3 ? '国语' : '英语',
    style: i % 2 ? '抒情' : '民谣',
    format: i % 2 ? 'flac' : 'mp3',
    duration: 160 + i
  });
}
const favoriteIds = new Set([1, 6, 7, 8, 9, 10, 11, 12]);
const playlistCalls = [];

const context = {
  console,
  Promise,
  Set,
  Map,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  encodeURIComponent,
  decodeURIComponent,
  setTimeout,
  clearTimeout,
  songloft: {
    storage: {
      get: async key => storage.has(key) ? storage.get(key) : null,
      set: async (key, value) => storage.set(key, value)
    },
    songs: {
      list: async () => songs
    },
    playlists: {
      list: async () => [],
      getSongs: async id => id === 1 ? songs.filter(song => favoriteIds.has(song.id) && song.type !== 'radio') : songs.filter(song => favoriteIds.has(song.id) && song.type === 'radio'),
      addSongs: async (playlistId, ids) => {
        playlistCalls.push({ action: 'add', playlistId, ids });
        ids.forEach(id => favoriteIds.add(Number(id)));
        return { added: ids.length, skipped: 0 };
      },
      removeSongs: async (playlistId, ids) => {
        playlistCalls.push({ action: 'remove', playlistId, ids });
        ids.forEach(id => favoriteIds.delete(Number(id)));
        return { removed: ids.length }
      }
    },
    log: { info() {}, warn() {}, error() {} }
  }
};
context.globalThis = context;
vm.runInNewContext(source, context, { filename: 'main.js' });

async function request(method, path, body) {
  const index = path.indexOf('?');
  const routePath = index >= 0 ? path.slice(0, index) : path;
  const query = index >= 0 ? path.slice(index + 1) : '';
  const result = await context.onHTTPRequest({ method, path: routePath, query, body: body ? JSON.stringify(body) : '' });
  return JSON.parse(result.body);
}

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  console.log('  OK: ' + message);
}

await context.onInit();
await request('POST', '/api/config', { source: { type: 'all', label: '全部音乐' } });
const config = await request('GET', '/api/config', null);
assert(config.config.scope.includeTypes.includes('local'), 'defaults to local audio scope');
const started = await request('POST', '/api/session/start', {});
assert(started.session && started.session.active, 'creates an active discovery session');
assert(started.favoriteSync.ids.includes('1'), 'loads host favorites as string IDs');

const batch = await request('GET', '/api/pool/next?count=8', null);
assert(batch.songs.length > 0, 'returns a recommendation batch');
assert(batch.songs.every(song => song.recommendation && song.recommendation.algorithm), 'attaches explainable recommendation metadata');
assert(!batch.songs.some(song => JSON.stringify(song.recommendation).includes('宿主收藏')), 'uses 用户收藏 in recommendation details');
assert(batch.songs.filter(song => favoriteIds.has(Number(song.id))).length <= 1, 'caps favorite songs in each recommendation batch');
const firstBatchIds = new Set(batch.songs.map(song => String(song.id)));
const secondBatch = await request('GET', '/api/pool/next?count=8', null);
assert(!secondBatch.songs.some(song => firstBatchIds.has(String(song.id))), 'keeps freshly served songs out of the next batch');
const savedSession = JSON.parse(storage.get('activeSession'));
assert(batch.songs.every(song => savedSession.recentQueueIds.includes(String(song.id))), 'stores served songs for recommendation cooldown');
const remaining = await request('GET', '/api/stats', null);
assert(remaining.poolSize < 100, 'checkout removes the batch atomically from the pool');

const first = songs[0];
await request('POST', '/api/behavior', {
  eventId: 'test-start-1', playbackId: 'play-1', type: 'start', songId: 1, song: songs[0]
});
await request('POST', '/api/behavior', {
  eventId: 'test-start-2', playbackId: 'play-2', type: 'start', songId: 3, song: songs[2]
});
await request('POST', '/api/behavior', {
  eventId: 'test-complete-1', playbackId: 'play-1', type: 'complete', songId: 1, song: songs[0], position: 178, duration: songs[0].duration
});
await request('POST', '/api/behavior', {
  eventId: 'test-next-2', playbackId: 'play-2', type: 'next', songId: 3, song: songs[2], position: 12, duration: songs[2].duration
});
await request('POST', '/api/behavior', {
  eventId: 'test-like-1', type: 'like', songId: first.id, song: first, position: 30, duration: first.duration
});
await request('POST', '/api/behavior', {
  eventId: 'test-like-1', type: 'like', songId: first.id, song: first, position: 30, duration: first.duration
});
const preferences = await request('GET', '/api/preferences', null);
assert(preferences.liked.includes(String(first.id)), 'persists liked song preference');
await request('POST', '/api/behavior', {
  eventId: 'test-dislike-1', type: 'dislike', songId: first.id, song: first
});
const exclusivePreferences = await request('GET', '/api/preferences', null);
assert(!exclusivePreferences.liked.includes(String(first.id)) && exclusivePreferences.disliked.includes(String(first.id)), 'keeps like and dislike mutually exclusive');
await request('POST', '/api/pool/release', { songs: [first] });
const dislikeFilteredBatch = await request('GET', '/api/pool/next?count=20', null);
assert(!dislikeFilteredBatch.songs.some(song => String(song.id) === String(first.id)), 'keeps explicitly disliked songs out of released and refilled recommendation batches');
const stats = await request('GET', '/api/stats', null);
assert(stats.historyCount === 6, 'deduplicates repeated behavior events');
assert(stats.historyStats.played === 2, 'counts actual playback starts instead of preference actions');
assert(stats.historyStats.complete === 1 && stats.historyStats.skip === 1, 'counts completed and skipped playback outcomes');
assert(stats.session.completeCount === 1 && stats.session.skipCount === 1, 'derives current session statistics from live behavior events');
assert(stats.session.duration === 192000 && stats.historyStats.durationMs === 192000, 'tracks actual listened time instead of elapsed plugin time');
assert(stats.topArtists[0].name === 'Artist A' && stats.topArtists[0].count === 2, 'computes frequent artists from playback history');
assert(stats.topGenres[0].name === 'Pop' && stats.topGenres[0].count === 2, 'computes frequent categories from playback history');
assert(typeof storage.get('longTermInterest') === 'string', 'serializes complex state in storage');
const storedProfile = JSON.parse(storage.get('longTermInterest'));
assert(storedProfile.version === 4, 'writes versioned preference model');
assert(storedProfile.decades['1990年代'] && storedProfile.languages['国语'] && storedProfile.styles['抒情'], 'learns decade, language and style features');
assert(storedProfile.formats.flac && storedProfile.durationBuckets['2-4分钟'], 'learns format and duration features');

const favorite = await request('POST', '/api/favorite', { action: 'add', songId: 2, song: songs[1] });
assert(favorite.favorited === true && favorite.ids.includes('2'), 'updates host favorite state after a successful star');
assert(playlistCalls.some(item => item.action === 'add' && item.playlistId === 1 && item.ids[0] === 2), 'uses the host normal-song favorite playlist');
const unfavorite = await request('POST', '/api/favorite', { action: 'remove', songId: 2, song: songs[1] });
assert(unfavorite.favorited === false && !unfavorite.ids.includes('2'), 'removes host favorite state and records the reverse signal');

const sourceInfo = await request('GET', '/api/sources', null);
assert(sourceInfo.folderOptions.some(item => item.path === 'music/小说'), 'exposes folder options for exclusion settings');
await request('POST', '/api/config', {
  config: {
    version: 2,
    source: { type: 'library', label: '本地所有音频' },
    scope: { includeTypes: ['local'], excludeTypes: ['remote', 'radio'], excludePaths: ['music/小说'] }
  }
});
const filteredBatch = await request('GET', '/api/pool/next', null);
assert(filteredBatch.songs.every(song => song.type === 'local' && !String(song.file_path).includes('小说')), 'excludes configured categories and directories');

const html = readFileSync(join(root, 'static', 'index.html'), 'utf8');
const app = readFileSync(join(root, 'static', 'app.js'), 'utf8');
const css = readFileSync(join(root, 'static', 'styles.css'), 'utf8');
const defaultCover = readFileSync(join(root, 'static', 'default-cover.svg'), 'utf8');
assert(/type="range"[^>]*id="progress-bar"|id="progress-bar"[^>]*type="range"/.test(html), 'uses a native draggable range for playback progress');
assert(html.includes('progress-fill') && html.includes('progress-thumb'), 'renders progress visuals beneath the native range input');
assert(html.includes('<img src="static/icon.svg" alt="抖歌图标"'), 'uses the plugin icon on the setup screen');
assert(html.includes('btn-recommendation-info') && !html.includes('reason-bar'), 'moves recommendation text behind the bottom-right info control');
assert(app.includes("progressBar.addEventListener('input'") && app.includes('requestHostSeek'), 'seeks through the host while the native range is dragged');
assert(app.includes("progressBar.addEventListener('pointermove'") && app.includes("progressSlider.addEventListener('pointerdown'") && app.includes("progressSlider.addEventListener('touchmove'") && app.includes("document.addEventListener('mousemove'"), 'supports pointer, touch, and mouse progress dragging from the bar and track');
assert(app.includes('resolveReportedQueueIndex') && app.includes('current_song is authoritative'), 'uses one authoritative host state to prevent B-C-B cover updates');
assert(app.includes('startPlayerStatePoll') && app.includes('staleBackwardPosition'), 'keeps progress and lyrics moving when host state events are stale or missing');
assert(app.indexOf('resetCardPositions(false)', app.indexOf('B → C → B')) < app.indexOf('updateAdjacentCards()', app.indexOf('B → C → B')), 'moves the current card into place before rewriting adjacent previews');
assert(app.includes('setSongDetailsHidden(true)') && app.includes('setDefaultCover'), 'hides stale progress and lyrics during song switches and falls back to the default cover');
assert(app.includes('DEFAULT_COVER_URL') && app.includes('setDefaultCover') && app.includes('removeQueuedSongAfterCurrent'), 'falls back to a default cover and removes disliked songs from the pending client queue');
assert(app.includes('refreshStatsIfVisible') && app.includes("then(refreshStatsIfVisible)"), 'refreshes visible statistics after behavior updates');
assert(defaultCover.includes('<svg') && defaultCover.includes('Default music cover'), 'ships a default cover image');
assert(css.includes('-webkit-user-drag: none') && /progress-bar[\s\S]*pointer-events:\s*auto/.test(css), 'prevents native image drag and keeps the native progress range interactive');
assert(!app.includes("factors.push('宿主收藏')") && app.includes("replace(/宿主收藏/g, '用户收藏')"), 'shows 用户收藏 in the bottom-right recommendation details');
assert(app.includes('/api/preferences/reset') && app.includes('btn-reset-preferences'), 'offers a history reset action');
assert(css.includes('.range-actions .stats-secondary') && css.includes('.range-actions .stats-close'), 'gives range cancel and save actions the same dimensions');

const reset = await request('POST', '/api/preferences/reset', {});
assert(reset.ok && reset.preferences.liked.length === 0 && reset.preferences.disliked.length === 0, 'resets learned likes and dislikes');
const resetStats = await request('GET', '/api/stats', null);
assert(resetStats.historyCount === 0 && resetStats.historyStats.played === 0, 'resets playback history and statistics');
const favoritesAfterReset = await request('GET', '/api/favorites', null);
assert(favoritesAfterReset.ids.includes('1'), 'keeps Songloft host favorites when plugin learning data is reset');

console.log('ALL BEHAVIOR TESTS PASSED');
