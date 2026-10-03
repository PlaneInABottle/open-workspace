import { constants } from 'node:fs';
import { access, lstat, open, opendir, realpath, stat } from 'node:fs/promises';
import { delimiter, isAbsolute, join, parse, resolve } from 'node:path';
import { homedir } from 'node:os';
import { maxProjectRootLength, projectRootMessages } from './project-roots.js';

const manifests = ['package.json', 'pyproject.toml', 'pom.xml', 'Cargo.toml', 'go.mod', 'Gemfile'] as const;
const composeFiles = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
const instructions = ['AGENTS.md', 'CLAUDE.md', 'OPENCODE.md', 'GEMINI.md'];
export type Repository = {
  name: string;
  path: string;
  git: boolean;
  stack: string[];
  manifests: string[];
  instructions: string[];
  scriptNames: string[];
  composeFiles: string[];
  processState: 'not_connected';
  readiness: 'not_checked';
};

async function regularFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function approvedRoot(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0') || path.length > maxProjectRootLength) throw new Error(projectRootMessages.absoluteDir);
  const selectedPath = resolve(path);
  let selectedInfo;
  try {
    selectedInfo = await lstat(selectedPath);
  } catch (error) {
    // Missing paths and I/O failures carry private absolute paths; report the safe reason instead.
    throw new Error(projectRootMessages.symlink);
  }
  if (!selectedInfo.isDirectory() || selectedInfo.isSymbolicLink()) {
    throw new Error(projectRootMessages.symlink);
  }
  const root = await realpath(selectedPath);
  if (root === parse(root).root || root === homedir()) throw new Error(projectRootMessages.homeRoot);
  // Filesystem roots/aliases such as macOS /var are canonicalized for stored access.
  return root;
}

async function inspectDirectory(directory: string, name: string): Promise<Repository | undefined> {
  const present = [];
  for (const manifest of manifests) if (await regularFile(join(directory, manifest))) present.push(manifest);
  const gitInfo = await lstat(join(directory, '.git')).catch(() => undefined);
  const git = Boolean(gitInfo && !gitInfo.isSymbolicLink() && (gitInfo.isDirectory() || gitInfo.isFile()));
  const compose = [];
  for (const file of composeFiles) if (await regularFile(join(directory, file))) compose.push(file);
  if (!present.length && !git && !compose.length) return undefined;
  const guidance = [];
  for (const file of instructions) if (await regularFile(join(directory, file))) guidance.push(file);
  let scriptNames: string[] = [];
  if (present.includes('package.json')) {
    const file = await open(join(directory, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('Package manifest is not a bounded regular file.');
      const packageJson = JSON.parse(await file.readFile('utf8'));
      if (packageJson.scripts && typeof packageJson.scripts === 'object' && !Array.isArray(packageJson.scripts)) {
        scriptNames = Object.keys(packageJson.scripts).filter(name => /^[\w:.-]{1,80}$/.test(name)).slice(0,60);
      }
    } finally {
      await file.close();
    }
  }
  const stacks: Record<string, string> = {
    'package.json': 'Node.js', 'pyproject.toml': 'Python', 'pom.xml': 'Java / Maven',
    'Cargo.toml': 'Rust', 'go.mod': 'Go', 'Gemfile': 'Ruby / Bundler',
  };
  return {
    name, path: directory, git, stack: present.map(file => stacks[file]), manifests: present,
    instructions: guidance, scriptNames, composeFiles: compose,
    processState: 'not_connected', readiness: 'not_checked',
  };
}

export async function discover(path: string): Promise<{ root: string; repositories: Repository[]; warnings: string[] }> {
  const root = await approvedRoot(path);
  if (root !== path) throw new Error(projectRootMessages.approvedIdentity);
  const warnings: string[] = [];
  const repositories: Repository[] = [];
  const inspect = async (directory: string, name: string) => {
    try {
      const repository = await inspectDirectory(directory, name);
      if (repository) repositories.push(repository);
    } catch {
      warnings.push(`${name}: metadata could not be read safely; no command was executed.`);
    }
  };
  await inspect(root, root.split('/').pop() || 'Project');
  const directory = await opendir(root);
  let entries = 0;
  let components = 0;
  for await (const entry of directory) {
    if (++entries > 1000) { warnings.push('Directory inventory stopped at 1000 entries. Select a smaller project root.'); break; }
    if (!entry.isDirectory() || entry.name.startsWith('.')
      || ['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage'].includes(entry.name)) continue;
    if (++components > 100) { warnings.push('Discovery is limited to 100 immediate directories.'); break; }
    const child = join(root, entry.name);
    // Re-check identity immediately before examining a child. This is not an OS sandbox.
    const info = await lstat(child);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(child) !== child) {
      warnings.push(`${entry.name}: redirected directory skipped.`);
      continue;
    }
    await inspect(child, entry.name);
  }
  repositories.sort((a,b) => a.name.localeCompare(b.name));
  return { root, repositories, warnings };
}

