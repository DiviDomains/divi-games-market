// Where the player stands in the season, and which of their resting orders filled: the market page's "Your standing"
// line, its fills list, its tab title and the "Tell me when an order fills" notification. Pure functions, no DOM, so
// tests/sdk/market-standing.test.mjs can run them. Also what the order form says once an order is in a block.
//
// Value is the chain's rule (`season_view` in crates/dg-market/src/market.rs): GOLD plus DIVI marked at the last trade
// price, open orders in the pair included. Fills are read from the trades the page already fetches: a trade whose
// maker is this address is one of its resting orders filling. A cancel leaves no trade, so it is never a fill.

import { notional, unitsText, priceText, DIVI_DECIMALS, PRICE_SCALE } from './market.js';

export { notifyPlan } from '../notify.js';

export const BASE_TITLE = 'Season market · DiviGames';
/** How many looks an order that left the book stays watched, in case its trade shows a look later than the orders. */
const WATCH_LOOKS = 3;

const big = (/** @type {any} */ v) => BigInt(v ?? 0);

/**
 * GOLD plus DIVI marked at `mark`, rounded down like `quote_for`; GOLD only while there is no trade (`mark` null).
 * @param {bigint|string} gold @param {bigint|string} divi @param {bigint|string|null|undefined} mark
 */
export function markedValue(gold, divi, mark) {
  return big(gold) + (mark == null ? 0n : notional(big(divi), big(mark), DIVI_DECIMALS));
}

/**
 * What an address holds in the pair, open orders included as the chain counts them: a buy adds the GOLD it locks, a
 * sell the DIVI not yet sold.
 * @param {bigint} gold @param {bigint} divi @param {any[]} orders @param {string} base @param {string} quote
 */
export function holdings(gold, divi, orders, base, quote) {
  let [g, d] = [big(gold), big(divi)];
  for (const o of orders ?? []) {
    if (o.base !== base || o.quote !== quote) continue;
    if (o.side === 'buy') g += big(o.locked);
    else if (o.side === 'sell') d += big(o.remaining);
  }
  return { gold: g, divi: d };
}

/**
 * @typedef {{rank: number|null, members: number, value: bigint, start: bigint, change: bigint, marked: boolean,
 *   mark: bigint|null, source: 'view'|'page'}} Standing
 */

/**
 * Where `me` stands in the season view `v` (`?view=season&n=`): rank of members, marked value, and the start value
 * (`start_gold` plus `start_divi` marked at the same price). The view ranks the top 100 only; a member below that has
 * no rank, and is valued from `own`, the balances and open orders the page read for itself. Null when not a member.
 * @param {any} v @param {string} me
 * @param {{gold: bigint, divi: bigint, orders: any[]}} [own]
 * @returns {Standing|null}
 */
export function standing(v, me, own) {
  if (!v || !me || !v.season) return null;
  const board = Array.isArray(v.leaderboard) ? v.leaderboard : [];
  const members = Number(v.members ?? board.length);
  const mark = v.mark_price == null ? null : big(v.mark_price);
  const start = markedValue(v.season.start_gold, v.season.start_divi, mark);
  const out = (/** @type {number|null} */ rank, /** @type {bigint} */ value, /** @type {'view'|'page'} */ source) =>
    ({ rank, members, value, start, change: value - start, marked: mark != null, mark, source });
  const row = board.find((r) => r?.address === me);
  if (row) return out(Number(row.rank), big(row.value), 'view');
  // Not in the top 100. Only a member can be below it, and a member who never traded still holds the season's tokens.
  if (!own || members <= board.length) return null;
  const pair = v.pair ?? { base: v.season.divi, quote: v.season.gold };
  const h = holdings(own.gold, own.divi, own.orders, pair.base, pair.quote);
  if (h.gold === 0n && h.divi === 0n) return null;
  return out(null, markedValue(h.gold, h.divi, mark), 'page');
}

/**
 * The "Your standing" line.
 * @param {Standing} s @param {{base: string, quote: string, goldDecimals: number, diviDecimals?: number}} f
 */
