import { isAbsolute, relative, resolve, sep } from 'node:path';

export const maxProjectRoots = 20;
export const maxProjectRootLength = 4096;

// Canonical registration-path messages. projectRootsError() and
// discovery.approvedRoot() throw these references (never literals); http.ts
// composes its allowlist from this object, so a rename propagates.
export const projectRootMessages = {
  empty: 'Select at least one repository folder.',
  tooMany: `Select no more than ${maxProjectRoots} repository folders.`,
  badPath: `Each repository folder must be an absolute path of ${maxProjectRootLength} characters or fewer.`,
  overlap: 'Choose distinct folders without selecting a parent and its child.',
  absoluteDir: 'Use an absolute project directory.',
  symlink: 'Choose a real directory, not a symlink.',
  homeRoot: 'Choose a project, not your home or filesystem root.',
  approvedIdentity: 'Approved directory identity changed. Request access again.',
} as const;

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function projectRootsError(roots: readonly string[]): string | undefined {
  if (roots.length === 0) return projectRootMessages.empty;
  if (roots.length > maxProjectRoots) return projectRootMessages.tooMany;

  const normalized: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || root.length > maxProjectRootLength) {
      return projectRootMessages.badPath;
    }
    const current = resolve(root);
    if (normalized.some(previous => contains(previous, current) || contains(current, previous))) {
      return projectRootMessages.overlap;
    }
    normalized.push(current);
  }
  return undefined;
}
