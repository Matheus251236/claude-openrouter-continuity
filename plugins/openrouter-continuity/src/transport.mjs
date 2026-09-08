const PRIMARY_URL = 'https://api.anthropic.com/v1/messages';
const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

function assertRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.model !== 'string' || !Array.isArray(body.messages)) {
    throw new TypeError('Invalid Anthropic Messages API request');
  }
}

export function translateAnthropicModel(model, overrides = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new TypeError('model must be a non-empty string');
  if (Object.hasOwn(overrides, model)) {
    const mapped = overrides[model];
    if (typeof mapped !== 'string' || !mapped.trim()) throw new TypeError('model override must be a non-empty string');
    return mapped;
  }
  if (model.startsWith('anthropic/')) return model;

  let slug = model.trim().replace(/-\d{8}$/, '');
  let match = /^claude-(\d+)-(\d+)-(sonnet|haiku|opus)$/.exec(slug);
  if (match) slug = `claude-${match[1]}.${match[2]}-${match[3]}`;
  match = /^claude-(sonnet|haiku|opus)-(\d+)-(\d+)$/.exec(slug);
  if (match) slug = `claude-${match[1]}-${match[2]}.${match[3]}`;
  match = /^claude-(sonnet|haiku|opus)-(\d+)-(\d+)-(\d+)$/.exec(slug);
  if (match) slug = `claude-${match[1]}-${match[2]}.${match[3]}.${match[4]}`;
  return `anthropic/${slug}`;
}

function textFromBlocks(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n');
}

