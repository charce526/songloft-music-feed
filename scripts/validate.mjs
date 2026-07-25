/**
 * 抖歌 - Validate Script
 * 验证构建产物完整性
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

const plugin = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
const version = plugin.version;
const zipName = 'douge-v' + version + '.jsplugin.zip';
const zipPath = join(DIST, zipName);

let errors = 0;
function check(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); errors++; }
  else { console.log('  OK: ' + msg); }
}

console.log('Validating ' + zipName + '...\n');

// Check zip exists
check(existsSync(zipPath), 'ZIP file exists');

// Check plugin.json fields
check(plugin.entryPath === 'music-feed', 'entryPath is music-feed');
check(plugin.main === 'main.js', 'main is main.js');
check(!!plugin.entryHash, 'entryHash present');
check(!!plugin.zipHash, 'zipHash present');
check(!!plugin.version, 'version present');
check(plugin.permissions.includes('storage'), 'has storage permission');
check(plugin.permissions.includes('songs.read'), 'has songs.read permission');

// Check source files
check(existsSync(join(ROOT, 'src', 'main.js')), 'src/main.js exists');
check(existsSync(join(ROOT, 'static', 'index.html')), 'static/index.html exists');
check(existsSync(join(ROOT, 'static', 'app.js')), 'static/app.js exists');
check(existsSync(join(ROOT, 'static', 'styles.css')), 'static/styles.css exists');

// Check main.js markers
const mainJs = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
const mainMarkers = [
  'globalThis.onInit',
  'globalThis.onDeinit',
  'globalThis.onHTTPRequest',
  'songloft.songs.list',
  'songloft.storage.get',
  'songloft.storage.set',
  'songloft.playlists.list',
  'songloft.playlists.getSongs',
  'songloft.plugin.getHostUrl',
  'songloft.plugin.getToken',
  'createRouter',
  'jsonResponse',
  'POOL_SIZE',
  'QUEUE_BATCH',
  'initPool',
  'refillPool',
  'processBehavior',
  'BEHAVIOR_WEIGHTS',
  'getInterestScore',
  'updateInterest',
  'decayInterest',
  'createSession',
  'shuffleArray',
  'buildReason',
  'filterBySource',
  'getAvailableSources',
  'loadState',
  'savePool',
  'saveSession',
  'saveLongTermInterest'
];
for (const m of mainMarkers) {
  check(mainJs.includes(m), 'main.js contains: ' + m);
}

// Check app.js markers
const appJs = readFileSync(join(ROOT, 'static', 'app.js'), 'utf8');
const appMarkers = [
  'PlayerBridge',
  'getState',
  'setQueue',
  'togglePlay',
  'onState',
  'loadSources',
  'selectSource',
  'startDiscovery',
  'endDiscovery',
  'loadNextBatch',
  'showSong',
  'loadCover',
  'goNext',
  'goPrev',
  'loadLyrics',
  'parseLrc',
  'updateLyricDisplay',
  'playIndicator',
  'progressThumb',
  'seekFromEvent',
  'applyDrag',
  'resetCardPositions',
  'updateAdjacentCards',
  'coverGeneration',
  'refreshFavoriteState',
  'startFavPoll',
  'CARD_PEEK',
  'likedIds',
  'dislikedIds',
  'markLikeBtn',
  'markDislikeBtn',
  'reportBehavior',
  'playbackPosition',
  'updateProgress',
  'showStats',
  'formatTime',
  'applyTheme',
  'showToast',
  'SWIPE_THRESHOLD',
  'touchstart',
  'touchend',
  'keydown'
];
for (const m of appMarkers) {
  check(appJs.includes(m), 'app.js contains: ' + m);
}

// Check index.html version cache-bust
const html = readFileSync(join(ROOT, 'static', 'index.html'), 'utf8');
check(html.includes('?v=' + version), 'index.html has version cache-bust');

// Verify entryHash
const mainContent = readFileSync(join(ROOT, 'src', 'main.js'));
const computedEntry = createHash('sha256').update(mainContent).digest('hex');
check(computedEntry === plugin.entryHash, 'entryHash matches main.js SHA-256');

console.log('\n' + (errors === 0 ? 'ALL CHECKS PASSED' : errors + ' CHECKS FAILED'));
process.exit(errors === 0 ? 0 : 1);
