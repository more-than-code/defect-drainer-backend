import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { acquireDataLock } from '../src/lock.js';
import { buildApp } from '../src/server.js';

const backendGo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../backend-go',
);
const goBin = path.join(backendGo, 'bin', 'defect-drainer');

describe('data dir flock', () => {
  const defectsRoot = mkdtempSync(path.join(tmpdir(), 'dd-lock-def-'));
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'dd-lock-data-'));

  after(() => {
    rmSync(defectsRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it('second TS locker fails immediately', () => {
    const a = acquireDataLock(dataRoot);
    try {
      assert.throws(() => acquireDataLock(dataRoot), /data dir locked/);
    } finally {
      a.release();
    }
  });

  it('buildApp then Go serve on the same data dir exits 1', async () => {
    const built = await buildApp({
      defectsRoot,
      dataRoot,
      skipMigrate: true,
    });
    try {
      const r = spawnSync(goBin, ['serve'], {
        cwd: backendGo,
        env: {
          ...process.env,
          DEFECTS_ROOT: defectsRoot,
          DEFECT_DRAINER_DATA: dataRoot,
          DEFECT_DRAINER_HOST: '127.0.0.1',
          DEFECT_DRAINER_PORT: '18788',
        },
        encoding: 'utf8',
        timeout: 8_000,
      });
      assert.notEqual(r.status, 0);
      const msg = `${r.stderr || ''}${r.stdout || ''}`;
      assert.match(msg, /locked|data dir/i);
    } finally {
      await built.app.close();
    }
  });

  it('Go serve then TS buildApp fails to listen', async () => {
    assert.ok(existsSync(goBin), `missing ${goBin}`);
    const defects2 = mkdtempSync(path.join(tmpdir(), 'dd-lock-def2-'));
    const data2 = mkdtempSync(path.join(tmpdir(), 'dd-lock-data2-'));
    const port = '18790';
    const child = spawn(goBin, ['serve'], {
      cwd: backendGo,
      env: {
        ...process.env,
        DEFECTS_ROOT: defects2,
        DEFECT_DRAINER_DATA: data2,
        DEFECT_DRAINER_HOST: '127.0.0.1',
        DEFECT_DRAINER_PORT: port,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      let up = false;
      for (let i = 0; i < 50; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.ok) {
            up = true;
            break;
          }
        } catch {
          /* not yet */
        }
        await delay(50);
      }
      assert.equal(up, true, 'Go serve did not become healthy');
      await assert.rejects(
        () => buildApp({ defectsRoot: defects2, dataRoot: data2, skipMigrate: true }),
        /locked/i,
      );
    } finally {
      child.kill('SIGTERM');
      await delay(100);
      child.kill('SIGKILL');
      rmSync(defects2, { recursive: true, force: true });
      rmSync(data2, { recursive: true, force: true });
    }
  });
});
