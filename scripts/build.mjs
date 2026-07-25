/**
 * 抖歌 - Build Script
 * 构建 .jsplugin.zip 包，计算 entryHash/zipHash
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync, readdirSync, statSync, existsSync } from 'fs';
import { join, relative } from 'path';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');
const BUILD = join(DIST, '_build');

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
const zipName = 'douge-v' + version + '.jsplugin.zip';
const zipPath = join(DIST, zipName);

// Remove existing same-version zip
if (existsSync(zipPath)) rmSync(zipPath);

// Use .NET ZipFile on Windows for forward-slash entries
const ps1 = `
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipPath = '${zipPath}'
$buildDir = '${BUILD}'
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
Get-ChildItem -Path $buildDir -Recurse -File | ForEach-Object {
  $rel = $_.FullName.Substring($buildDir.Length + 1).Replace([char]92, [char]47)
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
}
$zip.Dispose()
Write-Host "Created: ${zipName}"
`;

const ps1Path = join(DIST, '_build_zip.ps1');
writeFileSync(ps1Path, ps1);
try {
  execSync(`powershell -ExecutionPolicy Bypass -File "${ps1Path}"`, { stdio: 'inherit' });
} finally {
  if (existsSync(ps1Path)) rmSync(ps1Path);
}

console.log('Build complete: ' + zipName);
console.log('  entryHash: ' + entryHash);
console.log('  zipHash:   ' + zipHash);
console.log('  version:   ' + version);
