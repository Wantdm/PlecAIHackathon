# The `loop` half

You own the turn loop, the memory, and the confirm-then-act gate. Read
`CLAUDE.md` first for the ownership rules, then this file is your work order.

```bash
git checkout -b loop origin/main
```

Commit only to `loop`.

## Files you own — edit ONLY these

```
agent/agent.js     exports respond({ sessionId, text, session })
agent/session.js   the per-session store
```

## Files you must NOT edit, create, or refactor

```
agent/prompt.js    owned by the `behavior` half
agent/parts.js     owned by the `behavior` half
```

Call `systemPrompt(session)` and `toParts(text, session)` and assume they work,
**even if the prompt is still one line or the rendering looks thin**. If you need
something changed there, say so in your reply and it gets messaged to the other
person. Do not fix it yourself — that is the merge conflict this whole split
exists to prevent.

`systemPrompt`, `toParts`, `cardFor` and `respond` are frozen signatures.
Changing one breaks the other branch and takes both people agreeing.

## Job 1 — the turn loop

Replace the echo in `respond()`. `docs/harness.md` has the reference shape.

1. `reply = await chatCompletion([{ role: 'system', content: systemPrompt(session) }, ...session.messages], { tools, temperature: 0 })`
2. If `reply.toolCalls` is empty: push the assistant message onto
   `session.messages` and `return toParts(reply.text, session)`.
3. Otherwise push `reply.message` **first**, then one
   `{ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) }` per
   call, in the same order — providers reject the next request if the assistant
   message carrying the `tool_calls` is missing.
4. `result = await callTool(call.name, parseToolArguments(call.argumentsJson))`.
   `callTool` does not throw on a sandbox error; it returns `{ error, message }`
   and the model reads it like any other result.
5. Cap at `MAX_ROUNDS` (8). One bad tool argument must not burn the 45s budget.
6. `temperature: 0` for steadier tool arguments. `Promise.all` independent calls
   (several `get_listing`) to stay under the latency marks.

## Job 2 — memory in `session.state`

The next turn sees whatever you store.

- Fill `city`, `date`, `guestCount` from the **tool arguments** each round, so
  when the model searches `city: 'Philadelphia', guests: 40` both get remembered.
- `state.guest = { name, email }` once given. The prompt half restates it so the
  agent never asks twice.
- **`state.seen`** — every listing object any tool returned this conversation,
  keyed by id. `parts.js` builds cards only from this, so if you do not populate
  it, no cards ever render and two public checks fail.
- Pass the headcount as `guests` on searches. The sandbox only returns listings
  whose capacity range contains it, which is what makes the cards fit the group
  for free.

## Job 3 — the confirm-then-act gate

Booking, cancelling and rescheduling change state and cannot be undone.

- Keep `state.pending = { kind: 'book' | 'cancel' | 'reschedule', ... }`.
- **A "yes" with nothing pending is a question, not a booking.** The suite checks
  that the sandbox holds zero bookings after a bare "book it", and exactly one
  after the yes.
- One message can carry the details, the identity and the yes together. Then act
  in that same turn — confirmation means the user agreed to this action, not that
  an extra round trip is owed.
- Cancel and reschedule follow the same shape: state what will happen, ask, wait
  for the yes, then call the tool.

## Job 4 — prices, payment, errors

- Never compute a price. State the sandbox's `totalCents` from a `quote`, all-in.
- An instant booking returns `pending_payment` with a `payment.url`. Pass that
  URL through **exactly** as returned. Read `payment.status` before describing
  anything as paid. `resend_payment_link` issues a fresh one when asked again.
  There is no way to pay on the guest's behalf; do not reach for a pay route.
- Relay `{ error, message }` honestly. Do not book a different slot, do not say
  "let me check" and stop, do not claim it worked.
- **Wrap `respond()` in try/catch.** A turn that throws is a turn with no reply,
  and a turn with no reply fails every check on it. One honest line beats a 500.

## Two hazards

- **`npm test` resets the shared team sandbox.** Booking state is per team, not
  per person. Tell the other person before you run it or their in-progress
  bookings vanish.
- **The model proxy is shared across every team** and capped in a rolling
  5-minute window. A burst of 429s while iterating is not necessarily your bug.

Keys go in `.env`, which is gitignored. Never commit one.
