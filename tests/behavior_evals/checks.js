/**
 * Assertions for behaviour evals. Each returns { label, test(ctx) }, where ctx
 * is { parts, reply, text, delta, ms }: reply is every part flattened to text,
 * text is only the text parts, delta is the change in the team's live bookings.
 *
 * Several checks are heuristics for tone (warmth, hedging). They are marked
 * "(heuristic)" in the label; read the transcript line for those.
 */

const JARGON = ['slot', 'party size', 'headcount', 'booking id', 'availability window', 'session', 'quote id', 'quoteid', 'instant book', 'instantbook', 'request-to-book', 'pending_payment', 'api', 'sandbox'];

const ok = (pass, detail = '') => ({ ok: Boolean(pass), detail });

export const noJargon = () => ({
  label: 'No jargon (slot, party size, booking ID, session ...)',
  test: ({ text }) => {
    // Jargon in a URL (the payment link has /sandbox/ in it) is not user-facing wording.
    const words = text.replace(/https?:\/\/\S+/g, ' ').toLowerCase();
    const hits = JARGON.filter((j) => new RegExp(`\\b${j.replace(/[-_]/g, '[-_ ]?')}\\b`).test(words));
    return ok(hits.length === 0, hits.length ? `found: ${hits.join(', ')}` : '');
  },
});

export const noMarkdown = () => ({
  label: 'No markdown or emoji',
  test: ({ text }) => {
    const bad = [];
    if (/\*\*|__|`|^#{1,6}\s|\|/m.test(text)) bad.push('markdown');
    if (/\p{Extended_Pictographic}/u.test(text)) bad.push('emoji');
    return ok(bad.length === 0, bad.join(', '));
  },
});

export const asksQuestion = () => ({
  label: 'Asks a question',
  test: ({ text }) => ok(/[?？]/.test(text)),
});

export const atMostOneQuestion = () => ({
  label: 'At most one question',
  test: ({ text }) => {
    const n = (text.match(/[?？]/g) ?? []).length;
    return ok(n <= 1, `${n} question marks`);
  },
});

export const bookingsDelta = (n) => ({
  label: n === 0 ? 'Nothing booked, cancelled or moved' : `Exactly ${n} new booking`,
  test: ({ delta }) => ok(delta === n, `change ${delta}`),
});

export const includesAny = (values, label) => ({
  label: label ?? `Mentions one of: ${values.join(' / ')}`,
  test: ({ reply }) => {
    const hit = values.find((v) => reply.toLowerCase().includes(String(v).toLowerCase()));
    return ok(hit, hit ? `found "${hit}"` : '');
  },
});

export const excludesAll = (values, label) => ({
  label: label ?? `Never says: ${values.join(' / ')}`,
  test: ({ reply }) => {
    const hit = values.find((v) => reply.toLowerCase().includes(String(v).toLowerCase()));
    return ok(!hit, hit ? `found "${hit}"` : '');
  },
});

export const matches = (re, label) => ({
  label: label ?? `Matches ${re}`,
  test: ({ reply }) => ok(re.test(reply)),
});

export const textMatches = (re, label) => ({
  label: label ?? `Text matches ${re}`,
  test: ({ text }) => ok(re.test(text)),
});

export const cardsBetween = (min, max) => ({
  label: `Shows ${min} to ${max} cards`,
  test: ({ parts }) => {
    const n = parts.filter((p) => p.kind === 'card').length;
    return ok(n >= min && n <= max, `${n} cards`);
  },
});

export const noCards = () => ({
  label: 'No cards',
  test: ({ parts }) => ok(!parts.some((p) => p.kind === 'card')),
});

export const shortReply = (maxSentences = 5) => ({
  label: `Short: at most ${maxSentences} sentences of text`,
  test: ({ text }) => {
    const n = text.replace(/https?:\/\/\S+/g, 'URL').split(/[.!?？。](\s|$)/).filter((s) => s && s.trim().length > 3).length;
    return ok(n <= maxSentences, `${n} sentences`);
  },
});

export const noTechnicalError = () => ({
  label: 'No error codes, stack traces or raw JSON',
  test: ({ text }) => {
    const words = text.replace(/https?:\/\/\S+/g, ' ');
    const hit = words.match(/\b[a-z]+_[a-z_]+\b|\{\s*"|\bat \S+\.js:\d+|\b(?:HTTP|status) [45]\d\d\b|\bnot_found\b/i);
    return ok(!hit, hit ? `found "${hit[0]}"` : '');
  },
});
