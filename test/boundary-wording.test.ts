import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skill = (name: string) => readFile(join(repoRoot, 'skills', name, 'SKILL.md'), 'utf8');

// A guard sentence states what OUR tools won't do; it must never read as a
// claim that we block, prevent, restrict or disable the agent's own shell.
const shellControlClaim = /(?<!never )(?:block(?:s|ing|ed)?|prevent(?:s|ed|ing)?|restrict(?:s|ed|ing)?|disabl(?:e|es|ed|ing))[^.\n]{0,80}?(?:shell|terminal)/i;

test('reconciliation tasks never present side-effect ops as verification', async t => {
  const handoff = await skill('new-task');
  assert.match(handoff, /never rerun tests, sends, or other side effects as a substitute for a missing handoff/,
    'handoff read-back forbids side effects as a substitute');
  assert.match(handoff, /read-back itself runs nothing/, 'read-back states its own side-effect-freedom');
  const review = await skill('learn-from-mistake');
  assert.match(review, /they do not authorize other actions/, 'evidence review authorizes nothing else');
  const refresh = await skill('update');
  assert.match(refresh, /runs no service, verify, lease, or install operations/, 'refresh verification is a free read only');
  for (const [name, body] of [['new-task', handoff], ['learn-from-mistake', review], ['update', refresh]] as const) {
    assert.doesNotMatch(body, shellControlClaim, `${name}: no shell-control claim`);
  }
});

test('skills state our tools’ limits without claiming the agent’s shell', async () => {
  const onboarding = await skill('onboarding');
  assert.match(onboarding, /never blocks or limits your own shell/, 'refusals scoped to our own tools');
  assert.doesNotMatch(onboarding, shellControlClaim);
  const handoff = await skill('new-task');
  assert.match(handoff, /never block your own shell access/, 'read-back scoped to our own tools');
});

test('MCP instructions claim no control over the agent’s shell', async () => {
  const mcpSource = await readFile(join(repoRoot, 'src', 'mcp.ts'), 'utf8');
  assert.doesNotMatch(mcpSource, /shell/i, 'bridge instructions never mention shell access');
  assert.doesNotMatch(mcpSource, shellControlClaim);
});
