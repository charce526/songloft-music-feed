/**
 * Browser-level interaction checks for the feed UI.
 * Simulates the Songloft client bridge in JSDOM so progress seeking and
 * contradictory player states are exercised as events, not string markers.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { JSDOM } from 'jsdom';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const html = readFileSync(join(root, 'static', 'index.html'), 'utf8')
  .replace(/<script src="static\/app\.js[^"]*"><\/script>/, '');
const app = readFileSync(join(root, 'static', 'app.js'), 'utf8');
const songs = [
  { id: 1, type: 'local', title: 'A', artist: 'Artist A', album: 'Album A', duration: 180, cover_url: '/covers/A.jpg' },
  { id: 2, type: 'local', title: 'B', artist: 'Artist B', album: 'Album B', duration: 200, cover_url: '/covers/B.jpg' },
  { id: 3, type: 'local', title: 'C', artist: 'Artist C', album: 'Album C', duration: 220, cover_url: '/covers/C.jpg' }
];

const dom = new JSDOM(html, {
  url: 'http://songloft.test/api/v1/jsplugin/music-feed/static/index.html?access_token=test',
  runScripts: 'outside-only',
  pretendToBeVisual: true
});
const { window } = dom;
let stateListener = null;
let queueCallCount = 0;
const seekCalls = [];

window.fetch = async () => ({
  ok: false,
  status: 404,
  text: async () => ''
});
window.Image = class MockImage {
  set src(value) {
    this._src = value;
    queueMicrotask(() => {
      if (typeof this.onload === 'function') this.onload();
    });
  }
  get src() { return this._src || ''; }
};
window.SongloftPlugin = {
  getTheme: () => 'dark',
  onThemeChange: () => {},
  host: {
    isAvailable: () => true,
    getInfo: async () => ({ version: 'test', platform: 'web', capabilities: ['player'] })
  },
  player: {
    getState: async () => ({
      queue: songs,
      current_index: 0,
      current_song: songs[0],
      is_playing: true,
      current_time: 0,
      duration: songs[0].duration
    }),
    setQueue: async (_ids, options) => {
      queueCallCount++;
      if (!stateListener) return;
      if (queueCallCount === 1) {
        stateListener({
          queue: songs,
          current_index: 0,
          current_song: songs[0],
          is_playing: true,
          current_time: 0,
          duration: songs[0].duration
        });
      } else {
        // Reproduce the reported race: target song B arrives together with
        // a transient index pointing to C.
        stateListener({
          queue: songs,
          current_index: 2,
          current_song: songs[1],
          is_playing: true,
          current_time: 0,
          duration: songs[1].duration
        });
      }
      void options;
    },
    play: async () => {},
    togglePlay: async () => {},
    seek: async seconds => { seekCalls.push(seconds); },
    onStateChange: callback => {
      stateListener = callback;
      return () => {};
    }
  },
  apiGet: async path => {
    if (path.startsWith('/api/pool/next')) return { songs };
    if (path === '/api/config') {
      return {
        config: {
          version: 2,
          source: { type: 'library', label: '本地所有音频' },
          scope: { includeTypes: ['local'], excludeTypes: ['remote', 'radio'], excludePaths: [] }
        }
      };
    }
    if (path === '/api/favorites') return { ids: [] };
    if (path === '/api/preferences') return { liked: [], disliked: [] };
    if (path === '/api/sources') return { folderOptions: [], typeCounts: { local: 3 } };
    return {};
  },
  apiPost: async path => {
    if (path === '/api/session/start') {
      return {
        session: { active: true },
        preferences: { liked: [], disliked: [] },
        favoriteSync: { ids: [] }
      };
    }
    return {};
  }
};

function assert(condition, message) {
  if (!condition) throw new Error('FAIL: ' + message);
  console.log('  OK: ' + message);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeout = 1500) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for UI state');
    await wait(10);
  }
}

window.eval(app);
const title = window.document.getElementById('song-title');
const titleMutations = [];
const observer = new window.MutationObserver(records => {
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (node.textContent) titleMutations.push(node.textContent);
    }
  }
});
observer.observe(title, { childList: true, subtree: true });

window.document.getElementById('btn-start').click();
await waitFor(() => title.textContent === 'A');
await waitFor(() => window.document.getElementById('progress-time').textContent !== '0:00', 2200);
assert(window.document.getElementById('progress-time').textContent !== '0:00', 'keeps local playback time moving when host state repeats stale zero');

window.document.dispatchEvent(new window.KeyboardEvent('keydown', {
  key: 'ArrowUp',
  bubbles: true
}));
await waitFor(() => title.textContent === 'B');
await wait(450);

assert(title.textContent === 'B', 'keeps the requested song visible after a contradictory host index');
assert(!titleMutations.includes('C'), 'does not render the transient C state between A and B');
assert(window.document.getElementById('next-title').textContent === 'C', 'updates C only as the off-screen next preview');

const slider = window.document.querySelector('.progress-slider');
slider.getBoundingClientRect = () => ({ left: 100, right: 500, top: 0, bottom: 30, width: 400, height: 30 });
const progressBar = window.document.getElementById('progress-bar');

function dispatchPointer(target, type, clientX) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: 7, pointerType: 'mouse', clientX });
  target.dispatchEvent(event);
}

dispatchPointer(progressBar, 'pointerdown', 100);
dispatchPointer(window.document, 'pointermove', 300);
dispatchPointer(window.document, 'pointerup', 300);
await wait(40);

assert(seekCalls.some(value => Math.abs(value - 100) < 0.01), 'maps an actual pointer drag to a 100-second host seek');
seekCalls.length = 0;
progressBar.value = '500';
progressBar.dispatchEvent(new window.Event('input', { bubbles: true }));
await wait(160);

assert(seekCalls.some(value => Math.abs(value - 100) < 0.01), 'sends a 100-second seek while dragging a 200-second song to 50%');
assert(window.document.getElementById('progress-fill').style.width === '50%', 'updates the visible progress fill during dragging');
assert(window.document.getElementById('progress-time').textContent === '1:40', 'updates the visible time during dragging');

progressBar.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(20);
observer.disconnect();
dom.window.close();

console.log('ALL UI INTERACTION TESTS PASSED');
