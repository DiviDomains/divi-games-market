// The season market on Divi Games testnet: join the live season, place and cancel orders, watch the book and the
// trades. Plain ES module, no build step, no requests except to the chain API.
//
//   /play/market/                  the live season's S<n>DIVI/S<n>GOLD book
//   ?chain=http://127.0.0.1:7410   use another chain API root (default: <this origin>/chain; only on localhost)
//
// Helpers copied from play/blackjack/app.js (el, say, run, play key): the SDK stays untouched. Unlike the games this
// page does not mount the IronDivi wallets: a wallet plays through a session key, and the chain lets a session key
// send only game and faucet actions, never market ones. So the page always signs with the play key.

import { Chain, Key, NETWORK, readableError, setTextWithLinks } from '../../sdk/divigames.js';
import { liveSeason, nextSeason, pairOf, canJoin, buildOrder, cancelAction, joinAction, orderId, priceText, unitsText, GOLD_DECIMALS, DIVI_DECIMALS } from './market.js';

const KEY_STORE = 'dg.playkey.wif';
/** Refresh this often even without a block message, so a closed socket never leaves the book stale. */
const POLL_MS = 5000;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const chain = Chain.fromPage();

const state = {
  /** @type {Key} */ key: loadKey(),
  me: '',
  height: 0,
  /** The season that opens next, or null. @type {any} */ next: null,
  /** The live season from `view=seasons`, or null. @type {any} */ season: null,
  base: '',
  quote: '',
  goldDecimals: GOLD_DECIMALS,
  diviDecimals: DIVI_DECIMALS,
  /** What this address holds of the season's tokens, in base units, once read. @type {bigint|null} */ gold: null,
  /** @type {bigint|null} */ divi: null,
  /** This address's open orders in the season pair. @type {any[]} */ orders: [],
  /** Whether this address is on the season's leaderboard (it has joined). @type {boolean|null} */ member: null,
  /** @type {Map<string, number>} */ decimals: new Map(),
};
state.me = state.key.address;

// ---------- small helpers ----------

/**
 * Create an element. Text children are set with textContent, so chain data is never parsed as HTML.
 * @param {string} tag @param {Record<string, any>} [props] @param {...(Node|string|null|undefined|false)} children
 */
function el(tag, props = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k in n && typeof v !== 'string') /** @type {any} */ (n)[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const short = (/** @type {string|null|undefined} */ a) => (a ? (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a) : '');
const who = (/** @type {string|null|undefined} */ a) => (a && a === state.me ? 'you' : short(a));
const safe = (/** @type {() => string} */ f) => {
  try {
    return f();
  } catch {
    return '?';
  }
};
const goldText = (/** @type {any} */ units) => safe(() => unitsText(String(units ?? '0'), state.goldDecimals));
const diviText = (/** @type {any} */ units) => safe(() => unitsText(String(units ?? '0'), state.diviDecimals));
const priceOf = (/** @type {any} */ wire) => safe(() => priceText(String(wire ?? '0'), state.goldDecimals));

const clearTimers = new WeakMap();

/** Show a status line under a control. Success notes fade after a few seconds; errors stay until replaced. */
function say(/** @type {HTMLElement} */ node, text = '', kind = 'info') {
  clearTimeout(clearTimers.get(node));
  text = readableError(text);
  setTextWithLinks(node, text);
  node.dataset.kind = kind;
  node.hidden = !text;
  if (text && kind === 'ok') {
    clearTimers.set(node, setTimeout(() => { if (node.textContent === text) say(node, ''); }, 5000));
  }
}

const errText = (/** @type {any} */ e) => (e && e.message) || String(e);

// ---------- the play key ----------

function storageGet() {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
function storageSet(/** @type {string} */ wif) {
  try {
    localStorage.setItem(KEY_STORE, wif);
    return true;
  } catch {
    return false;
  }
}

function loadKey() {
  const wif = storageGet();
  if (wif) {
    try {
      const k = Key.fromWif(wif);
      if (k.network === NETWORK) return k;
    } catch {
      /* unreadable: replace it */
    }
  }
  const k = Key.generate(NETWORK);
  storageSet(k.toWif());
  return k;
}

/** Balance of `token` from an account response: `balances` as {SYM: "n"} or [{token|symbol, amount|balance}]. */
function balanceOf(/** @type {any} */ account, /** @type {string} */ token) {
  const b = account?.balances ?? account?.balance;
  if (Array.isArray(b)) {
    const row = b.find((r) => (r.token ?? r.symbol) === token);
    return String(row?.amount ?? row?.balance ?? '0');
  }
  if (b && typeof b === 'object') return String(b[token] ?? '0');
  return '0';
}

/** A list from a view that may wrap it: `{key: [...]}` or `[...]`. */
const listOf = (/** @type {any} */ v, /** @type {string} */ key) => (Array.isArray(v) ? v : Array.isArray(v?.[key]) ? v[key] : []);

// ---------- sending actions ----------

let queue = Promise.resolve();

/**
 * Sign and submit an action with the play key, wait for its block, and report the outcome inline.
 * Actions from this page run one at a time, so each gets the right nonce.
 * @param {any} action @param {HTMLElement} msg @param {HTMLButtonElement[]} [buttons]
 * @returns {Promise<any|null>} the receipt when ok, else null
 */
function run(action, msg, buttons = []) {
  const job = async () => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      say(msg, 'Signing and sending…');
      const txid = await chain.send(state.key, action);
      say(msg, 'Sent. Waiting for the next block…');
      const receipt = await chain.waitForReceipt(txid);
      if (!receipt.ok) {
        say(msg, receipt.error || 'The transaction failed.', 'error');
        return null;
      }
      say(msg, '');
      return receipt;
    } catch (e) {
      say(msg, errText(e), 'error');
      return null;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      refreshAll();
    }
  };
  const p = queue.then(job, job);
  queue = p.then(() => {}, () => {});
  return p;
}

