/**
 * A fake internet, so the edge cases can be tested at all.
 *
 * Every network call the agent makes goes through the global `fetch`: llm.js
 * calls it directly, and plec.js reads `fetch` off the global at call time
 * inside config(). Replacing that one function therefore puts both the model and
 * the sandbox under our control, and lets the tests drive the real agent.js
 * rather than a copy of its logic.
 *
 * Why this and not the live services: these cases are rate limits, 500s and dead
 * sockets. You cannot ask a sandbox for a 500 on demand, and `npm test` resets
 * the shared team booking state, which is not something to do in a loop.
 */

const realFetch = globalThis.fetch;

/**
 * @param {object} plan
 * @param {Array<object|Function>} plan.llm       one entry per model call, in order
 * @param {Function} plan.sandbox                (method, path, body) => response spec
 * @returns {{ log: Array<object>, restore: Function }}
 */
export function install({ llm = [], sandbox = () => ({}) }) {
  const log = [];
  let llmCall = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input instanceof URL ? input : (input?.url ?? input));
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;

    if (url.includes('/chat/completions')) {
      const entry = llm[llmCall] ?? llm[llm.length - 1];
      llmCall += 1;
      log.push({ kind: 'llm', call: llmCall });
      const spec = typeof entry === 'function' ? entry(llmCall) : entry;
      return respond(spec.status ?? 200, spec.body ?? completion(spec));
    }

    const path = new URL(url).pathname.replace(/^.*\/sandbox/, '');
    const query = Object.fromEntries(new URL(url).searchParams);
    log.push({ kind: 'sandbox', method, path, query, body });
    const spec = (await sandbox(method, path, body, query)) ?? {};
    if (spec.throw) throw Object.assign(new Error(spec.throw), { name: spec.throwName ?? 'Error' });
    // A response spec is a plain body unless it explicitly carries one. It must
    // be this way round: a booking has its own `status` field ("pending_payment")
    // and reading that as the HTTP status turns every success into a failure.
    const explicit = Object.hasOwn(spec, 'body');
    return respond(explicit ? (spec.status ?? 200) : 200, explicit ? spec.body : spec);
  };

  return { log, restore: () => { globalThis.fetch = realFetch; } };
}

function respond(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify(body ?? {}),
    json: async () => body ?? {},
  };
}

/** An OpenAI-shaped completion from either plain text or a list of tool calls. */
function completion({ text = '', toolCalls = [] }) {
  const message = { role: 'assistant', content: text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((tc, i) => ({
      id: `call_${i}`,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
  }
  return { choices: [{ message, finish_reason: toolCalls.length ? 'tool_calls' : 'stop' }] };
}

/** Shorthand for "the model says this and stops". */
export const says = (text) => ({ text });
/** Shorthand for "the model calls these tools". */
export const calls = (...toolCalls) => ({ toolCalls });

/** A booking row the way the sandbox returns one. */
export function booking(over = {}) {
  return {
    ref: 'BK-9001',
    listingId: 'lst_foundry',
    listingName: 'The Foundry at Fishtown',
    date: '2026-10-10',
    startTime: '18:00',
    endTime: '23:00',
    guests: 40,
    status: 'pending_payment',
    subtotalCents: 165000,
    serviceFeeCents: 16500,
    totalCents: 181500,
    refundCents: null,
    payment: { status: 'unpaid', url: 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_abc' },
    ...over,
  };
}
