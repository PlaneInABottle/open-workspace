import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class DashboardBuildError extends Error {
  constructor() {
    super('Dashboard assets are missing or invalid. Run `pnpm build` before starting OpenWorkspace.');
    this.name = 'DashboardBuildError';
  }
}

export interface StaticAsset {
  body: Buffer;
  contentType: string;
}

export interface StaticAssets {
  indexHtml: Buffer;
  files: ReadonlyMap<string, StaticAsset>;
}

interface ManifestEntry {
  file?: unknown;
  isEntry?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
  css?: unknown;
  assets?: unknown;
}

const defaultAssetRoot = fileURLToPath(new URL('../web-dist/', import.meta.url));
const mimeTypes: Record<string, string> = {
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hashedAssetPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('assets/') || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return false;
  if (value.endsWith('.map')) return false;
  const basename = segments.at(-1) || '';
  const extension = extname(basename).toLowerCase();
  if (!mimeTypes[extension]) return false;
  const stem = basename.slice(0, -extension.length);
  return /^.+-[A-Za-z0-9_-]{8,}$/.test(stem);
}

async function readRegularFile(root: string, relativePath: string): Promise<Buffer> {
  const segments = relativePath.split('/');
  let path = root;
  for (let index = 0; index < segments.length; index++) {
    path = join(path, segments[index]);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new DashboardBuildError();
    if (index < segments.length - 1 && !stat.isDirectory()) throw new DashboardBuildError();
    if (index === segments.length - 1 && !stat.isFile()) throw new DashboardBuildError();
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new DashboardBuildError();
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new DashboardBuildError();
  return value;
}

function referencedAssetPaths(html: string): string[] {
  if (/<style\b|\sstyle\s*=/i.test(html)) throw new DashboardBuildError();
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  const moduleScripts = scripts.filter(([, attributes]) => /\btype=["']module["']/i.test(attributes));
  if (!moduleScripts.length || scripts.some(([, attributes, body]) => !/\bsrc=["'][^"']+["']/i.test(attributes) || body.trim())) {
    throw new DashboardBuildError();
  }
  const paths: string[] = [];
  for (const match of html.matchAll(/<(?:script|link|img|source)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi)) {
    paths.push(match[1]);
  }
  return paths;
}

export async function loadStaticAssets(assetRoot = defaultAssetRoot): Promise<StaticAssets> {
  try {
    const rootPath = resolve(assetRoot);
    const rootStat = await lstat(rootPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new DashboardBuildError();
    const root = await realpath(rootPath);
    const manifestText = (await readRegularFile(root, 'manifest.json')).toString('utf8');
    const manifest: unknown = JSON.parse(manifestText);
    if (!record(manifest) || !record(manifest['index.html'])) throw new DashboardBuildError();

    const htmlEntry = manifest['index.html'] as ManifestEntry;
    if (!hashedAssetPath(htmlEntry.file) || !htmlEntry.file.endsWith('.js') || htmlEntry.isEntry !== true) throw new DashboardBuildError();

    const keys = new Set(Object.keys(manifest));
    const paths = new Set<string>();
    let javascriptEntries = 0;
    for (const [key, value] of Object.entries(manifest)) {
      if (!record(value)) throw new DashboardBuildError();
      const entry = value as ManifestEntry;
      if (typeof entry.file !== 'string') throw new DashboardBuildError();
      if (!hashedAssetPath(entry.file)) {
        throw new DashboardBuildError();
      } else {
        paths.add(entry.file);
        if (entry.isEntry === true && entry.file.endsWith('.js')) javascriptEntries++;
      }
      for (const keyReference of [...stringList(entry.imports), ...stringList(entry.dynamicImports)]) {
        if (!keys.has(keyReference)) throw new DashboardBuildError();
      }
      for (const fileReference of [...stringList(entry.css), ...stringList(entry.assets)]) {
        if (!hashedAssetPath(fileReference)) throw new DashboardBuildError();
        paths.add(fileReference);
      }
    }
    if (javascriptEntries !== 1) throw new DashboardBuildError();

    const indexHtml = await readRegularFile(root, 'index.html');
    const html = indexHtml.toString('utf8');
    if (!/<div\b[^>]*\bid=["']root["']/i.test(html)) throw new DashboardBuildError();

    const files = new Map<string, StaticAsset>();
    for (const path of paths) {
      const contentType = mimeTypes[extname(path).toLowerCase()];
      if (!contentType) throw new DashboardBuildError();
      files.set(`/${path}`, { body: await readRegularFile(root, path), contentType });
    }

    const htmlPaths = referencedAssetPaths(html);
    const entryScript = Object.entries(manifest).find(([, value]) =>
      record(value) && value.isEntry === true && typeof value.file === 'string' && value.file.endsWith('.js'))?.[1] as ManifestEntry | undefined;
    if (!entryScript || !htmlPaths.includes(`/` + entryScript.file)) throw new DashboardBuildError();
    for (const path of htmlPaths) {
      if (!path.startsWith('/assets/') || path.includes('?') || path.includes('#') || !files.has(path)) {
        throw new DashboardBuildError();
      }
    }

    return { indexHtml, files };
  } catch {
    throw new DashboardBuildError();
  }
}