// ---------- the key box ----------

function showKey() {
  $('me').textContent = state.me;
  $('me').title = state.me;
  const wif = $('wif');
  wif.hidden = true;
  wif.textContent = '';
  $('export').textContent = 'Show WIF';
}

$('copy-addr').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.me);
    say($('wallet-msg'), 'Address copied.', 'ok');
  } catch {
    say($('wallet-msg'), `Your address: ${state.me}`, 'info');
  }
});

$('export').addEventListener('click', () => {
  const wif = $('wif');
  if (wif.hidden) {
    wif.textContent = state.key.toWif();
    wif.hidden = false;
    $('export').textContent = 'Hide WIF';
  } else showKey();
});

$('import').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('import-wif'));
  const text = input.value.trim();
  const msg = $('key-msg');
  try {
    const k = Key.fromWif(text);
    if (k.network !== NETWORK) throw new Error('That is a mainnet key. Import a testnet WIF (it starts with c).');
    if (k.address === state.me) {
      say(msg, 'That key is already in use.', 'info');
      return;
    }
    if (!confirmReplace()) return;
    state.key = k;
    state.me = k.address;
    const saved = storageSet(k.toWif());
    input.value = '';
    showKey();
    say(msg, saved ? 'Key imported.' : 'Key imported for this visit only: this browser would not save it.', saved ? 'ok' : 'info');
    Object.assign(state, { gold: null, divi: null, orders: [], member: null });
    refreshAll();
  } catch (e) {
    say(msg, `Not a valid WIF: ${errText(e)}`, 'error');
  }
});

/** Two-step import: the first click warns inline, a second click within 10 s replaces the key. */
let armedAt = 0;
function confirmReplace() {
  if (Date.now() - armedAt < 10000) {
    armedAt = 0;
    return true;
  }
  armedAt = Date.now();
  say($('key-msg'), 'This replaces the current play key. Export it first if it holds anything you want. Press Import again to continue.', 'info');
  return false;
}

// ---------- reading the chain ----------

let refreshing = false;
let again = false;

/** Read the head, the seasons, this address and the season's book, then redraw. Calls that overlap coalesce. */
async function refreshAll() {
  if (refreshing) {
    again = true;
    return;
  }
  refreshing = true;
  try {
    do {
      again = false;
      await refreshOnce();
    } while (again);
  } finally {
    refreshing = false;
  }
}

async function refreshOnce() {
  let info, seasons;
  try {
    [info, seasons] = await Promise.all([chain.info(), chain.game('market', { view: 'seasons' })]);
  } catch (e) {
    $('season-line').textContent = `Could not reach the chain: ${errText(e)}`;
    return;
  }
  if (Number.isFinite(Number(info?.height))) state.height = Number(info.height);
  const season = liveSeason(listOf(seasons, 'seasons'), state.height);
  const changed = Number(season?.season) !== Number(state.season?.season);
  state.season = season;
  state.next = nextSeason(listOf(seasons, 'seasons'), state.height);
  if (!season) {
    Object.assign(state, { base: '', quote: '', gold: null, divi: null, orders: [], member: null });
    render();
    return;
  }
  ({ base: state.base, quote: state.quote } = pairOf(season));
  if (changed) Object.assign(state, { gold: null, divi: null, orders: [], member: null });
  state.goldDecimals = state.decimals.get(state.quote) ?? GOLD_DECIMALS;
  state.diviDecimals = state.decimals.get(state.base) ?? DIVI_DECIMALS;
  const pair = { base: state.base, quote: state.quote };
  const [acct, mine, book, trades, board] = await Promise.all([
    chain.account(state.me).catch(() => null),
    chain.game('market', { view: 'orders', owner: state.me }).catch(() => null),
    chain.game('market', { view: 'book', ...pair }).catch(() => null),
    chain.game('market', { view: 'trades', ...pair, limit: 20 }).catch(() => null),
    chain.game('market', { view: 'season', n: season.season }).catch(() => null),
  ]);
  if (acct) {
    state.gold = BigInt(balanceOf(acct, state.quote));
    state.divi = BigInt(balanceOf(acct, state.base));
  }
  if (mine) state.orders = listOf(mine, 'orders').filter((o) => o.base === state.base && o.quote === state.quote);
  if (board) state.member = listOf(board, 'leaderboard').some((r) => r.address === state.me);
  render();
  if (book) renderBook(book);
  if (trades) renderTrades(listOf(trades, 'trades'));
}

