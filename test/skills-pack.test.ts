import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = join(repoRoot, 'skills');
const pluginsDir = join(repoRoot, 'plugins');
const generator = join(repoRoot, 'scripts', 'build-skill-packs.mjs');
const clients = ['claude', 'codex', 'vscode', 'opencode'];

function packPath(root: string, client: string, skill: string): string {
  const file = `ow-${skill}.md`;
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
    assert.ok(Buffer.byteLength(body, 'utf8') <= 12 * 1024, `${skill}: body within 12 KiB`);
    assert.ok(Buffer.byteLength(canonical, 'utf8') <= 12 * 1024, `${skill}: whole file within 12 KiB (loader drop limit)`);
    for (const client of clients) {
      const generated = await readFile(packPath(pluginsDir, client, skill), 'utf8');
      const expected = `---\nname: ow-${skill}\ndescription: ${description}\n---\n${body}`;
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
        `checked-in ${client}/ow-${skill}.md matches fresh generation`,
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
  // Seed the output dir: stale namespaced files (current plus legacy
  // flag-day prefix) plus unrelated content.
  const staleFile = join(fixturePlugins, 'claude', 'commands', 'ow-stale.md');
  await mkdir(dirname(staleFile), { recursive: true });
  await writeFile(staleFile, 'Stale snapshot.\n');
  const legacyStaleFile = join(fixturePlugins, 'opencode', 'openworkspace-stale.md');
  await mkdir(dirname(legacyStaleFile), { recursive: true });
  await writeFile(legacyStaleFile, 'Legacy stale snapshot.\n');
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
  await writeSkill('huge', 'A huge skill.', `${'x'.repeat(13 * 1024)}\n`);
  const tooLarge = await runGenerator({ OPENWORKSPACE_SKILLS_DIR: fixtureSkills, OPENWORKSPACE_PLUGINS_DIR: fixturePlugins });
  assert.notEqual(tooLarge.code, 0, 'file over 12 KiB fails');
  assert.match(tooLarge.output, /SKILL_TOO_LARGE/, 'named cap error');
  assert.match(tooLarge.output, /huge/, 'names the offending skill');
  assert.deepEqual(await snapshotDir(fixturePlugins), before, 'second failing run still writes nothing');
  await rm(join(fixtureSkills, 'huge'), { recursive: true, force: true });
  const pruned = await runGenerator({ OPENWORKSPACE_SKILLS_DIR: fixtureSkills, OPENWORKSPACE_PLUGINS_DIR: fixturePlugins });
  assert.equal(pruned.code, 0, pruned.output);
  const after = await snapshotDir(fixturePlugins);
  assert.ok(![...after.keys()].some(path => path.endsWith('ow-stale.md') || path.endsWith('openworkspace-stale.md')), 'successful run prunes current and legacy stale packs');
  assert.equal(after.get(unrelatedFile), 'Unrelated content.\n', 'unrelated files survive pruning');
});

test('shipped skills and packs never reference removed views', async () => {
  // Removed dashboard views (projects/records/lessons/workstreams/connect)
  // must not be reachable from consumer guidance: agents following a stale
  // pointer would invent a surface that no longer exists. Denial statements
  // ("there is no workstream surface") live in canonical prose, not in these
  // pointer patterns, so a match here is always a stale reference. The
  // pruned lesson read routes are covered too — bare `/api/learnings`
  // (GET) is gone while `/api/learnings/record` (POST) stays, hence the
  // lookahead. Milestone notes have no reader or writer hint left, so the
  // phrase is stale anywhere it appears.
  const staleViewPattern = /records view|recent_runs|activity_list|create new project|choose a project|learned lessons|projectsview|recordsview|connectionview|workstream-board|workstream board|\/api\/lessons|lesson shelf|milestone notes|\/api\/learnings(?!\/record)|what happened here/i;
  const collect = async (root: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
      }
    };
    await walk(root);
    return out.sort();
  };
  for (const file of [...(await collect(skillsDir)), ...(await collect(pluginsDir))]) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, staleViewPattern, `${file}: no pointer to a removed view`);
  }
});

test('skills and packs never teach the retired session verbs', async () => {
  // prompts/stuck/timeline/export were removed from the CLI: any remaining
  // `ow <verb>` recipe would teach a refusal. Generic English words and
  // skill-file senses of "prompts" live outside this pattern, so a match
  // here is always a stale command recipe, never legitimate prose.
  const staleVerbPattern = /\bow (stuck|timeline|export|prompts)\b|--bundle\b|session-timeline|up-export|stuckReport|sessionPrompts|PROMPTS_DEFAULT|formatStuck|maxOverlap/;
  const collect = async (root: string): Promise<string[]> => {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
      }
    };
    await walk(root);
    return out.sort();
  };
  for (const file of [...(await collect(skillsDir)), ...(await collect(pluginsDir))]) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, staleVerbPattern, `${file}: no retired-verb recipe`);
  }
});

test('learn-from-mistake packs never reference removed learning producers', async () => {
  // The receipt/runId/dashboard-activity learning backend is gone: the skill
  // teaches transcript + completed-session ow output instead. A match here is
  // always a stale instruction, never a denial statement (this skill carries
  // no "there is no receipt" prose). The ow-runtime "no dashboard" non-goal
  // lives in a different skill, so this scan stays scoped to learn-from-mistake.
  const staleProducerPattern = /environment_verify|runId|receipt|dashboard|failure signature/i;
  const canonical = join(skillsDir, 'learn-from-mistake', 'SKILL.md');
  const canonicalText = await readFile(canonical, 'utf8');
  assert.doesNotMatch(canonicalText, staleProducerPattern, `${canonical}: no removed learning-producer reference`);
  assert.ok(canonicalText.startsWith('---\nname: learn-from-mistake\n'), `${canonical}: intact canonical frontmatter`);
  for (const client of clients) {
    const file = packPath(pluginsDir, client, 'learn-from-mistake');
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, staleProducerPattern, `${file}: no removed learning-producer reference`);
    assert.ok(text.startsWith('---\nname: ow-learn-from-mistake\n'), `${file}: intact ow- command frontmatter`);
  }
});

