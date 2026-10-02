import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { maxProjectRoots, projectRootsError } from './project-roots.js';
import { trustedSystemPath } from './trusted-system.js';

export const projectRootPickerTimeoutMs = 5 * 60 * 1000;
const maximumPickerOutputBytes = 512 * 1024;
const osascriptPath = '/usr/bin/osascript';

export const projectRootPickerScript = `
const app = Application.currentApplication();
app.includeStandardAdditions = true;
try {
  const selection = app.chooseFolder({
    withPrompt: "Select repository folders for this OpenWorkspace project.",
    multipleSelectionsAllowed: true
  });
  const folders = Array.isArray(selection) ? selection : [selection];
  const roots = folders.map(folder => folder.toString());
  JSON.stringify({ status: "selected", roots });
} catch (error) {
  const code = error && (error.errorNumber ?? error.number);
  JSON.stringify({ status: code === -128 ? "cancelled" : "error" });
}
`;

export type ProjectRootPickerResult =
  | { status: 'selected'; roots: string[] }
  | { status: 'cancelled' | 'unavailable' | 'timeout' | 'error' | 'aborted' };

type PickerChild = Pick<ChildProcess, 'once' | 'kill'> & { stdout: NodeJS.ReadableStream | null };
type SpawnFunction = (command: string, args: string[], options: SpawnOptions) => PickerChild;

export interface ProjectRootPickerOptions {
  platform?: NodeJS.Platform;
  spawn?: SpawnFunction;
  timeoutMs?: number;
}

export function pickProjectRoots(signal?: AbortSignal, options: ProjectRootPickerOptions = {}): Promise<ProjectRootPickerResult> {
  if (signal?.aborted) return Promise.resolve({ status: 'aborted' });
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return Promise.resolve({ status: 'unavailable' });
  const executable = trustedSystemPath(osascriptPath, 'file');
  if (!executable) return Promise.resolve({ status: 'unavailable' });

  let child: PickerChild;
  try {
    child = (options.spawn ?? spawn as SpawnFunction)(executable, ['-l', 'JavaScript', '-e', projectRootPickerScript], {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: {},
    });
  } catch {
    return Promise.resolve({ status: 'unavailable' });
  }

  return new Promise(resolve => {
    let settled = false;
    let forcedStatus: 'timeout' | 'aborted' | 'error' | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? options.timeoutMs!
      : projectRootPickerTimeoutMs;
    let deadline: NodeJS.Timeout | undefined;
    let killDeadline: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (deadline) clearTimeout(deadline);
      if (killDeadline) clearTimeout(killDeadline);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onData);
    };
    const finish = (result: ProjectRootPickerResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const terminate = (status: 'timeout' | 'aborted' | 'error') => {
      if (settled || forcedStatus) return;
      forcedStatus = status;
      child.kill('SIGTERM');
      killDeadline = setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const onAbort = () => terminate('aborted');
    const onData = (chunk: Buffer | string) => {
      if (forcedStatus) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.length;
      if (bytes > maximumPickerOutputBytes) {
        terminate('error');
        return;
      }
      chunks.push(value);
    };

    child.stdout?.on('data', onData);
    child.once('error', () => {
      if (!forcedStatus) finish({ status: 'unavailable' });
    });
    child.once('close', (code: number | null) => {
      if (forcedStatus) {
        finish({ status: forcedStatus });
        return;
      }
      if (code !== 0) {
        finish({ status: 'error' });
        return;
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)).trim();
        const result: unknown = JSON.parse(text);
        if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Invalid picker response.');
        const response = result as Record<string, unknown>;
        if (response.status === 'cancelled' && Object.keys(response).length === 1) {
          finish({ status: 'cancelled' });
          return;
        }
        if (response.status === 'error' && Object.keys(response).length === 1) {
          finish({ status: 'error' });
          return;
        }
        if (response.status !== 'selected' || Object.keys(response).length !== 2
          || !Array.isArray(response.roots) || response.roots.length > maxProjectRoots
          || response.roots.some(root => typeof root !== 'string')) throw new Error('Invalid picker response.');
        const roots = response.roots as string[];
        if (projectRootsError(roots)) throw new Error('Invalid picker roots.');
        finish({ status: 'selected', roots });
      } catch {
        finish({ status: 'error' });
      }
    });

    deadline = setTimeout(() => terminate('timeout'), timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}
