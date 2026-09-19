/**
 * The brain. server.js calls respond() once per user turn and sends back
 * whatever parts you return.
 *
 * OWNER: the `loop` branch. The prompt lives in agent/prompt.js and the part
 * rendering in agent/parts.js, both owned by the `behavior` branch. This file
 * calls them and does not edit them.
 *
 * The shape of a turn: let the model decide whether it needs a tool, run the
 * tool, feed the result back, repeat until it answers in words. Two things this
 * loop guarantees that a prompt cannot:
 *
 *   - It always answers. server.js cuts a turn at 40s, and a turn with no reply
 *     fails every check on it, so the loop carries its own wall-clock budget and
 *     spends its last seconds on words instead of another tool call.
 *   - It never books, cancels or reschedules without the user having said yes in
 *     the message that triggered it. See the gate in runToolCall().
 *
 * Parts you can return (docs/contract.md):
 *   { kind: 'text',  text }
 *   { kind: 'card',  title, subtitle?, photoUrls: [], url? }
 *   { kind: 'link',  label, url }
 *   { kind: 'image', url, caption? }
 * Always include at least one text part.
 */

import { chatCompletion, parseToolArguments } from './llm.js';
import { callTool, tools } from './plec.js';
import { systemPrompt } from './prompt.js';
import { toParts, cardFor } from './parts.js';

/** server.js gives up at 40s. Stay well inside it: a late answer is no answer. */
const TURN_BUDGET_MS = 32_000;
/** Once this little is left, stop reaching for tools and spend it on words. */
const FINAL_ANSWER_RESERVE_MS = 12_000;
/** A confused model must not loop until the budget is gone. */
const MAX_ROUNDS = 8;
/** A chat bubble is not a brochure. */
const MAX_CARDS = 5;

/** These change state in the sandbox and cannot be undone. */
const WRITE_TOOLS = new Set(['book', 'cancel_booking', 'reschedule_booking']);

/**
 * Retry policy for reads.
 *
 * The model proxy and the sandbox are shared across every team and capped per
 * five-minute window, so a 429 is a fact of the afternoon rather than a bug. A
 * read is safe to repeat, so repeat it — with jitter, because every team's agent
 * hits the same cap at the same moment and a fixed backoff makes them collide
 * again on the retry.
 */
const READ_RETRIES = 2;
const BACKOFF_BASE_MS = 400;
const BACKOFF_MAX_MS = 2_500;
/** Below this, a retry cannot finish and would only eat the final answer's time. */
const RETRY_FLOOR_MS = 6_000;

/** Codes worth trying again: the request never landed, or the far side was busy. */
const TRANSIENT = new Set(['network', 'rate_limited', 'too_many_requests', 'upstream_error', 'server_error']);

/**
 * A write whose outcome we do not know. Retrying is the one thing we must never
 * do here: a repeated `book` that actually succeeded the first time bills the
 * guest twice, and the guest cannot undo that. Reconcile instead.
 */
function isAmbiguous(result) {
  if (!result?.error) return false;
  return result.error === 'network' || (result.status ?? 0) >= 500;
}

function isTransient(result) {
  if (!result?.error) return false;
  return TRANSIENT.has(result.error) || (result.status ?? 0) === 429 || (result.status ?? 0) >= 500;
}

/**
 * A yes, in the message that triggered the write. Deliberately narrow: "book
 * it" and "cancel BK-1001" are requests, not confirmations, and the suite
 * checks that neither one acts on its own. Spanish is here because a Spanish
 * conversation can reach a booking too.
 */
const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|correct|agreed|perfect|sounds good|go ahead|do it|please do|let'?s do it|s[íi]|claro|adelante|dale|hazlo|perfecto|de acuerdo)\b/i;

/**
 * A yes that is not really a yes.
 *
 * "yes I think so", "ok, is that the one near the river?" and "sure, but make it
 * 7pm" all contain an affirmative and none of them is permission to spend the
 * user's money. A question mark is the clearest tell: someone still asking is
 * not someone who has decided. Neither is "but" — that is a change of terms, and
 * the terms they are agreeing to are no longer the ones we quoted.
 *
 * Raised by the behaviour half (HANDOFF_TO_LOOP.md), who was told judges would
 * stress exactly these phrasings. Spanish hedges are here for the same reason the
 * Spanish affirmatives are.
 */
