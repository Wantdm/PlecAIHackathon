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
 * A yes, in the message that triggered the write. Deliberately narrow: "book
 * it" and "cancel BK-1001" are requests, not confirmations, and the suite
 * checks that neither one acts on its own. Spanish is here because a Spanish
 * conversation can reach a booking too.
 */
const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|ok|okay|sure|confirm|confirmed|correct|agreed|perfect|sounds good|go ahead|do it|please do|let'?s do it|s[íi]|claro|adelante|dale|hazlo|perfecto|de acuerdo)\b/i;

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
    const apology = 'Something went wrong on my side just now. Could you try that once more?';
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
  const turn = { text, lookedUpIds: [] };

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

    const settled = await Promise.all(reply.toolCalls.map((call) => runToolCall(call, session, turn)));
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
  return await withTimeout(chatCompletion(messages, options), remainingMs);
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

  if (WRITE_TOOLS.has(call.name) && !AFFIRMATIVE.test(turn.text)) {
    session.state.pending = { kind: call.name, args };
    return { call, result: { error: 'confirmation_required', message: NEEDS_CONFIRMATION[call.name] } };
  }

  const result = await callTool(call.name, args);
  remember(session, call.name, args, result, turn);

  // The action happened, so there is nothing outstanding to confirm.
  if (WRITE_TOOLS.has(call.name) && !result?.error) delete session.state.pending;

  return { call, result };
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
  if (parts.some((part) => part.kind === 'card')) return parts;

  const state = session.state;
  const candidates = [];
  for (const id of turn.lookedUpIds) {
    const listing = state.seen?.[id];
    if (listing?.name && fitsGroup(listing, state.guestCount)) candidates.push(listing);
  }
  if (candidates.length === 0) return parts;

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