// ---------- drawing ----------

function render() {
  const s = state.season;
  for (const id of ['trade', 'mine', 'book-card', 'trades-card']) $(id).hidden = !s;
  $('join-box').hidden = true;
  if (!s) {
    $('season-line').textContent = `No season is trading at block ${state.height}. A season trades only between its start and end blocks; the list of seasons is on the market page.`;
    if (state.next) $('season-line').textContent += ` Season ${state.next.season} opens at height ${state.next.start_height}.`;
    $('bal-gold').textContent = '–';
    $('bal-divi').textContent = '–';
    return;
  }
  const n = s.season;
  $('season-line').textContent = `Season ${n} is trading ${state.base} against ${state.quote} from block ${s.start_height} to block ${s.end_height} (now ${state.height}).`;
  $('board-link').setAttribute('href', `/market?season=${encodeURIComponent(n)}`);
  $('board-link').textContent = `Season ${n} leaderboard`;
  $('sym-gold').textContent = state.quote;
  $('sym-divi').textContent = state.base;
  document.querySelectorAll('.sym-gold').forEach((e) => (e.textContent = state.quote));
  document.querySelectorAll('.sym-divi').forEach((e) => (e.textContent = state.base));
  $('bal-gold').textContent = state.gold == null ? '…' : goldText(state.gold);
  $('bal-divi').textContent = state.divi == null ? '…' : diviText(state.divi);

  if (state.gold != null && state.divi != null) {
    const box = $('join-box');
    const line = $('join-line');
    if (state.member) {
      box.hidden = true;
    } else if (canJoin(state.gold, state.divi, state.orders.length)) {
      box.hidden = false;
      line.textContent = `Joining gives this address ${goldText(s.start_gold)} ${state.quote} and ${diviText(s.start_divi)} ${state.base} to trade with.`;
      $('join').hidden = false;
    } else {
      box.hidden = false;
      line.textContent = `This address already holds ${state.quote} or ${state.base}, or has an open order, so it trades with what it has; joining is for a fresh address.`;
      $('join').hidden = true;
    }
  }
  renderOrders();
  orderNote();
}

function renderOrders() {
  const list = $('orders');
  list.replaceChildren();
  if (!state.orders.length) {
    list.append(el('li', { class: 'muted' }, 'None.'));
    return;
  }
  for (const o of [...state.orders].sort((a, b) => Number(b.seq) - Number(a.seq))) {
    const btn = /** @type {HTMLButtonElement} */ (el('button', { class: 'ghost small', type: 'button' }, 'Cancel'));
    btn.addEventListener('click', async () => {
      const r = await run(cancelAction(o.id), $('orders-msg'), [btn]);
      if (r) say($('orders-msg'), `Order ${o.id} cancelled.`, 'ok');
    });
    const left = o.remaining !== o.amount ? ` (${diviText(o.remaining)} left)` : '';
    list.append(
      el('li', {},
        el('div', { class: 'info' },
          el('span', { class: `side-tag ${o.side}` }, o.side === 'buy' ? 'Buy' : 'Sell'), ' ',
          `${diviText(o.amount)} ${state.base} at ${priceOf(o.price)} ${state.quote}${left}`,
          el('div', { class: 'sub' }, `Order ${o.id} · block ${o.height}${o.side === 'buy' ? ` · ${goldText(o.locked)} ${state.quote} locked` : ''}`)),
        el('div', { class: 'btns' }, btn)),
    );
  }
}

/** Fill a book side, best price first as the chain lists it. */
function fillLevels(/** @type {HTMLElement} */ body, /** @type {any[]} */ levels, /** @type {string} */ side) {
  body.replaceChildren();
  if (!levels.length) {
    body.append(el('tr', {}, el('td', { class: 'muted', colspan: '3' }, 'Empty.')));
    return;
  }
  for (const l of levels.slice(0, 15)) {
    const row = el('tr', { class: `lvl ${side}`, title: 'Use this price' },
      el('td', {}, priceOf(l.price)), el('td', {}, diviText(l.amount)), el('td', {}, String(l.orders ?? '')));
    row.addEventListener('click', () => {
      const form = /** @type {HTMLFormElement} */ ($('order-form'));
      /** @type {HTMLInputElement} */ (form.elements.namedItem('price')).value = priceOf(l.price);
      // Clicking an ask fills a buy that takes it, and a bid a sell.
      const want = side === 'ask' ? 'buy' : 'sell';
      form.querySelectorAll('input[name="side"]').forEach((r) => (/** @type {HTMLInputElement} */ (r).checked = /** @type {HTMLInputElement} */ (r).value === want));
      orderNote();
    });
    body.append(row);
  }
}

