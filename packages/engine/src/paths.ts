import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * SPEC-0054: the path as the volume names it, symbolic links resolved and each existing name in
 * the case on disk (`realpathSync.native`); the names that do not exist yet follow, as given. On a
 * case-insensitive volume two spellings of one directory give one canonical path. Only comparisons
 * use it: what the engine records keeps the spelling it always had, so that an older engine reads
 * it (SPEC-0054 D-case-3).
 */
export function canonicalPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

/** Whether two paths name one place; false when either cannot be resolved (SPEC-0054). */
export function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return canonicalPath(a) === canonicalPath(b);
  } catch {
    return false;
  }
}

/** Whether `path` is `parent` or inside it, as the volume names them (SPEC-0054). */
export function insidePath(parent: string, path: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(path));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel));
}

/** `path` inside `root`, spelled from `root` on: the rest as the volume names it (SPEC-0054). */
export function rebasePath(root: string, path: string): string {
  return join(root, relative(canonicalPath(root), canonicalPath(path)));
}
