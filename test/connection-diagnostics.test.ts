import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = await readFile(join(repoRoot, 'skills', 'onboarding', 'SKILL.md'), 'utf8');

test('onboarding skill carries a secret-free connection-diagnostics section', async () => {
  assert.match(text, /## Connection diagnostics/, 'diagnostics live in the setup skill, not a new tool');
});

test('diagnostics matrix renders loaded/disabled/missing states with a remedy each', async () => {
  assert.match(text, /`loaded`[^]*?workspace_list/, 'loaded: free-read verification');
  assert.match(text, /`disabled`[^]*?[Ee]nable it in the client/, 'disabled: client-side re-enable, never a service call');
  assert.match(text, /`missing`[^]*?[Rr]e-paste the setup prompt/, 'missing: setup prompt, never hand-written commands');
  assert.match(text, /never paste tokens/, 'prohibits secrets instead of requesting them');
});

test('diagnostics name the exact scope served and the catalog generation source', async () => {
  assert.match(text, /OPENWORKSPACE_HOME/, 'state-directory scope served');
  assert.match(text, /dashboard needs no browser session/, 'dashboard scope distinguished: no browser session');
  assert.match(text, /project-local/, 'project-local vs user-wide install scope');
  assert.match(text, /skill\/<name>/, 'live catalog prompts named');
  assert.match(text, /update skill/, 'snapshot refresh path named');
  assert.match(text, /served text, not the snapshot, decides/, 'authoritative generation source stated');
});

test('diagnostics emit no tokens or paths-with-secrets', async () => {
  const secretPattern = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/|\/home\/|[a-f0-9]{64})/;
  assert.doesNotMatch(text, secretPattern);
});
