/**
 * Edge cases for the turn loop, against a mocked sandbox and a mocked model.
 *
 *   node tests/edge_cases/run.js
 *
 * Safe to run as often as you like: it touches no network and, unlike
 * `npm test`, does not reset the shared team booking state.
 *
 * Each case says what the model decides to do and what the sandbox does back,
 * then asserts on what reached the user and on the requests the agent actually
 * made. The second half is the important half: "did it retry the booking" is a
 * question about the request log, not about the reply text.
 */

import { install, says, calls, booking } from './mock.js';

process.env.PLEC_SANDBOX_KEY ??= 'hk_test';
process.env.LLM_API_KEY ??= 'plk_test';
process.env.PLEC_SANDBOX_URL ??= 'https://api.plec.ai/hackathon/sandbox';
process.env.LLM_BASE_URL ??= 'https://api.plec.ai/hackathon/llm/v1';

const { respond } = await import('../../agent/agent.js');

const cases = [];
const test = (name, fn) => cases.push({ name, fn });

/** One turn against a fresh or carried-over session. */
async function turn(text, { llm, sandbox, session = { messages: [], state: {} } }) {
  const mock = install({ llm, sandbox });
  try {
    const parts = await respond({ sessionId: 'edge', text, session });
    return { parts, session, log: mock.log, text: parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n') };
  } finally {
    mock.restore();
  }
}

const sandboxCalls = (log, path) => log.filter((e) => e.kind === 'sandbox' && e.path.includes(path));
const writes = (log) => log.filter((e) => e.kind === 'sandbox' && e.method === 'POST' && !e.path.includes('/quote'));

// ---------------------------------------------------------------- reads

test('a rate-limited read is retried and succeeds', async () => {
  let hits = 0;
  const { text, log } = await turn('Any venues in Philadelphia on October 10 for 40?', {
    llm: [calls({ name: 'search_listings', args: { city: 'Philadelphia', guests: 40 } }), says('One option fits. Want details?')],
    sandbox: (method, path) => {
      if (path.includes('/listings')) {
        hits += 1;
        if (hits === 1) return { status: 429, body: { error: 'rate_limited', message: 'Too many requests.' } };
        return { results: [{ id: 'lst_foundry', name: 'The Foundry at Fishtown', capacity: { min: 20, max: 120 } }] };
      }
      return {};
    },
  });
  expect(hits >= 2, `search retried (saw ${hits} attempts)`);
  expect(/option/i.test(text), 'the user got a real answer, not the 429');
});

test('a read that keeps failing gives up and reports it', async () => {
  const { log } = await turn('Venues in Philadelphia October 10 for 40?', {
    llm: [calls({ name: 'search_listings', args: { city: 'Philadelphia' } }), says('The search is down. Try again in a minute?')],
    sandbox: () => ({ status: 503, body: { error: 'server_error', message: 'Upstream unavailable.' } }),
  });
  const attempts = sandboxCalls(log, '/listings').length;
  expect(attempts >= 2 && attempts <= 3, `bounded retries, not infinite (saw ${attempts})`);
});

// ---------------------------------------------------------------- writes

test('an ambiguous book is NEVER retried', async () => {
  const { log } = await turn('Yes, book it for Sam Rivera, sam@example.com.', {
    llm: [calls({ name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10', guestEmail: 'sam@example.com' } }), says('That did not go through. Shall I try again?')],
    sandbox: (method, path) => {
      if (path.includes('/bookings') && method === 'POST') return { throw: 'socket hang up' };
      if (path.includes('/bookings')) return { bookings: [] };
      return {};
    },
  });
  const attempts = log.filter((e) => e.method === 'POST' && e.path.includes('/bookings')).length;
  expect(attempts === 1, `exactly one book attempt (saw ${attempts})`);
});

test('an ambiguous book reconciles: the booking that did land is found, not remade', async () => {
  const { text, log } = await turn('Yes, book it.', {
    llm: [calls({ name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10' } }), says('It is booked, reference BK-9001.')],
    sandbox: (method, path) => {
      if (path.includes('/bookings') && method === 'POST') return { status: 502, body: { error: 'server_error', message: 'Bad gateway.' } };
      if (path.includes('/bookings')) return { bookings: [booking()] };
      return {};
    },
  });
  expect(log.filter((e) => e.method === 'POST' && e.path.includes('/bookings')).length === 1, 'still only one write attempt');
  expect(sandboxCalls(log, '/bookings').some((e) => e.method === 'GET'), 'reconciled by reading the bookings back');
  expect(/BK-9001/.test(text), 'the real reference reached the user');
});

test('the same booking asked for twice books once', async () => {
  const session = { messages: [], state: {} };
  const args = { listingId: 'lst_foundry', date: '2026-10-10', startTime: '18:00', guestEmail: 'sam@example.com' };
  const sandbox = (method, path) => {
    if (path.includes('/bookings') && method === 'POST') return booking();
    if (path.includes('/bookings')) return booking();
    return {};
  };

  const first = await turn('Yes, book it.', { llm: [calls({ name: 'book', args }), says('Booked, BK-9001. Anything else?')], sandbox, session });
  const second = await turn('Yes, book it.', { llm: [calls({ name: 'book', args }), says('That is already booked as BK-9001. Anything else?')], sandbox, session });

  expect(writes(first.log).length === 1, 'first turn booked');
  expect(writes(second.log).length === 0, 'second turn did not book again');
});

test('a successful book is verified against the sandbox', async () => {
  const { log } = await turn('Yes, book it.', {
    llm: [calls({ name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10' } }), says('Booked. Shall I send the link again?')],
    sandbox: (method, path) => (path.includes('/bookings') ? booking() : {}),
  });
  expect(sandboxCalls(log, 'BK-9001').length >= 1 || sandboxCalls(log, '/bookings').some((e) => e.method === 'GET'), 're-read the booking after writing it');
});

// ---------------------------------------------------------------- relaxation

test('an empty search widens one constraint and says which', async () => {
  let seen = [];
  const { log } = await turn('Anything called Foundry in Philadelphia on October 10 for 40?', {
    llm: [
      calls({ name: 'search_listings', args: { q: 'Foundry', city: 'Philadelphia', date: '2026-10-10', guests: 40 } }),
      says('Nothing under that name, so I widened the search. Want details?'),
    ],
    sandbox: (method, path, body, query) => {
      seen.push(query);
      if (query.q) return { results: [], totalMatches: 0 };
      return { results: [{ id: 'lst_other', name: 'Germantown Hall', capacity: { min: 20, max: 80 } }], totalMatches: 1 };
    },
  });
  expect(seen.length >= 2, `it searched again after zero results (${seen.length} searches)`);
  expect(seen.some((q) => !q.q && q.city === 'Philadelphia'), 'it dropped the name and kept the city');
  expect(seen.every((q) => q.guests === undefined || q.guests === '40'), 'it never quietly dropped the headcount first');
});

test('relaxation stops when nothing will ever match', async () => {
  const { log, text } = await turn('Venues in Philadelphia October 10 for 40?', {
    llm: [
      calls({ name: 'search_listings', args: { city: 'Philadelphia', date: '2026-10-10', guests: 40 } }),
      says('Nothing fits even after widening. Which detail can you change?'),
    ],
    sandbox: () => ({ results: [], totalMatches: 0 }),
  });
  const searches = sandboxCalls(log, '/listings').length;
  expect(searches >= 2 && searches <= 4, `bounded widening, not every combination (saw ${searches})`);
  expect(text.includes('?'), 'it asks the user what can change');
});

// ---------------------------------------------------------------- bundles

test('a half-failed bundle is rolled back', async () => {
  const cancelled = [];
  const { log } = await turn('Yes, book the venue and the caterer.', {
    llm: [
      calls(
        { name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10', guests: 40 } },
        { name: 'book', args: { listingId: 'lst_caterer', date: '2026-10-10', guests: 40 } },
      ),
      says('The caterer fell through, so I undid the venue too. Try another caterer?'),
    ],
    sandbox: (method, path, body) => {
      if (method === 'POST' && path.endsWith('/cancel')) {
        cancelled.push(path.split('/')[2]);
        return booking({ status: 'cancelled', refundCents: 0 });
      }
      if (method === 'POST' && path === '/bookings') {
        if (body.listingId === 'lst_caterer') return { status: 409, body: { error: 'slot_taken', message: 'That slot just went.' } };
        return booking({ ref: 'BK-9001' });
      }
      return booking({ ref: 'BK-9001' });
    },
  });
  expect(cancelled.includes('BK-9001'), `the successful half was cancelled (saw ${JSON.stringify(cancelled)})`);
});

test('a bundle that fully succeeds is left alone', async () => {
  const cancelled = [];
  await turn('Yes, book both.', {
    llm: [
      calls(
        { name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10' } },
        { name: 'book', args: { listingId: 'lst_caterer', date: '2026-10-10' } },
      ),
      says('Both are booked. Shall I send the payment links?'),
    ],
    sandbox: (method, path, body) => {
      if (path.endsWith('/cancel')) { cancelled.push(path); return booking({ status: 'cancelled' }); }
      if (method === 'POST' && path === '/bookings') return booking({ ref: body.listingId === 'lst_caterer' ? 'BK-9002' : 'BK-9001' });
      return booking();
    },
  });
  expect(cancelled.length === 0, 'nothing was rolled back');
});

test('one booking failing alone is not a bundle and is not unwound', async () => {
  const cancelled = [];
  await turn('Yes, book it.', {
    llm: [calls({ name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10' } }), says('That slot went. Another date?')],
    sandbox: (method, path) => {
      if (path.endsWith('/cancel')) { cancelled.push(path); return booking({ status: 'cancelled' }); }
      if (method === 'POST') return { status: 409, body: { error: 'slot_taken', message: 'Gone.' } };
      return { bookings: [] };
    },
  });
  expect(cancelled.length === 0, 'no phantom rollback');
});

// ---------------------------------------------------------------- fan-out and trace

test('independent checks run concurrently, not one after another', async () => {
  const gaps = [];
  let open = 0;
  let peak = 0;
  await turn('Compare those five for Friday.', {
    llm: [
      calls(
        ...['a', 'b', 'c', 'd', 'e'].map((id) => ({ name: 'get_availability', args: { id: `lst_${id}`, date: '2026-10-16' } })),
      ),
      says('Three of the five are open. Want the prices?'),
    ],
    sandbox: async () => {
      open += 1;
      peak = Math.max(peak, open);
      await new Promise((r) => setTimeout(r, 30));
      open -= 1;
      return { available: true };
    },
  });
  expect(peak >= 4, `at least four availability checks were in flight at once (peak ${peak})`);
});

test('every tool call lands in the trace with its outcome', async () => {
  const { session } = await turn('Venues in Philadelphia for 40 on October 10?', {
    llm: [
      calls({ name: 'search_listings', args: { city: 'Philadelphia', guests: 40, date: '2026-10-10' } }),
      says('Two fit. Want a quote on one?'),
    ],
    sandbox: () => ({ results: [{ id: 'lst_foundry', name: 'The Foundry at Fishtown', capacity: { min: 20, max: 120 } }] }),
  });
  const trace = session.state.trace ?? [];
  expect(trace.length >= 1, 'the trace recorded the call');
  expect(trace[0].tool === 'search_listings' && trace[0].ok === true, 'it names the tool and whether it worked');
  expect(typeof trace[0].ms === 'number' && trace[0].outcome.matched === 1, 'it carries timing and a readable outcome');
});

// ---------------------------------------------------------------- the gate

test('no yes, no write — the sandbox is never touched', async () => {
  const { log } = await turn('Book The Foundry for October 10.', {
    llm: [calls({ name: 'book', args: { listingId: 'lst_foundry', date: '2026-10-10' } }), says('I can do that. What name and email should I use?')],
    sandbox: () => booking(),
  });
  expect(writes(log).length === 0, 'nothing was booked without a yes');
});

test('"cancel BK-9001" is a request, not a confirmation', async () => {
  const { log } = await turn('Cancel BK-9001.', {
    llm: [calls({ name: 'cancel_booking', args: { ref: 'BK-9001' } }), says('That would cancel October 10 with no refund. Confirm?')],
    sandbox: () => booking(),
  });
  expect(log.filter((e) => e.method === 'POST').length === 0, 'nothing was cancelled');
});

// ---------------------------------------------------------------- loop safety

test('a repeated identical tool call is refused, not run again', async () => {
  const { log } = await turn('Venues in Philadelphia?', {
    llm: [
      calls({ name: 'search_listings', args: { city: 'Philadelphia' } }, { name: 'search_listings', args: { city: 'Philadelphia' } }),
      says('Here is what I found. Want details on one?'),
    ],
    sandbox: () => ({ results: [] }),
  });
  expect(sandboxCalls(log, '/listings').length === 1, `the duplicate was not sent (saw ${sandboxCalls(log, '/listings').length})`);
});

test('a model that never stops calling tools still answers', async () => {
  const { text } = await turn('Venues?', {
    llm: [calls({ name: 'search_listings', args: { city: 'Philadelphia', page: Math.random() } }), says('')],
    sandbox: () => ({ results: [] }),
  });
  expect(text.trim().length > 0, 'the turn produced words');
});

// ---------------------------------------------------------------- always answer

test('a model outage becomes an apology, not a 500', async () => {
  const { parts, text } = await turn('Hello?', {
    llm: [{ status: 500, body: { error: { message: 'upstream_error' } } }],
    sandbox: () => ({}),
  });
  expect(parts.length >= 1 && parts[0].kind === 'text', 'still a text part');
  expect(text.trim().length > 0, 'still words');
});

test('history is left usable after a failed turn', async () => {
  const session = { messages: [], state: {} };
  await turn('Hello?', { llm: [{ status: 500, body: {} }], sandbox: () => ({}), session });
  const orphan = session.messages.some(
    (m, i) => m.tool_calls?.length && session.messages[i + 1]?.role !== 'tool',
  );
  expect(!orphan, 'no tool_calls left without tool results');
  expect(session.messages.every((m) => m.role !== 'tool' || m.tool_call_id), 'every tool message keeps its id');
});

test('every reply asks something', async () => {
  const { text } = await turn('hi', { llm: [says('Hello.')], sandbox: () => ({}) });
  expect(text.includes('?'), 'the reply ends up asking a question');
});

// ---------------------------------------------------------------- runner

function expect(ok, label) {
  if (!ok) throw new Error(label);
  current.push(label);
}

let current = [];
let passed = 0;
const failures = [];

console.log('\nedge cases — mocked sandbox, mocked model, no live state touched\n');
for (const { name, fn } of cases) {
  current = [];
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
    for (const label of current) console.log(`          - ${label}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}`);
    for (const label of current) console.log(`          - ${label}`);
    console.log(`          ! ${err.message}`);
  }
}

console.log(`\n${passed} of ${cases.length} edge cases pass\n`);
if (failures.length > 0) process.exitCode = 1;
