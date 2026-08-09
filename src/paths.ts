import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { envDrainer } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Backend package root (`defect-drainer/backend`) */
export const packageRoot = path.resolve(__dirname, '..');

/** Umbrella root (parent of backend) — inventory SSOT lives here */
export const umbrellaRoot = path.resolve(packageRoot, '..');

/**
 * Inventory root: open/, resolved/, evidence/, batches/
 * Default: umbrella root (parent of this package).
 */
export function resolveDefectsRoot(override?: string): string {
  return override ?? process.env.DEFECTS_ROOT ?? umbrellaRoot;
}

/** Job handoff / runtime data (default: backend/.data) */
export function resolveDataRoot(defectsRoot: string, override?: string): string {
  return (
    override ??
    envDrainer('DATA') ??
    path.join(packageRoot, '.data')
  );
}

export function openDir(defectsRoot: string): string {
  return path.join(defectsRoot, 'open');
}

export function resolvedDir(defectsRoot: string): string {
  return path.join(defectsRoot, 'resolved');
}

export function evidenceDir(defectsRoot: string): string {
  return path.join(defectsRoot, 'evidence');
}

export function batchesDir(defectsRoot: string): string {
  return path.join(defectsRoot, 'batches');
}

export function jobsDir(dataRoot: string): string {
  return path.join(dataRoot, 'jobs');
}

/** SQLite SSOT path */
export function resolveDbPath(dataRoot: string): string {
  return path.join(dataRoot, 'defect-drainer.db');
}