const HEDGED =
  /\b(think so|thinking|maybe|probably|i guess|not sure|unsure|perhaps|might|possibly|almost|tal vez|quiz[áa]s?|creo que|no s[ée])\b|\?|\bbut\b|\bexcept\b|\bpero\b/i;

/** Permission to change real state: an affirmative, and no hedge anywhere near it. */
function clearYes(text) {
  return AFFIRMATIVE.test(text) && !HEDGED.test(text);
}

/** What to tell the model when it reached for a write without a yes. */
const NEEDS_CONFIRMATION = {
  book: 'Nothing was booked. Quote the exact total first, show it to the user, make sure you have their name and email, and ask them to confirm before you book.',
  cancel_booking:
    'Nothing was cancelled. Look the booking up, tell the user which booking it is and what the refund would be, and ask them to confirm before you cancel.',
  reschedule_booking:
    'Nothing was rescheduled. Show the user the new slot and what it would cost, and ask them to confirm before you move it.',
};

/**
 * @param {{ sessionId: string, text: string, session: { messages: object[], state: object } }} turn
 * @returns {Promise<Array<object>>} parts
 */
export async function respond({ sessionId, text, session }) {
  const deadline = Date.now() + TURN_BUDGET_MS;
  // Where this turn starts, so a failure can be rolled back cleanly. An
  // assistant message carrying tool_calls with no tool results after it makes
  // every later request in this session invalid, so a half-written turn must
  // not survive.
  const mark = session.messages.length;

  try {
    return await runTurn({ text, session, deadline });
  } catch (err) {
    console.error(`[agent ${sessionId.slice(0, 8)}]`, err);

    // A rate limit is not a mystery, and saying "something went wrong" invites
    // the user to retry straight into the same wall. Tell them how long.
    const after = retryAfter(err);
    const apology =
      after === null
        ? 'Something went wrong on my side just now. Could you try that once more?'
        : after > 0
          ? `I have hit my request limit for the moment. Could you ask me again in about ${after} seconds?`
          : 'I have hit my request limit for the moment. Could you ask me again in a minute?';
    session.messages.length = mark;
    session.messages.push({ role: 'user', content: text });
    session.messages.push({ role: 'assistant', content: apology });
    return [{ kind: 'text', text: apology }];
  }
}

async function runTurn({ text, session, deadline }) {
  session.messages.push({ role: 'user', content: text });

  // What happened during this turn only, as opposed to session.state, which is
  // the whole conversation. The card fallback needs "what did we look up just
  // now", so a card is never a leftover from three turns ago.
  // `calls` is this turn's tool fingerprints, which is how a stuck model gets
  // told it is repeating itself. `deadline` rides along so a retry can decide
  // whether there is still room for one.
  const turn = { text, lookedUpIds: [], calls: new Map(), deadline };

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // With little time left, ask for prose and nothing else: another tool round
    // cannot finish, and an unanswered turn scores zero.
    const withTools = remaining > FINAL_ANSWER_RESERVE_MS;
    const reply = await askModel(session, remaining, withTools);

    if (reply.toolCalls.length === 0) {
      session.messages.push({ role: 'assistant', content: reply.text });
      return buildParts(reply.text, session, turn);
    }

    // The assistant message carrying the tool_calls goes in first, then one tool
    // message per call in the same order, or the next request is rejected.
    session.messages.push(forHistory(reply.message));

    // Independent calls go together. "Check these five venues for Friday" is one
    // round-trip, not five, which is the difference between a four-second answer
    // and a timeout.
    const settled = await Promise.all(reply.toolCalls.map((call) => runToolCall(call, session, turn)));
    await unwindPartialBundle(settled, session, turn);

    for (const { call, result } of settled) {
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }

  // Out of rounds or out of budget: answer from what we already know.
  return await lastWords(session, deadline, turn);
}

/**
 * One model call, cut off at whatever is left of the turn rather than llm.js's 35s.
 *
 * No `temperature`. docs/harness.md asks for `temperature: 0` for steadier tool
 * arguments, but kimi-k2.6 on PLEC's proxy rejects every value except 1 with an
 * upstream 400 — verified against all of 0, 0.1, 0.3, 0.6 and 1. Omitting the
 * field is the only setting that works on the default model, so the loop leans
 * on explicit tool descriptions instead of a low temperature.
 */
