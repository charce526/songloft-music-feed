/**
 * 抖歌 - Build Script
 * 构建 .jsplugin.zip 包，计算 entryHash/zipHash
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { deflateRawSync } from 'zlib';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const RELEASE = join(ROOT, 'Release');
const BUILD = join(RELEASE, '_build');

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function getAllFiles(dir, base) {
  base = base || dir;
  let results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) results = results.concat(getAllFiles(full, base));
    else results.push({ abs: full, rel: relative(base, full).replace(/\\/g, '/') });
  }
  return results;
}

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c >>> 0;
}

function crc32(data) {
  let c = 0xffffffff;
  for (const byte of data) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0);
  return buf;
}

function createZip(files, zipPath) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.rel, 'utf8');
    const data = readFileSync(file.abs);
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(0),
      u16(0x0021),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name
    ]);

    localParts.push(localHeader, compressed);

    centralParts.push(Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0x0800),
      u16(8),
      u16(0),
      u16(0x0021),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name
    ]));

    offset += localHeader.length + compressed.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0)
  ]);

  writeFileSync(zipPath, Buffer.concat([...localParts, ...centralParts, end]));
}

// Clean build dir
if (existsSync(BUILD)) rmSync(BUILD, { recursive: true });
mkdirSync(BUILD, { recursive: true });

// Copy files
cpSync(join(ROOT, 'src', 'main.js'), join(BUILD, 'main.js'));
cpSync(join(ROOT, 'static'), join(BUILD, 'static'), { recursive: true });

// Read plugin.json
const pluginPath = join(ROOT, 'plugin.json');
const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));

// Compute hashes
const files = getAllFiles(BUILD).filter(f => f.rel !== 'plugin.json');
files.sort((a, b) => a.rel.localeCompare(b.rel));

const entryHash = sha256(readFileSync(join(BUILD, 'main.js')));

let manifest = '';
for (const f of files) {
  const hash = sha256(readFileSync(f.abs));
  manifest += f.rel + '\n' + hash + '\n';
}
const zipHash = sha256(Buffer.from(manifest, 'utf8'));

// Update plugin.json
plugin.entryHash = entryHash;
plugin.zipHash = zipHash;
writeFileSync(join(BUILD, 'plugin.json'), JSON.stringify(plugin, null, 2));
writeFileSync(pluginPath, JSON.stringify(plugin, null, 2) + '\n');

// Create zip
const version = plugin.version;
const zipName = 'songloft-music-feed-v' + version + '.jsplugin.zip';
const zipPath = join(RELEASE, zipName);

// Remove existing same-version zip
if (existsSync(zipPath)) rmSync(zipPath);

createZip(getAllFiles(BUILD).sort((a, b) => a.rel.localeCompare(b.rel)), zipPath);

console.log('Build complete: ' + zipName);
console.log('  entryHash: ' + entryHash);
console.log('  zipHash:   ' + zipHash);
console.log('  version:   ' + version);
