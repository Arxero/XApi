import { JsonPatch, MockRule, RuleMatchMode } from './types';
import { generateId } from './utils';

// ============== Rule matching ==============

export const matchUrl = (url: string, pattern: string, mode: RuleMatchMode): boolean => {
  if (!pattern) return false;
  if (mode === 'exact') return url === pattern;
  if (mode === 'contains') {
    try {
      const requestUrl = new URL(url);
      const patternUrl = new URL(pattern);
      const matchesDomain = requestUrl.hostname === patternUrl.hostname || requestUrl.hostname.endsWith(`.${patternUrl.hostname}`);
      return requestUrl.protocol === patternUrl.protocol && requestUrl.port === patternUrl.port && matchesDomain && requestUrl.pathname === patternUrl.pathname;
    } catch {
      return false;
    }
  }
  return url.startsWith(pattern);
};

export const matchRule = (
  url: string,
  method: string,
  rules: MockRule[]
): MockRule | undefined => {
  const m = (method || 'GET').toUpperCase();
  for (const r of rules) {
    if (!r.enabled) continue;
    if (r.method && r.method !== 'ANY' && r.method !== m) continue;
    if (matchUrl(url, r.urlPattern, r.matchMode)) return r;
  }
  return undefined;
};

// ============== JSON path ==============

const RAW_PREFIX = '::raw::';

interface PathSeg {
  type: 'key' | 'index';
  value: string | number;
}

const parsePath = (path: string): PathSeg[] => {
  const segs: PathSeg[] = [];
  // Split by `.`, then break each segment by `[N]`
  const parts = path.split('.').filter(p => p !== '');
  for (const part of parts) {
    const m = part.match(/^([^\[\]]*)((?:\[\d+\])*)$/);
    if (!m) {
      segs.push({ type: 'key', value: part });
      continue;
    }
    const head = m[1];
    const tail = m[2];
    if (head) segs.push({ type: 'key', value: head });
    if (tail) {
      const idxRegex = /\[(\d+)\]/g;
      let mm: RegExpExecArray | null;
      while ((mm = idxRegex.exec(tail)) !== null) {
        segs.push({ type: 'index', value: parseInt(mm[1], 10) });
      }
    }
  }
  return segs;
};

const interpretValue = (v: string): any => {
  if (v.startsWith(RAW_PREFIX)) {
    const raw = v.slice(RAW_PREFIX.length);
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // fall back to literal string
    }
  }
  return v;
};

/**
 * Apply a single patch in-place. Returns true if path resolved & set;
 * false if any segment was missing (we do NOT auto-create new keys).
 */
export const applyJsonPatch = (data: any, patch: JsonPatch): boolean => {
  if (!patch.enabled || !patch.path) return false;
  const segs = parsePath(patch.path);
  if (segs.length === 0) return false;

  let cur = data;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur == null || typeof cur !== 'object') return false;
    if (s.type === 'index' && Array.isArray(cur)) {
      cur = cur[s.value as number];
    } else if (s.type === 'key' && !Array.isArray(cur)) {
      cur = cur[s.value as string];
    } else {
      return false;
    }
  }
  if (cur == null || typeof cur !== 'object') return false;

  const last = segs[segs.length - 1];
  const value = interpretValue(patch.value);
  if (last.type === 'index' && Array.isArray(cur)) {
    cur[last.value as number] = value;
    return true;
  }
  if (last.type === 'key' && !Array.isArray(cur)) {
    (cur as any)[last.value as string] = value;
    return true;
  }
  return false;
};

export const applyJsonPatches = (data: any, patches?: JsonPatch[]): number => {
  if (!patches || patches.length === 0) return 0;
  let n = 0;
  for (const p of patches) {
    if (applyJsonPatch(data, p)) n++;
  }
  return n;
};

/**
 * Recursively collect all leaf paths from a JSON object for autocompletion.
 * Limits: max 200 paths, max depth 6.
 */
