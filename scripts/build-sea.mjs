// Build the macOS arm64 single-executable (SEA) binary (M1 only).
//
// Pipeline: `vite build` -> esbuild CJS bundle -> enumerate web-dist/** +
// skills/*/SKILL.md into the sea-config assets dict -> version-matched
// downloaded Node 22 `node --experimental-sea-config` generates the blob ->
// `cp` the SAME Node 22 binary -> (darwin) `codesign --remove-signature` ->
// pinned postject injects NODE_SEA_BLOB (+ --macho-segment-name NODE_SEA) with
// the documented sentinel fuse -> (darwin) ad-hoc `codesign --sign -`.
//
// Supply chain: the Node 22 base (exact patch below) is SHASUMS256-verified
// before use; postject runs one-shot via a pinned `npx postject@<ver>`
// (build tool only, never a product dependency or lockfile entry).
// Blob-gen and injection-target Node versions are identical by construction
// (the same downloaded binary). Artifacts live in gitignored `dist/`.
//
// Usage: `node scripts/build-sea.mjs` from this source directory.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(join(fileURLToPath(new URL('.', import.meta.url)), '..'));
const dist = join(root, 'dist');
const cacheDir = join(dist, '.sea-cache');

// Pinned supply chain (Node 22 LTS base: declared runtime floor; >=22.20.0
// required because sea.getAssetKeys() shipped in v22.20.0).
const NODE_VERSION = '22.23.3';
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;
const NODE_TARBALL = `node-v${NODE_VERSION}-darwin-arm64.tar.gz`;
const POSTJECT_VERSION = '1.0.0-alpha.6';
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const BINARY_NAME = 'openworkspace-darwin-arm64';

