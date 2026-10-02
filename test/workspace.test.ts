import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, readPrivateJson, writePrivateJson, acquireStateLock, ensurePrivateDirectory } from '../src/store.js';
import { WorkspaceService } from '../src/workspace.js';
import { approvedRoot, toolAvailability } from '../src/discovery.js';

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-test-')));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(project, 'web'));
  await writeFile(join(project, 'web/package.json'), JSON.stringify({
    scripts: { dev: 'SECRET_SENTINEL=fixture-only pnpm vite', test: 'node --test' },
  }));
  await writeFile(join(project, 'web/.env'), 'PRIVATE_SENTINEL=not-to-be-read');
  await mkdir(join(project, 'api'));
  await writeFile(join(project, 'api/pom.xml'), '<project/>');
  await writeFile(join(project, 'compose.yaml'), 'services: {}');
  await writeFile(join(project, 'AGENTS.md'), 'UNTRUSTED_INSTRUCTION_SENTINEL');
  const store = new Store(join(root, 'state'));
  await store.initialize();
  return { root, project, store, service: new WorkspaceService(store), cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('proposal does not read a directory; only approved workspaces can be inspected', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const missing = await f.service.propose('Not present', [join(f.root, 'not-present')]);
  assert.ok(missing.id);
  await assert.rejects(f.service.inspect(missing.id), /not approved/);
  await assert.rejects(f.service.approve(missing.id));
  assert.equal((await f.store.read()).proposals.length, 1);
  const proposal = await f.service.propose('Project', [f.project]);
  const workspace = await f.service.approve(proposal.id);
  const found = await f.service.inspect(workspace.id);
  assert.deepEqual(found.roots[0].repositories.map(repo => repo.name).sort(), ['api','project','web']);
  assert.deepEqual(found.roots[0].repositories.find(repo => repo.name === 'web')?.scriptNames, ['dev','test']);
  assert.ok(found.roots[0].repositories.every(repo => repo.processState === 'not_connected' && repo.readiness === 'not_checked'));
  const result = JSON.stringify(found);
  assert.ok(!result.includes('PRIVATE_SENTINEL'));
  assert.ok(!result.includes('SECRET_SENTINEL'));
  assert.ok(!result.includes('UNTRUSTED_INSTRUCTION_SENTINEL'));
  assert.equal(await readFile(join(f.project, 'web/.env'), 'utf8'), 'PRIVATE_SENTINEL=not-to-be-read');
});

test('discovery skips symlinked repos and manifests, hidden secret folders and oversized input', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await writeFile(join(outside, 'package.json'), '{"scripts":{"private":"secret"}}');
  await symlink(outside, join(f.project, 'linked-repo'));
  await mkdir(join(f.project, 'linked-manifest'));
  await symlink(join(outside, 'package.json'), join(f.project, 'linked-manifest/package.json'));
  await mkdir(join(f.project, '.secrets'));
  await writeFile(join(f.project, '.secrets/package.json'), '{}');
  await mkdir(join(f.project, 'large')); await writeFile(join(f.project, 'large/package.json'), 'X'.repeat(300 * 1024));
  const proposal = await f.service.propose('Project', [f.project]);
  const workspace = await f.service.approve(proposal.id);
  const found = await f.service.inspect(workspace.id);
  assert.ok(!found.roots[0].repositories.some(repo => /linked|secrets|large/.test(repo.name)));
  assert.equal(found.roots[0].warnings.length, 1);
});

test('approved root identity cannot be replaced with a symlink', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const proposal = await f.service.propose('Project', [f.project]);
  const workspace = await f.service.approve(proposal.id);
  await rm(f.project, { recursive: true });
  await mkdir(join(f.root, 'replacement'));
  await symlink(join(f.root, 'replacement'), f.project);
  const inspection = await f.service.inspect(workspace.id);
  assert.equal(inspection.roots[0].unavailable, true);
  assert.deepEqual(inspection.roots[0].repositories, []);
  assert.equal(inspection.roots[0].error?.includes('identity changed'), true);
  await assert.rejects(approvedRoot('/'));
  await assert.rejects(f.service.propose('Relative', ['some/project']));
});

