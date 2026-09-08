import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createContinuityTransport,
  toOpenRouterChatRequest,
  translateAnthropicModel
} from '../plugins/openrouter-continuity/src/transport.mjs';

const body = {
  model: 'claude-3-5-sonnet-20241022',
  max_tokens: 50,
  system: [{ type: 'text', text: 'Preserve the session' }],
  tools: [{ name: 'read_file', description: 'Read one file', input_schema: {
    type: 'object', properties: { path: { type: 'string' } }
  } }],
  messages: [
    { role: 'user', content: 'Continue the same work' },
    { role: 'assistant', content: [
      { type: 'text', text: 'Reading.' },
      { type: 'tool_use', id: 'tool-123', name: 'read_file', input: { path: 'a.txt' } }
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'tool-123', content: 'file content' }
    ] }
  ],
  metadata: { user_id: 'private-account-session' }
};
const auth = {
  authorization: 'Bearer unit-test-primary',
  cookie: 'private-cookie',
  'anthropic-beta': 'oauth-test'
};
const rateLimit = () => new Response(JSON.stringify({
  type: 'error', error: { type: 'rate_limit_error' }
}), { status: 429, headers: { 'content-type': 'application/json' } });
const primaryOk = () => new Response(JSON.stringify({
  type: 'message', content: [{ type: 'text', text: 'primary' }]
}), { headers: { 'content-type': 'application/json' } });
const fallbackOk = () => new Response(JSON.stringify({
  id: 'gen-1',
  model: 'anthropic/claude-3.5-sonnet',
  choices: [{ index: 0, finish_reason: 'stop', message: {
    role: 'assistant', content: 'continued'
  } }],
  usage: { prompt_tokens: 12, completion_tokens: 3 }
}), { headers: { 'content-type': 'application/json' } });

function harness(responses, options = {}) {
  const calls = [];
  const transport = createContinuityTransport({
    enabled: true,
    openRouterKey: 'unit-test-fallback',
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init });
      return responses.shift()();
    },
    ...options
  });
  return { calls, transport };
}

test('dynamically normalizes dated Anthropic model identifiers', () => {
  assert.equal(translateAnthropicModel('claude-3-5-sonnet-20241022'), 'anthropic/claude-3.5-sonnet');
  assert.equal(translateAnthropicModel('claude-sonnet-4-5-20250929'), 'anthropic/claude-sonnet-4.5');
  assert.equal(translateAnthropicModel('claude-opus-4-1-20250805'), 'anthropic/claude-opus-4.1');
  assert.equal(translateAnthropicModel('anthropic/claude-sonnet-4'), 'anthropic/claude-sonnet-4');
  assert.equal(translateAnthropicModel('future-model', {
    'future-model': 'anthropic/claude-future'
  }), 'anthropic/claude-future');
});

test('converts Anthropic messages and tool references to Chat Completions', () => {
  const converted = toOpenRouterChatRequest(body);
  assert.equal(converted.model, 'anthropic/claude-3.5-sonnet');
  assert.deepEqual(converted.messages[0], { role: 'system', content: 'Preserve the session' });
  assert.equal(converted.messages[2].tool_calls[0].id, 'tool-123');
  assert.equal(converted.messages[3].role, 'tool');
  assert.equal(converted.messages[3].tool_call_id, 'tool-123');
  assert.equal(converted.tools[0].function.name, 'read_file');
  assert.equal('metadata' in converted, false);
});

test('HTTP 429 retries once on OpenRouter Chat Completions and returns Anthropic JSON', async () => {
  const { transport, calls } = harness([rateLimit, fallbackOk]);
  const response = await transport.send(body, auth);
  const result = await response.json();
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(JSON.parse(calls[1].body).model, 'anthropic/claude-3.5-sonnet');
  assert.equal(result.type, 'message');
  assert.equal(result.model, body.model);
  assert.equal(result.content[0].text, 'continued');
  assert.equal(result.usage.input_tokens, 12);
});

test('Anthropic credentials, cookies and account metadata never reach OpenRouter', async () => {
  const { transport, calls } = harness([rateLimit, fallbackOk]);
  await transport.send(body, auth);
  assert.equal(calls[1].headers.get('authorization'), 'Bearer unit-test-fallback');
  for (const header of ['cookie', 'x-api-key', 'anthropic-beta']) {
    assert.equal(calls[1].headers.has(header), false);
  }
  assert.equal(calls[1].body.includes('private-account-session'), false);
  assert.equal(calls[0].headers.has('cookie'), false);
  assert.equal(calls[0].headers.get('authorization'), auth.authorization);
});

