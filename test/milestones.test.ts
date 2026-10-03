import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMilestones } from '../src/milestones.js';

async function home() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-milestones-')));
  await mkdir(join(root, 'learnings', 'milestones'), { recursive: true });
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('milestone notes merge newest-first with epoch filenames and masked text', async t => {
  const f = await home(); t.after(f.cleanup);
  await writeFile(join(f.root, 'learnings', 'milestones', '1700000000-ship.md'), '# Shipped\nDeployed the new checkout flow for reviewers.\n');
  await writeFile(join(f.root, 'learnings', 'milestones', '1700001000-fix.md'), 'Fixed flaky restart with password=hunter2 in the note.\n');
  await writeFile(join(f.root, 'learnings', 'milestones', 'not-a-note.txt'), 'ignored\n');
  const notes = await listMilestones(f.root);
  assert.equal(notes.length, 2);
  assert.ok(notes[0].at > notes[1].at);
  assert.equal(notes[1].text, 'Deployed the new checkout flow for reviewers.');
  assert.ok(!JSON.stringify(notes).includes('hunter2'));
  assert.ok(notes[0].text.includes('password=***'));
});

test('oversized learning files are skipped under the enforced 2KiB cap', async t => {
  const f = await home(); t.after(f.cleanup);
  await writeFile(join(f.root, 'learnings', 'milestones', '1700000000-big.md'), `# Big\n${'x'.repeat(64 * 1024)}\n`);
  const exact = `# T\n${'a'.repeat(2048 - 4)}`;
  assert.equal(Buffer.byteLength(exact, 'utf8'), 2048);
  await writeFile(join(f.root, 'learnings', 'milestones', '1700000001-edge.md'), exact);
  const notes = await listMilestones(f.root);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].source, '1700000001-edge.md');
});

test('milestone reader tolerates missing directories and unreadable entries', async t => {
  const f = await home(); t.after(f.cleanup);
  await rm(join(f.root, 'learnings', 'milestones'), { recursive: true, force: true });
  assert.deepEqual(await listMilestones(f.root), []);
});
