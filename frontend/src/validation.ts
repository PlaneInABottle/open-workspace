import type { ProjectRootRequest } from './api';

export interface ProjectRequest {
  name: string;
  roots: string[];
}

export type ProjectField = keyof ProjectRequest;
export type ProjectValidation =
  | { ok: true; value: ProjectRequest }
  | { ok: false; field: ProjectField; message: string };

function normalizedRoot(path: string): string {
  if (/^[a-zA-Z]:[\\/]/.test(path)) {
    const drive = path.slice(0, 2).toLowerCase();
    const segments: string[] = [];
    for (const segment of path.slice(3).split(/[\\/]+/)) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment.toLowerCase());
    }
    return `${drive}\\${segments.join('\\')}`;
  }
  if (path.startsWith('\\\\')) {
    const segments: string[] = [];
    for (const segment of path.slice(2).split(/[\\/]+/)) {
      if (!segment || segment === '.') continue;
      if (segment === '..') segments.pop();
      else segments.push(segment.toLowerCase());
    }
    return `\\\\${segments.join('\\')}`;
  }
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

export function validateProjectRoots(roots: string[]): string | undefined {
  if (roots.length === 0) return 'Select at least one repository folder.';
  if (roots.length > 20) return 'Select no more than 20 repository folders.';
  const normalized: string[] = [];
  for (const root of roots) {
    const absolute = root.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\');
    if (!absolute || root.includes('\0') || root.length > 4096) {
      return 'Each repository folder must be an absolute path of 4096 characters or fewer.';
    }
    const current = normalizedRoot(root);
    if (normalized.some(previous => current === previous || current.startsWith(`${previous.replace(/[\\/]$/, '')}${previous.includes('\\') ? '\\' : '/'}`)
      || previous.startsWith(`${current.replace(/[\\/]$/, '')}${current.includes('\\') ? '\\' : '/'}`))) {
      return 'Choose distinct folders without selecting a parent and its child.';
    }
    normalized.push(current);
  }
  return undefined;
}

export function validateProjectRequest(nameValue: string, roots: string[]): ProjectValidation {
  const name = nameValue.trim();
  if (!name) return { ok: false, field: 'name', message: 'Enter a project name.' };
  if (name.length > 100) return { ok: false, field: 'name', message: 'Use a project name with 100 characters or fewer.' };
  const rootsError = validateProjectRoots(roots);
  if (rootsError) return { ok: false, field: 'roots', message: rootsError };
  return { ok: true, value: { name, roots } satisfies ProjectRootRequest };
}
