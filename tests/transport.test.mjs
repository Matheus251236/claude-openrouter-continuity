import test from 'node:test';
import assert from 'node:assert/strict';
import { createContinuityTransport } from '../plugins/openrouter-continuity/src/transport.mjs';

const body = {
  model: 'claude-test', max_tokens: 50,
  system: [{ type: 'text', text: 'Preserve the session' }],
  tools: [{ name: 'read_file', input_schema: { type: 'object', properties: {} } }],
  messages: [
    { role: 'user', content: 'Continue the same work' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-123', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-123', content: 'file content' }] }
  ],
  metadata: { user_id: 'private-account-session' }
};
const auth = { authorization: 'Bearer FAKE_ANTHROPIC_CREDENTIAL', cookie: 'private-cookie', 'anthropic-beta': 'oauth-test' };
const error = (type = 'rate_limit_error', status = 429) => new Response(JSON.stringify({ type: 'error', error: { type } }), { status, headers: { 'content-type': 'application/json' } });
const ok = () => new Response(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'continued' }] }), { headers: { 'content-type': 'application/json' } });
function harness(responses, options = {}) {
  const calls = [];
  const transport = createContinuityTransport({ enabled: true, openRouterKey: 'FAKE_OPENROUTER_KEY',
    fetchImpl: async (url, init) => { calls.push({ url, ...init }); return responses.shift()(); }, ...options });
  return { calls, transport };
}

test('429 falls back within the same request, preserving all conversation and tool references', async () => {
  const { transport, calls } = harness([error, ok]);
  assert.equal((await (await transport.send(body, auth)).json()).content[0].text, 'continued');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/messages');
  const sent = JSON.parse(calls[1].body);
  for (const field of ['system', 'tools', 'messages', 'model']) assert.deepEqual(sent[field], body[field]);
  assert.deepEqual(JSON.parse(calls[0].body), body);
  assert.equal(body.metadata.user_id, 'private-account-session');
});

test('Anthropic credentials, OAuth headers and account metadata never reach OpenRouter', async () => {
  const { transport, calls } = harness([error, ok]);
  await transport.send(body, auth);
  assert.equal(calls[1].headers.get('authorization'), 'Bearer FAKE_OPENROUTER_KEY');
  for (const header of ['cookie', 'x-api-key', 'anthropic-beta']) assert.equal(calls[1].headers.has(header), false);
  assert.equal(calls[1].body.includes('private-account-session'), false);
  assert.equal(calls[0].headers.has('cookie'), false);
  assert.equal(calls[0].headers.get('authorization'), auth.authorization);
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[1].redirect, 'error');
});

for (const [name, response] of [
  ['success', ok], ['authentication', () => error('authentication_error', 401)],
  ['overload', () => error('overloaded_error', 529)],
  ['unstructured 429', () => new Response('Gateway rejected', { status: 429 })],
  ['unknown 429', () => error('unknown_error', 429)]
]) test(`${name} does not trigger a paid fallback`, async () => {
  const { transport, calls } = harness([response]);
  await (await transport.send(body, auth)).text();
  assert.equal(calls.length, 1);
});

test('explicit billing failure can fall back', async () => {
  const { transport, calls } = harness([() => error('billing_error', 402), ok]);
  await transport.send(body, auth);
  assert.equal(calls.length, 2);
});

for (const options of [{ enabled: false }, { openRouterKey: '' }, { maxFallbackRequests: 0 }])
  test(`inactive configuration passes through the original limit: ${JSON.stringify(options)}`, async () => {
    const { transport, calls } = harness([error], options);
    assert.equal((await transport.send(body, auth)).status, 429);
    assert.equal(calls.length, 1);
  });

test('successful SSE stream remains byte-for-byte intact', async () => {
  const stream = 'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const { transport, calls } = harness([() => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })]);
  assert.equal(await (await transport.send({ ...body, stream: true }, auth)).text(), stream);
  assert.equal(calls.length, 1);
});

test('an SSE limit before any message starts can fall back', async () => {
  const text = ': heartbeat\n\ndata: {"type":"ping"}\n\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n';
  const { transport, calls } = harness([() => new Response(text, { headers: { 'content-type': 'text/event-stream' } }), ok]);
  await transport.send({ ...body, stream: true }, auth);
  assert.equal(calls.length, 2);
});

test('a limit after a message starts is not replayed or duplicated', async () => {
  const text = 'data: {"type":"message_start"}\n\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n';
  const { transport, calls } = harness([() => new Response(text, { headers: { 'content-type': 'text/event-stream' } })]);
  assert.equal(await (await transport.send({ ...body, stream: true }, auth)).text(), text);
  assert.equal(calls.length, 1);
});

test('split UTF-8 and split SSE frames survive inspection', async () => {
  const text = 'data: {"type":"message_start","text":"seção"}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const { transport } = harness([() => new Response(new ReadableStream({
    start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); }
  }), { headers: { 'content-type': 'text/event-stream' } })]);
  assert.equal(await (await transport.send(body, auth)).text(), text);
});

test('fallback failure is returned once without loops', async () => {
  const { transport, calls } = harness([error, () => error('billing_error', 402)]);
  assert.equal((await transport.send(body, auth)).status, 402);
  assert.equal(calls.length, 2);
});

test('next turn probes primary again and recovers when subscription becomes available', async () => {
  const { transport, calls } = harness([error, ok, ok]);
  await transport.send(body, auth);
  await transport.send(body, auth);
  assert.equal(calls[2].url, calls[0].url);
  assert.equal(transport.status().fallbackRequests, 1);
});

test('concurrent requests cannot exceed the configured fallback cap', async () => {
  let fallbackCalls = 0;
  const transport = createContinuityTransport({ enabled: true, openRouterKey: 'fake', maxFallbackRequests: 1,
    fetchImpl: async url => url.includes('openrouter') ? (fallbackCalls++, ok()) : error() });
  await Promise.all([transport.send(body, auth), transport.send(body, auth)]);
  assert.equal(fallbackCalls, 1);
});

test('aborted request never starts a network request', async () => {
  const { transport, calls } = harness([]);
  await assert.rejects(transport.send(body, auth, { signal: AbortSignal.abort() }));
  assert.equal(calls.length, 0);
});

test('oversize error body is passed through unchanged without fallback', async () => {
  const text = JSON.stringify({ error: { type: 'rate_limit_error', detail: 'x'.repeat(70000) } });
  const { transport, calls } = harness([() => new Response(text, { status: 429, headers: { 'content-type': 'application/json' } })]);
  assert.equal(await (await transport.send(body, auth)).text(), text);
  assert.equal(calls.length, 1);
});

test('network errors are not treated as subscription exhaustion', async () => {
  let calls = 0;
  const transport = createContinuityTransport({ enabled: true, openRouterKey: 'fake', fetchImpl: async () => { calls++; throw new Error('offline'); } });
  await assert.rejects(transport.send(body, auth), /offline/);
  assert.equal(calls, 1);
});