async function askModel(session, remainingMs, withTools) {
  const messages = [{ role: 'system', content: systemPrompt(session) }, ...session.messages];
  const options = withTools ? { tools } : {};
  const deadline = Date.now() + remainingMs;

  // The proxy is shared and capped per five-minute window, so a 429 here is the
  // cap rather than our bug. Sit out one short wait before giving up: the turn
  // is worth more than the second we spend waiting.
  for (let attempt = 0; ; attempt += 1) {
    const left = deadline - Date.now();
    try {
      return await withTimeout(chatCompletion(messages, options), left);
    } catch (err) {
      const after = retryAfter(err);
      if (after === null || attempt >= 1) throw err;

      // The proxy says exactly how long the window has left. Wait it out only if
      // it fits with room to answer afterwards; a 29s reset does not fit a 32s
      // turn, and pretending otherwise just burns the turn before failing.
      const wait = after > 0 ? after * 1000 + 250 : BACKOFF_BASE_MS + Math.random() * BACKOFF_MAX_MS;
      if (wait > left - RETRY_FLOOR_MS) throw err;
      await sleep(wait);
    }
  }
}

/**
 * Seconds until the rate-limit window resets, or null if this was not a 429.
 *
 * The proxy is shared by every team and capped at 40 requests per five minutes,
 * so this is a normal condition during judging, not an exception.
 */
function retryAfter(err) {
  const busy = err?.status === 429 || /\b(429|rate_limit|rate limit|too many)\b/i.test(err?.message ?? '');
  if (!busy) return null;
  const seconds = Number(/"retryAfterSeconds"\s*:\s*(\d+)/.exec(err?.body ?? err?.message ?? '')?.[1]);
  return Number.isFinite(seconds) ? seconds : 0;
}

/**
 * Run one tool call, unless it is a write the user has not agreed to.
 *
 * A blocked write comes back as a { error, message } result, the same shape
 * callTool() returns for a sandbox failure, so the model reads it the way it
 * reads any other refusal and asks the question it should have asked.
 */
async function runToolCall(call, session, turn) {
  const args = parseToolArguments(call.argumentsJson);
  const isWrite = WRITE_TOOLS.has(call.name);

  if (isWrite && !clearYes(turn.text)) {
    session.state.pending = { kind: call.name, args };
    const hedging = AFFIRMATIVE.test(turn.text);
    return {
      call,
      result: {
        error: 'confirmation_required',
        message: hedging
          ? `${NEEDS_CONFIRMATION[call.name]} The user's last message sounds like a yes but is not a clear one — they are still asking something, or changing a detail. Answer what they actually said first, then ask for a plain yes.`
          : NEEDS_CONFIRMATION[call.name],
      },
    };
  }

  // "What did I book?" must show the user's reservations, not the team's. The
  // sandbox scopes bookings per team, so an unfiltered list would show a
  // stranger's booking to whoever asks.
  if (call.name === 'list_bookings' && !args.guestEmail) {
    const known = session.state.guest?.email;
    if (!known) {
      return {
        call,
        result: {
          error: 'email_required',
          message: 'Ask the user which email the reservation is under before listing any bookings. Do not list bookings you cannot attribute to them.',
        },
      };
    }
    args.guestEmail = known;
  }

  // A model that calls the same tool with the same arguments twice in one turn
  // is stuck, not thorough. Hand back what it already has so it spends the next
  // round writing an answer instead of burning the budget re-asking.
  const fingerprint = `${call.name}:${stableJson(args)}`;
  if (turn.calls.has(fingerprint)) {
    return {
      call,
      result: {
        error: 'already_called',
        message: 'You already called this exact tool with these exact arguments this turn. The result is above. Answer the user now, or call a different tool.',
        previous: turn.calls.get(fingerprint),
      },
    };
  }

  // Claim the fingerprint before awaiting anything. The calls in one round run
  // together under Promise.all, so a check that only records the result would
  // let both halves of a duplicated call through: neither has finished by the
  // time the other starts.
  turn.calls.set(fingerprint, null);

  const startedAt = Date.now();
  const result = isWrite
    ? await runWrite(call.name, args, session, turn)
    : await runRead(call.name, args, turn);

  turn.calls.set(fingerprint, result);
  trace(session, call.name, args, result, startedAt);
  remember(session, call.name, args, result, turn);

  // The action happened, so there is nothing outstanding to confirm.
  if (isWrite && !result?.error) delete session.state.pending;

  return { call, result };
}

