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

## 7. Housekeeping

- `CLAUDE.md` still says "`.env` is gitignored, so this setting does not travel
  through git", but `.env` is now tracked on `loop`. Worth one line fixing.
- `git fetch` from `github.com/Wantdm/PlecAIHackathon` returned "Repository not
  found" at the time of writing. Check the repo was not renamed or made
  inaccessible before the 3:30pm submission.
