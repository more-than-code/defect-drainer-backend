import { closeSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import koffi from 'koffi';

/** POSIX flock(2) — same constants as Darwin/Linux libc. */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

function loadLibc() {
  if (process.platform === 'darwin') {
    return koffi.load('libSystem.B.dylib');
  }
  if (process.platform === 'linux') {
    return koffi.load('libc.so.6');
  }
  throw new Error(`flock is not supported on ${process.platform}`);
}

const libc = loadLibc();
const flock = libc.func('int flock(int fd, int operation)');

export type DataLock = {
  path: string;
  release: () => void;
};

/**
 * Exclusive non-blocking flock on `{dataRoot}/defect-drainer.lock`.
 * Interoperates with Go `syscall.Flock(LOCK_EX|LOCK_NB)` — POSIX flock(2), not fcntl.
 */
export function acquireDataLock(dataRoot: string): DataLock {
  mkdirSync(dataRoot, { recursive: true });
  const lockPath = path.join(dataRoot, 'defect-drainer.lock');
  const fd = openSync(lockPath, 'a+');
  const rc = flock(fd, LOCK_EX | LOCK_NB) as number;
  if (rc !== 0) {
    closeSync(fd);
    throw new Error(`data dir locked: ${dataRoot}`);
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    },
  };
}