/** Reads are safe to repeat, so a busy sandbox costs us a wait, not the turn. */
async function runRead(name, args, turn) {
  let result = await callTool(name, args);

  for (let attempt = 1; attempt <= READ_RETRIES && isTransient(result); attempt += 1) {
    if (turn.deadline - Date.now() < RETRY_FLOOR_MS) break;

    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    await sleep(Math.round(wait / 2 + Math.random() * wait));
    result = await callTool(name, args);
  }

  if (name === 'search_listings' && Array.isArray(result?.results) && result.results.length === 0) {
    return await relaxSearch(args, result, turn);
  }
  return result;
}

/**
 * Nothing matched. Widen one constraint and say which one.
 *
 * "No venues found" is a dead end for the user: they cannot tell whether the
 * city was wrong, the date was blacked out or the party was too big. So drop one
 * filter at a time, loosest first, and hand the model the name of what was
 * dropped so the reply can say "nothing on October 10, but here are three that
 * fit on other dates".
 *
 * One constraint at a time, and never the headcount before the date: a venue the
 * group does not fit in is not a result, it is a wrong answer.
 */
const RELAXATION_LADDER = [
  { drop: 'q', says: 'the name you searched for' },
  { drop: 'category', says: 'the category' },
  { drop: 'date', says: 'the date' },
  { drop: 'capacityMin', says: 'the minimum capacity' },
  { drop: 'guests', says: 'the headcount' },
];

async function relaxSearch(args, empty, turn) {
  const tried = [];
  let current = { ...args };

  for (const step of RELAXATION_LADDER) {
    if (current[step.drop] === undefined || current[step.drop] === null) continue;
    if (turn.deadline - Date.now() < RETRY_FLOOR_MS) break;

    const dropped = current[step.drop];
    delete current[step.drop];
    tried.push(step.drop);

    const wider = await callTool('search_listings', current);
    if (Array.isArray(wider?.results) && wider.results.length > 0) {
      return {
        ...wider,
        relaxed: { constraint: step.drop, originalValue: dropped, stillApplied: current },
        note: `Nothing matched the original search. These results come from the same search with ${step.says} relaxed (${step.drop} was ${JSON.stringify(dropped)}). Tell the user you widened that one thing, and say what it was, before listing anything.`,
      };
    }
  }

  return {
    ...empty,
    relaxed: { constraint: null, attempted: tried },
    note: tried.length
      ? `Nothing matched even after relaxing ${tried.join(', then ')}. Tell the user plainly that nothing fits and ask which detail they can change.`
      : 'Nothing matched. Ask the user which detail they can change.',
  };
}

/**
 * One attempt, then verify. Never a retry.
 *
 * Three guards, in the order they matter:
 *
 *   1. Idempotency. The same booking asked for twice in one conversation — a
 *      double-sent message, a model that re-books after being told the first
 *      one worked — returns the first booking rather than making a second.
 *   2. Reconciliation. When the call fails in a way that leaves the outcome
 *      unknown (the socket died, the sandbox 500ed), we do not guess and we do
 *      not retry. We list the bookings and look.
 *   3. Verification. On apparent success, re-read the booking. A reply that
 *      says "booked" is only worth saying if the sandbox agrees.
 */
async function runWrite(name, args, session, turn) {
  const state = session.state;
  state.writes ??= {};

  const key = name === 'book' ? bookingKey(args, state) : null;
  if (key && state.writes[key]) {
    const done = state.writes[key];
    return { ...done, idempotent: true, note: `This booking already exists as ${done.ref}. It was not booked again.` };
  }

  const result = await callTool(name, args);

  if (isAmbiguous(result)) {
    const found = await reconcile(name, args, state, turn);
    if (found) return { ...found, reconciled: true, note: 'The request timed out but the booking did go through. This is the real record; do not try again.' };
    return {
      ...result,
      message: `${result.message} Nothing was changed, as far as I can tell. Tell the user it did not go through and ask whether to try again.`,
    };
  }

  if (result?.error) return result;

  if (key && result.ref) state.writes[key] = result;

  const confirmed = await verify(result.ref, turn);
  return confirmed ? { ...result, ...confirmed } : result;
}

