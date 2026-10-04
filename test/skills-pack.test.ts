import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(repoRoot, 'skills');
const pluginsDir = join(repoRoot, 'plugins');
const generator = join(repoRoot, 'scripts', 'build-skill-packs.mjs');
const clients = ['claude', 'codex', 'vscode', 'opencode'];

function packPath(root: string, client: string, skill: string): string {
  const file = `openworkspace-${skill}.md`;
  return client === 'claude' ? join(root, 'claude', 'commands', file) : join(root, client, file);
}

async function skillNames(): Promise<string[]> {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

function splitSkill(text: string): { description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, 'canonical SKILL.md has a frontmatter block');
  const description = /^description:[ \t]*(.*?)[ \t]*$/m.exec(match[1])?.[1];
  assert.ok(description, 'canonical SKILL.md has a description');
  return { description, body: text.slice(match[0].length) };
}

function runGenerator(env: Record<string, string>): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    execFile(process.execPath, [generator], { env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error && 'code' in error ? Number((error as { code: unknown }).code) || 1 : 0, output: `${stdout}${stderr}` });
    });
  });
}

test('generated packs byte-match canonical skills with inherited frontmatter', async () => {
  for (const skill of await skillNames()) {
    const canonical = await readFile(join(skillsDir, skill, 'SKILL.md'), 'utf8');
    const { description, body } = splitSkill(canonical);
    assert.ok(description.length <= 200, `${skill}: description within 200 chars`);
    assert.ok(Buffer.byteLength(body, 'utf8') <= 8 * 1024, `${skill}: body within 8 KiB`);
    for (const client of clients) {
      const generated = await readFile(packPath(pluginsDir, client, skill), 'utf8');
      const expected = `---\nname: openworkspace-${skill}\ndescription: ${description}\n---\n${body}`;
      assert.equal(generated, expected, `${client}/${skill}: verbatim body plus command frontmatter`);
    }
  }
});

test('generated packs are namespaced, laid out per client and secret-free', async t => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-skill-packs-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  // Reproducibility: a fresh generation into an empty dir matches the
  // checked-in output byte-for-byte, and a second run is identical.
  const fresh = join(tmp, 'plugins');
  const first = await runGenerator({ OPENWORKSPACE_PLUGINS_DIR: fresh });
  assert.equal(first.code, 0, first.output);
  for (const skill of await skillNames()) {
    for (const client of clients) {
      const file = packPath(fresh, client, skill);
      assert.equal(
        await readFile(file, 'utf8'),
        await readFile(packPath(pluginsDir, client, skill), 'utf8'),
        `checked-in ${client}/openworkspace-${skill}.md matches fresh generation`,
      );
    }
  }
  const rerun = join(tmp, 'plugins-rerun');
  const second = await runGenerator({ OPENWORKSPACE_PLUGINS_DIR: rerun });
  assert.equal(second.code, 0, second.output);
  for (const skill of await skillNames()) {
    for (const client of clients) {
      assert.equal(
        await readFile(packPath(rerun, client, skill), 'utf8'),
        await readFile(packPath(fresh, client, skill), 'utf8'),
        'generator output is deterministic',
      );
    }
  }
  const secretPattern = /(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\/Users\/|\/home\/)/;
  for (const skill of await skillNames()) {
    for (const client of clients) {
      const generated = await readFile(packPath(pluginsDir, client, skill), 'utf8');
      assert.doesNotMatch(generated, secretPattern, `${client}/${skill}: no tokens or machine paths`);
    }
  }
});

