import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureSeededApps } from './apps.js';
import { openDatabase } from './db.js';
import { acquireDataLock } from './lock.js';
import { BatchJobRunner } from './jobs/batchJob.js';
import { NormalizeJobRunner } from './jobs/normalizeJob.js';
import { envDrainer } from './env.js';
import { loadEnvFile } from './loadEnv.js';
import { migrateFilesystemIfNeeded } from './migrateFs.js';
import { resolveDataRoot, resolveDefectsRoot } from './paths.js';
import { registerRoutes } from './routes.js';
import { DefectStore } from './store.js';

export async function buildApp(opts?: {
  defectsRoot?: string;
  dataRoot?: string;
  /** Skip FS→SQLite migration (tests can use empty DB) */
  skipMigrate?: boolean;
}) {
  const defectsRoot = resolveDefectsRoot(opts?.defectsRoot);
  const dataRoot = resolveDataRoot(defectsRoot, opts?.dataRoot);
  const lock = acquireDataLock(dataRoot);
  try {
    const db = openDatabase(dataRoot);
    if (!opts?.skipMigrate) {
      const mig = migrateFilesystemIfNeeded(db, defectsRoot);
      if (mig.apps || mig.defects || mig.batches) {
        // eslint-disable-next-line no-console
        console.log(
          `sqlite migrate: apps=${mig.apps} defects=${mig.defects} batches=${mig.batches}`,
        );
      }
    }
    ensureSeededApps(db);

    const store = new DefectStore(db, defectsRoot);
    const jobs = new NormalizeJobRunner(store, dataRoot);
    const batches = new BatchJobRunner(store, dataRoot);

    const app = Fastify({ logger: false });

    await app.register(multipart, {
      limits: {
        fileSize: 25 * 1024 * 1024,
        files: 12,
      },
    });

    await registerRoutes(app, { store, jobs, batches, defectsRoot, db });

    app.addHook('onClose', async () => {
      try {
        db.close();
      } catch {
        /* already closed */
      }
      lock.release();
    });

    return { app, store, jobs, batches, defectsRoot, dataRoot, db, lock };
  } catch (err) {
    lock.release();
    throw err;
  }
}

async function main() {
  // Load .env here, not at module scope: importing buildApp (tests) must not
  // pick up a developer's local config, or ambient env changes test outcomes.
  loadEnvFile();
  const host = envDrainer('HOST') ?? '127.0.0.1';
  const port = Number(envDrainer('PORT') ?? '8788');
  const { app, defectsRoot, dataRoot } = await buildApp();

  await app.listen({ host, port });
  // eslint-disable-next-line no-console
  console.log(
    `defect-drainer-backend http://${host}:${port}  evidenceRoot=${defectsRoot}  db=${path.join(dataRoot, 'defect-drainer.db')}`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
