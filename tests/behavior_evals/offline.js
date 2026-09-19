/**
 * parts.js checks that need no model and no sandbox: markdown stripping keeps
 * URLs, money and references intact, cards only come from seen listings, and
 * sensitive numbers are never echoed. Run with --offline.
 */

import { toParts, cardFor, dollars, plainText } from '../../agent/parts.js';
import { systemPrompt } from '../../agent/prompt.js';

const PAY = 'https://api.plec.ai/hackathon/sandbox/pay/cs_test_ab_cd_ef__gh';
const seen = {
  'foundry-fishtown': {
    id: 'foundry-fishtown',
    name: 'The Foundry at Fishtown',
    category: 'loft',
    neighborhood: 'Fishtown',
    capacity: { min: 40, max: 150 },
    pricing: { model: 'hourly', rateCents: 30000 },
    photoUrls: ['https://picsum.photos/seed/foundry-fishtown-1/800/500', 'https://picsum.photos/seed/foundry-fishtown-2/800/500'],
    mapUrl: 'https://www.google.com/maps/search/?api=1&query=1400%20N%20Front%20St',
  },
  'no-photos': { id: 'no-photos', name: 'Bare Room', photoUrls: [] },
};
const session = { state: { seen } };
const textOf = (parts) => parts.find((p) => p.kind === 'text').text;

const cases = [
  ['Pipe table folds into plain lines', () => {
    const t = textOf(toParts('Quote:\n\n| Item | Amount |\n|---|---|\n| 5 hours @ $300/hour | $1,500.00 |\n| **Total** | **$1,815.00** |', session));
    return !/[|*]/.test(t) && t.includes('Total: $1,815.00') && !t.includes('Item');
  }],
  ['Payment URL survives byte for byte', () => textOf(toParts(`**Booked!** Pay here: ${PAY}\n\nThanks.`, session)).includes(`Pay here: ${PAY}\n`)],
  ['URL at the end of a sentence keeps its full stop outside', () => plainText(`Link: ${PAY}.`) === `Link: ${PAY}.`],
  ['Money, BK- reference and times intact', () => {
    const t = plainText('🎉 **BK-1001** is set for 6:00pm, **$1,815.00** all in ✅');
    return t === 'BK-1001 is set for 6:00pm, $1,815.00 all in';
  }],
  ['Underscores inside words are not italics', () => plainText('snake_case_word stays') === 'snake_case_word stays'],
  ['Bullets and headings removed, numbered choices kept', () => plainText('## Options\n- one\n* two\n1. First\n2. Second') === 'Options\none\ntwo\n1. First\n2. Second'],
  ['Card and SSN numbers are masked', () => {
    const t = plainText('Card 4111 1111 1111 1111, SSN 123-45-6789, total $1,815.00');
    return !t.includes('4111') && !t.includes('6789') && t.includes('$1,815.00');
  }],
  ['Tag lines removed from text, even in bold', () => textOf(toParts('Here you go.\n**CARDS:** foundry-fishtown', session)) === 'Here you go.'],
  ['Cards only from seen listings, exact name, deduped by id and name', () => {
    const cards = toParts('x\nCARDS: foundry-fishtown, made-up-venue\ncards: The Foundry at Fishtown', session).filter((p) => p.kind === 'card');
    return cards.length === 1 && cards[0].title === 'The Foundry at Fishtown' && Array.isArray(cards[0].photoUrls);
  }],
  ['At most three cards', () => {
    const many = { state: { seen: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map((id) => [id, { id, name: `Venue ${id}`, photoUrls: [] }])) } };
    return toParts('x\nCARDS: a, b, c, d, e', many).filter((p) => p.kind === 'card').length === 3;
  }],
  ['PHOTOS gives image parts; no photos falls back to a card', () => {
    const parts = toParts('x\nPHOTOS: foundry-fishtown, no-photos', session);
    return parts.filter((p) => p.kind === 'image').length === 2 && parts.some((p) => p.kind === 'card' && p.title === 'Bare Room');
  }],
  ['MAP gives a link to mapUrl', () => toParts('x\nMAP: foundry-fishtown', session).some((p) => p.kind === 'link' && p.url === seen['foundry-fishtown'].mapUrl)],
  ['Empty model text still yields a text part', () => textOf(toParts('', session)).length > 0],
  ['dollars() and card url', () => dollars(181500) === '$1,815.00' && cardFor(seen['foundry-fishtown']).url === seen['foundry-fishtown'].mapUrl],
  ['Prompt restates reservations made this conversation', () =>
    systemPrompt({ state: { bookings: { 'BK-1001': { ref: 'BK-1001', listingName: 'The Foundry at Fishtown', date: '2026-10-10', startTime: '18:00', endTime: '23:00', guestCount: 40, status: 'pending_payment' } } } }).includes('BK-1001: The Foundry at Fishtown')],
  ['Prompt calendar has the right weekday for October 10, 2026', () => systemPrompt({ state: {} }).includes('2026-10-10 Sat')],
];

export function runOfflineChecks() {
  let passed = 0;
  for (const [label, fn] of cases) {
    let ok = false;
    try {
      ok = fn() === true;
    } catch (err) {
      console.log(`  error: ${err.message}`);
    }
    if (ok) passed += 1;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }
  console.log(`\n${passed} of ${cases.length} offline checks passed`);
  return passed === cases.length;
}
