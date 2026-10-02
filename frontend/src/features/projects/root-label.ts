export function projectRootLabel(path: string): string {
  const segments = path.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return segments.slice(-2).join('/') || path;
}
