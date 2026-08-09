import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env loader (no dotenv dependency).
 * Does not override variables already set in the process environment.
 */
export function loadEnvFile(filePath?: string): string | null {
  const resolved =
    filePath ??
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
  if (!existsSync(resolved)) return null;

  const text = readFileSync(resolved, 'utf8');
  for (const line of text.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return resolved;
}