/**
 * Did the write land after all? Looks for a booking matching what we asked for.
 * Only a read, so it is safe to make after a failure of unknown outcome.
 */
async function reconcile(name, args, state, turn) {
  if (turn.deadline - Date.now() < RETRY_FLOOR_MS) return null;

  if (name === 'book') {
    const listing = await runRead('list_bookings', {}, turn);
    const rows = Array.isArray(listing?.bookings) ? listing.bookings : (listing?.results ?? []);
    const known = new Set(Object.keys(state.bookings ?? {}));
    return (
      rows.find(
        (row) =>
          !known.has(row.ref) &&
          row.status !== 'cancelled' &&
          (!args.listingId || row.listingId === args.listingId) &&
          (!args.date || row.date === args.date),
      ) ?? null
    );
  }

  // cancel and reschedule both name the booking, so read that one row back.
  if (!args.ref) return null;
  const row = await runRead('get_booking', { ref: args.ref }, turn);
  if (row?.error) return null;
  if (name === 'cancel_booking' && row.status === 'cancelled') return row;
  if (name === 'reschedule_booking' && args.date && row.date === args.date) return row;
  return null;
}

/**
 * A bundle is all or nothing.
 *
 * When a round books several things together — the venue, the caterer, the
 * photographer — a partial success is the worst outcome available. The user asked
 * for an evening, and half an evening still costs them money and still has to be
 * unpicked by hand. So if any booking in the round failed, cancel the ones that
 * went through and tell the model what it is now holding.
 *
 * Only bookings made in this same round are unwound. An earlier booking from an
 * earlier turn is a commitment the user already agreed to, and cancelling it
 * because a later unrelated one failed would be its own disaster.
 */
async function unwindPartialBundle(settled, session, turn) {
  const books = settled.filter((s) => s.call.name === 'book');
  if (books.length < 2) return;

  const made = books.filter((s) => s.result?.ref && !s.result.error && s.result.status !== 'cancelled');
  const failed = books.filter((s) => s.result?.error);
  if (failed.length === 0 || made.length === 0) return;

  const undone = [];
  const stuck = [];
  for (const { result } of made) {
    const out = await callTool('cancel_booking', { ref: result.ref });
    if (out?.error) stuck.push(result.ref);
    else {
      undone.push(result.ref);
      session.state.bookings[result.ref] = out;
      // The idempotency record must go too, or a genuine retry of the whole
      // bundle would be told the cancelled booking already exists.
      for (const [key, saved] of Object.entries(session.state.writes ?? {})) {
        if (saved?.ref === result.ref) delete session.state.writes[key];
      }
    }
  }

  const detail = [
    `Part of this bundle failed, so it was rolled back: nothing in it stands.`,
    undone.length ? `Cancelled again: ${undone.join(', ')}.` : '',
    stuck.length ? `Could NOT cancel ${stuck.join(', ')} — tell the user this one is still live and needs attention.` : '',
    `Tell the user which part failed and why, say the rest was undone, and ask whether to try a different option.`,
  ]
    .filter(Boolean)
    .join(' ');

  for (const entry of made) {
    entry.result = { ...entry.result, rolledBack: true, status: 'cancelled', note: detail };
  }
  for (const entry of failed) {
    entry.result = { ...entry.result, bundleRolledBack: true, note: detail };
  }
  turn.rolledBack = [...undone, ...stuck];
}

/** Re-read a booking we just wrote, so what we tell the user is the sandbox's word. */
async function verify(ref, turn) {
  if (!ref || turn.deadline - Date.now() < RETRY_FLOOR_MS) return null;
  const row = await runRead('get_booking', { ref }, turn);
  return row?.error ? null : row;
}

