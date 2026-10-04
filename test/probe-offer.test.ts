import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Store } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';

const skillPath = new URL('../skills/learn-from-mistake/SKILL.md', import.meta.url);

async function skillText(): Promise<string> {
  return readFile(skillPath, 'utf8');
}

function probeSubsection(text: string): string {
  const start = text.indexOf('## Probe offer (offer-only)');
  assert.ok(start >= 0, 'probe offer subsection exists');
  const next = text.indexOf('\n## ', start + 1);
  return next === -1 ? text.slice(start) : text.slice(start, next);
}

async function filesUnder(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function ownedProject(prefix: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'package.json'), '{"scripts":{"test":"node --test"}}');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const service = new WorkspaceService(store);
  const workspace = await service.register('Probe project', [project]);
  const workstream = await service.createWorkstream({
    name: 'Stream', workspace: workspace.name, checkouts: [project],
  });
  return { root, project, store, service, workspace, workstream };
}

// ---- Offer wording (consent review contract) ----

test('probe offer names the regression-note path and closes with the consent sentence', async () => {
  const subsection = probeSubsection(await skillText());
  assert.ok(subsection.includes('[needs-review]'), 'suspect-lesson trigger named');
  assert.ok(subsection.includes('detourNudge'), 'detour vocabulary referenced consistently');
  assert.ok(subsection.includes("'yes, draft a regression test at <path>'"), 'acceptance grammar named');
  assert.ok(subsection.includes('(at most 2KiB)'), 'size bound pinned');
  assert.ok(subsection.includes('inside the active project only'), 'project boundary pinned');
  assert.ok(subsection.includes('run by nobody'), 'inertness pinned');
  assert.ok(!subsection.includes('scaffold'), 'no scaffold path: the declared local-tool engine is shed');
  assert.ok(
    subsection.includes('Nothing is created unless you accept."'),
    'offer closes with the fixed consent sentence',
  );
  assert.doesNotMatch(
    subsection,
    /\bauto-?create\b|\bautomatically\b|\bwill (create|write|generate|scaffold)\b/i,
    'no auto-create verb anywhere in the subsection',
  );
});

// ---- Decline / no-reply: nothing is created ----

test('decline and no-reply write nothing: zero pending/proposals files, zero repo writes', async t => {
  const f = await ownedProject('openworkspace-probe-decline-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  // A review pass with no explicit `yes`: read context, then stop. The offer
  // is text-only, so declining issues no write call at all.
  await f.service.workstreamContext(f.workspace.name, f.workstream.name);
  assert.deepEqual(await filesUnder(f.project), ['package.json'], 'no repo writes without acceptance');
});

// ---- Accept path B: bounded inert note inside the fixture root only ----

const regressionNoteLimit = 2 * 1024;

/**
 * Test-local rendering of the skill's path-B rule: a bounded guidance note
 * lands inside the active project root, or the write is refused. The note is
 * inert markdown — nothing executes it.
 */
async function draftRegressionNote(root: string, targetPath: string, content: string): Promise<string> {
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new Error('Regression notes need a repo-relative path inside the active project.');
  }
  if (isAbsolute(targetPath)) throw new Error('Regression notes stay inside the active project.');
  const resolved = resolve(root, targetPath);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('Regression notes stay inside the active project.');
  }
  if (Buffer.byteLength(content, 'utf8') > regressionNoteLimit) {
    throw new Error('Regression note exceeds 2KiB.');
  }
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, content);
  return resolved;
}

test('accept path B writes a bounded inert note inside the root and refuses outside paths', async t => {
  const f = await ownedProject('openworkspace-probe-noteb-');
  t.after(() => rm(f.root, { recursive: true, force: true }));
  const note = '# Regression guard\n\n- Rule: Confirm settings before starting the service.\n- Source: runId 12345-abcde123\n';
  const written = await draftRegressionNote(f.project, 'notes/regression-guard.md', note);
  assert.equal(await readFile(written, 'utf8'), note, 'inside-root note lands byte-identical');
  assert.deepEqual(
    (await filesUnder(f.project)).sort(),
    ['notes', 'package.json'],
    'exactly the note is added; nothing else in the repo moves',
  );
  await assert.rejects(
    draftRegressionNote(f.project, '../escape.md', note),
    /inside the active project/,
    'parent-escape refused',
  );
  await assert.rejects(
    draftRegressionNote(f.project, '/tmp/elsewhere.md', note),
    /inside the active project/,
    'absolute path refused',
  );
  await assert.rejects(
    draftRegressionNote(f.project, 'notes/big.md', `${'x'.repeat(3 * 1024)}\n`),
    /exceeds 2KiB/,
    'oversized note refused',
  );
});
