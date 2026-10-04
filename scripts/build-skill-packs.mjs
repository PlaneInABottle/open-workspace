// Single-source skill-pack generator (M3): canonical `skills/*/SKILL.md` is
// the only hand-edited skill text. This script is the only writer of
// `plugins/` (checked-in, reviewable output). Generated files carry a
// verbatim body plus command frontmatter reusing the SKILL description, so
// per-client copies never rot by hand. Install is done by the user's agent
// (project-local paths, preserving existing settings); the service writes
// no client files and no endpoint serves these packs.
//
// Usage: `pnpm build-skill-packs` (or `node scripts/build-skill-packs.mjs`).
// Optional env overrides (tests only): OPENWORKSPACE_SKILLS_DIR,
// OPENWORKSPACE_PLUGINS_DIR.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const skillsDir = process.env.OPENWORKSPACE_SKILLS_DIR ?? join(repoRoot, 'skills');
const pluginsDir = process.env.OPENWORKSPACE_PLUGINS_DIR ?? join(repoRoot, 'plugins');

const maxBodyBytes = 8 * 1024;
const maxDescriptionChars = 200;

// Fixed per-client layout: Claude command files live under commands/;
// every other client takes the same file content at its top level.
const clients = ['claude', 'codex', 'vscode', 'opencode'];

function fail(code, message) {
  const error = new Error(`[build-skill-packs:${code}] ${message}`);
  console.error(error.message);
  process.exitCode = 1;
  throw error;
}

function readMetadata(text, file) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) fail('FRONTMATTER', `${file}: missing leading frontmatter block`);
  let name;
  let description;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!field) continue;
    if (field[1] === 'name') {
      if (name !== undefined) fail('FRONTMATTER', `${file}: duplicate name field`);
      name = field[2];
    } else if (description !== undefined) fail('FRONTMATTER', `${file}: duplicate description field`);
    else description = field[2];
  }
  if (!name || !/^[a-z][a-z0-9-]{0,79}$/.test(name)) fail('FRONTMATTER', `${file}: invalid skill name`);
  if (!description || description.trim() !== description || /[\r\n\0-\x1f]/.test(description)) {
    fail('FRONTMATTER', `${file}: invalid skill description`);
  }
  return { name, description, body: text.slice(match[0].length) };
}

function outputPath(client, skillName) {
  const file = `openworkspace-${skillName}.md`;
  return client === 'claude' ? join(pluginsDir, 'claude', 'commands', file) : join(pluginsDir, client, file);
}

async function main() {
  const entries = await readdir(skillsDir, { withFileTypes: true });
  const skillDirs = entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  if (skillDirs.length === 0) fail('NO_SKILLS', `no skill directories in ${skillsDir}`);
  // Two phases: validate every skill first, then write. A failing run leaves
  // the output dir untouched — no partial pack writes, no pruning.
  const outputs = [];
  for (const skillName of skillDirs) {
    const file = join(skillsDir, skillName, 'SKILL.md');
    let text;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      fail('UNREADABLE', `cannot read ${file}`);
    }
    const { name, description, body } = readMetadata(text, file);
    if (name !== skillName) fail('NAME_MISMATCH', `${file}: directory "${skillName}" does not match frontmatter name "${name}"`);
    if (description.length > maxDescriptionChars) {
      fail('DESCRIPTION_TOO_LONG', `skill "${name}": description is ${description.length} chars (cap ${maxDescriptionChars})`);
    }
    if (Buffer.byteLength(body, 'utf8') > maxBodyBytes) {
      fail('BODY_TOO_LARGE', `skill "${name}": body is ${Buffer.byteLength(body, 'utf8')} bytes (cap ${maxBodyBytes})`);
    }
    const content = `---\nname: openworkspace-${name}\ndescription: ${description}\n---\n${body}`;
    for (const client of clients) {
      outputs.push({ out: outputPath(client, name), content });
    }
  }
  for (const { out, content } of outputs) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, content);
  }
  const written = new Set(outputs.map(entry => entry.out));
  // Prune snapshots of skills that no longer exist (our namespaced files
  // only — never anything else).
  for (const client of clients) {
    const dir = client === 'claude' ? join(pluginsDir, 'claude', 'commands') : join(pluginsDir, client);
    let present = [];
    try {
      present = await readdir(dir);
    } catch {
      continue;
    }
    for (const file of present) {
      const full = join(dir, file);
      if (file.startsWith('openworkspace-') && file.endsWith('.md') && !written.has(full)) {
        await rm(full);
      }
    }
  }
  console.log(`[build-skill-packs] ${skillDirs.length} skills × ${clients.length} clients`);
}

await main();
