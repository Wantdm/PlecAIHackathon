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

/**
 * Tag lines the model appends to ask for rich parts; stripped before display.
 * Tolerates the model wrapping the tag in markdown (`**CARDS:** a, b`).
 */
const TAG_LINE = /^[\s*_`]*(CARDS|PHOTOS|MAP)[*_`]*\s*:.*$/gim;

/** More cards than this is a brochure, not an answer. */
const MAX_CARDS = 8;

/**
 * @param {string} text  the model's final answer
 * @param {{ state: object }} session
 * @returns {Array<object>} parts, always with at least one text part
 */
export function toParts(text, session) {
  const seen = session?.state?.seen ?? {};
  const raw = typeof text === 'string' ? text : '';

  const cardIds = idsFrom(raw, 'CARDS').slice(0, MAX_CARDS);
  const photoIds = idsFrom(raw, 'PHOTOS');
  const mapIds = idsFrom(raw, 'MAP');
  const clean = plainText(raw.replace(TAG_LINE, ''));

  // The contract requires at least one text part on every turn.
  const parts = [{ kind: 'text', text: clean || 'Sorry, could you say that again?' }];

  const carded = new Set();
  for (const id of cardIds) {
    const listing = lookup(seen, id);
    if (!listing || carded.has(listing)) continue;
    carded.add(listing);
    parts.push(cardFor(listing));
  }

  for (const id of photoIds) {
    const listing = lookup(seen, id);
    if (!listing) continue;
    const urls = listing.photoUrls ?? [];
    for (const url of urls) parts.push({ kind: 'image', url, caption: listing.name });
    // No photos on file: a card is the next best photo-capable part.
    if (urls.length === 0 && !carded.has(listing)) {
      carded.add(listing);
      parts.push(cardFor(listing));
    }
  }

  for (const id of mapIds) {
    const listing = lookup(seen, id);
    if (listing?.mapUrl) parts.push({ kind: 'link', label: `${listing.name} on the map`, url: listing.mapUrl });
  }

  return parts;
}

/**
 * The chat page draws text parts with textContent (chat/index.html) and the
 * contract says no markdown rendering, so any markdown the model writes shows
 * up as stray symbols. The prompt asks for plain sentences; this is the net.
 *
 * URLs are set aside first and restored last, so a payment link like
 * .../pay/cs_test_ab_cd survives byte for byte. Money, times and BK- refs carry
 * no markdown characters and pass through untouched.
 */
export function plainText(text) {
  const urls = [];
  const keep = (url) => `\u0000${urls.push(url) - 1}\u0000`;

  let out = text
    // [label](url) -> label: url
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => `${label}: ${keep(url)}`)
    .replace(/https?:\/\/[^\s<>"')\]]*[^\s<>"')\].,;:!?]/g, keep);

  const isSeparator = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
  const lines = out.split('\n');
  out = lines
    // A table's header row (the line above |---|) and the separator itself carry no facts.
    .filter((line, i) => !isSeparator(line) && !(isSeparator(lines[i + 1] ?? '') && line.includes('|')))
    .map((line) => {
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim()).filter(Boolean);
        line = cells.length === 2 ? `${cells[0]}: ${cells[1]}` : cells.join(', ');
      }
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*>\s?/, '')
        .replace(/^\s*[-*+•]\s+/, '');
    })
    .join('\n');

  out = out
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`\n]*)`/g, '$1')
    .replace(/[*`]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)]);
}

/** By id, or by exact name in case the model wrote the name. Always a real listing object. */
function lookup(seen, key) {
  if (seen[key]) return seen[key];
  const k = key.toLowerCase();
  return Object.values(seen).find((l) => l?.id?.toLowerCase() === k || l?.name?.toLowerCase() === k) ?? null;
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
  const ids = [];
  const re = new RegExp(`^[\\s*_\`]*${tag}[*_\`]*\\s*:(.*)$`, 'gim');
  for (const match of text.matchAll(re)) {
    for (const piece of match[1].split(',')) {
      const id = piece.replace(/[*`"'[\]]/g, '').trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}
