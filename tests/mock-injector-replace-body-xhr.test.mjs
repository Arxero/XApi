import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = readFileSync(new URL('../mock-injector.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'iife' });

const messageListeners = [];
const postedMessages = [];
let nativeSendCalls = 0;

const window = {
  location: { href: 'https://example.com/app/page.html' },
  addEventListener(type, listener) {
    if (type === 'message') messageListeners.push(listener);
  },
  postMessage(message) {
    postedMessages.push(message);
    for (const listener of messageListeners) listener({ source: window, data: message });
  },
  fetch: async () => new Response('unrelated')
};

class FakeXMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseType = '';
    this.responseText = '';
    this.response = '';
    this.responseURL = '';
    this.listeners = new Map();
    this.headers = new Map([
      ['content-type', 'application/json; charset=utf-8'],
      ['content-length', '17'],
      ['content-encoding', 'gzip'],
      ['etag', '"original-etag"'],
      ['digest', 'sha-256=original'],
      ['content-md5', 'original-md5'],
      ['content-range', 'bytes 0-16/17'],
      ['x-upstream', 'preserved']
    ]);
  }

  open(method, url) {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }

  setRequestHeader() {}

  addEventListener(type, listener, options) {
    const listeners = this.listeners.get(type) || [];
    listeners.push({ listener, capture: options === true || options?.capture === true });
    this.listeners.set(type, listeners);
  }

  dispatch(type) {
    const event = { type, target: this };
    const listeners = this.listeners.get(type) || [];
    for (const entry of listeners.filter(item => item.capture)) entry.listener.call(this, event);
    const propertyHandler = this[`on${type}`];
    if (propertyHandler) propertyHandler.call(this, event);
    for (const entry of listeners.filter(item => !item.capture)) entry.listener.call(this, event);
  }

  getResponseHeader(name) {
    return this.headers.get(name.toLowerCase()) || null;
  }

  getAllResponseHeaders() {
    return [...this.headers].map(([name, value]) => `${name}: ${value}`).join('\r\n') + '\r\n';
  }

  send() {
    nativeSendCalls++;
    this.status = this.responseStatus ?? 201;
    this.statusText = this.status === 0 ? '' : 'Created';
    this.responseText = '{"original":true}';
    this.response = this.responseText;
    this.responseURL = this.url;
    this.readyState = 4;
    this.dispatch('readystatechange');
    this.dispatch('load');
  }
}

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
    replaceBody: '{"mocked":true}'
  }]
});

const xhr = new FakeXMLHttpRequest();
let applicationObservation;
xhr.open('GET', 'https://example.com/api/crmOffers');
xhr.addEventListener('load', () => {
  applicationObservation = {
    body: xhr.responseText,
    response: xhr.response,
    status: xhr.status,
    statusText: xhr.statusText,
    contentType: xhr.getResponseHeader('content-type'),
    upstream: xhr.getResponseHeader('x-upstream'),
    contentLength: xhr.getResponseHeader('content-length'),
    contentEncoding: xhr.getResponseHeader('content-encoding'),
    etag: xhr.getResponseHeader('etag'),
    digest: xhr.getResponseHeader('digest'),
    contentMd5: xhr.getResponseHeader('content-md5'),
    contentRange: xhr.getResponseHeader('content-range'),
    marker: xhr.getResponseHeader('x-xapi-mock')
  };
});
xhr.send();

assert.equal(nativeSendCalls, 1);
assert.deepEqual(applicationObservation, {
  body: '{"mocked":true}',
  response: '{"mocked":true}',
  status: 201,
  statusText: 'Created',
  contentType: 'application/json',
  upstream: 'preserved',
  contentLength: null,
  contentEncoding: null,
  etag: null,
  digest: null,
  contentMd5: null,
  contentRange: null,
  marker: 'replace-body-rule'
});
assert.ok(postedMessages.some(message => message.type === 'hit' && message.ruleId === 'replace-body-rule'));

{
  const hitCountBeforeFailure = postedMessages.filter(
    message => message.type === 'hit' && message.ruleId === 'replace-body-rule'
  ).length;
  const failedXhr = new FakeXMLHttpRequest();
  let failureObservation;

  failedXhr.open('GET', 'https://example.com/api/crmOffers');
  failedXhr.responseStatus = 0;
  failedXhr.addEventListener('load', () => {
    failureObservation = {
      body: failedXhr.responseText,
      response: failedXhr.response,
      status: failedXhr.status,
      marker: failedXhr.getResponseHeader('x-xapi-mock')
    };
  });
  failedXhr.send();

  assert.deepEqual(failureObservation, {
    body: '{"original":true}',
    response: '{"original":true}',
    status: 0,
    marker: null
  });
  assert.equal(
    postedMessages.filter(message => message.type === 'hit' && message.ruleId === 'replace-body-rule').length,
    hitCountBeforeFailure,
    'failed XHR responses must not report a mock hit'
  );
}
