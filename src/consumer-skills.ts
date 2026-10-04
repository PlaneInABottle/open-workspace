import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAsset, getAssetKeys, isSea } from 'node:sea';

function defaultSkillsDirectory(): string {
  // Lazily computed (never at module load): esbuild CJS empties
  // import.meta.url, so evaluating this at load time crashes the bundle.
  return fileURLToPath(new URL('../skills/', import.meta.url));
}
const maxSkillBytes = 8 * 1024;
const shortDescriptions: Record<string, string> = {
  'learn-from-mistake': 'Use on demand to write reusable skill and AGENTS.md guidance from session evidence.',
  'onboarding': 'Use to connect an existing assistant to OpenWorkspace and onboard selected projects.',
};

export interface ConsumerSkill {
  name: string;
  description: string;
  text: string;
}

export interface AvailableSkill {
  name: string;
  whenToUse: string;
  fetch: { prompt: string };
}

function reportSkip(log: (message: string) => void, name: string, reason: string) {
  try { log(`[OpenWorkspace] Skipping consumer skill "${name}": ${reason}.`); } catch { /* Logging must not block startup. */ }
}

function readMetadata(text: string): { name: string; description: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return null;

  let name: string | undefined;
  let description: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!field) continue;
    if (field[1] === 'name') {
      if (name !== undefined) return null;
      name = field[2];
    } else {
      if (description !== undefined) return null;
      description = field[2];
    }
  }

  if (!name || !/^[a-z][a-z0-9-]{0,79}$/.test(name)) return null;
  if (!description || description.trim() !== description || /[\r\n\u0000-\u001f]/.test(description)) return null;
  return { name, description };
}

function seaSkillBytes(key: string): Buffer | null {
  let raw: unknown;
  try {
    raw = getAsset(key);
  } catch {
    return null;
  }
  if (typeof raw === 'string') return Buffer.from(raw, 'utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  return null;
}

async function loadSeaConsumerSkills(
  log: (message: string) => void = message => console.error(message),
): Promise<ConsumerSkill[]> {
  // Inside the read-only blob there is no skills directory to lstat/readdir;
  // enumerate the build-time `skills/<name>/SKILL.md` asset keys instead. The
  // size cap and frontmatter/name/description validation below are the same
  // checks as the filesystem loader (symlink proofs are vacuous in the blob).
  let keys: string[];
  try {
    keys = getAssetKeys().filter(key => key.startsWith('skills/') && key.endsWith('/SKILL.md'));
  } catch {
    reportSkip(log, 'skills directory', 'directory could not be read');
    return [];
  }
  const names = [...new Set(keys.map(key => key.slice('skills/'.length, -'/SKILL.md'.length)))].sort((a, b) => a.localeCompare(b));
  const skills: ConsumerSkill[] = [];
  for (const name of names) {
    try {
      const bytes = seaSkillBytes(`skills/${name}/SKILL.md`);
      if (!bytes) {
        reportSkip(log, name, 'SKILL.md could not be read');
        continue;
      }
      if (bytes.byteLength > maxSkillBytes) {
        reportSkip(log, name, 'SKILL.md exceeds the size limit');
        continue;
      }
      const text = bytes.toString('utf8');
      const metadata = readMetadata(text);
      const description = metadata && (shortDescriptions[metadata.name] ?? metadata.description);
      if (!metadata || metadata.name !== name || !description || description.length > 200) {
        reportSkip(log, name, 'SKILL.md has invalid frontmatter');
        continue;
      }
      skills.push({ ...metadata, description, text });
    } catch {
      reportSkip(log, name, 'SKILL.md could not be read');
    }
  }
  return skills;
}

export async function loadConsumerSkills(
  directory?: string,
  log: (message: string) => void = message => console.error(message),
): Promise<ConsumerSkill[]> {
  // The SEA branch comes first: under a CJS bundle the default-directory
  // evaluation below must never run inside SEA (import.meta.url is empty).
  if (isSea()) return loadSeaConsumerSkills(log);
  const root = directory ?? defaultSkillsDirectory();
  let rootInfo;
  try {
    // lstat rejects a redirected skills root before readdir can follow it.
    rootInfo = await lstat(root);
  } catch {
    reportSkip(log, 'skills directory', 'directory could not be read');
    return [];
  }
  if (!rootInfo.isDirectory()) {
    reportSkip(log, 'skills directory', rootInfo.isSymbolicLink() ? 'directory is a symbolic link' : 'path is not a directory');
    return [];
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    reportSkip(log, 'skills directory', 'directory could not be read');
    return [];
  }

  const skills: ConsumerSkill[] = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const path = join(root, entry.name, 'SKILL.md');
      const info = await lstat(path);
      if (!info.isFile()) {
        reportSkip(log, entry.name, 'SKILL.md is not a regular file');
        continue;
      }
      if (info.size > maxSkillBytes) {
        reportSkip(log, entry.name, 'SKILL.md exceeds the size limit');
        continue;
      }
      const bytes = await readFile(path);
      if (bytes.byteLength > maxSkillBytes) {
        reportSkip(log, entry.name, 'SKILL.md exceeds the size limit');
        continue;
      }
      const text = bytes.toString('utf8');
      const metadata = readMetadata(text);
      const description = metadata && (shortDescriptions[metadata.name] ?? metadata.description);
      if (!metadata || metadata.name !== entry.name || !description || description.length > 200) {
        reportSkip(log, entry.name, 'SKILL.md has invalid frontmatter');
        continue;
      }
      skills.push({ ...metadata, description, text });
    } catch {
      reportSkip(log, entry.name, 'SKILL.md could not be read');
    }
  }
  return skills;
}

// Mutable live bindings (no top-level await — esbuild cannot bundle TLA into
// CJS). Both runners call initConsumerSkills() before serving so the
// workspace.ts live import stays populated under every entry.
export let consumerSkills: ConsumerSkill[] = [];

export let availableSkills: AvailableSkill[] = [];

export async function initConsumerSkills(
  directory?: string,
  log: (message: string) => void = message => console.error(message),
): Promise<ConsumerSkill[]> {
  // Pass the directory through unevaluated: loadConsumerSkills branches on
  // isSea() before touching the filesystem default, which is undefined under
  // a CJS bundle and must never be evaluated inside SEA.
  const loaded = await loadConsumerSkills(directory, log);
  consumerSkills = loaded;
  availableSkills = loaded.map(({ name, description }) => ({
    name,
    whenToUse: description,
    fetch: { prompt: `skill/${name}` },
  }));
  return loaded;
}
