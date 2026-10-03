import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultSkillsDirectory = fileURLToPath(new URL('../skills/', import.meta.url));
const maxSkillBytes = 8 * 1024;
const shortDescriptions: Record<string, string> = {
  'learn-from-mistake': 'Use to turn session surprises or user corrections into local learning drafts.',
  'openworkspace-onboarding': 'Use to connect an existing assistant to OpenWorkspace and onboard selected projects.',
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

export async function loadConsumerSkills(
  directory = defaultSkillsDirectory,
  log: (message: string) => void = message => console.error(message),
): Promise<ConsumerSkill[]> {
  let rootInfo;
  try {
    // lstat rejects a redirected skills root before readdir can follow it.
    rootInfo = await lstat(directory);
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
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    reportSkip(log, 'skills directory', 'directory could not be read');
    return [];
  }

  const skills: ConsumerSkill[] = [];
  for (const entry of entries.filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const path = join(directory, entry.name, 'SKILL.md');
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

export const consumerSkills = await loadConsumerSkills();

export const availableSkills: AvailableSkill[] = consumerSkills.map(({ name, description }) => ({
  name,
  whenToUse: description,
  fetch: { prompt: `skill/${name}` },
}));
