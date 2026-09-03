import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../mock-bridge.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'iife' });

const storage = {
  mockRules: [{
    id: 'crm-offers',
    name: 'CRM offers',
    enabled: true,
    urlPattern: 'https://example.com/api/crmOffers',
    matchMode: 'exact',
    hitCount: 7
  }],
  mockGlobalEnabled: true
};
const writes = [];
const messageListeners = [];
const window = {
  addEventListener(type, listener) {
    if (type === 'message') messageListeners.push(listener);
  },
  postMessage(message) {
    for (const listener of messageListeners) {
      listener({ source: window, data: message });
    }
  },
  setTimeout(callback) {
    callback();
    return 1;
  }
};
const chrome = {
  runtime: { lastError: undefined, sendMessage() {} },
  storage: {
    local: {
      get(keys, callback) {
        callback(Object.fromEntries(keys.map(key => [key, storage[key]])));
      },
      set(value) {
        writes.push(value);
        Object.assign(storage, value);
      }
    },
    onChanged: { addListener() {} }
  }
};

vm.runInContext(code, vm.createContext({ window, chrome, Date, console }));
window.postMessage({ source: 'xapi-mock', type: 'hit', ruleId: 'crm-offers' });

assert.equal(writes.length, 1, 'a hit should be persisted once');
assert.deepEqual(
  Object.keys(writes[0]),
  ['mockRules'],
  'legacy hit persistence updates the stored mock rule'
);
assert.equal(storage.mockRules[0].hitCount, 8);
assert.equal(storage.mockRules[0].matchMode, 'exact', 'the counter update preserves the existing exact match mode');