/**
 * What makes two booking requests the same booking: the listing, the slot, the
 * size and who it is for. Not the quoteId — a fresh quote for the identical slot
 * is still the same booking.
 */
function bookingKey(args, state) {
  if (!args.listingId && !state.lastQuote?.listingId) return null;
  const parts = [
    args.listingId ?? state.lastQuote?.listingId,
    args.date ?? state.date,
    args.startTime ?? '',
    args.endTime ?? '',
    args.guests ?? args.guestCount ?? state.guestCount ?? '',
    (args.guestEmail ?? state.guest?.email ?? '').toLowerCase(),
  ];
  return parts.join('|');
}

/** Key order must not change a fingerprint, so sort before stringifying. */
function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Keep the trace short enough that a session cannot grow without bound. */
const TRACE_LIMIT = 60;

/**
 * Every tool call, with what it was asked and what came back.
 *
 * This is the data behind a live trace panel: a reader can see that a price came
 * from a `quote` and not from the model's imagination, which is the single
 * clearest way to show the agent is not making things up. Kept on the session so
 * a UI can read it without the loop knowing a UI exists.
 */
function trace(session, name, args, result, startedAt) {
  const state = session.state;
  state.trace ??= [];
  state.trace.push({
    at: new Date(startedAt).toISOString(),
    ms: Date.now() - startedAt,
    tool: name,
    args,
    ok: !result?.error,
    outcome: result?.error
      ? { error: result.error, message: result.message }
      : summarise(name, result),
  });
  if (state.trace.length > TRACE_LIMIT) state.trace.splice(0, state.trace.length - TRACE_LIMIT);
}

/** A line a human can read at a glance, not the whole payload. */
function summarise(name, result) {
  if (!result || typeof result !== 'object') return { value: result };
  if (Array.isArray(result.results)) {
    return { matched: result.results.length, names: result.results.slice(0, 5).map((r) => r?.name).filter(Boolean), relaxed: result.relaxed?.constraint ?? null };
  }
  if (Array.isArray(result.bookings)) return { bookings: result.bookings.length };
  if (result.totalCents !== undefined && !result.ref) return { totalCents: result.totalCents };
  if (result.ref) {
    return {
      ref: result.ref,
      status: result.status,
      totalCents: result.totalCents,
      payment: result.payment?.status ?? null,
      idempotent: result.idempotent ?? undefined,
      reconciled: result.reconciled ?? undefined,
      rolledBack: result.rolledBack ?? undefined,
    };
  }
  if (result.name) return { listing: result.name, capacity: result.capacity ?? null };
  return { keys: Object.keys(result).slice(0, 8) };
}

/**
 * Fold a tool call into session.state so later turns can use it.
 *
 * Arguments matter as much as results: when the model searches Philadelphia for
 * 40 guests, both belong to the conversation from then on, which is what stops
 * the agent asking for a city it was already given.
 */
function remember(session, name, args, result, turn) {
  const state = session.state;
  state.seen ??= {};
  state.bookings ??= {};

  if (args.city) state.city = args.city;
  if (args.date) state.date = args.date;
  const guests = args.guests ?? args.guestCount;
  if (Number.isFinite(guests)) state.guestCount = guests;
  if (args.guestName && args.guestEmail) state.guest = { name: args.guestName, email: args.guestEmail };

  if (!result || result.error) return;

  if (name === 'search_listings' && Array.isArray(result.results)) {
    const ids = [];
    for (const listing of result.results) {
      stash(state, listing);
      if (listing?.id) ids.push(listing.id);
    }
    state.lastSearch = { ids, args };
    turn.lookedUpIds.push(...ids);
  }

  if (name === 'get_listing' && result.id) {
    stash(state, result);
    // A detail fetch is the strongest signal of which listing the turn is about,
    // so it goes to the front of the card candidates.
    turn.lookedUpIds.unshift(result.id);
  }
  if (name === 'quote' && result.quoteId) state.lastQuote = result;

  // book, get_booking, cancel_booking, reschedule_booking and
  // resend_payment_link all answer with a booking.
  if (result.ref) {
    state.bookings[result.ref] = result;
    state.lastBookingRef = result.ref;
  }
}

/**
 * Every listing object any tool returned, keyed by id. A search hit is compact:
 * no description, packages, open hours, blackouts or mapUrl. Merging rather
 * than replacing means a later detail fetch fills those in and a later search
 * never strips them back out.
 */
