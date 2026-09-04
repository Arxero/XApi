import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'iife' });

const storageChangeListeners = [];
const badgeTexts = [];
const event = { addListener() {} };
const chrome = {
  action: {
    setBadgeText(details) {
      badgeTexts.push(details.text);
    },
    setBadgeBackgroundColor() {}
  },
  declarativeNetRequest: {
    updateSessionRules() {
      return Promise.resolve();
    },
    HeaderOperation: { SET: 'set' },
    RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
    ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' }
  },
  runtime: {
    id: 'test-extension',
    lastError: undefined,
    onInstalled: event,
    onStartup: event,
    onMessage: event
  },
  storage: {
    local: {
      get(_keys, callback) {
        callback({});
      },
      set() {}
    },
    onChanged: {
      addListener(listener) {
        storageChangeListeners.push(listener);
      }
    }
  },
  webRequest: {
    onBeforeRequest: event,
    onBeforeSendHeaders: event,
    onHeadersReceived: event,
    onCompleted: event,
    onErrorOccurred: event
  }
};

vm.runInContext(
  code,
  vm.createContext({ chrome, console, Date, Promise, setTimeout, TextDecoder })
);

assert.equal(storageChangeListeners.length, 1, 'background should register one storage listener');
const [onStorageChanged] = storageChangeListeners;

onStorageChanged({ isRecording: { oldValue: false, newValue: true } });
assert.equal(badgeTexts.at(-1), 'REC', 'enabling recording should show the REC badge');

onStorageChanged({ isRecording: { oldValue: true } });
assert.equal(badgeTexts.at(-1), '', 'removing isRecording should clear the REC badge');