function userPart(block) {
  if (block?.type === 'text' && typeof block.text === 'string') {
    return { type: 'text', text: block.text };
  }
  if (block?.type === 'image' && block.source?.type === 'base64') {
    return {
      type: 'image_url',
      image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` }
    };
  }
  if (block?.type === 'image' && block.source?.type === 'url') {
    return { type: 'image_url', image_url: { url: block.source.url } };
  }
  throw new TypeError(`Unsupported Anthropic user content block: ${block?.type ?? 'unknown'}`);
}

function toolResultContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(block => {
    if (block?.type === 'text') return block.text;
    if (block?.type === 'image' && block.source?.type === 'base64') {
      return `[image:${block.source.media_type};base64,${block.source.data}]`;
    }
    return JSON.stringify(block);
  }).join('\n');
}

function convertMessages(messages) {
  const result = [];
  for (const message of messages) {
    if (!message || !['user', 'assistant'].includes(message.role)) {
      throw new TypeError('Unsupported Anthropic message role');
    }
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw new TypeError('Invalid Anthropic message content');

    if (message.role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const block of message.content) {
        if (block?.type === 'text') texts.push(block.text);
        else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) }
          });
        } else if (block?.type !== 'thinking' && block?.type !== 'redacted_thinking') {
          throw new TypeError(`Unsupported Anthropic assistant content block: ${block?.type ?? 'unknown'}`);
        }
      }
      const converted = { role: 'assistant', content: texts.join('') || null };
      if (toolCalls.length) converted.tool_calls = toolCalls;
      result.push(converted);
      continue;
    }

    let pending = [];
    const flush = () => {
      if (!pending.length) return;
      result.push({ role: 'user', content: pending.length === 1 && pending[0].type === 'text'
        ? pending[0].text : pending });
      pending = [];
    };
    for (const block of message.content) {
      if (block?.type === 'tool_result') {
        flush();
        result.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: toolResultContent(block.content)
        });
      } else {
        pending.push(userPart(block));
      }
    }
    flush();
  }
  return result;
}

export function toOpenRouterChatRequest(body, modelMap = {}) {
  assertRequest(body);
  const messages = convertMessages(body.messages);
  const system = textFromBlocks(body.system);
  if (system) messages.unshift({ role: 'system', content: system });

  const result = {
    model: translateAnthropicModel(body.model, modelMap),
    messages,
    max_tokens: body.max_tokens,
    stream: body.stream === true
  };
  for (const field of ['temperature', 'top_p', 'top_k', 'seed']) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema ?? { type: 'object', properties: {} }
      }
    }));
  }
  if (body.tool_choice?.type === 'auto') result.tool_choice = 'auto';
  else if (body.tool_choice?.type === 'any') result.tool_choice = 'required';
  else if (body.tool_choice?.type === 'none') result.tool_choice = 'none';
  else if (body.tool_choice?.type === 'tool') {
    result.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
  }
  if (body.thinking?.type === 'enabled') {
    result.reasoning = {
      enabled: true,
      ...(Number.isFinite(body.thinking.budget_tokens) ? { max_tokens: body.thinking.budget_tokens } : {})
    };
  }
  return result;
}

function stopReason(value) {
  return ({ stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use' })[value] ?? null;
}

function responseHeaders(source, contentType) {
  const headers = new Headers(source);
  headers.delete('content-length');
  headers.delete('content-encoding');
  headers.set('content-type', contentType);
  return headers;
}

function anthropicError(payload, status) {
  const type = status === 429 ? 'rate_limit_error'
    : status === 401 || status === 403 ? 'authentication_error'
      : status === 400 ? 'invalid_request_error' : 'api_error';
  return {
    type: 'error',
    error: { type, message: payload?.error?.message ?? `OpenRouter request failed with HTTP ${status}` }
  };
}

function convertChatCompletion(payload, originalModel) {
  const choice = payload?.choices?.[0];
  const message = choice?.message ?? {};
  const content = [];
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content });
  }
  for (const call of message.tool_calls ?? []) {
    let input = {};
    try { input = JSON.parse(call.function?.arguments || '{}'); } catch { input = { raw: call.function?.arguments || '' }; }
    content.push({
      type: 'tool_use',
      id: call.id,
      name: call.function?.name,
      input
    });
  }
  return {
    id: payload.id,
    type: 'message',
    role: 'assistant',
    model: originalModel,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: payload.usage?.prompt_tokens ?? 0,
      output_tokens: payload.usage?.completion_tokens ?? 0
    }
  };
}

function eventBytes(encoder, event, data) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function convertChatStream(body, originalModel) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      let buffer = '';
      let started = false;
      let id = 'msg_openrouter';
      let finish = null;
      let usage = {};
      let nextBlock = 0;
      let textIndex = null;
      const toolBlocks = new Map();
      const emit = (event, data) => controller.enqueue(eventBytes(encoder, event, data));
      const ensureStart = chunk => {
        if (started) return;
        started = true;
        id = chunk.id || id;
        emit('message_start', {
          type: 'message_start',
          message: {
            id, type: 'message', role: 'assistant', model: originalModel,
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 }
          }
        });
      };
      const ensureText = () => {
        if (textIndex !== null) return textIndex;
        textIndex = nextBlock++;
        emit('content_block_start', {
          type: 'content_block_start', index: textIndex,
          content_block: { type: 'text', text: '' }
        });
        return textIndex;
      };
      const ensureTool = (tool, delta) => {
        if (tool.opened) return;
        if (typeof delta.function?.name === 'string') tool.name += delta.function.name;
        if (!tool.name) return;
        tool.opened = true;
        tool.blockIndex = nextBlock++;
        emit('content_block_start', {
          type: 'content_block_start', index: tool.blockIndex,
          content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} }
        });
      };
      const handle = data => {
        if (data === '[DONE]') return 'done';
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new Error('Invalid OpenRouter SSE JSON'); }
        if (chunk.error) {
          emit('error', anthropicError(chunk, chunk.error.code || 502));
          return;
        }
        ensureStart(chunk);
        if (chunk.usage) usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (!choice) return;
        const delta = choice.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) {
          emit('content_block_delta', {
            type: 'content_block_delta', index: ensureText(),
            delta: { type: 'text_delta', text: delta.content }
          });
        }
        for (const call of delta.tool_calls ?? []) {
          const key = call.index ?? 0;
          let tool = toolBlocks.get(key);
          if (!tool) {
            tool = { id: call.id || `tool_${key}`, name: '', opened: false, blockIndex: null, pending: '' };
            toolBlocks.set(key, tool);
          }
          if (call.id) tool.id = call.id;
          ensureTool(tool, call);
          const args = call.function?.arguments;
          if (typeof args === 'string' && args) {
            if (!tool.opened) tool.pending += args;
            else emit('content_block_delta', {
              type: 'content_block_delta', index: tool.blockIndex,
              delta: { type: 'input_json_delta', partial_json: args }
            });
          }
          if (tool.opened && tool.pending) {
            emit('content_block_delta', {
              type: 'content_block_delta', index: tool.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tool.pending }
            });
            tool.pending = '';
          }
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      };
      const finalize = () => {
        if (!started) ensureStart({});
        if (textIndex !== null) emit('content_block_stop', { type: 'content_block_stop', index: textIndex });
        for (const tool of toolBlocks.values()) {
          if (!tool.opened) {
            tool.name ||= 'unknown_tool';
            ensureTool(tool, { function: {} });
          }
          if (tool.pending) emit('content_block_delta', {
            type: 'content_block_delta', index: tool.blockIndex,
            delta: { type: 'input_json_delta', partial_json: tool.pending }
          });
          emit('content_block_stop', { type: 'content_block_stop', index: tool.blockIndex });
        }
        emit('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: stopReason(finish), stop_sequence: null },
          usage: { output_tokens: usage.completion_tokens ?? 0 }
        });
        emit('message_stop', { type: 'message_stop' });
      };
      try {
        let doneSeen = false;
        while (!doneSeen) {
          const next = await reader.read();
          buffer += decoder.decode(next.value ?? new Uint8Array(), { stream: !next.done });
          let match;
          while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart()).join('\n');
            if (data && handle(data) === 'done') { doneSeen = true; break; }
          }
          if (next.done) break;
        }
        finalize();
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
    cancel(reason) { return reader.cancel(reason); }
  });
}

async function fromOpenRouter(response, requestBody) {
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    return new Response(JSON.stringify(anthropicError(payload, response.status)), {
      status: response.status,
      headers: responseHeaders(response.headers, 'application/json')
    });
  }
  if (requestBody.stream === true && contentType.includes('text/event-stream') && response.body) {
    return new Response(convertChatStream(response.body, requestBody.model), {
      status: response.status,
      headers: responseHeaders(response.headers, 'text/event-stream')
    });
  }
  const payload = await response.json();
  return new Response(JSON.stringify(convertChatCompletion(payload, requestBody.model)), {
    status: response.status,
    headers: responseHeaders(response.headers, 'application/json')
  });
}

function primaryHeaders(input) {
  const source = new Headers(input);
  const result = new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
  for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'user-agent']) {
    if (source.has(name)) result.set(name, source.get(name));
  }
  if (!result.has('authorization') && !result.has('x-api-key')) {
    throw new Error('The session adapter must supply the existing Anthropic credential');
  }
  return result;
}

export function createContinuityTransport({
  openRouterKey = process.env.OPENROUTER_API_KEY,
  enabled = true,
  modelMap = {},
  maxFallbackRequests = 20,
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000
} = {}) {
  if (!Number.isSafeInteger(maxFallbackRequests) || maxFallbackRequests < 0) {
    throw new TypeError('Invalid fallback request limit');
  }
  let primaryRequests = 0;
  let fallbackRequests = 0;
  return {
    status: () => ({
      enabled,
      openRouterKeyConfigured: typeof openRouterKey === 'string' && openRouterKey.trim().length > 0,
      primaryRequests,
      fallbackRequests,
      maxFallbackRequests
    }),
    async send(body, sessionHeaders, { signal } = {}) {
      assertRequest(body);
      const combinedSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs);
      combinedSignal.throwIfAborted();
      const headers = primaryHeaders(sessionHeaders);
      primaryRequests++;
      const primary = await fetchImpl(PRIMARY_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: combinedSignal
      });
      if (primary.status !== 429 || !enabled || typeof openRouterKey !== 'string' ||
          !openRouterKey.trim() || fallbackRequests >= maxFallbackRequests) {
        return primary;
      }

      fallbackRequests++;
      await primary.body?.cancel();
      combinedSignal.throwIfAborted();
      const fallback = await fetchImpl(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: new Headers({
          authorization: `Bearer ${openRouterKey.trim()}`,
          'content-type': 'application/json'
        }),
        body: JSON.stringify(toOpenRouterChatRequest(body, modelMap)),
        redirect: 'error',
        signal: combinedSignal
      });
      return fromOpenRouter(fallback, body);
    }
  };
}