export const collectJsonPaths = (data: any): string[] => {
  const out: string[] = [];
  const MAX = 200;
  const MAX_DEPTH = 6;
  const walk = (v: any, prefix: string, depth: number) => {
    if (out.length >= MAX || depth > MAX_DEPTH) return;
    if (v == null || typeof v !== 'object') {
      if (prefix) out.push(prefix);
      return;
    }
    if (Array.isArray(v)) {
      // Only sample first index to avoid blow-up
      if (v.length > 0) walk(v[0], `${prefix}[0]`, depth + 1);
      else if (prefix) out.push(prefix);
      return;
    }
    const keys = Object.keys(v);
    if (keys.length === 0 && prefix) {
      out.push(prefix);
      return;
    }
    for (const k of keys) {
      if (out.length >= MAX) break;
      const next = prefix ? `${prefix}.${k}` : k;
      walk(v[k], next, depth + 1);
    }
  };
  walk(data, '', 0);
  return out;
};

/**
 * Stringify a leaf JSON value into the textual form used by the patch editor.
 * Plain strings stay as-is; numbers/booleans/null are wrapped with the
 * "::raw::" prefix so applyJsonPatch -> interpretValue inflates them back.
 */
const stringifyLeafValue = (v: any): string => {
  if (typeof v === 'string') return v;
  if (v === null || typeof v === 'number' || typeof v === 'boolean') {
    return `::raw::${JSON.stringify(v)}`;
  }
  // Should not happen — collectJsonPaths only descends to leaves — but if a
  // sparse array slot or odd value sneaks in, fall back to JSON.
  try { return `::raw::${JSON.stringify(v)}`; } catch { return ''; }
};

/**
 * Walk a JSON value the same way collectJsonPaths does and produce JsonPatch
 * rows pre-filled with the current value. Used by "Mock this response" to
 * seed the patch-json editor from a captured response body. Bounded by the
 * same MAX/MAX_DEPTH so we don't explode on huge payloads.
 */
export const buildPatchesFromJson = (data: any): JsonPatch[] => {
  const out: JsonPatch[] = [];
  const MAX = 200;
  const MAX_DEPTH = 6;
  const push = (path: string, value: any) => {
    if (!path) return;
    out.push({ id: generateId(), path, value: stringifyLeafValue(value), enabled: true });
  };
  const walk = (v: any, prefix: string, depth: number) => {
    if (out.length >= MAX || depth > MAX_DEPTH) return;
    if (v == null || typeof v !== 'object') { push(prefix, v); return; }
    if (Array.isArray(v)) {
      if (v.length > 0) walk(v[0], `${prefix}[0]`, depth + 1);
      // Empty arrays are not patchable as leaves — skip.
      return;
    }
    const keys = Object.keys(v);
    if (keys.length === 0) {
      // Empty object — not patchable as a leaf, skip.
      return;
    }
    for (const k of keys) {
      if (out.length >= MAX) break;
      const next = prefix ? `${prefix}.${k}` : k;
      walk(v[k], next, depth + 1);
    }
  };
  walk(data, '', 0);
  return out;
};

// ============== Factories ==============

export const createMockRule = (partial?: Partial<MockRule>): MockRule => ({
  id: generateId(),
  name: 'New Mock Rule',
  enabled: true,
  urlPattern: '',
  matchMode: 'exact',
  method: 'ANY',
  mode: 'replace',
  replaceStatus: 200,
  replaceContentType: 'application/json',
  replaceBody: '',
  jsonPatches: [],
  createdAt: Date.now(),
  hitCount: 0,
  ...(partial || {})
});

export const createJsonPatch = (partial?: Partial<JsonPatch>): JsonPatch => ({
  id: generateId(),
  path: '',
  value: '',
  enabled: true,
  ...(partial || {})
});

// ============== Storage helpers ==============

export const MOCK_RULES_KEY = 'mockRules';
export const MOCK_GLOBAL_ENABLED_KEY = 'mockGlobalEnabled';

// Global request headers (Header tab in popup).
export const GLOBAL_HEADERS_KEY = 'globalHeaders';
export const GLOBAL_HEADERS_ENABLED_KEY = 'globalHeadersEnabled';
