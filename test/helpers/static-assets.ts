import type { StaticAsset, StaticAssets } from '../../src/static-assets.js';

export function fixtureStaticAssets(): StaticAssets {
  const html = Buffer.from('<!doctype html><html><head><link rel="stylesheet" href="/assets/index-AbCd1234.css"><script type="module" src="/assets/index-EfGh5678.js"></script></head><body><div id="root"></div></body></html>');
  const files = new Map<string, StaticAsset>([
    ['/assets/index-AbCd1234.css', { body: Buffer.from('body{color:#222}'), contentType: 'text/css; charset=utf-8' }],
    ['/assets/index-EfGh5678.js', { body: Buffer.from('document.body.dataset.fixture="loaded"'), contentType: 'text/javascript; charset=utf-8' }],
  ]);
  return { indexHtml: html, files };
}
