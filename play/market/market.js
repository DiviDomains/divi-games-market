// The season market's rules, without the page: which season is live, whether you may join it, and how a price
// and an amount typed in whole tokens become the units the chain reads (ARCHITECTURE §6.1). No DOM and no Node
// imports, so the page, its tests and the end-to-end script all use this one copy.

/** Prices are quote base units per whole base token, times 10^8 (`PRICE_SCALE` in crates/dg-market). */
export const PRICE_SCALE = 100_000_000n;
/**
 * The wire scale as decimal places: PRICE_SCALE is 10^PRICE_DECIMALS. A price's tick on the chain is one wire unit,
 * 10^-(PRICE_DECIMALS + quote decimals) whole quote tokens, so a price is shown and typed to that many places.
 */
export const PRICE_DECIMALS = 8;
export const MAX_PRICE = 18446744073709551615n;
/** Season tokens: S<n>GOLD has 2 decimals, S<n>DIVI 8, unless /v1/tokens says otherwise. */
export const GOLD_DECIMALS = 2;
export const DIVI_DECIMALS = 8;

/**
 * The live season: the newest whose height range holds `height`, both ends included. Null when none is.
 * The same rule as `live_season` in bins/divi-games-site/src/pages.rs and `latest_live` in bots/rust/src/bot.rs.
 * @param {any[]} seasons the `seasons` of `view=seasons` @param {number} height the chain head
 */
export function liveSeason(seasons, height) {
  let best = null;
  for (const s of Array.isArray(seasons) ? seasons : []) {
    const [n, start, end] = [Number(s?.season), Number(s?.start_height), Number(s?.end_height)];
    if (![n, start, end].every(Number.isSafeInteger)) continue;
    if (start <= height && height <= end && (!best || n > Number(best.season))) best = s;
  }
  return best;
}

/**
 * The season that starts soonest after `height`, or null: shown while none is trading.
 * @param {any[]} seasons @param {number} height
 */
export function nextSeason(seasons, height) {
  let best = null;
  for (const s of Array.isArray(seasons) ? seasons : []) {
    const [n, start] = [Number(s?.season), Number(s?.start_height)];
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(start) || start <= height) continue;
    if (!best || start < Number(best.start_height) || (start === Number(best.start_height) && n < Number(best.season))) best = s;
  }
  return best;
}

/** The season's pair: its S<n>DIVI is traded for its S<n>GOLD. @param {any} season */
export function pairOf(season) {
  const n = Number(season.season);
  return { base: String(season.divi ?? `S${n}DIVI`), quote: String(season.gold ?? `S${n}GOLD`) };
}

/**
 * Whether this address may join: it holds none of the season's tokens and has no open order in its pair,
 * as `ensure_joined` in bots/rust/src/bot.rs. The chain itself refuses a second join by the same address.
 * @param {string|bigint} gold @param {string|bigint} divi @param {number} openOrders
 */
export function canJoin(gold, divi, openOrders) {
  return BigInt(gold) === 0n && BigInt(divi) === 0n && openOrders === 0;
}

/**
 * Whole tokens to base units: toUnits("1.5", 8) === 150000000n. Throws a readable error on anything else.
 * @param {string} text @param {number} decimals @param {string} what what the number is, for the error
 */
export function toUnits(text, decimals, what = 'amount') {
  const s = String(text ?? '').trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!s || !m || (!m[1] && !m[2])) throw new Error(`The ${what} must be a number, like 1.5.`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`The ${what} can have at most ${decimals} decimal places.`);
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

/**
 * A price in whole quote tokens per whole base token to the wire price: priceToWire("1.25", 2) === 12500000000n
 * (1.25 S<n>GOLD is 125 base units, times 10^8). The same as `reference_price` in bots/rust/src/strategy.rs, except
 * that it takes up to the chain's tick, PRICE_DECIMALS + quote decimals places (the bots take 8), so any price
 * priceText shows reads back to the same wire price: priceToWire("1.0752823095", 2) === 10752823095n.
 * @param {string} text @param {number} [quoteDecimals]
 */