// Proposal hints for environment topology derivation: read-only, bounded,
// never executed. Procfile contributes up to 20 `name: command` lines,
// Makefile contributes up to 30 target names, and package.json contributes
// script bodies for port-hint grepping. Dot-env files are never read; bodies
// are hints only — execution stays on the manifest-script path.
export interface ProposalHints {
  scripts: Record<string, string>;
  procfile: Array<{ name: string; command: string }>;
  makefileTargets: string[];
}

const proposalFileLimit = 4 * 1024;

async function readBoundedFile(directory: string, file: string, limit = proposalFileLimit): Promise<string | null> {
  let handle;
  try {
    handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) return null;
    return await handle.readFile('utf8');
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

export async function readProposalHints(directory: string): Promise<ProposalHints> {
  const scripts: Record<string, string> = {};
  const manifest = await readBoundedFile(directory, 'package.json', 256 * 1024);
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest) as { scripts?: unknown };
      if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
        for (const [name, body] of Object.entries(parsed.scripts as Record<string, unknown>)) {
          if (!/^[\w:.-]{1,80}$/.test(name) || typeof body !== 'string' || !body) continue;
          if (Object.keys(scripts).length >= 60) break;
          scripts[name] = body.slice(0, 8192);
        }
      }
    } catch {
      // Unparseable manifests contribute no hints; discovery already warned.
    }
  }
  const procfile: ProposalHints['procfile'] = [];
  const procfileBody = await readBoundedFile(directory, 'Procfile');
  if (procfileBody) {
    for (const line of procfileBody.split('\n')) {
      if (procfile.length >= 20) break;
      const match = /^([A-Za-z0-9_-]{1,80}):\s*(.{1,500})$/.exec(line.trim());
      if (match) procfile.push({ name: match[1], command: match[2] });
    }
  }
  const makefileTargets: string[] = [];
  const makefileBody = (await readBoundedFile(directory, 'Makefile'))
    ?? (await readBoundedFile(directory, 'makefile'));
  if (makefileBody) {
    for (const line of makefileBody.split('\n')) {
      if (makefileTargets.length >= 30) break;
      const match = /^([\w:.-]{1,80})\s*:[^=]*$/.exec(line);
      if (match && !line.startsWith('\t') && !match[1].startsWith('.')) makefileTargets.push(match[1]);
    }
  }
  return { scripts, procfile, makefileTargets };
}

export async function toolAvailability(searchPath = process.env.PATH || '') {
  // Availability is PATH executability only: git/pm2/psql run via bare PATH
  // names at spawn, agent-browser via resolveAgentBrowser and declarative
  // tools via resolveCanonicalBinary. A 'found' tool may still be missing or
  // refused at execution time. Availability is not runtime readiness.
  const definitions = [
    { id: 'git', name: 'Git', purpose: 'Repository operations', required: true },
    { id: 'pm2', name: 'PM2', purpose: 'Optional application runner', required: false },
    { id: 'psql', name: 'PostgreSQL client', purpose: 'Optional read-only datastore queries', required: false },
    { id: 'docker', name: 'Docker', purpose: 'Optional container runner', required: false },
    { id: 'agent-browser', name: 'Agent Browser', purpose: 'Browser verification in M1', required: false },
  ];
  return Promise.all(definitions.map(async tool => {
    let available = false;
    for (const directory of searchPath.split(delimiter).filter(isAbsolute)) {
      try {
        if (!(await stat(join(directory, tool.id))).isFile()) continue;
        await access(join(directory, tool.id), constants.X_OK);
        available = true;
        break;
      } catch { /* Availability is not runtime readiness. */ }
    }
    return { ...tool, status: available ? 'found' : 'missing', verified: false };
  }));
}