for (const [name, response] of [
  ['success', primaryOk],
  ['authentication failure', () => new Response('{}', { status: 401 })],
  ['overload', () => new Response('{}', { status: 529 })],
  ['billing failure', () => new Response('{}', { status: 402 })]
]) {
  test(`${name} does not trigger OpenRouter fallback`, async () => {
    const { transport, calls } = harness([response]);
    await (await transport.send(body, auth)).text();
    assert.equal(calls.length, 1);
  });
}

for (const options of [
  { enabled: false },
  { openRouterKey: '' },
  { maxFallbackRequests: 0 }
]) {
  test(`inactive configuration passes through HTTP 429: ${JSON.stringify(options)}`, async () => {
    const { transport, calls } = harness([rateLimit], options);
    assert.equal((await transport.send(body, auth)).status, 429);
    assert.equal(calls.length, 1);
  });
}

test('OpenRouter tool calls are converted back to Anthropic tool_use blocks', async () => {
  const fallbackTool = () => new Response(JSON.stringify({
    id: 'gen-tools',
    choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'tool-456', type: 'function', function: {
        name: 'read_file', arguments: '{"path":"b.txt"}'
      } }]
    } }],
    usage: { prompt_tokens: 5, completion_tokens: 4 }
  }), { headers: { 'content-type': 'application/json' } });
  const { transport } = harness([rateLimit, fallbackTool]);
  const result = await (await transport.send(body, auth)).json();
  assert.equal(result.stop_reason, 'tool_use');
  assert.deepEqual(result.content[0], {
    type: 'tool_use', id: 'tool-456', name: 'read_file', input: { path: 'b.txt' }
  });
});

test('OpenRouter streaming response is translated to Anthropic SSE', async () => {
  const sse = [
    'data: {"id":"gen-stream","choices":[{"delta":{"role":"assistant","content":"Olá"},"finish_reason":null}]}',
    'data: {"id":"gen-stream","choices":[{"delta":{"content":" mundo"},"finish_reason":null}]}',
    'data: {"id":"gen-stream","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"completion_tokens":2}}',
    'data: [DONE]',
    ''
  ].join('\n\n');
  const fallbackStream = () => new Response(sse, {
    headers: { 'content-type': 'text/event-stream' }
  });
  const { transport } = harness([rateLimit, fallbackStream]);
  const response = await transport.send({ ...body, stream: true }, auth);
  const text = await response.text();
  assert.match(text, /event: message_start/);
  assert.match(text, /"type":"text_delta","text":"Olá"/);
  assert.match(text, /"type":"text_delta","text":" mundo"/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /event: message_stop/);
  assert.equal(text.includes('[DONE]'), false);
});

test('OpenRouter errors are returned in Anthropic error shape', async () => {
  const fallbackError = () => new Response(JSON.stringify({
    error: { message: 'fallback rejected' }
  }), { status: 401, headers: { 'content-type': 'application/json' } });
  const { transport } = harness([rateLimit, fallbackError]);
  const response = await transport.send(body, auth);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    type: 'error',
    error: { type: 'authentication_error', message: 'fallback rejected' }
  });
});

test('next turn probes Anthropic again after one fallback', async () => {
  const { transport, calls } = harness([rateLimit, fallbackOk, primaryOk]);
  await transport.send(body, auth);
  await transport.send(body, auth);
  assert.equal(calls[2].url, calls[0].url);
  assert.equal(transport.status().fallbackRequests, 1);
});

test('concurrent requests cannot exceed the fallback cap', async () => {
  let fallbackCalls = 0;
  const transport = createContinuityTransport({
    openRouterKey: 'unit-test-fallback',
    maxFallbackRequests: 1,
    fetchImpl: async url => {
      if (url.includes('openrouter')) { fallbackCalls++; return fallbackOk(); }
      return rateLimit();
    }
  });
  await Promise.all([transport.send(body, auth), transport.send(body, auth)]);
  assert.equal(fallbackCalls, 1);
});

test('an already aborted request performs no network call', async () => {
  const { transport, calls } = harness([]);
  await assert.rejects(transport.send(body, auth, { signal: AbortSignal.abort() }));
  assert.equal(calls.length, 0);
});

test('network errors are not converted into paid fallback requests', async () => {
  let calls = 0;
  const transport = createContinuityTransport({
    openRouterKey: 'unit-test-fallback',
    fetchImpl: async () => { calls++; throw new Error('offline'); }
  });
  await assert.rejects(transport.send(body, auth), /offline/);
  assert.equal(calls, 1);
});
