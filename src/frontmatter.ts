/**
 * Minimal YAML-frontmatter helpers for defect markdown files.
 * Supports scalars, string arrays, and quoted strings. Not a full YAML parser.
 */

export type FrontmatterValue = string | string[] | number | boolean | null;

export type Frontmatter = Record<string, FrontmatterValue>;

export function parseMarkdownWithFrontmatter(raw: string): {
  frontmatter: Frontmatter;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) {
    return { frontmatter: {}, body: text };
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    return { frontmatter: {}, body: text };
  }
  const fmBlock = text.slice(4, end).trimEnd();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  return { frontmatter: parseFrontmatterBlock(fmBlock), body };
}

export function parseFrontmatterBlock(block: string): Frontmatter {
  const out: Frontmatter = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1]!;
    const rest = m[2] ?? '';
    if (rest === '' || rest === '|' || rest === '>') {
      // multi-line scalar or empty → next indented lines as array items or block
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j] ?? '';
        const item = next.match(/^\s+-\s+(.*)$/);
        if (item) {
          items.push(unquote(item[1] ?? ''));
          j += 1;
          continue;
        }
        if (rest === '|' || rest === '>') {
          const indented = next.match(/^\s{2,}(.*)$/);
          if (indented || next === '') {
            items.push(indented?.[1] ?? '');
            j += 1;
            continue;
          }
        }
        break;
      }
      if (items.length && (rest === '' || lines[i + 1]?.match(/^\s+-\s+/))) {
        out[key] = items;
      } else if (rest === '|' || rest === '>') {
        out[key] = items.join('\n').trimEnd();
      } else {
        out[key] = '';
      }
      i = j;
      continue;
    }
    out[key] = coerceScalar(rest);
    i += 1;
  }
  return out;
}

function coerceScalar(raw: string): FrontmatterValue {
  const v = raw.trim();
  if (v === 'null' || v === '~') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return unquote(v);
}

function unquote(v: string): string {
  const t = v.trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

export function serializeFrontmatter(fm: Frontmatter): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${quoteIfNeeded(String(item))}`);
        }
      }
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      const s = String(value);
      if (s.includes('\n')) {
        lines.push(`${key}: |`);
        for (const row of s.split('\n')) {
          lines.push(`  ${row}`);
        }
      } else {
        lines.push(`${key}: ${quoteIfNeeded(s)}`);
      }
    }
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(s: string): string {
  if (s === '') return '""';
  if (/[:#\[\]{},&*?|>!%@`]/.test(s) || s.startsWith(' ') || s.endsWith(' ')) {
    return JSON.stringify(s);
  }
  return s;
}

export function serializeMarkdown(fm: Frontmatter, body: string): string {
  const b = body.startsWith('\n') ? body : `\n${body}`;
  const normalized = b.endsWith('\n') ? b : `${b}\n`;
  return `${serializeFrontmatter(fm)}${normalized}`;
}
