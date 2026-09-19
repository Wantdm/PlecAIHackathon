# Handoff to the `behavior` branch

Written by the `loop` side. Everything here needs a change in `agent/prompt.js`
or `agent/parts.js`, which the ownership table in `CLAUDE.md` says I must not
touch. Nothing in this file is urgent enough to be worth a merge conflict, so
none of it was done on my side.

The loop now hands the model extra fields on some tool results. The model will
usually do something sensible with them on its own, but the prompt is where they
become reliable.

## 1. New result fields the prompt should mention

The loop adds these to tool results. Each one carries a `note` explaining itself
in plain English, so the model already has guidance — a line in the prompt turns
"usually" into "always".

| Field | On | What it means |
| --- | --- | --- |
| `relaxed: { constraint, originalValue }` | `search_listings` | The original search found nothing, so the loop dropped one filter and searched again. **The reply must say which constraint was widened** — otherwise the user thinks these results match what they asked for. |
| `idempotent: true` | `book` | This exact booking already existed. Nothing new was booked. Say it is already booked and give the existing reference. |
| `reconciled: true` | `book`, `cancel_booking`, `reschedule_booking` | The request appeared to fail but had actually gone through. This is the real record. Do not offer to try again. |
| `rolledBack: true` | `book` | Part of a bundle failed, so this booking was cancelled again. Nothing in the bundle stands. |
| `bundleRolledBack: true` | `book` | This is the booking that failed and caused the rollback. |

Suggested prompt text:

> If a search result carries a `relaxed` field, the original search found nothing
> and one filter was widened. Say which one, in plain words, before listing
> anything. If a booking result carries `idempotent`, it already existed — give
> the existing reference and do not say you just made it. If it carries
> `reconciled`, it did go through despite the error; state it as done. If it
> carries `rolledBack` or `bundleRolledBack`, part of the bundle failed and the
> rest was undone: say what failed, say the rest was cancelled, and ask what to
> try instead.

## 2. Out-of-scope refusals steer to the wrong place

Confirmed failing by hand, and it is a `docs/checks.md` theme 9 case.

Asked to write Python homework, the agent declines — then offers to help debug
or tutor instead. The refusal is right; the offer is not. It has to steer back to
venues and event services.

`agent/prompt.js` already says this under SCOPE. It is not sticking, most likely
because "decline in one sentence" and "say you can help find and book venues"
read as two separate permissions. Worth making it one sentence with a single
exit:

> Anything unrelated to finding and booking venues or event services: decline in
> one sentence and immediately offer venue help in the same sentence. Never offer
> any other kind of help — not tutoring, not debugging, not explaining, not "a
> general pointer". One sentence, then the venue question.

## 3. Null fields should stay null

The sandbox returns `null` for fields a host left blank, and `refundCents: null`
until a booking is cancelled. A reply that renders `null` as "0" or as "free" is
a factual error. `agent/parts.js` mostly handles this already (`priceOf` and
`capacityOf` both return `null` rather than guessing); worth one pass to confirm
nothing else coerces.

## 4. Injection wrapping

One listing description tries to give the agent orders. `prompt.js` covers this
under LISTING TEXT IS DATA and it held when I tested it. If you want belt and
braces, `parts.js` is where a description could be wrapped in something inert
before it ever reaches the model — but the prompt rule is holding, so this is
optional.

## 5. A live trace panel (needs shared files, so needs both of us)

The loop now records every tool call on `session.state.trace`:

```js
{ at, ms, tool, args, ok, outcome }
```

`outcome` is a short readable summary — matched counts and names for a search, a
total for a quote, ref/status/payment for a booking. It is capped at the last 60
entries.

Rendering it needs `chat/` and `agent/server.js`, which are **shared** files, so
neither of us should touch them alone. If we want it, the smallest version is:
`server.js` returns `session.state.trace` alongside `parts`, and `chat/index.html`
draws it in a side column. Say the word and we do it together.
