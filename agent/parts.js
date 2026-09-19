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
const TAG_LINE = /^[\s*_`]*(CARDS|PHOTOS|MAP|BOOKING)[*_`]*\s*:.*$/gim;

/** Two or three options, then "show more": more than this overwhelms. */
const MAX_CARDS = 3;

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
  const bookingRefs = idsFrom(raw, 'BOOKING');
  const clean = dropInventedAddresses(plainText(raw.replace(TAG_LINE, '')), seen);

  // The contract requires at least one text part on every turn.
  const parts = [{ kind: 'text', text: clean || 'Sorry, could you say that again?' }];

  for (const ref of bookingRefs) parts.push(...bookingParts(ref, session?.state));

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

  // Never echo a card number or Social Security number back, even if the user typed one.
  out = out
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[removed]')
    .replace(/\b\d(?:[ -]?\d){12,18}\b/g, '[removed]');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => urls[Number(i)]);
}

/**
 * A street address in the reply must be one a tool returned. Search hits carry
 * no address, and when the model has none it writes a plausible fake one
 * ("1101 Frankford Avenue") with total confidence. A match is the street number
 * plus the first word of the street name found in some seen listing's address.
 * An unmatched address takes its whole sentence with it.
 */
const STREET = /\b\d{1,5}\s+(?:(?:N|S|E|W|North|South|East|West)\.?\s+)?([A-Z0-9][\w'-]*)(?:\s+[A-Z][\w'-]*){0,2}\s+(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Pl|Place|Pike|Ct|Court|Pkwy|Parkway|Sq|Square|Row|Terrace)\b/g;
const NO_ADDRESS = "I don't have the street address in front of me, but I can look it up if you'd like.";

export function dropInventedAddresses(text, seen) {
  const known = Object.values(seen ?? {}).map((l) => String(l?.address ?? '').toLowerCase()).filter(Boolean);
  const isKnown = (match, word) => {
    const num = match.match(/\d+/)[0];
    return known.some((a) => new RegExp(`\\b${num}\\b`).test(a) && a.includes(word.toLowerCase()));
  };

  let out = text;
  for (const m of [...text.matchAll(STREET)]) {
    if (isKnown(m[0], m[1])) continue;
    const at = out.indexOf(m[0]);
    if (at < 0) continue;
    const before = out.slice(0, at);
    const start = Math.max(before.search(/(?<=^|[.!?\n]\s*)[^.!?\n\s][^.!?\n]*$/), 0);
    const rest = out.slice(at);
    const endRel = rest.search(/[.!?](\s|$)|\n/);
    const end = endRel < 0 ? out.length : at + endRel + (rest[endRel] === '\n' ? 0 : 1);
    out = `${out.slice(0, start)}${NO_ADDRESS}${out.slice(end)}`;
  }
  return out;
}

/** By id, or by exact name in case the model wrote the name. Always a real listing object. */
function lookup(seen, key) {
  if (seen[key]) return seen[key];
  const k = key.toLowerCase();
  return Object.values(seen).find((l) => l?.id?.toLowerCase() === k || l?.name?.toLowerCase() === k) ?? null;
}

/** Booking statuses in words a guest understands. Anything else is shown as-is. */
const STATUS_WORDS = {
  pending_payment: 'waiting for payment',
  requested: 'waiting for the host to approve',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
};

/**
 * A reservation as a card, built only from the booking object a tool returned
 * (the loop keeps each one in state.bookings, refreshed by get_booking, cancel
 * and reschedule). The title is the listing's exact name so cardsOnlyFrom still
 * holds; every subtitle fact is a field of that booking. No booking, no card.
 */
function bookingParts(ref, state) {
  const bookings = state?.bookings ?? {};
  const booking = bookings[ref] ?? Object.values(bookings).find((b) => b?.ref?.toLowerCase() === String(ref).toLowerCase());
  if (!booking) return [];

  const listing = state?.seen?.[booking.listingId];
  const title = booking.listingName ?? listing?.name;
  if (!title) return [];

  const subtitle = [
    booking.ref,
    booking.date ? longDate(booking.date) : null,
    booking.startTime && booking.endTime ? `${clock(booking.startTime)} to ${clock(booking.endTime)}` : null,
    Number.isFinite(booking.guestCount) ? `${booking.guestCount} people` : null,
    Number.isFinite(booking.totalCents) ? dollars(booking.totalCents) : null,
    booking.status ? STATUS_WORDS[booking.status] ?? booking.status : null,
  ]
    .filter(Boolean)
    .join(', ');

  const card = { kind: 'card', title, subtitle, photoUrls: listing?.photoUrls ?? [] };
  if (listing?.mapUrl) card.url = listing.mapUrl;
  const parts = [card];

  if (booking.status === 'pending_payment' && booking.payment?.url && booking.payment.status !== 'paid') {
    parts.push({ kind: 'link', label: `Pay for ${booking.ref}`, url: booking.payment.url });
  }
  return parts;
}

/** 2026-11-25 -> Wednesday, November 25 */
function longDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** 18:00 -> 6:00pm, 09:30 -> 9:30am */
function clock(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]}${h < 12 ? 'am' : 'pm'}`;
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