test('root approval rejects a symlink final component after path normalization and commits no roots on partial failure', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const outside = join(f.root, 'outside-target');
  const alias = join(f.root, 'project-alias');
  const outsideManifest = join(outside, 'package.json');
  await mkdir(outside);
  await writeFile(outsideManifest, '{"scripts":{"outside":"OUTSIDE_TARGET_SENTINEL"}}');
  await symlink(outside, alias);

  const canonicalProject = await realpath(f.project);
  assert.equal(await approvedRoot(`${f.project}/`), canonicalProject);
  assert.equal(await approvedRoot(`${f.project}/.`), canonicalProject);

  const proposals: string[] = [];
  for (const selectedAlias of [alias, `${alias}/`, `${alias}/.`]) {
    await assert.rejects(approvedRoot(selectedAlias), /real directory, not a symlink/);
    const proposal = await f.service.propose('Atomic roots', [`${f.project}/.`, selectedAlias]);
    proposals.push(proposal.id);
    await assert.rejects(f.service.approve(proposal.id), /real directory, not a symlink/);

    const state = await f.store.read();
    assert.deepEqual(state.workspaces, []);
    assert.ok(state.proposals.some(item => item.id === proposal.id));
    assert.deepEqual(state.proposals.find(item => item.id === proposal.id)?.roots, [`${f.project}/.`, selectedAlias]);
    await assert.rejects(f.service.inspect(proposal.id), /not approved/);
  }

  const state = await f.store.read();
  assert.deepEqual(state.workspaces, []);
  assert.deepEqual(state.proposals.map(proposal => proposal.id), proposals);
  assert.equal(await readFile(outsideManifest, 'utf8'), '{"scripts":{"outside":"OUTSIDE_TARGET_SENTINEL"}}');
});

test('state persists and concurrent proposals are not lost', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await Promise.all(Array.from({ length: 20 }, (_, i) => f.service.propose(`Project ${i}`, [join(f.root, String(i))])));
  const reopened = new Store(f.store.directory); await reopened.initialize();
  assert.equal((await reopened.read()).proposals.length, 20);
  const proposal = (await reopened.read()).proposals[0];
  await f.service.reject(proposal.id);
  assert.equal((await reopened.read()).proposals.length, 19);
  await assert.rejects(f.service.reject(proposal.id));
});

test('private state rejects public permissions and symlinked files', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await chmod(f.store.directory, 0o755);
  await assert.rejects(new Store(f.store.directory).initialize(), /private/);
  await chmod(f.store.directory, 0o700);
  await chmod(join(f.store.directory, 'state.json'), 0o644);
  await assert.rejects(f.store.read(), /Unsafe/);
  const destination = join(f.root, 'outside.json');
  await writeFile(destination, '{}', { mode: 0o600 });
  const linked = join(f.store.directory, 'linked.json'); await symlink(destination, linked);
  await assert.rejects(readPrivateJson(linked));
  await assert.rejects(writePrivateJson(linked, { overwritten: true }), /Unsafe/);
  assert.equal(await readFile(destination, 'utf8'), '{}');
});

test('missing tools are explicit and checks execute nothing', async () => {
  const tools = await toolAvailability('');
  assert.ok(tools.every(tool => tool.status === 'missing' && !tool.verified));
  assert.deepEqual(tools.map(tool => tool.id), ['git','pm2','docker','agent-browser']);
});

test('a second service cannot mutate the same state directory', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const release = await acquireStateLock(f.store.directory);
  await assert.rejects(acquireStateLock(f.store.directory));
  await release();
  const next = await acquireStateLock(f.store.directory);
  await next();
});

test('state setup rejects redirected ancestors before creating files', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const target = join(f.root, 'real'); await mkdir(target);
  const alias = join(f.root, 'alias'); await symlink(target, alias);
  await assert.rejects(ensurePrivateDirectory(join(alias, 'state')), /symlinks/);
  await assert.rejects(readFile(join(target, 'state/state.json')));
});

test('revoking workspace access prevents subsequent discovery without touching the project', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const proposal = await f.service.propose('Project', [f.project]);
  const workspace = await f.service.approve(proposal.id);
  await f.service.revoke(workspace.id);
  await assert.rejects(f.service.inspect(workspace.id), /not approved/);
  assert.equal(await readFile(join(f.project, 'api/pom.xml'), 'utf8'), '<project/>');
});

test('tool availability requires an executable file, not a directory', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await mkdir(join(f.root, 'git'));
  await writeFile(join(f.root, 'docker'), '#!/bin/sh\nexit 99', { mode: 0o700 });
  const tools = await toolAvailability(f.root);
  assert.equal(tools.find(tool => tool.id === 'git')?.status, 'missing');
  assert.equal(tools.find(tool => tool.id === 'docker')?.status, 'found');
});

