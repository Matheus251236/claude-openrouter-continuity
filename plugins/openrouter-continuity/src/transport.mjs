/**
 * Experimental transport. This module does NOT attach itself to Claude Desktop.
 * An adapter must route the existing session's requests through send() first.
 */
const PRIMARY_URL = 'https://api.anthropic.com/v1/messages';
const FALLBACK_URL = 'https://openrouter.ai/api/v1/messages';
const INSPECT_LIMIT = 64 * 1024;

function eligible(type, status) {
  return (type === 'rate_limit_error' && (status === 429 || status === 200)) ||
    (type === 'billing_error' && (status === 402 || status === 200));
}

function rebuild(response, chunks, reader, done) {
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  headers.delete('content-encoding');
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(chunk); },
    async pull(controller) {
      if (done) { controller.close(); return; }
      try {
        const next = await reader.read();
        if (next.done) { done = true; controller.close(); }
        else controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    cancel(reason) { return reader.cancel(reason); }
  }), { status: response.status, statusText: response.statusText, headers });
}

// Inspect only an error body or the first meaningful SSE event. Once a message
// starts, never replay it: doing so could duplicate visible output or tool calls.
async function inspect(response) {
  const contentType = response.headers.get('content-type') || '';
  const sse = response.status === 200 && contentType.includes('text/event-stream');
  const jsonError = [402, 429].includes(response.status) && contentType.includes('json');
  if ((!sse && !jsonError) || !response.body) return { response, fallback: false };
  const reader = response.body.getReader();
  const chunks = [];
  const decoder = new TextDecoder();
  let size = 0, text = '', done = false, fallback = false;
  while (size < INSPECT_LIMIT) {
    const next = await reader.read();
    done = next.done;
    if (done) { text += decoder.decode(); break; }
    chunks.push(next.value);
    size += next.value.byteLength;
    if (size > INSPECT_LIMIT) break;
    text += decoder.decode(next.value, { stream: true });
    if (sse) {
      let match;
      while ((match = /\r?\n\r?\n/.exec(text))) {
        const frame = text.slice(0, match.index);
        text = text.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let event;
        try { event = JSON.parse(data); } catch { return { response: rebuild(response, chunks, reader, done), fallback: false }; }
        if (event.type === 'ping') continue;
        fallback = event.type === 'error' && eligible(event.error?.type, 200);
        return { response: rebuild(response, chunks, reader, done), fallback };
      }
    }
  }
  if (jsonError && done && size <= INSPECT_LIMIT) {
    try { fallback = eligible(JSON.parse(text).error?.type, response.status); } catch { /* pass through */ }
  }
  return { response: rebuild(response, chunks, reader, done), fallback };
}

function primaryHeaders(input) {
  const source = new Headers(input);
  const result = new Headers({ 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
  // Do not accept arbitrary destinations or forward cookies/proxy credentials.
  for (const name of ['authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'user-agent']) {
    if (source.has(name)) result.set(name, source.get(name));
  }
  if (!result.has('authorization') && !result.has('x-api-key')) {
    throw new Error('The session adapter must supply the existing Anthropic credential');
  }
  return result;
}

export function createContinuityTransport({
  openRouterKey, enabled = false, modelMap = {}, maxFallbackRequests = 20,
  fetchImpl = globalThis.fetch, timeoutMs = 120000
} = {}) {
  if (!Number.isSafeInteger(maxFallbackRequests) || maxFallbackRequests < 0) throw new Error('Invalid fallback request limit');
  let primaryRequests = 0, fallbackRequests = 0;
  return {
    status: () => ({ enabled, primaryRequests, fallbackRequests, maxFallbackRequests }),
    async send(body, sessionHeaders, { signal } = {}) {
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          typeof body.model !== 'string' || !Array.isArray(body.messages)) throw new Error('Invalid Messages API request');
      const combinedSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      combinedSignal.throwIfAborted();
      const headers = primaryHeaders(sessionHeaders);
      const serialized = JSON.stringify(body);
      primaryRequests++;
      const initial = await fetchImpl(PRIMARY_URL, {
        method: 'POST', headers, body: serialized, redirect: 'error', signal: combinedSignal
      });
      if (!enabled || !openRouterKey || fallbackRequests >= maxFallbackRequests) return initial;
      const checked = await inspect(initial);
      if (!checked.fallback || fallbackRequests >= maxFallbackRequests) return checked.response;
      combinedSignal.throwIfAborted();
      // Count before awaiting: concurrent requests cannot exceed the local cap.
      fallbackRequests++;
      await checked.response.body?.cancel();
      const fallbackBody = JSON.parse(serialized);
      // No account metadata, OAuth headers, cookies or Anthropic credentials cross providers.
      delete fallbackBody.metadata;
      delete fallbackBody.provider;
      const mapped = Object.hasOwn(modelMap, body.model) ? modelMap[body.model] : undefined;
      fallbackBody.model = typeof mapped === 'string' && mapped ? mapped : body.model;
      fallbackBody.provider = { only: ['anthropic'], allow_fallbacks: false };
      const fallbackHeaders = new Headers({
        authorization: `Bearer ${openRouterKey}`,
        'content-type': 'application/json',
        'anthropic-version': headers.get('anthropic-version')
      });
      return fetchImpl(FALLBACK_URL, {
        method: 'POST', headers: fallbackHeaders, body: JSON.stringify(fallbackBody),
        redirect: 'error', signal: combinedSignal
      });
    }
  };
}
