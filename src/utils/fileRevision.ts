import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';

/**
 * A native-history revision token for one file: size changes on every append, and the modification time
 * also catches same-length rewrites. Null when the file cannot be read.
 */
export async function readFileRevision(filePath: string): Promise<string | null> {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : null;
  } catch {
    return null;
  }
}

/** The first wait before watching again after a watch failed; it doubles with each failure, to a minute. */
export const FILE_WATCH_RETRY_MS = 1_000;
const FILE_WATCH_RETRY_MAX_MS = 60_000;
/** How long a watch must hold, or deliver a change, before the wait goes back to the first. */
const FILE_WATCH_STABLE_MS = 30_000;

/**
 * Calls `onChange` when the file may have changed, as the operating system reports it (no polling); returns
 * the watch's stop, or null when the file cannot be watched. A watch that fails later is started again, after
 * a wait that doubles with each failure until a watch has held (a browser's watch starts at once and is refused
 * a moment later, so starting is no proof), and reports one change when it starts, for what it may have missed.
 */
export function watchFileChanges(filePath: string, onChange: () => void): (() => void) | null {
  let stopped = false;
  let watcher: ReturnType<typeof watch> | null = null;
  let retry: number | null = null;
  let stable: number | null = null;
  let wait = FILE_WATCH_RETRY_MS;
  const held = () => {
    wait = FILE_WATCH_RETRY_MS;
    if (stable !== null) window.clearTimeout(stable);
    stable = null;
  };
  const start = (): boolean => {
    try {
      const started = watch(filePath, { persistent: false }, () => {
        if (stopped || watcher !== started) return;
        held();
        onChange();
      });
      watcher = started;
      stable = window.setTimeout(held, FILE_WATCH_STABLE_MS);
      started.on('error', () => {
        if (stopped || watcher !== started) return;
        started.close();
        watcher = null;
        if (stable !== null) window.clearTimeout(stable);
        stable = null;
        again();
      });
      return true;
    } catch {
      return false;
    }
  };
  const again = () => {
    const delay = wait;
    wait = Math.min(wait * 2, FILE_WATCH_RETRY_MAX_MS);
    retry = window.setTimeout(() => {
      retry = null;
      if (stopped) return;
      if (start()) onChange();
      else again();
    }, delay);
  };
  if (!start()) return null;
  return () => {
    if (stopped) return;
    stopped = true;
    for (const timer of [retry, stable]) if (timer !== null) window.clearTimeout(timer);
    retry = null;
    stable = null;
    watcher?.close();
    watcher = null;
  };
}