test('v1 state migrates every approved and pending path to one root and remains idempotent', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-v1-migration-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  const stateFile = join(stateDirectory, 'state.json');
  const legacy = {
    version: 1,
    workspaces: [
      { id: '11111111-1111-4111-8111-111111111111', name: 'ResAI', path: '/synthetic/wrapper with spaces', createdAt: '2026-01-02T03:04:05.000Z' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'Unrelated project', path: '/synthetic/elsewhere/repo', createdAt: '2026-02-03T04:05:06.000Z' },
      { id: '55555555-5555-4555-8555-555555555555', name: ' ', path: '/synthetic/legacy-blank-name', createdAt: '2026-02-04T04:05:06.000Z' },
    ],
    proposals: [
      { id: '33333333-3333-4333-8333-333333333333', name: 'Pending 🌱', path: "/synthetic/pending's root", createdAt: '2026-03-04T05:06:07.000Z' },
    ],
  };
  await writePrivateJson(stateFile, legacy);
  const migratedStore = new Store(stateDirectory);
  await migratedStore.initialize();
  const migrated = await migratedStore.read();
  assert.equal(migrated.version, 2);
  assert.deepEqual(migrated.workspaces.map(({ id, name, roots, createdAt }) => ({ id, name, roots, createdAt })), [
    { id: legacy.workspaces[0].id, name: 'ResAI', roots: ['/synthetic/wrapper with spaces'], createdAt: legacy.workspaces[0].createdAt },
    { id: legacy.workspaces[1].id, name: 'Unrelated project', roots: ['/synthetic/elsewhere/repo'], createdAt: legacy.workspaces[1].createdAt },
    { id: legacy.workspaces[2].id, name: ' ', roots: ['/synthetic/legacy-blank-name'], createdAt: legacy.workspaces[2].createdAt },
  ]);
  assert.deepEqual(migrated.proposals.map(({ id, name, roots, createdAt }) => ({ id, name, roots, createdAt })), [
    { id: legacy.proposals[0].id, name: 'Pending 🌱', roots: ["/synthetic/pending's root"], createdAt: legacy.proposals[0].createdAt },
  ]);
  const version2Bytes = await readFile(stateFile);
  await migratedStore.initialize();
  assert.deepEqual(await readFile(stateFile), version2Bytes);
});

test('invalid, mixed, unknown, invalid-UTF8 and oversized prior state stays byte-identical', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-state-preserve-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const validV1 = {
    version: 1,
    workspaces: [],
    proposals: [],
  };
  const cases: Buffer[] = [
    Buffer.from('{broken'),
    Buffer.from(JSON.stringify({ ...validV1, version: 3 })),
    Buffer.from(JSON.stringify({ ...validV1, extra: true })),
    Buffer.from(JSON.stringify({ ...validV1, workspaces: [{ id: '66666666-6666-4666-8666-666666666666', name: 'Unknown field', path: '/synthetic/repo', createdAt: '2026-01-01T00:00:00.000Z', unknown: true }] })),
    Buffer.from(JSON.stringify({ version: 1, workspaces: [{ id: '44444444-4444-4444-8444-444444444444', name: 'Mixed', path: '/synthetic/repo', roots: ['/synthetic/other'], createdAt: '2026-01-01T00:00:00.000Z' }], proposals: [] })),
    Buffer.concat([Buffer.from(JSON.stringify(validV1)), Buffer.from([0xff])]),
    Buffer.concat([Buffer.from(JSON.stringify(validV1)), Buffer.alloc(1024 * 1024, 0x20)]),
  ];

  for (let index = 0; index < cases.length; index++) {
    const stateDirectory = join(root, `state-${index}`);
    await mkdir(stateDirectory, { mode: 0o700 });
    const file = join(stateDirectory, 'state.json');
    await writeFile(file, cases[index], { mode: 0o600 });
    await assert.rejects(new Store(stateDirectory).initialize());
    assert.deepEqual(await readFile(file), cases[index]);
  }
});

test('oversized serialized state is rejected before replacing the prior bytes', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-state-cap-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(join(root, 'state'));
  await store.initialize();
  const roots = Array.from({ length: 20 }, (_, index) => `/${'\n'.repeat(4093)}${index.toString().padStart(2, '0')}`);
  const populated = {
    version: 2,
    workspaces: Array.from({ length: 6 }, (_, index) => ({
      id: `${(index + 1).toString().padStart(8, '0')}-1111-4111-8111-111111111111`,
      name: `Large ${index}`,
      roots,
      createdAt: '2026-01-01T00:00:00.000Z',
    })),
    proposals: [],
  };
  const expanded = { ...populated, proposals: [{ id: '77777777-7777-4777-8777-777777777777', name: 'Overflow', roots, createdAt: '2026-01-01T00:00:00.000Z' }] };
  const currentBytes = Buffer.from(JSON.stringify(populated, null, 2));
  const expandedBytes = Buffer.from(JSON.stringify(expanded, null, 2));
  assert.ok(currentBytes.byteLength < 1024 * 1024);
  assert.ok(expandedBytes.byteLength > 1024 * 1024);
  const stateFile = join(store.directory, 'state.json');
  await writeFile(stateFile, currentBytes, { mode: 0o600 });
  await store.initialize();
  const before = await readFile(stateFile);
  const service = new WorkspaceService(store);
  await assert.rejects(service.propose('Overflow', roots), /size limit/);
  assert.deepEqual(await readFile(stateFile), before);
  assert.equal((await readdir(store.directory)).some(name => name.endsWith('.tmp')), false);
});