export function priceToWire(text, quoteDecimals = GOLD_DECIMALS) {
  const p = toUnits(text, PRICE_DECIMALS + quoteDecimals, 'price');
  if (p < 1n) throw new Error('The price must be more than zero.');
  if (p > MAX_PRICE) throw new Error('That price is too high for the chain.');
  return p;
}

/** A wire price as whole quote tokens per whole base token: priceText("12500000000", 2) === "1.25". */
export function priceText(/** @type {string|bigint} */ wire, quoteDecimals = GOLD_DECIMALS) {
  return unitsText(wire, quoteDecimals + PRICE_DECIMALS);
}

/** Base units as whole tokens, trailing zeros trimmed: unitsText("150000000", 8) === "1.5". */
export function unitsText(/** @type {string|bigint} */ units, /** @type {number} */ decimals) {
  const n = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const frac = (n % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return (n / scale).toString() + (frac ? '.' + frac : '');
}

/**
 * What an order is worth in quote base units, rounded down: `quote_for` in crates/dg-market. A buy locks this much.
 * @param {bigint} amount base units @param {bigint} price wire price @param {number} [baseDecimals]
 */
export function notional(amount, price, baseDecimals = DIVI_DECIMALS) {
  return (amount * price) / (10n ** BigInt(baseDecimals) * PRICE_SCALE);
}

/**
 * Check an order the way the chain will, and build its action. Throws a readable error instead of signing an
 * order the chain would refuse for its numbers or for what you hold.
 * @param {{side: string, price: string, amount: string}} form what was typed
 * @param {{base: string, quote: string, baseDecimals?: number, quoteDecimals?: number, gold?: bigint, divi?: bigint}} ctx
 *   the pair, its decimals, and what you hold (in base units; omit to skip the balance check)
 */
export function buildOrder(form, ctx) {
  const side = form.side;
  if (side !== 'buy' && side !== 'sell') throw new Error('Choose buy or sell.');
  const [bd, qd] = [ctx.baseDecimals ?? DIVI_DECIMALS, ctx.quoteDecimals ?? GOLD_DECIMALS];
  const price = priceToWire(form.price, qd);
  const amount = toUnits(form.amount, bd, 'amount');
  if (amount === 0n) throw new Error('The amount must be more than zero.');
  if (amount * price >= 1n << 128n) throw new Error('That order is too large for the chain.');
  const cost = notional(amount, price, bd);
  if (cost === 0n) throw new Error(`That order is worth less than 0.${'0'.repeat(qd - 1)}1 ${ctx.quote}. Trade more, or at a higher price.`);
  if (side === 'buy' && ctx.gold != null && cost > ctx.gold) {
    throw new Error(`A buy of ${unitsText(amount, bd)} ${ctx.base} at ${priceText(price, qd)} needs ${unitsText(cost, qd)} ${ctx.quote}; you have ${unitsText(ctx.gold, qd)}.`);
  }
  if (side === 'sell' && ctx.divi != null && amount > ctx.divi) {
    throw new Error(`You have ${unitsText(ctx.divi, bd)} ${ctx.base} to sell.`);
  }
  return { action: placeAction(ctx.base, ctx.quote, side, price, amount), price, amount, cost };
}

/** The market actions, as the bots send them (bots/js/market-maker.mjs). */
export const placeAction = (/** @type {string} */ base, /** @type {string} */ quote, /** @type {string} */ side, /** @type {bigint} */ price, /** @type {bigint} */ amount) => ({
  type: 'market',
  op: { kind: 'place', base, quote, side, price: price.toString(), amount: amount.toString() },
});
export const cancelAction = (/** @type {string} */ orderId) => ({ type: 'market', op: { kind: 'cancel', order_id: orderId } });
export const joinAction = (/** @type {number} */ season) => ({ type: 'market', op: { kind: 'join_season', season: Number(season) } });

/** An order's id: the first 16 hex digits of the txid that placed it. */
export const orderId = (/** @type {string} */ txid) => txid.slice(0, 16);
