/**
 * Process env helpers for defect-drainer.
 *
 * Canonical prefix: `DEFECT_DRAINER_*`
 * Legacy prefix (still read): `DEFECT_CHANNEL_*` — do not use in new docs/config.
 */

/** First non-empty value among keys (in order). */
export function envFirst(...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

/**
 * Read `DEFECT_DRAINER_<suffix>`, then legacy `DEFECT_CHANNEL_<suffix>`.
 * @param suffix e.g. `HOST`, `GROK_SANDBOX`, `NORMALIZE_MODE`
 */
export function envDrainer(suffix: string): string | undefined {
  return envFirst(`DEFECT_DRAINER_${suffix}`, `DEFECT_CHANNEL_${suffix}`);
}

export function envDrainerFlag(suffix: string): boolean {
  return envDrainer(suffix) === '1';
}
