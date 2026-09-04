import type { MockRule } from './types';

/**
 * XApi mock-bridge — runs as a content script in the ISOLATED world.
 * It bridges chrome.storage rules to the page's MAIN world (mock-injector.ts)
 * via window.postMessage, and forwards hit reports back to storage.
 */

const MSG_TAG = 'xapi-mock';
const MOCK_RULES_KEY = 'mockRules';
const MOCK_GLOBAL_ENABLED_KEY = 'mockGlobalEnabled';

type MockStorage = {
  mockRules?: MockRule[];
  mockGlobalEnabled?: boolean;
};

let pendingHits: Record<string, number> = {};
let flushTimer: number | null = null;
let lastFlush = 0;

const sendRulesToMainWorld = (enabled: boolean, rules: MockRule[]) => {
  window.postMessage({ source: MSG_TAG, type: 'rules', enabled, rules }, '*');
};

const loadAndPush = () => {
  try {
    chrome.storage.local.get<MockStorage>([MOCK_RULES_KEY, MOCK_GLOBAL_ENABLED_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      const rules = result[MOCK_RULES_KEY] || [];
      const enabled = result[MOCK_GLOBAL_ENABLED_KEY] === true; // default OFF
      sendRulesToMainWorld(enabled, rules);
    });
  } catch { /* extension context invalidated */ }
};

// Push initial rules ASAP. Note: the MAIN-world script may not have its
// listener wired yet at this exact tick, but storage callbacks are async
// so by the time we postMessage, document_start scripts have run.
loadAndPush();

// Re-push when the user toggles rules.
try {
  chrome.storage.onChanged.addListener((changes, area?: string) => {
    if (area !== 'local') return;
    if (changes[MOCK_RULES_KEY] || changes[MOCK_GLOBAL_ENABLED_KEY]) {
      loadAndPush();
    }
  });
} catch { /* noop */ }

// Re-push when the page asks (e.g. injector loaded after us)
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const data = e.data;
  if (!data || data.source !== MSG_TAG) return;

  if (data.type === 'hit' && typeof data.ruleId === 'string') {
    pendingHits[data.ruleId] = (pendingHits[data.ruleId] || 0) + 1;
    scheduleFlush();
    return;
  }
  if (data.type === 'response' && typeof data.url === 'string') {
    // Forward to the service worker so it can attach the body to the matching
    // log entry. Best-effort — silently drop if the SW is gone (extension
    // context invalidated, page in BFCache, etc).
    try {
      chrome.runtime.sendMessage({
        type: 'XAPI_RESPONSE_BODY',
        payload: {
          url: data.url,
          method: data.method,
          status: data.status,
          contentType: data.contentType,
          body: data.body,
          truncated: !!data.truncated,
          ts: data.ts || Date.now()
        }
      }, () => { void chrome.runtime.lastError; });
    } catch { /* noop */ }
    return;
  }
  if (data.type === 'request-rules') {
    loadAndPush();
    return;
  }
});

const FLUSH_INTERVAL = 1000;

const scheduleFlush = () => {
  if (flushTimer != null) return;
  const now = Date.now();
  const wait = Math.max(0, FLUSH_INTERVAL - (now - lastFlush));
  flushTimer = window.setTimeout(() => {
    flushTimer = null;
    flushHits();
  }, wait);
};

const flushHits = () => {
  const hits = pendingHits;
  pendingHits = {};
  lastFlush = Date.now();
  const ids = Object.keys(hits);
  if (ids.length === 0) return;
  try {
    chrome.storage.local.get<MockStorage>([MOCK_RULES_KEY], (result) => {
      if (chrome.runtime.lastError) return;
      const rules = result[MOCK_RULES_KEY] || [];
      let changed = false;
      const next = rules.map(r => {
        const inc = hits[r.id];
        if (!inc) return r;
        changed = true;
        return { ...r, hitCount: (r.hitCount || 0) + inc, lastHitAt: lastFlush };
      });
      if (changed) chrome.storage.local.set({ [MOCK_RULES_KEY]: next });
    });
  } catch { /* noop */ }
};