test('fixture copy walkthrough: verbatim pinned files, preserved settings, same-path updates', async t => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-skill-install-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  // The user's agent copies from the generated pack into project-local paths.
  const packFile = packPath(pluginsDir, 'claude', 'onboarding');
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
  const snapshot = join(commandsDir, 'ow-onboarding.md');
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

  // Update flow: re-copy over the same snapshot path only. A stale tool-owned
  // snapshot is overwritten there with the diff reported; a personal edit needs
  // the user's decision first (see the update skill). Personal files never touched.
  await writeFile(snapshot, 'Stale tool-owned snapshot.\n');
  await writeFile(snapshot, packBytes);
  assert.equal((await readFile(snapshot)).toString(), packBytes.toString(), 're-copy restores the verbatim snapshot');
  assert.equal(await readFile(personalFile, 'utf8'), before, 'personal files still byte-identical');
});

test('stale→refresh walkthrough: byte-compare reports per-skill current/updated and overwrites stale snapshots verbatim', async t => {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'openworkspace-skill-refresh-')));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const project = join(tmp, 'project');
  const commandsDir = join(project, '.claude', 'commands');
  await mkdir(commandsDir, { recursive: true });
  const personalFile = join(commandsDir, 'personal.md');
  await writeFile(personalFile, 'Personal command content.\n');
  const personalBefore = await readFile(personalFile, 'utf8');

  // Served text is authoritative (canonical bytes); installed copies carry
  // the renamed `ow-` frontmatter prefix, normalized on compare.
  const served = (skill: string) => readFile(join(skillsDir, skill, 'SKILL.md'), 'utf8');
  const installedForm = (canonical: string, skill: string) =>
    canonical.replace(`name: ${skill}\n`, `name: ow-${skill}\n`);
  const normalize = (installed: string) => installed.replace(/^name: ow-/m, 'name: ');
  const dest = (skill: string) => join(commandsDir, `ow-${skill}.md`);

  const currentSkill = 'learn-from-mistake';
  const staleSkill = 'update';
  const missingSkill = 'onboarding';
  const currentServed = await served(currentSkill);
  await writeFile(dest(currentSkill), installedForm(currentServed, currentSkill));
  // Stale seed: installed copy from an older canonical revision (final line
  // not yet added), not a user edit — wording-independent by construction.
  const staleServed = await served(staleSkill);
  const olderServed = `${staleServed.trimEnd().split('\n').slice(0, -1).join('\n')}\n`;
  assert.notEqual(olderServed, staleServed, 'stale seed actually differs from served bytes');
  await writeFile(dest(staleSkill), installedForm(olderServed, staleSkill));
  const currentMtime = (await stat(dest(currentSkill))).mtimeMs;

  // The update flow: byte-compare per skill, overwrite stale/missing
  // verbatim at the same project-local path, report current vs updated.
  const report: { skill: string; status: 'current' | 'updated'; file: string }[] = [];
  for (const skill of [currentSkill, staleSkill, missingSkill]) {
    const fresh = await served(skill);
    const target = dest(skill);
    let installed: string | null = null;
    try {
      installed = await readFile(target, 'utf8');
    } catch {
      installed = null;
    }
    if (installed !== null && normalize(installed) === fresh) {
      report.push({ skill, status: 'current', file: target });
    } else {
      await writeFile(target, installedForm(fresh, skill));
      report.push({ skill, status: 'updated', file: target });
    }
  }

  assert.deepEqual(
    report.map(({ skill, status }) => ({ skill, status })),
    [
      { skill: currentSkill, status: 'current' },
      { skill: staleSkill, status: 'updated' },
      { skill: missingSkill, status: 'updated' },
    ],
    'diff report carries per-skill current/updated fields',
  );
  assert.ok(report.every(entry => entry.file.startsWith(project)), 'every reported write stays project-local');
  assert.equal(await readFile(dest(staleSkill), 'utf8'), installedForm(staleServed, staleSkill), 'stale snapshot overwritten verbatim');
  assert.equal(await readFile(dest(missingSkill), 'utf8'), installedForm(await served(missingSkill), missingSkill), 'missing snapshot installed verbatim');
  assert.equal(await readFile(dest(currentSkill), 'utf8'), installedForm(currentServed, currentSkill), 'current snapshot content untouched');
  assert.equal((await stat(dest(currentSkill))).mtimeMs, currentMtime, 'current snapshot not rewritten (no-op)');
  assert.equal(await readFile(personalFile, 'utf8'), personalBefore, 'personal files stay byte-identical');
});

test('skill size cap is declared by the pack builder', async t => {
  const text = await readFile(join(repoRoot, 'scripts/build-skill-packs.mjs'), 'utf8');
  const match = /maxSkillBytes\s*=\s*(\d+)\s*\*\s*1024/.exec(text);
  assert.ok(match, 'scripts/build-skill-packs.mjs declares maxSkillBytes as N * 1024');
  assert.equal(Number(match[1]) * 1024, 12 * 1024, 'pack size cap stays 12 KiB');
});
