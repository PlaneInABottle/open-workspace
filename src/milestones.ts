import { open, readdir, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { maskSecrets } from './run-summaries.js';

export interface MilestoneNote {
  at: string;
  text: string;
  source: string;
}

const maxFiles = 50;
const maxFileBytes = 2048;
const maxNoteChars = 500;

/**
 * Bounded read enforcing the declared 2KiB cap before parsing: at most
 * maxFileBytes + 1 bytes are ever allocated per file, so oversized files are
 * skipped without being fully loaded (including a file that grows mid-read).
 */
async function readCappedFile(path: string): Promise<string | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, 'r');
    if (!(await handle.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxFileBytes) return undefined;
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function epochFromName(name: string): number | undefined {
  const match = /^(\d{10,13})/.exec(name);
  if (!match) return undefined;
  const digits = match[1];
  const value = Number(digits);
  if (!Number.isFinite(value)) return undefined;
  return digits.length <= 10 ? value * 1000 : value;
}

/** First non-empty content line, skipping the markdown title and Scope/Source/Status fields. */
function firstNoteLine(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (/^-\s*(Scope|Source|Status)\s*:/i.test(line)) continue;
    const ruleMatch = /^-\s*Rule\s*:\s*(.+?)\s*$/.exec(line);
    if (ruleMatch?.[1]) return ruleMatch[1];
    if (/^\s*[-*]\s+/.test(line)) return line.replace(/^\s*[-*]\s+/, '');
    return line;
  }
  return '';
}

/**
 * Reader-only view over agent-written learning files. The dashboard never
 * writes these; agents append milestone notes per the learn-from-mistake
 * skill convention (epoch-prefixed file, one pattern-only line, no secrets).
 * Everything returned is masked and capped; raw payloads never surface.
 */
export async function listMilestones(homeDirectory: string): Promise<MilestoneNote[]> {
  let files: string[];
  try {
    files = (await readdir(join(homeDirectory, 'learnings', 'milestones'))).filter(name => name.endsWith('.md')).sort().reverse();
  } catch {
    return [];
  }
  const notes: MilestoneNote[] = [];
  for (const name of files.slice(0, maxFiles)) {
    try {
      const content = await readCappedFile(join(homeDirectory, 'learnings', 'milestones', name));
      if (content === undefined) continue;
      const text = maskSecrets(firstNoteLine(content)).slice(0, maxNoteChars).trim();
      if (!text) continue;
      const epoch = epochFromName(name);
      notes.push({
        at: epoch === undefined ? '1970-01-01T00:00:00.000Z' : new Date(epoch).toISOString(),
        text,
        source: name.slice(0, 80),
      });
    } catch {
      continue;
    }
  }
  return notes.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, maxFiles);
}
