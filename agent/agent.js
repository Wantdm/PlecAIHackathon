/**
 * The brain. server.js calls respond() once per user turn and sends back
 * whatever parts you return.
 *
 * OWNER: the `loop` branch. The prompt lives in agent/prompt.js and the part
 * rendering in agent/parts.js, both owned by the `behavior` branch. This file
 * calls them and does not edit them.
 *
 * It still ships as an echo so the whole pipeline (chat page, server, test
 * runner) is provable before either half is written. Every TODO marks where the
 * harness goes; docs/harness.md walks through each one with code.
 *
 * Parts you can return (docs/contract.md):
 *   { kind: 'text',  text }
 *   { kind: 'card',  title, subtitle?, photoUrls: [], url? }
 *   { kind: 'link',  label, url }
 *   { kind: 'image', url, caption? }
 * Always include at least one text part.
 */

import { chatCompletion, parseToolArguments } from './llm.js';
import { callTool, plec, tools } from './plec.js';
import { systemPrompt } from './prompt.js';
import { toParts } from './parts.js';

/** A confused model must not loop until the 45s turn budget is gone. */
const MAX_ROUNDS = 8;

/**
 * @param {{ sessionId: string, text: string, session: { messages: object[], state: object } }} turn
 * @returns {Promise<Array<object>>} parts
 */
export async function respond({ sessionId, text, session }) {
  // TODO(memory): `session.messages` is the chat history in OpenAI shape;
  // `session.state` is yours (pending action, guest name and email, city, date,
  // headcount, and `seen`: every listing object a tool returned, keyed by id).
  // Keep both up to date every turn.
  const isFirstTurn = session.messages.length === 0;
  session.messages.push({ role: 'user', content: text });

  // TODO(loop): replace everything below with the harness loop:
  //   for (let round = 0; round < MAX_ROUNDS; round += 1) {
  //     1. reply = await chatCompletion([{ role: 'system', content: systemPrompt(session) },
  //                                      ...session.messages], { tools, temperature: 0 })
  //     2. if reply.toolCalls is empty: push the assistant message and
  //        return toParts(reply.text, session)
  //     3. push reply.message FIRST, then for each call:
  //        result = await callTool(call.name, parseToolArguments(call.argumentsJson))
  //        remember it in session.state (including state.seen), then push
  //        { role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) }
  //   }
  // Wrap the whole thing in try/catch: a turn that throws is a turn with no
  // reply, and every check on it fails.

  const greeting =
    'Hi, I am the PLEC Concierge. I can find venues and event services and book them for you. What city is your event in, what date, and roughly how many guests?';
  const echo = `You said: "${text}". I am only an echo so far. Open agent/agent.js to teach me the rest.`;

  // TODO(tools): the echo never touches the sandbox. Ground every fact
  // (capacity, price, availability, booking status) in a result from plec.js.
  const answer = isFirstTurn ? greeting : echo;

  // TODO(errors): a PlecError from callTool() carries { error, message }. Relay
  // the message honestly ("The Rooftop is not available on October 17") instead
  // of hiding it or inventing an alternative.

  session.messages.push({ role: 'assistant', content: answer });
  return toParts(answer, session);
}
