/**
 * Behaviour evals: scripted conversations against the running agent, one per
 * edge case, with assertions on the reply and on the team's bookings.
 *
 *   node tests/behavior_evals/run.js              the elderly-user demo only
 *   node tests/behavior_evals/run.js --all        every scenario
 *   node tests/behavior_evals/run.js id1,id2      just those scenarios
 *   node tests/behavior_evals/run.js --list       list scenario ids
 *   node tests/behavior_evals/run.js --offline    parts.js checks only, no model calls
 *
 * Unlike `npm test` this NEVER resets the sandbox: it reads the team's booking
 * count before and after each turn and checks the difference, so a teammate's
 * hand-made bookings survive. Bookings it makes land on a random late-autumn
 * date so repeated runs do not collide with each other.
 *
 * Every turn costs the shared model quota (about 2 to 4 requests). The demo is
 * 5 turns; --all is about 50. Space --all runs across 5-minute windows.
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scenarios, DEMO_ID } from './scenarios.js';
import { runOfflineChecks } from './offline.js';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
loadDotEnv(join(ROOT, '.env'));

const SANDBOX_URL = (process.env.PLEC_SANDBOX_URL || 'https://api.plec.ai/hackathon/sandbox').replace(/\/+$/, '');
const KEY = process.env.PLEC_SANDBOX_KEY || '';
const AGENT_URL = (process.env.AGENT_URL || `http://localhost:${process.env.AGENT_PORT || 8787}`).replace(/\/+$/, '');
const TURN_TIMEOUT_MS = 45_000;

const tty = process.stdout.isTTY;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = paint(32), red = paint(31), dim = paint(2), bold = paint(1), yellow = paint(33);

async function main() {
  const arg = process.argv[2] ?? '';

  if (arg === '--list') {
    for (const s of scenarios(sampleDates())) console.log(`${s.id.padEnd(22)} item ${String(s.item).padEnd(6)} ${s.title}`);
    return;
  }

  if (arg === '--offline') {
    const ok = runOfflineChecks();
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (!KEY) fail('PLEC_SANDBOX_KEY is missing from .env.');
  await assertAgentUp();

  const dates = sampleDates();
  const all = scenarios(dates);
  const wanted = arg === '--all' ? all : arg ? all.filter((s) => arg.split(',').includes(s.id)) : all.filter((s) => s.id === DEMO_ID);
  if (wanted.length === 0) fail(`No scenario matches "${arg}". Try --list.`);

  console.log(bold('PLEC behaviour evals'));
  console.log(dim(`agent ${AGENT_URL}   booking date for this run: ${dates.a.long} (${dates.a.iso})\n`));

  const summary = [];
  for (const scenario of wanted) summary.push(await runScenario(scenario));

  console.log(bold('\nChecklist'));
  for (const s of summary) {
    const mark = s.passed === s.total ? green('PASS') : red('FAIL');
    console.log(`  ${mark}  ${s.id.padEnd(22)} ${s.passed}/${s.total}  ${dim(s.title)}`);
  }
  const passed = summary.reduce((n, s) => n + s.passed, 0);
  const total = summary.reduce((n, s) => n + s.total, 0);
  console.log(bold(`\n${passed} of ${total} checks passed`));
  process.exitCode = passed === total ? 0 : 1;
}

async function runScenario(scenario) {
  console.log(bold(`${scenario.id}  (item ${scenario.item})  ${scenario.title}`));
  const sessionId = randomUUID();
  let passed = 0;
  let total = 0;

  for (const turn of scenario.turns) {
    const before = await bookingCount();
    const started = Date.now();
    const parts = await send(sessionId, turn.user);
    const ms = Date.now() - started;
    const after = await bookingCount();

    const reply = flatten(parts);
    console.log(`   > ${turn.user}`);
    console.log(`   < ${oneLine(textOf(parts))} ${dim(`${(ms / 1000).toFixed(1)}s`)}`);
    for (const p of parts ?? []) {
      if (p.kind === 'card') console.log(dim(`     [card: ${p.title}]`));
      if (p.kind === 'image') console.log(dim(`     [image: ${p.caption ?? p.url}]`));
      if (p.kind === 'link') console.log(dim(`     [link: ${p.label}]`));
    }

    const ctx = { parts, reply, text: textOf(parts), delta: after - before, ms };
    for (const check of turn.expect) {
      total += 1;
      let ok = false;
      let detail = '';
      try {
        const result = check.test(ctx);
        ok = result === true || result?.ok === true;
        detail = result?.detail ?? '';
      } catch (err) {
        detail = String(err?.message ?? err);
      }
      if (ok) passed += 1;
      console.log(`     ${ok ? green('PASS') : red('FAIL')}  ${check.label}${detail ? dim(`  ${detail}`) : ''}`);
    }
  }
  console.log(`   ${passed === total ? green(`${passed} of ${total}`) : yellow(`${passed} of ${total}`)} checks passed\n`);
  return { id: scenario.id, title: scenario.title, passed, total };
}

async function send(sessionId, text) {
  try {
    const res = await fetch(`${AGENT_URL}/agent/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, text }),
      signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
    });
    const body = await res.json();
    return Array.isArray(body?.parts) ? body.parts : [];
  } catch (err) {
    return [{ kind: 'text', text: `(no reply: ${err.message})` }];
  }
}

async function bookingCount() {
  const res = await fetch(`${SANDBOX_URL}/bookings`, { headers: { Authorization: `Bearer ${KEY}` } });
  if (!res.ok) return NaN;
  const body = await res.json();
  return (body.bookings ?? []).filter((b) => b.status !== 'cancelled').length;
}

async function assertAgentUp() {
  try {
    await fetch(AGENT_URL, { signal: AbortSignal.timeout(3000) });
  } catch {
    fail(`The agent is not answering at ${AGENT_URL}. Start it with npm start.`);
  }
}

/**
 * Two random dates between November 2 and December 18, 2026, avoiding
 * Thanksgiving (every listing's blackout) and Mondays/Tuesdays (a few
 * listings close then). One run's bookings rarely collide with another's.
 */
function sampleDates() {
  const start = Date.UTC(2026, 10, 2);
  const pick = (exclude) => {
    for (;;) {
      const d = new Date(start + Math.floor(Math.random() * 46) * 86_400_000);
      const iso = d.toISOString().slice(0, 10);
      const dow = d.getUTCDay();
      if (iso === '2026-11-26' || dow === 1 || dow === 2 || iso === exclude) continue;
      return describe(d);
    }
  };
  const a = pick();
  return { a, b: pick(a.iso), nextFriday: describe(nextWeekday(5)) };
}

function nextWeekday(target) {
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let d = today + 86_400_000;
  while (new Date(d).getUTCDay() !== target) d += 86_400_000;
  // "next Friday" said on a Monday usually means this week's; the check accepts either.
  return new Date(d);
}

function describe(d) {
  const weekday = d.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const month = d.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const day = d.getUTCDate();
  return { iso: d.toISOString().slice(0, 10), weekday, month, day, long: `${month} ${day}`, full: `${weekday}, ${month} ${day}` };
}

const textOf = (parts) => (parts ?? []).filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
const flatten = (parts) =>
  (parts ?? [])
    .map((p) => [p.text, p.title, p.subtitle, p.label, p.caption].filter(Boolean).join(' '))
    .join('\n');
const oneLine = (s) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > 220 ? `${flat.slice(0, 217)}...` : flat;
};

function fail(message) {
  console.error(red(message));
  process.exit(2);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