export function standingText(s, { base, quote, goldDecimals }) {
  const gold = (/** @type {bigint} */ u) => `${unitsText(u < 0n ? -u : u, goldDecimals)} ${quote}`;
  const of = `${s.members} member${s.members === 1 ? '' : 's'}`;
  const where = s.rank == null ? `outside the top 100 of ${of}` : `#${s.rank} of ${of}`;
  const sign = s.change > 0n ? '+' : s.change < 0n ? '−' : '±';
  const how = s.marked && s.mark != null
    ? `marked at ${priceText(s.mark, goldDecimals)} ${quote} per ${base}`
    : `no trade yet, so this is GOLD only: ${base} is not counted until it has a price`;
  return `Your standing: ${where} · ${gold(s.value)} · ${sign}${gold(s.change)} since joining (${how}).`;
}

// ---------- fills ----------

/**
 * @typedef {{order: string, side: string, price: bigint, amount: bigint, gold: bigint, left: bigint, full: boolean,
 *   open: boolean, seq: number, height: number}} Fill
 * @typedef {{seq: number, orders: Map<string, {order: any, gone: number}>}} Watch
 */

/**
 * One look at the market: which of `me`'s resting orders filled since the previous look `prev`. A fill is a trade
 * newer than the last one seen (`seq`) with `me` as the maker; trades where `me` took liquidity are their own orders
 * going in. The trades of one order in one look add up to one fill. The first look (`prev` null) is never news.
 * @param {Watch|null|undefined} prev
 * @param {{orders: any[], trades: any[], me: string}} now the open orders in the pair, the trades (newest first)
 * @returns {{next: Watch, fills: Fill[]}}
 */
export function trackFills(prev, { orders, trades, me }) {
  const list = Array.isArray(trades) ? trades : [];
  const top = list.reduce((m, t) => Math.max(m, Number(t?.seq ?? -1)), prev ? prev.seq : -1);
  /** @type {Watch['orders']} */
  const watch = new Map();
  for (const [id, w] of prev?.orders ?? []) if (w.gone + 1 < WATCH_LOOKS) watch.set(id, { order: w.order, gone: w.gone + 1 });
  const after = new Map((orders ?? []).map((o) => [o.id, o]));
  for (const o of orders ?? []) watch.set(o.id, { order: o, gone: 0 });
  const next = { seq: top, orders: watch };
  if (!prev) return { next, fills: [] };

  /** @type {Map<string, Fill>} */
  const fills = new Map();
  for (const t of [...list].reverse()) {
    if (Number(t?.seq) <= prev.seq || t.maker !== me) continue;
    const id = String(t.maker_order);
    const f = fills.get(id) ?? {
      order: id, side: prev.orders.get(id)?.order.side ?? (t.taker_side === 'buy' ? 'sell' : 'buy'), price: big(t.price),
      amount: 0n, gold: 0n, left: 0n, full: false, open: false, seq: 0, height: 0,
    };
    f.amount += big(t.amount);
    f.gold += big(t.quote_amount);
    f.seq = Math.max(f.seq, Number(t.seq));
    f.height = Math.max(f.height, Number(t.height ?? 0));
    fills.set(id, f);
  }
  for (const f of fills.values()) {
    const before = prev.orders.get(f.order)?.order;
    const now = after.get(f.order);
    // What is left: what the last look saw less these trades, or what the orders say now if they are further on.
    let left = before ? big(before.remaining) - f.amount : now ? big(now.remaining) : 0n;
    if (now && big(now.remaining) < left) left = big(now.remaining);
    if (left < 0n) left = 0n;
    Object.assign(f, { left, full: left === 0n, open: Boolean(now) && left > 0n });
  }
  return { next, fills: [...fills.values()] };
}

/**
 * What the tab title and a notification say about `fills` from one look; the base title when there are none.
 * @param {Fill[]} fills @param {{base: string, quote: string, goldDecimals: number, diviDecimals: number}} f
 */
export function fillAlert(fills, f) {
  if (!fills.length) return { title: BASE_TITLE, text: '' };
  const allFull = fills.every((x) => x.full);
  const lead = fills.length === 1
    ? (allFull ? '✓ Order filled' : '◐ Order partly filled')
    : (allFull ? `✓ ${fills.length} orders filled` : `◐ ${fills.length} orders filled, some partly`);
  return { title: `${lead} · Market`, text: fills.map((x) => fillText(x, f)).join(' ') };
}

