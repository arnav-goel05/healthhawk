// HealthHawk — robust CLI entry-point guard (merge round, 01-review N2).
// The naive `resolve(process.argv[1]) === fileURLToPath(import.meta.url)`
// comparison is symlink-sensitive: invoking a script through a symlinked path
// (e.g. macOS /var/folders/… -> /private/var/folders/…) made the guard false,
// so the CLI body silently no-opped with exit 0 — a canary that never ran.
// Node resolves the main module's realpath for import.meta.url, so compare
// REALPATHS on both sides. Falls back to plain resolve equality when either
// path cannot be realpath'd (and returns false for a missing argv[1]).

import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isMain(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const self = fileURLToPath(importMetaUrl);
  const entry = resolve(argv1);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    return false;
  }
}