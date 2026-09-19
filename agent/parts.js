/**
 * Turning the model's final answer into contract parts (docs/contract.md).
 *
 * OWNER: the `behavior` branch. The loop calls toParts(text, session) with the
 * model's words and never edits this file.
 *
 * The rule that matters: a card may only be built from a listing object a tool
 * actually returned, which the loop stashes in session.state.seen keyed by id.
 * Building cards from the model's prose is how invented venues reach the judges.
 */

/** Tag lines the model appends to ask for rich parts; stripped before display. */
const TAG_LINE = /^(CARDS|PHOTOS):.*$/gm;

/**
 * @param {string} text  the model's final answer
 * @param {{ state: object }} session
 * @returns {Array<object>} parts, always with at least one text part
 */
export function toParts(text, session) {
  const seen = session?.state?.seen ?? {};
  const raw = typeof text === 'string' ? text : '';

  const cardIds = idsFrom(raw, 'CARDS');
  const photoIds = idsFrom(raw, 'PHOTOS');
  const clean = raw.replace(TAG_LINE, '').trim();

  // The contract requires at least one text part on every turn.
  const parts = [{ kind: 'text', text: clean || 'Sorry, could you say that again?' }];

  for (const id of cardIds) {
    const listing = seen[id];
    if (listing) parts.push(cardFor(listing));
  }

  for (const id of photoIds) {
    const listing = seen[id];
    for (const url of listing?.photoUrls ?? []) {
      parts.push({ kind: 'image', url, caption: listing.name });
    }
  }

  // TODO(behaviour): link parts to mapUrl when the user asks where something is.
  return parts;
}

/**
 * One listing as a card. The title must be the listing's exact `name`: the
 * checks match cards to listings by title, so a reworded title fails
 * cardsOnlyFrom even when the venue is right.
 *
 * @param {object} listing  a listing object from a tool result
 * @returns {object} a card part
 */
export function cardFor(listing) {
  const card = {
    kind: 'card',
    title: listing.name,
    subtitle: [listing.category, listing.neighborhood, capacityOf(listing), priceOf(listing)]
      .filter(Boolean)
      .join(', '),
    photoUrls: listing.photoUrls ?? [],
  };
  // The offline catalogue has no mapUrl; the sandbox adds it. Only set it when there is one.
  if (listing.mapUrl) card.url = listing.mapUrl;
  return card;
}

function capacityOf(listing) {
  const c = listing.capacity;
  return c ? `${c.min} to ${c.max} guests` : null;
}

function priceOf(listing) {
  const p = listing.pricing;
  if (!p || typeof p.rateCents !== 'number') return null;
  const rate = dollars(p.rateCents);
  if (p.model === 'hourly') return `${rate}/hour`;
  if (p.model === 'perGuest') return `${rate} per guest`;
  return `${rate} flat`;
}

/** Cents to `$1,815.00`, the format docs/harness.md asks for. */
export function dollars(cents) {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function idsFrom(text, tag) {
  const match = text.match(new RegExp(`^${tag}:\\s*(.+)$`, 'm'));
  if (!match) return [];
  return match[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