/** One fill in words: "Your buy filled: 2 S1DIVI at 1.25 S1GOLD, for 2.5 S1GOLD." @param {Fill} x @param {any} f */
export function fillText(x, { base, quote, goldDecimals, diviDecimals }) {
  const d = (/** @type {bigint} */ u) => `${unitsText(u, diviDecimals)} ${base}`;
  const what = `${d(x.amount)} at ${priceText(x.price, goldDecimals)} ${quote}, for ${unitsText(x.gold, goldDecimals)} ${quote}`;
  if (x.full) return `Your ${x.side} filled: ${what}.`;
  return `Your ${x.side} partly filled: ${what}; ${x.open ? `${d(x.left)} still open` : 'the rest is no longer on the book'}.`;
}

/**
 * Whether a look's fills are worth a notification: some fill is newer than what the previous look `prev` had seen.
 * The first look (`prev` missing) never is, and fills already told are not again.
 * @param {Watch|null|undefined} prev @param {{seq: number}[]} fills
 */
export function shouldNotify(prev, fills) {
  if (!prev) return false;
  return fills.some((f) => f.seq > prev.seq);
}

// ---------- the order just placed ----------

/** The most trades one order may make in a block: `MAX_FILLS` in crates/dg-market/src/market.rs. */
const MAX_FILLS = 50;
const WHY_CLOSED = /** @type {Record<string, string>} */ ({ fill_limit: `one order trades at most ${MAX_FILLS} times`, dust: 'too little was left to price' });

/**
 * What the order form says once a place is in a block, from its receipt `r`: filled, partly filled with the rest on
 * the book (or returned), or placed and resting. The chain names its events after the module (`market.trade`,
 * crates/dg-chain/src/exec.rs `emit`); the bare kind is read too. Only this order's events count: the receipt also
 * closes the resting orders it took.
 * @param {{txid: string, events?: {kind: string, data: any}[]}} r
 * @param {{base: string, quote: string, goldDecimals: number, diviDecimals: number}} f
 * @returns {{text: string, traded: boolean, full: boolean}}
 */
export function placedText(r, { base, quote, goldDecimals, diviDecimals }) {
  const id = String(r?.txid ?? '').slice(0, 16);
  const events = Array.isArray(r?.events) ? r.events : [];
  const of = (/** @type {string} */ kind) => events.filter((e) => (e?.kind === `market.${kind}` || e?.kind === kind) && e.data);
  const placed = of('order_placed').find((e) => e.data.id === id)?.data;
  const trades = of('trade').map((e) => e.data).filter((t) => t.taker_order == null || t.taker_order === id);
  const closed = of('order_closed').find((e) => e.data.id === id)?.data;
  if (!trades.length) return { text: `Order ${id} placed; it rests on the book until it fills or you cancel it.`, traded: false, full: false };

  const d = (/** @type {bigint} */ u) => `${unitsText(u, diviDecimals)} ${base}`;
  const amount = trades.reduce((s, t) => s + big(t.amount), 0n);
  const gold = trades.reduce((s, t) => s + big(t.quote_amount), 0n);
  const prices = new Set(trades.map((t) => String(t.price)));
  // One price: that price. Several: GOLD paid per whole DIVI, rounded down to the price's own precision.
  const price = prices.size === 1
    ? `at ${priceText(String(trades[0].price), goldDecimals)} ${quote}`
    : `at an average of ${priceText((gold * 10n ** BigInt(diviDecimals) * PRICE_SCALE) / amount, goldDecimals)} ${quote}`;
  const count = trades.length > 1 ? ` (${trades.length} trades)` : '';
  const side = placed?.side ?? trades[0].taker_side;
  const what = `you ${side === 'sell' ? 'sold' : 'bought'} ${d(amount)} ${price}${count}, for ${unitsText(gold, goldDecimals)} ${quote}`;
  const left = closed ? big(closed.remaining) : placed ? big(placed.amount) - amount : 0n;
  if (left <= 0n) return { text: `Order ${id} filled: ${what}.`, traded: true, full: true };
  const rest = closed
    ? `the other ${d(left)} did not rest (${WHY_CLOSED[closed.reason] ?? closed.reason}), and what it held came back to you`
    : `the other ${d(left)} rests on the book`;
  return { text: `Order ${id} partly filled: ${what}; ${rest}.`, traded: true, full: false };
}