function renderBook(/** @type {any} */ book) {
  fillLevels($('bids'), listOf(book, 'bids'), 'bid');
  fillLevels($('asks'), listOf(book, 'asks'), 'ask');
  const last = book?.last?.price;
  $('last').textContent = last ? `last ${priceOf(last)} ${state.quote}` : '';
}

function renderTrades(/** @type {any[]} */ trades) {
  const body = $('trades');
  body.replaceChildren();
  if (!trades.length) {
    body.append(el('tr', {}, el('td', { class: 'muted', colspan: '5' }, 'No trades yet this season.')));
    return;
  }
  for (const t of trades) {
    const mine = t.maker === state.me || t.taker === state.me;
    body.append(el('tr', { class: mine ? 'you' : null },
      el('td', {}, String(t.height ?? '')),
      el('td', { class: `side-tag ${t.taker_side}` }, t.taker_side === 'buy' ? 'Buy' : 'Sell'),
      el('td', {}, priceOf(t.price)),
      el('td', {}, diviText(t.amount)),
      el('td', { class: 'muted' }, mine ? (t.taker === state.me ? 'you took' : 'you made') : `${who(t.taker)} ← ${who(t.maker)}`)));
  }
}

// ---------- the order form ----------

/** Read the form as text, and check it with what this address holds. */
function readOrder() {
  const form = /** @type {HTMLFormElement} */ ($('order-form'));
  const data = new FormData(form);
  return buildOrder(
    { side: String(data.get('side') ?? ''), price: String(data.get('price') ?? ''), amount: String(data.get('amount') ?? '') },
    { base: state.base, quote: state.quote, baseDecimals: state.diviDecimals, quoteDecimals: state.goldDecimals, gold: state.gold ?? undefined, divi: state.divi ?? undefined },
  );
}

/** Under the form: what the order would cost or bring, or nothing while it is incomplete. */
function orderNote() {
  const note = $('order-note');
  const data = new FormData(/** @type {HTMLFormElement} */ ($('order-form')));
  if (!String(data.get('price') ?? '').trim() || !String(data.get('amount') ?? '').trim() || !state.season) {
    note.textContent = '';
    return;
  }
  try {
    const o = readOrder();
    note.textContent = o.action.op.side === 'buy'
      ? `Locks up to ${goldText(o.cost)} ${state.quote} while it rests.`
      : `Brings at least ${goldText(o.cost)} ${state.quote} if it fills.`;
  } catch (e) {
    note.textContent = errText(e);
  }
}

$('order-form').addEventListener('input', orderNote);

$('order-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('order-msg');
  if (!state.season) return say(msg, 'No season is trading right now.', 'error');
  let o;
  try {
    o = readOrder();
  } catch (e) {
    return say(msg, errText(e), 'error');
  }
  const r = await run(o.action, msg, [/** @type {HTMLButtonElement} */ ($('place'))]);
  if (!r) return;
  const traded = (r.events ?? []).filter((e) => e.kind === 'trade').length;
  say(msg, `Order ${orderId(r.txid)} placed${traded ? `; it traded ${traded} time${traded === 1 ? '' : 's'}` : ''}.`, 'ok');
});

$('join').addEventListener('click', async (ev) => {
  if (!state.season) return;
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  const r = await run(joinAction(state.season.season), $('season-msg'), [btn]);
  if (r) say($('season-msg'), `You joined season ${state.season.season}.`, 'ok');
});

// ---------- start ----------

function setConn(/** @type {boolean} */ on) {
  const c = $('conn');
  c.dataset.state = on ? 'on' : 'off';
  c.textContent = on ? 'live' : 'reconnecting…';
  if (on) refreshAll();
}

async function start() {
  $('chain-url').textContent = chain.baseUrl;
  showKey();
  try {
    const tokens = await chain.tokens();
    for (const t of listOf(tokens, 'tokens')) {
      const sym = t?.symbol ?? t?.token;
      if (typeof sym === 'string' && Number.isInteger(t?.decimals)) state.decimals.set(sym, t.decimals);
    }
  } catch {
    /* defaults stand */
  }
  chain.subscribe(() => refreshAll(), { onStatus: setConn });
  setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, POLL_MS);
  refreshAll();
}

start();