function log(message) {
  console.log(`[build-sea] ${message}`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`);
  execFileSync(command, args, { stdio: 'inherit', cwd: root, ...options });
}

function findEsbuild() {
  // pnpm-workspace.yaml allowBuilds pins esbuild@0.28.2 for the build only;
  // resolve it from the existing store tree (vite's dependency) — never a
  // new global install or lockfile entry.
  const store = join(root, 'node_modules', '.pnpm');
  const hit = readdirSync(store).filter(name => /^esbuild@\d/.test(name)).sort().at(-1);
  if (!hit) throw new Error('esbuild not found under node_modules/.pnpm (run pnpm install first).');
  const bin = join(store, hit, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (!existsSync(bin)) throw new Error(`esbuild binary missing at ${bin}.`);
  log(`esbuild: ${relative(root, bin)} (${execFileSync(bin, ['--version']).toString().trim()})`);
  return bin;
}

function walkFiles(directory, base = directory) {
  const out = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`refusing symlink in SEA assets: ${relative(root, abs)}`);
    if (entry.isDirectory()) out.push(...walkFiles(abs, base));
    else if (entry.isFile()) out.push({ abs, rel: relative(base, abs).split(sep).join(posix.sep) });
    else throw new Error(`refusing non-regular file in SEA assets: ${relative(root, abs)}`);
  }
  return out;
}

function download(url, destination) {
  if (existsSync(destination)) {
    log(`cached: ${relative(root, destination)}`);
    return;
  }
  log(`GET ${url}`);
  const response = awaitFetch(url);
  writeFileSync(destination, response);
}

function awaitFetch(url) {
  // Synchronous GET via curl (macOS system binary, trusted absolute path).
  return execFileSync('/usr/bin/curl', ['-fsSL', '--retry', '3', url], { maxBuffer: 512 * 1024 * 1024 });
}

function verifyShasum(tarballPath, shasumsPath) {
  const line = readFileSync(shasumsPath, 'utf8').split('\n').find(entry => entry.trim().endsWith(`  ${NODE_TARBALL}`));
  if (!line) throw new Error(`SHASUMS256.txt has no entry for ${NODE_TARBALL}.`);
  const expected = line.split(/\s+/)[0];
  const actual = createHash('sha256').update(readFileSync(tarballPath)).digest('hex');
  if (actual !== expected) throw new Error(`SHASUM mismatch for ${NODE_TARBALL}: expected ${expected}, got ${actual}.`);
  log(`SHASUMS256 verified: ${NODE_TARBALL} (${expected.slice(0, 16)}…)`);
}

function ensureNode22() {
  mkdirSync(cacheDir, { recursive: true });
  const tarballPath = join(cacheDir, NODE_TARBALL);
  const shasumsPath = join(cacheDir, `SHASUMS256.txt-${NODE_VERSION}`);
  download(`${NODE_DIST}/${NODE_TARBALL}`, tarballPath);
  download(`${NODE_DIST}/SHASUMS256.txt`, shasumsPath);
  verifyShasum(tarballPath, shasumsPath);
  const binaryPath = join(cacheDir, `node-v${NODE_VERSION}-darwin-arm64`, 'bin', 'node');
  if (!existsSync(binaryPath)) {
    log(`extracting ${NODE_TARBALL}`);
    execFileSync('/usr/bin/tar', ['-xzf', tarballPath, '-C', cacheDir]);
  }
  const version = execFileSync(binaryPath, ['--version']).toString().trim();
  if (version !== `v${NODE_VERSION}`) throw new Error(`Node base mismatch: expected v${NODE_VERSION}, got ${version}.`);
  log(`Node base: ${version} (${relative(root, binaryPath)})`);
  return binaryPath;
}

// --- main -----------------------------------------------------------------

mkdirSync(dist, { recursive: true });

// 1. Frontend bundle (the blob embeds its output, so always rebuild first).
run('pnpm', ['build']);

// 2. Single-file CJS bundle of the real service/MCP graph via the SEA entry.
const esbuild = findEsbuild();
const bundlePath = join(dist, 'sea-entry.cjs');
const importMetaShim = JSON.stringify(`file://${join(root, 'src', 'sea-entry.ts')}`);
run(esbuild, ['src/sea-entry.ts',
  '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundlePath}`,
  `--define:import.meta.url=${importMetaShim}`,
  '--log-level=warning',
]);
log(`bundle: ${relative(root, bundlePath)} (${statSync(bundlePath).size} bytes)`);

// 3. Enumerate blob assets: web-dist/** plus skills/*/SKILL.md.
const assets = {};
for (const { abs, rel } of walkFiles(join(root, 'web-dist'))) {
  assets[`web-dist/${rel}`] = abs;
}
for (const name of readdirSync(join(root, 'skills')).sort()) {
  const abs = join(root, 'skills', name, 'SKILL.md');
  if (!statSync(abs, { throwIfNoEntry: false })?.isFile()) throw new Error(`missing SKILL.md for skill "${name}".`);
  assets[`skills/${name}/SKILL.md`] = abs;
}
log(`assets: ${Object.keys(assets).length} keys (${Object.keys(assets).filter(k => k.startsWith('web-dist/')).length} web-dist, ${Object.keys(assets).filter(k => k.startsWith('skills/')).length} skills)`);

// 4. sea-config (no snapshot/codecache: the blob is generated on darwin-arm64
// and must stay platform-neutral; execArgv none closes preload injection).
const blobPath = join(dist, 'sea-prep.blob');
const seaConfigPath = join(dist, 'sea-config.json');
writeFileSync(seaConfigPath, JSON.stringify({
  main: bundlePath,
  output: blobPath,
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  execArgvExtension: 'none',
  assets,
}, null, 2) + '\n');
log(`sea-config: ${relative(root, seaConfigPath)}`);

// 5. Version-matched Node 22 generates the blob.
const node22 = ensureNode22();
run(node22, ['--experimental-sea-config', seaConfigPath]);
log(`blob: ${relative(root, blobPath)} (${statSync(blobPath).size} bytes)`);

// 6. Inject the blob into a copy of the SAME Node 22 binary.
const binaryPath = join(dist, BINARY_NAME);
execFileSync('/bin/cp', [node22, binaryPath]);
run('/usr/bin/codesign', ['--remove-signature', binaryPath]);
run('npx', ['-y', `postject@${POSTJECT_VERSION}`, binaryPath, 'NODE_SEA_BLOB', blobPath,
  '--sentinel-fuse', SENTINEL_FUSE, '--macho-segment-name', 'NODE_SEA']);
run('/usr/bin/codesign', ['--sign', '-', binaryPath]);
execFileSync('/bin/chmod', ['+x', binaryPath]);
log(`binary: ${relative(root, binaryPath)} (${statSync(binaryPath).size} bytes)`);

// 7. Smoke: the binary answers --help without a checkout dependency.
// (No --version flag exists by contract; the Node base version is logged
// from the version-matched binary in step 5.)
const help = execFileSync(binaryPath, ['--help']).toString();
if (!help.includes('openworkspace start')) throw new Error('--help smoke failed.');
log(`smoke: --help OK (postject ${POSTJECT_VERSION})`);
log('done. Next: isolated-cwd M1 gate (see plan) — never a repo-cwd boot.');
