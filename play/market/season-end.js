// The end of a season on the market page: how many blocks the live season has left, which season is queued next, and
// the result of the season the player just left, with the orders still resting when it ended. Pure functions, no DOM,
// so tests/sdk/market-season-end.test.mjs can run them.
//
// Time is given in blocks only. Blocks come irregularly on this chain (every few hundred ms while there is traffic,
// one a minute when idle), and the page reads only the head's time, so it has no honest way to turn blocks into time.
//
// What the chain does at the end (crates/dg-market/src/market.rs): `place` and `join_season` are refused once the
// height is past `end_height`, but `cancel` is not. An order still resting then stays on the book with its escrow until
// its owner cancels it, and the season view goes on counting it in the owner's value (a buy's locked GOLD, a sell's
// unsold DIVI), so a cancel after the end moves it back to the balance without changing the result.

import { liveSeason, nextSeason, pairOf, unitsText, priceText } from './market.js';
import { standing, holdings } from './standing.js';

/**
 * The last stretch: this many blocks before the end. It is the lead with which `divi-gamechain season-roll` queues the
 * next season (`DEFAULT_LEAD` in bins/divi-gamechain/src/season.rs), about a day at the idle rate of a block a minute.
 */
export const NEAR_BLOCKS = 1440;

const num = (/** @type {any} */ v) => Number(v);
const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @typedef {{live: any, left: number|null, near: boolean, next: any}} Clock
 */

/**
 * The live season and its blocks left at head `height`, and the season queued next. Blocks left are the blocks an order
 * sent now can still land in: the chain runs a transaction in a block after the head, and trades up to `end_height`
 * included, so it is `end - height` (heights height+1 to end). At the end block itself that is 0.
 * @param {any[]} seasons the `seasons` of `view=seasons` @param {number} height the chain head
 * @returns {Clock}
 */
export function seasonClock(seasons, height) {
  const live = liveSeason(seasons, height);
  const left = live ? Math.max(0, num(live.end_height) - height) : null;
  return { live, left, near: left != null && left <= NEAR_BLOCKS, next: nextSeason(seasons, height) };
}

/**
 * The season card's time line: blocks left (and, in the last stretch, what that means for a resting order), then the
 * season that opens next. Empty when nothing is live or queued.
 * @param {Clock} c
 */
export function clockText(c) {
  const parts = [];
  if (c.live && c.left != null) {
    const end = num(c.live.end_height);
    if (c.left === 0) parts.push(`Trading has closed: block ${end} was the last one an order could land in. An order still resting can no longer fill; cancel it to get back what it holds.`);
    else if (c.near) parts.push(`Last stretch: ${plural(c.left, 'block')} left, trading ends after block ${end}. An order still resting at the end can no longer fill.`);
    else parts.push(`${plural(c.left, 'block')} left: trading ends after block ${end}.`);
  }
  if (c.next) parts.push(`Season ${c.next.season} opens at block ${c.next.start_height}.`);
  return parts.join(' ');
}

/**
 * The seasons that have ended at `height` (their end block is below it), the newest end first.
 * @param {any[]} seasons @param {number} height
 */
export function endedSeasons(seasons, height) {
  return (Array.isArray(seasons) ? seasons : [])
    .filter((s) => [s?.season, s?.start_height, s?.end_height].every((v) => Number.isSafeInteger(num(v))) && num(s.end_height) < height)
    .sort((a, b) => num(b.end_height) - num(a.end_height) || num(b.season) - num(a.season));
}

/**
 * @typedef {{season: any, standing: import('./standing.js').Standing, resting: any[]}} Result
 */

/**
 * The season you just left: the newest season that ended at `height` and that `me` joined, with your result in it by
 * the rules of `standing()`, and your orders in its pair that are still open (they were resting when it ended).
 * Walks the ended seasons newest first through `views`, the `view=season&n=` replies read so far: `{need: n}` asks for
 * the next one to look at, `{result}` is the answer, and null means you joined none of them (or, for a member below the
 * top 100, that the page has not read its own balances yet).
 * @param {any[]} seasons @param {number} height @param {Map<number, any>} views @param {string} me
 * @param {{balances: Record<string, string|bigint>, orders: any[]}} [own] this address's balances by token and all its open orders
 * @returns {{need: number} | {result: Result} | null}
 */
export function justLeft(seasons, height, views, me, own) {
  if (!me) return null;
  for (const s of endedSeasons(seasons, height)) {
    const n = num(s.season);
    const v = views.get(n);
    if (!v) return { need: n };
    const { base, quote } = pairOf(v.season ?? s);
    const resting = (own?.orders ?? []).filter((o) => o.base === base && o.quote === quote);
    const mine = own ? { gold: BigInt(own.balances?.[quote] ?? 0), divi: BigInt(own.balances?.[base] ?? 0), orders: resting } : undefined;
    const st = standing(v, me, mine);
    if (st) return { result: { season: v.season ?? s, standing: st, resting } };
    // Below the top 100 a member is told apart by what it holds: until the page has read that, wait rather than look further back.
    if (!own && num(v.members) > (Array.isArray(v.leaderboard) ? v.leaderboard.length : 0)) return null;
  }
  return null;
}

/**
 * "Season 1 ended at block 26633: you finished #3 of 12 members · 2500.5 S1GOLD · +250.5 S1GOLD since joining (…)."
 * @param {Result} r @param {{base: string, quote: string, goldDecimals: number}} f the ended season's pair and decimals
 */
export function resultText(r, { base, quote, goldDecimals }) {
  const s = r.standing;
  const gold = (/** @type {bigint} */ u) => `${unitsText(u < 0n ? -u : u, goldDecimals)} ${quote}`;
  const of = plural(s.members, 'member');
  const where = s.rank == null ? `outside the top 100 of ${of}` : `#${s.rank} of ${of}`;
  const sign = s.change > 0n ? '+' : s.change < 0n ? '−' : '±';
  const how = s.marked && s.mark != null ? `marked at ${priceText(s.mark, goldDecimals)} ${quote} per ${base}` : 'no trade all season, so this is GOLD only';
  return `Season ${r.season.season} ended at block ${r.season.end_height}: you finished ${where} · ${gold(s.value)} · ${sign}${gold(s.change)} since joining (${how}).`;
}

/**
 * What became of the orders still resting when the season ended; empty when there were none.
 * @param {{season: any, resting: any[]}} r @param {{base: string, quote: string, goldDecimals: number, diviDecimals: number}} f
 */
export function restingText(r, { base, quote, goldDecimals, diviDecimals }) {
  const n = r.resting.length;
  if (!n) return '';
  const held = holdings(0n, 0n, r.resting, base, quote);
  const what = [
    held.gold > 0n ? `${unitsText(held.gold, goldDecimals)} ${quote}` : '',
    held.divi > 0n ? `${unitsText(held.divi, diviDecimals)} ${base}` : '',
  ].filter(Boolean).join(' and ');
  const [orders, it] = n === 1 ? ['Your order', 'it'] : [`Your ${n} orders`, 'them'];
  return `${orders} still resting when season ${r.season.season} ended can no longer fill. The chain keeps ${it} on the book, holding ${what}, until you cancel ${it}; cancelling returns that to you. It counts in your final value either way.`;
}
