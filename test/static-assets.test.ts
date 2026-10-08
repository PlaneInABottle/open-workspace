import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/http.js';
import { DashboardBuildError, loadSeaStaticAssets, loadStaticAssets } from '../src/static-assets.js';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';

const jsPath = 'assets/index-EfGh5678.js';
const cssPath = 'assets/index-AbCd1234.css';

async function buildFixture(root: string, js = jsPath, css = cssPath) {
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'index.html'), `<!doctype html><html><head><link rel="stylesheet" href="/${css}"><script type="module" src="/${js}"></script></head><body><div id="root"></div></body></html>`);
  await writeFile(join(root, 'manifest.json'), JSON.stringify({
    'index.html': { file: js, src: 'index.html', isEntry: true, css: [css] },
  }));
  await writeFile(join(root, js), 'document.body.dataset.ready="yes";');
  await writeFile(join(root, css), 'body{color:#222}');
}

function requestRaw(origin: string, target: string) {
  const { port } = new URL(origin);
  return new Promise<{ status: number; contentType: string | undefined; body: string }>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: Number(port),
      path: target,
      headers: { Host: `127.0.0.1:${port}` },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        contentType: response.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('production asset preflight serves only the manifest bundle and safe response types', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-assets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'web-dist');
  await buildFixture(dist);
  const assets = await loadStaticAssets(dist);
  const app = createApp(new WorkspaceService(new Store(join(root, 'unused-state'))), { mcpToken: 'f'.repeat(64), assets });
  const origin = await app.listen(0);
  t.after(() => app.close());

  const html = await fetch(origin);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(html.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  assert.ok(!(await html.text()).includes('f'.repeat(64)));

  const script = await fetch(`${origin}/${jsPath}`);
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.match(await script.text(), /dataset\.ready/);
  const stylesheet = await fetch(`${origin}/${cssPath}`);
  assert.equal(stylesheet.status, 200);
  assert.equal(stylesheet.headers.get('content-type'), 'text/css; charset=utf-8');

  for (const target of [
    '/manifest.json', '/index.html', '/app.js', '/styles.css', '/src/http.ts', '/.env', '/assets/index-AbCd1234.js.map',
    '/node_modules/tsx/dist/cli.mjs', '/connection.json', '/state.json', '/assets/missing-AbCd1234.js',
  ]) {
    const response = await requestRaw(origin, target);
    assert.equal(response.status, 404, target);
    assert.ok(!response.contentType?.startsWith('text/html'), target);
  }
  const unknownApi = await fetch(`${origin}/api/not-a-route`, { headers: { Authorization: `Bearer ${'f'.repeat(64)}` } });
  assert.equal(unknownApi.status, 403);
  assert.match(unknownApi.headers.get('content-type') || '', /^application\/json/);
});

test('asset validation accepts Vite URL-safe hashes with internal and trailing hyphens without widening the allowlist', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-assets-url-hash-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'web-dist');
  const js = 'assets/index-BndJFna-.js';
  const css = 'assets/theme-dark-AbCd_EfGh-.css';
  const vendor = 'assets/vendor-shared-Aa-Bb_Cc-.js';
  await buildFixture(dist, js, css);
  await writeFile(join(dist, vendor), 'document.body.dataset.vendor="loaded";');
  const manifestPath = join(dist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { file: string; isEntry?: boolean; imports?: string[] }>;
  manifest['vendor.js'] = { file: vendor, isEntry: false };
  await writeFile(manifestPath, JSON.stringify(manifest));

  const assets = await loadStaticAssets(dist);
  assert.ok(assets.files.has(`/${js}`));
  assert.ok(assets.files.has(`/${css}`));
  assert.ok(assets.files.has(`/${vendor}`));

  const app = createApp(new WorkspaceService(new Store(join(root, 'unused-state'))), { assets });
  const origin = await app.listen(0);
  t.after(() => app.close());
  for (const path of [js, css, vendor]) assert.equal((await fetch(`${origin}/${path}`)).status, 200, path);
  assert.equal((await fetch(`${origin}/assets/not-listed-AbCd1234.js`)).status, 404);

  for (const invalidFile of ['assets/index-short12.js', 'assets/index-invalid!123.js', 'assets/index-AbCd1234.js.map']) {
    manifest['index.html'].file = invalidFile;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(loadStaticAssets(dist), DashboardBuildError, invalidFile);
  }
});