test('multi-root approval is all-or-nothing, groups same-basename roots independently and allows cross-project reuse', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const firstParent = join(f.root, 'first-parent');
  const secondParent = join(f.root, 'second-parent');
  const firstRoot = join(firstParent, 'same-name');
  const secondRoot = join(secondParent, 'same-name');
  const outsideRoot = join(f.root, 'outside-root');
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  await mkdir(outsideRoot);
  await writeFile(join(firstRoot, 'package.json'), '{}');
  await writeFile(join(secondRoot, 'pom.xml'), '<project/>');
  await writeFile(join(outsideRoot, 'package.json'), '{"scripts":{"secret":"not-read"}}');

  const proposal = await f.service.propose('Two repositories', [firstRoot, secondRoot]);
  assert.deepEqual(proposal.roots, [firstRoot, secondRoot]);
  const approved = await f.service.approve(proposal.id);
  assert.deepEqual(approved.roots, [await realpath(firstRoot), await realpath(secondRoot)]);
  const inspection = await f.service.inspect(approved.id);
  assert.deepEqual(inspection.roots.map(root => root.path), approved.roots);
  assert.deepEqual(inspection.roots.map(root => root.repositories.map(repository => repository.name)), [['same-name'], ['same-name']]);
  assert.ok(inspection.roots.every(root => !root.unavailable));

  await rm(secondRoot, { recursive: true });
  await symlink(outsideRoot, secondRoot);
  const partial = await f.service.inspect(approved.id);
  assert.equal(partial.roots[0].unavailable, false);
  assert.equal(partial.roots[1].unavailable, true);
  assert.deepEqual(partial.roots[1].repositories, []);
  assert.ok(!JSON.stringify(partial).includes('not-read'));

  const sameRootProposal = await f.service.propose('Reused root', [firstRoot]);
  const reused = await f.service.approve(sameRootProposal.id);
  assert.notEqual(reused.id, approved.id);
  assert.deepEqual(reused.roots, [approved.roots[0]]);
  assert.equal((await f.store.read()).workspaces.length, 2);
});

test('overlapping selected roots are rejected and one invalid approved root grants none', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const child = join(f.project, 'web');
  await assert.rejects(f.service.propose('Overlap', [f.project, child]), /parent and its child/);
  await assert.rejects(f.service.propose('Duplicate', [f.project, join(f.project, '.', '')]), /parent and its child/);

  const missingRoot = join(f.root, 'not-created');
  const proposal = await f.service.propose('All roots', [f.project, missingRoot]);
  await assert.rejects(f.service.approve(proposal.id));
  const state = await f.store.read();
  assert.equal(state.workspaces.length, 0);
  assert.equal(state.proposals.length, 1);
  assert.deepEqual(state.proposals[0].roots, [f.project, missingRoot]);
});

test('projects keep bounded approved and pending counts and at most twenty roots', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const twentyOneRoots = Array.from({ length: 21 }, (_, index) => join(f.root, `candidate-${index}`));
  await assert.rejects(f.service.propose('Too many roots', twentyOneRoots), /no more than 20/);
  await assert.rejects(f.service.propose('Long root', [`/${'x'.repeat(4096)}`]), /4096 characters or fewer/);
  await assert.rejects(f.service.propose('x'.repeat(101), [f.project]), /100 characters or fewer/);
  await Promise.all(Array.from({ length: 50 }, (_, index) => f.service.propose(`Pending ${index}`, [join(f.root, `pending-${index}`)])));
  assert.equal((await f.store.read()).proposals.length, 50);
  await assert.rejects(f.service.propose('One too many', [join(f.root, 'pending-extra')]), /Too many pending requests/);
  assert.equal((await f.store.read()).proposals.length, 50);

  await f.store.update(state => {
    state.proposals = [];
    state.workspaces = Array.from({ length: 50 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
      name: `Approved ${index}`,
      roots: [join(f.root, `approved-${index}`)],
      createdAt: '2026-01-01T00:00:00.000Z',
    }));
  });
  const lastProposal = await f.service.propose('Project limit', [f.project]);
  await assert.rejects(f.service.approve(lastProposal.id), /Project limit reached/);
  const after = await f.store.read();
  assert.equal(after.workspaces.length, 50);
  assert.equal(after.proposals.length, 1);
});
