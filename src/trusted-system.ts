import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

function trustedSystemNode(stat: Stats): boolean {
  return stat.uid === 0 && (stat.isSymbolicLink() || (stat.mode & 0o022) === 0);
}

export function trustedSystemPath(path: string, kind: 'file' | 'directory'): string | undefined {
  try {
    if (!isAbsolute(path) || resolve(path) !== path) return undefined;

    const inspectAncestors = (candidate: string) => {
      if (!isAbsolute(candidate) || resolve(candidate) !== candidate) return false;
      const root = candidate.slice(0, candidate.indexOf(sep) + 1) || sep;
      let current = root;
      const rootStat = lstatSync(root);
      if (!rootStat.isDirectory() || !trustedSystemNode(rootStat)) return false;
      const segments = candidate.slice(root.length).split(sep).filter(Boolean);
      if (!segments.length) return false;
      for (let index = 0; index < segments.length; index++) {
        current = resolve(current, segments[index]);
        const stat = lstatSync(current);
        if (!trustedSystemNode(stat)) return false;
        if (index < segments.length - 1 && !stat.isDirectory() && !stat.isSymbolicLink()) return false;
      }
      return true;
    };

    if (!inspectAncestors(path)) return undefined;
    const realPath = realpathSync.native(path);
    if (!inspectAncestors(realPath)) return undefined;
    const target = statSync(realPath);
    if (!trustedSystemNode(target)) return undefined;
    if (kind === 'file' && (!target.isFile() || (target.mode & 0o111) === 0)) return undefined;
    if (kind === 'directory' && !target.isDirectory()) return undefined;
    return realPath;
  } catch {
    return undefined;
  }
}
