# Handoff: behavior → loop

Things the behaviour half needs from `agent/agent.js` / `agent/session.js`, or
that I noticed there and left alone. Nothing below was edited on your side.

## 1. The yes-gate lets unsure yeses through (most important)

`AFFIRMATIVE` in `agent/agent.js` matches `ok`, `sure` and `yes` anywhere in the
message, so these all pass the code gate and only the prompt stops a booking:

- "yes I think so"
- "ok, is that the one near the river?"
- "sure, but make it 7pm"

Judges were told to stress elderly users with exactly these replies. Suggested
tightening, applied only in the write gate:

```js
const HEDGE = /\b(think so|maybe|probably|i guess|not sure|perhaps|might)\b|\?|\bbut\b/i;
const clearYes = (text) => AFFIRMATIVE.test(text) && !HEDGE.test(text);
```

A message that carries full details, identity and "yes, go ahead" in one turn
still passes, so hidden themes 3 and 13 are unaffected.

## 2. `list_bookings` without an email shows every team booking

"What did I book?" should only ever show the user's own reservations. The
prompt tells the model to filter by the user's email, but the tool allows no
filter. Suggest: in the `list_bookings` call path, default `guestEmail` to
`session.state.guest.email`, and if there is none, return
`{ error: 'email_required', message: 'Ask the user for the email the reservation is under.' }`.

## 3. Fields the prompt reads from `session.state`

The prompt now restates bookings made in this conversation, so "book it" twice
never books twice. It reads, per entry of `state.bookings`:
`ref, listingName, listingId, date, startTime, endTime, guestCount, status`.
Your `remember()` already stores the whole booking result there, so this works
today. Please keep that shape.

Also read: `city, date, guestCount, guest {name, email}, pending`.

`BOOKING: BK-1001` tag lines (parts.js) render a reservation card from
`state.bookings[ref]`. `remember()` stores results that carry a top-level
`ref`, so `list_bookings` results (`{ bookings: [...] }`) are not stored and
get no card. If you want "what did I book?" to show cards straight from
`list_bookings`, store each entry of `result.bookings` by its `ref` too.

## 4. The event contract in the behaviour brief does not exist here

The brief describes `needs_confirmation` / `clarification_needed` / `error` /
`final` events and a `confirmation_id`. This repo's contract
(`docs/contract.md`) is parts only: `text`, `card`, `link`, `image`. I built on
what exists: `state.pending` plus the prompt for confirmation, and `toParts()`
for rendering. Adding an event layer now would change the frozen seam, so I
have not asked for it.

## 5. UI items left undone (shared `chat/`, not scored by the evaluator)

Large-text toggle, high contrast, "Yes, book it" / "No, change something"
buttons, a collapsible "what I'm doing" trace, and a "still working on it" state
during retries all live in `chat/index.html`. The staff evaluator calls the
agent URL server side and never renders the page, so none of it moves the
score. If we want it for a live demo, it needs both of us to agree to touch
`chat/`.

## 6. Token budget

The system prompt is now ~15k characters (~4k tokens) and is sent every round.
With the 150k-token / 5-minute team cap, long conversations (history grows
too) can hit `token_quota_exceeded` during judging. If that shows up, trimming
old tool results from `session.messages` (keep the last few) is the cheapest fix
on the loop side.

## 7. Fallback cards can exceed three

`buildParts` in agent.js caps its fallback at `MAX_CARDS = 5`. When the model
emits no `CARDS:` line, a search reply can show 4 or 5 cards (seen live on the
"wheelchair accessible venue for 30 people" turn). The prompt and parts.js aim
for 2 or 3 plus "show more". Suggest `MAX_CARDS = 3` in agent.js.

## 8. ensureQuestion adds English and breaks emergencies (important, 2-line fix)

Seen live in the behaviour evals:

- Chinese: the reply already ended with a full-width question mark
  (`请问你想订哪一天呢？`), which `includes('?')` misses, so it appended the
  English "What else can I help you with?" to a Chinese conversation.
- Emergency: "Call 911 right now. Put the phone on speaker and start CPR..." got
  "What else can I help you with?" appended. Tone-deaf, and it fails the
  "911 and nothing else" check.

Suggested fix in `ensureQuestion` (agent.js):

```js
if (texts.some((part) => /[?？¿]/.test(part.text ?? ''))) return parts;
if (texts.some((part) => /\b911\b/.test(part.text ?? ''))) return parts;
```

A generic English follow-up is also wrong for any non-English reply; if easy,
skip appending when the text has no Latin letters or the user wrote in Spanish.