test('generator fails closed on cap breach with a named error', async t => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-skill-pack-fail-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const fixtureSkills = join(tmp, 'skills');
  const fixturePlugins = join(tmp, 'plugins');
  const writeSkill = async (name: string, description: string, body: string) => {
    await mkdir(join(fixtureSkills, name), { recursive: true });
    await writeFile(join(fixtureSkills, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
  };
  await writeSkill('fine', 'A fine skill.', 'Body.\n');
  await writeSkill('verbose', 'x'.repeat(201), 'Body.\n');
  // Seed the output dir: a stale namespaced file plus unrelated content.
  const staleFile = join(fixturePlugins, 'claude', 'commands', 'openworkspace-stale.md');
  await mkdir(dirname(staleFile), { recursive: true });
  await writeFile(staleFile, 'Stale snapshot.\n');
  const unrelatedFile = join(fixturePlugins, 'notes.txt');
  await writeFile(unrelatedFile, 'Unrelated content.\n');
  const snapshotDir = async (root: string): Promise<Map<string, string>> => {
    const entries = new Map<string, string>();
    const walk = async (dir: string) => {
      let children: string[] = [];
      try {
        children = await readdir(dir);
      } catch {
        return;
      }
      for (const child of children.sort()) {
        const full = join(dir, child);
        try {
          entries.set(full, await readFile(full, 'utf8'));
        } catch {
          await walk(full);
        }
      }
    };
    await walk(root);
    return entries;
  };
  const before = await snapshotDir(fixturePlugins);
  const tooLong = await runGenerator({ OPENWORKSPACE_SKILLS_DIR: fixtureSkills, OPENWORKSPACE_PLUGINS_DIR: fixturePlugins });
  assert.notEqual(tooLong.code, 0, 'description over 200 chars fails');
  assert.match(tooLong.output, /DESCRIPTION_TOO_LONG/, 'named cap error');
  assert.deepEqual(await snapshotDir(fixturePlugins), before, 'failing run writes nothing and prunes nothing');
  await rm(join(fixtureSkills, 'verbose'), { recursive: true, force: true });
  await writeSkill('huge', 'A huge skill.', `${'x'.repeat(9 * 1024)}\n`);
  const tooLarge = await runGenerator({ OPENWORKSPACE_SKILLS_DIR: fixtureSkills, OPENWORKSPACE_PLUGINS_DIR: fixturePlugins });
  assert.notEqual(tooLarge.code, 0, 'body over 8 KiB fails');
  assert.match(tooLarge.output, /BODY_TOO_LARGE/, 'named cap error');
  assert.deepEqual(await snapshotDir(fixturePlugins), before, 'second failing run still writes nothing');
});

test('fixture copy walkthrough: verbatim pinned files, preserved settings, same-path updates', async t => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-skill-install-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  // The user's agent copies from the generated pack into project-local paths.
  const packFile = packPath(pluginsDir, 'claude', 'openworkspace-onboarding');
  const packBytes = await readFile(packFile);
  const project = join(tmp, 'project');
  const commandsDir = join(project, '.claude', 'commands');
  await mkdir(commandsDir, { recursive: true });
  const personalFile = join(commandsDir, 'personal.md');
  await writeFile(personalFile, 'Personal command content.\n');
  const settingsFile = join(project, '.mcp.json');
  const existingSettings = { mcpServers: { other: { command: '/usr/bin/other', args: [], env: {} } } };
  await writeFile(settingsFile, JSON.stringify(existingSettings, null, 2));
  const before = await readFile(personalFile, 'utf8');

  // Initial install: verbatim snapshot next to untouched personal content.
  const snapshot = join(commandsDir, 'openworkspace-openworkspace-onboarding.md');
  await writeFile(snapshot, packBytes);
  assert.equal((await readFile(snapshot)).toString(), packBytes.toString(), 'snapshot is a verbatim copy');
  assert.equal(await readFile(personalFile, 'utf8'), before, 'personal files stay byte-identical');

  // Settings merge preserves every existing server while adding the entry.
  const merged = JSON.parse(await readFile(settingsFile, 'utf8')) as { mcpServers: Record<string, unknown> };
  merged.mcpServers.openworkspace = { command: '/opt/ow/bin/openworkspace.mjs', args: ['mcp'], env: { OPENWORKSPACE_HOME: '/tmp/state' } };
  await writeFile(settingsFile, JSON.stringify(merged, null, 2));
  const reread = JSON.parse(await readFile(settingsFile, 'utf8')) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(reread.mcpServers.other, existingSettings.mcpServers.other, 'existing settings preserved');
  assert.ok(reread.mcpServers.openworkspace, 'generated entry added');

  // Update flow: re-copy over the same snapshot path only; a user edit to the
  // snapshot is overwritten there (documented), personal files never touched.
  await writeFile(snapshot, 'User-edited snapshot.\n');
  await writeFile(snapshot, packBytes);
  assert.equal((await readFile(snapshot)).toString(), packBytes.toString(), 're-copy restores the verbatim snapshot');
  assert.equal(await readFile(personalFile, 'utf8'), before, 'personal files still byte-identical');
});
