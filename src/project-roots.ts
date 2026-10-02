import { isAbsolute, relative, resolve, sep } from 'node:path';

export const maxProjectRoots = 20;
export const maxProjectRootLength = 4096;

function contains(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

export function projectRootsError(roots: readonly string[]): string | undefined {
  if (roots.length === 0) return 'Select at least one repository folder.';
  if (roots.length > maxProjectRoots) return `Select no more than ${maxProjectRoots} repository folders.`;

  const normalized: string[] = [];
  for (const root of roots) {
    if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || root.length > maxProjectRootLength) {
      return `Each repository folder must be an absolute path of ${maxProjectRootLength} characters or fewer.`;
    }
    const current = resolve(root);
    if (normalized.some(previous => contains(previous, current) || contains(current, previous))) {
      return 'Choose distinct folders without selecting a parent and its child.';
    }
    normalized.push(current);
  }
  return undefined;
}