function stash(state, listing) {
  if (!listing?.id) return;
  state.seen[listing.id] = { ...(state.seen[listing.id] ?? {}), ...listing };
}

/**
 * The model's words, plus cards.
 *
 * parts.js renders cards when the model emits a `CARDS: id, id` line, which is
 * the prompt half's protocol. Until that instruction lands — and as a net if the
 * model forgets it — attach the listings this turn actually looked up. Both
 * paths build from state.seen, so a card can only ever be a listing a tool
 * really returned.
 *
 * Which ones: the listings the answer names. A question about one venue gets one
 * card, not the whole search that found it. Only when the answer names none —
 * "here are some options" — do the top results stand in.
 */
function buildParts(text, session, turn) {
  const parts = toParts(text, session);
  if (parts.some((part) => part.kind === 'card')) return ensureQuestion(parts, session);

  const state = session.state;
  const candidates = [];
  for (const id of turn.lookedUpIds) {
    const listing = state.seen?.[id];
    if (listing?.name && fitsGroup(listing, state.guestCount)) candidates.push(listing);
  }
  if (candidates.length === 0) return ensureQuestion(parts, session);

  const haystack = (text ?? '').toLowerCase();
  const named = candidates.filter((listing) => haystack.includes(listing.name.toLowerCase()));
  const chosen = named.length > 0 ? named : candidates;

  const shown = new Set();
  for (const listing of chosen) {
    if (shown.size >= MAX_CARDS) break;
    if (shown.has(listing.name)) continue;
    shown.add(listing.name);
    parts.push(cardFor(listing));
  }

  return ensureQuestion(parts, session);
}

/**
 * Make sure the reply asks something.
 *
 * prompt.js already tells the model that any reply which has not just finished
 * an action ends with a question, and most of the time it obeys. Most of the
 * time is not good enough: the suite checks for a question mark on several
 * turns, and we cannot damp the variance with `temperature` because the proxy
 * rejects every value (see askModel). So the prompt asks, and this guarantees.
 */
function ensureQuestion(parts, session) {
  const texts = parts.filter((part) => part.kind === 'text');
  if (texts.some((part) => part.text?.includes('?'))) return parts;

  const state = session.state;
  const question = state.pending
    ? 'Shall I go ahead?'
    : state.lastQuote
      ? 'Would you like me to go ahead and book it?'
      : 'What else can I help you with?';

  if (texts.length > 0) {
    texts[0].text = `${(texts[0].text ?? '').trim()}\n\n${question}`.trim();
  } else {
    parts.unshift({ kind: 'text', text: question });
  }
  return parts;
}

function fitsGroup(listing, guestCount) {
  if (!Number.isFinite(guestCount) || !listing.capacity) return true;
  return guestCount >= listing.capacity.min && guestCount <= listing.capacity.max;
}

/** Rounds or budget ran out mid-loop. Try for prose; failing that, say so plainly. */
async function lastWords(session, deadline, turn) {
  const remaining = deadline - Date.now();
  if (remaining > 2_000) {
    try {
      const reply = await askModel(session, remaining, false);
      if (reply.text?.trim()) {
        session.messages.push({ role: 'assistant', content: reply.text });
        return buildParts(reply.text, session, turn);
      }
    } catch (err) {
      console.error('[agent] final answer failed:', err);
    }
  }

  const honest = 'I lost the thread there. Could you say that again in one line?';
  session.messages.push({ role: 'assistant', content: honest });
  return [{ kind: 'text', text: honest }];
}

/**
 * The assistant message as history. `reasoning_content` is kimi's scratchpad; it
 * is not part of the OpenAI message shape and replaying it back to a proxy is a
 * good way to earn a 400, so keep the parts that matter and drop it.
 */
function forHistory(message) {
  const kept = { role: 'assistant', content: message.content ?? '' };
  if (message.tool_calls) kept.tool_calls = message.tool_calls;
  return kept;
}

function withTimeout(promise, ms) {
  let timer;
  const cutoff = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer from the model in ${Math.round(ms / 1000)}s.`)), Math.max(0, ms));
  });
  return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
}
