import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../mock-injector.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'iife' });

const createHarness = (fetchImpl) => {
  const messageListeners = [];
  const postedMessages = [];

  const window = {
    location: { href: 'https://example.com/app/page.html' },
    addEventListener(type, listener) {
      if (type === 'message') messageListeners.push(listener);
    },
    postMessage(message) {
      postedMessages.push(message);
      for (const listener of messageListeners) {
        listener({ source: window, data: message });
      }
    },
    fetch: fetchImpl
  };

  class FakeXMLHttpRequest {}
  FakeXMLHttpRequest.prototype.open = function () {};
  FakeXMLHttpRequest.prototype.send = function () {};
  FakeXMLHttpRequest.prototype.setRequestHeader = function () {};

  const context = vm.createContext({
    window,
    XMLHttpRequest: FakeXMLHttpRequest,
    Response,
    Headers,
    URL,
    ProgressEvent: class ProgressEvent {},
    Event: class Event {},
    setTimeout,
    Date,
    console
  });
  vm.runInContext(code, context);

  const setRule = (overrides = {}) => {
    window.postMessage({
      source: 'xapi-mock',
      type: 'rules',
      enabled: true,
      rules: [{
        id: 'replace-body-rule',
        name: 'Replace response body',
        enabled: true,
        urlPattern: 'https://example.com/api/crmOffers',
        matchMode: 'startsWith',
        method: 'GET',
        mode: 'replace-body',
        replaceContentType: 'application/json',
        replaceBody: '{"mocked":true}',
        ...overrides
      }]
    });
  };

  return { window, postedMessages, setRule };
};

{
  let nativeFetchCalls = 0;
  const harness = createHarness(async () => {
    nativeFetchCalls++;
    return new Response('{"original":true}', {
      status: 201,
      statusText: 'Created',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-length': '17',
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
        'etag': '"original-etag"',
        'digest': 'sha-256=original',
        'content-md5': 'original-md5',
        'content-range': 'bytes 0-16/17',
        'x-upstream': 'preserved'
      }
    });
  });
  harness.setRule();

  const response = await harness.window.fetch('https://example.com/api/crmOffers');
  const body = await Promise.race([
    response.text(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('replacement body did not complete')), 250))
  ]);

  assert.equal(nativeFetchCalls, 1, 'pass-through replacement must execute the real request once');
  assert.equal(body, '{"mocked":true}');
  assert.equal(response.status, 201);
  assert.equal(response.statusText, 'Created');
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-upstream'), 'preserved');
  assert.equal(response.headers.get('content-length'), null);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('transfer-encoding'), null);
  assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('digest'), null);
  assert.equal(response.headers.get('content-md5'), null);
  assert.equal(response.headers.get('content-range'), null);
  assert.equal(response.headers.get('x-xapi-mock'), 'replace-body-rule');
  assert.ok(
    harness.postedMessages.some(message => message.type === 'hit' && message.ruleId === 'replace-body-rule'),
    'successful replacement should report a rule hit'
  );
}

{
  const expectedError = new Error('network failed');
  const harness = createHarness(async () => { throw expectedError; });
  harness.setRule();

  await assert.rejects(
    harness.window.fetch('https://example.com/api/crmOffers'),
    error => error === expectedError,
    'pass-through replacement must preserve network failures'
  );
  assert.ok(!harness.postedMessages.some(message => message.type === 'hit'));
}

{
  let nativeFetchCalls = 0;
  const harness = createHarness(async () => {
    nativeFetchCalls++;
    return new Response('{"endpoint":"original"}', { headers: { 'content-type': 'application/json' } });
  });
  harness.setRule({ matchMode: 'exact' });

  const childResponse = await harness.window.fetch('https://example.com/api/crmOffers/GetAccaBoost');
  assert.equal(await childResponse.text(), '{"endpoint":"original"}', 'exact rules must not match child endpoints');
  assert.equal(nativeFetchCalls, 1);
  assert.ok(!harness.postedMessages.some(message => message.type === 'hit'));

  const exactResponse = await harness.window.fetch('https://example.com/api/crmOffers');
  assert.equal(await exactResponse.text(), '{"mocked":true}', 'exact rules must match the configured endpoint');
  assert.equal(nativeFetchCalls, 2, 'replace-body must still call the exact endpoint once');
  assert.ok(harness.postedMessages.some(message => message.type === 'hit' && message.ruleId === 'replace-body-rule'));
}

{
  let nativeFetchCalls = 0;
  const harness = createHarness(async () => {
    nativeFetchCalls++;
    return new Response('original', { status: 202, headers: { 'content-type': 'text/plain' } });
  });
  harness.setRule({ mode: 'future-mode' });

  const response = await harness.window.fetch('https://example.com/api/crmOffers');
  assert.equal(await response.text(), 'original', 'unknown modes should fail open');
  assert.equal(nativeFetchCalls, 1);
  assert.ok(!harness.postedMessages.some(message => message.type === 'hit'));
}

{
  let nativeFetchCalls = 0;
  const harness = createHarness(async () => {
    nativeFetchCalls++;
    return new Response('network body');
  });
  harness.setRule({ mode: 'replace', replaceBody: 'offline mock', replaceContentType: 'text/plain' });

  const response = await harness.window.fetch('https://example.com/api/crmOffers');
  assert.equal(await response.text(), 'offline mock');
  assert.equal(nativeFetchCalls, 0, 'existing replace mode must remain an offline mock');
}