test('asset routes reject raw and encoded traversal and separator paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-assets-paths-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'web-dist');
  await buildFixture(dist);
  const assets = await loadStaticAssets(dist);
  const app = createApp(new WorkspaceService(new Store(join(root, 'unused-state'))), { assets });
  const origin = await app.listen(0);
  t.after(() => app.close());

  for (const target of ['/../src/http.ts', '/assets/../src/http.ts', '/assets/%2e%2e/src/http.ts', '/assets%2findex-AbCd1234.css', '/assets%5cindex-AbCd1234.css', '/%']) {
    assert.equal((await requestRaw(origin, target)).status, 404, target);
  }
});

test('asset preflight rejects missing, invalid, and symlinked bundles without exposing paths', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-assets-invalid-')));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(loadStaticAssets(join(root, 'missing')), error => {
    assert.ok(error instanceof DashboardBuildError);
    assert.ok(!error.message.includes(root));
    assert.match(error.message, /pnpm build/);
    return true;
  });

  const invalid = join(root, 'invalid');
  await mkdir(invalid);
  await writeFile(join(invalid, 'manifest.json'), '{not json');
  await assert.rejects(loadStaticAssets(invalid), DashboardBuildError);

  const linked = join(root, 'linked');
  await buildFixture(linked);
  const outside = join(root, 'outside.js');
  await writeFile(outside, 'private');
  await rm(join(linked, jsPath));
  await symlink(outside, join(linked, jsPath));
  await assert.rejects(loadStaticAssets(linked), DashboardBuildError);
});

test('asset preflight rejects manifest traversal and inline HTML styling/scripts', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-assets-contract-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dist = join(root, 'web-dist');
  await buildFixture(dist);

  const manifestPath = join(dist, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, { file: string }>;
  manifest['index.html'].file = '../src/http.ts';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(loadStaticAssets(dist), DashboardBuildError);

  await buildFixture(dist);
  await writeFile(join(dist, 'index.html'), '<!doctype html><html><head><style>body{color:red}</style></head><body><div id="root"></div><script>window.injected=true</script></body></html>');
  await assert.rejects(loadStaticAssets(dist), DashboardBuildError);
});

test('SEA asset preflight accepts a valid manifest through an injected reader', async () => {
  const files = new Map<string, Buffer>([
    ['index.html', Buffer.from(`<!doctype html><html><head><link rel="stylesheet" href="/${cssPath}"><script type="module" src="/${jsPath}"></script></head><body><div id="root"></div></body></html>`, 'utf8')],
    ['manifest.json', Buffer.from(JSON.stringify({
      'index.html': { file: jsPath, src: 'index.html', isEntry: true, css: [cssPath] },
    }), 'utf8')],
    [jsPath, Buffer.from('document.body.dataset.ready="yes";', 'utf8')],
    [cssPath, Buffer.from('body{color:#222}', 'utf8')],
  ]);
  const readSea = (relativePath: string) => {
    const body = files.get(relativePath);
    if (!body) throw new Error(`missing SEA asset: ${relativePath}`);
    return Promise.resolve(body);
  };

  const assets = await loadSeaStaticAssets(readSea);
  assert.ok(assets.indexHtml.toString('utf8').includes('id="root"'));
  assert.equal(assets.files.get(`/${jsPath}`)?.contentType, 'text/javascript; charset=utf-8');
  assert.equal(assets.files.get(`/${cssPath}`)?.contentType, 'text/css; charset=utf-8');
});

test('SEA asset preflight rejects invalid hashes and missing bytes through an injected reader', async () => {
  const files = new Map<string, Buffer>([
    ['index.html', Buffer.from(`<!doctype html><html><head><script type="module" src="/${jsPath}"></script></head><body><div id="root"></div></body></html>`, 'utf8')],
    ['manifest.json', Buffer.from(JSON.stringify({
      'index.html': { file: jsPath, src: 'index.html', isEntry: true },
    }), 'utf8')],
    [jsPath, Buffer.from('document.body.dataset.ready="yes";', 'utf8')],
  ]);
  const readSea = (relativePath: string) => {
    const body = files.get(relativePath);
    if (!body) throw new Error(`missing SEA asset: ${relativePath}`);
    return Promise.resolve(body);
  };

  files.set('manifest.json', Buffer.from(JSON.stringify({
    'index.html': { file: 'assets/index-short12.js', src: 'index.html', isEntry: true },
  }), 'utf8'));
  await assert.rejects(loadSeaStaticAssets(readSea), DashboardBuildError);

  files.set('manifest.json', Buffer.from(JSON.stringify({
    'index.html': { file: jsPath, src: 'index.html', isEntry: true },
  }), 'utf8'));
  files.delete(jsPath);
  await assert.rejects(loadSeaStaticAssets(readSea), DashboardBuildError);
});
