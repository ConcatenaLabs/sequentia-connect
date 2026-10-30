// A trade on one market, planned by the wallet: which orders on the book it takes, how
// much of each, and, for a limit order, the order that rests with what is left. Pure
// arithmetic over the relay's offers: no I/O, no wallet. src/market.js runs the plan.
//
// A market is a pair of assets, `base` and `quote` (display hex, or 'BTC'), read the
// same way whichever way round a maker listed an order: an order that sells the base
// for the quote is an ask, and one that sells the quote for the base (listed on the
// reversed market) is a bid. Only orders the wallet can settle in one step are read:
// covenant orders on the on-chain book, filled by one transaction that pays the maker
// on the chain and the wallet in the same transaction, and interactive makers' offers
// on the same book, filled by one transaction the maker co-signs while it is online
// (src/dex.js). Each covenant fixes its rate
// (the maker gets ceil(filled * rate_num / rate_den) of what it wants for `filled` of
// what it sells), its smallest lot, and that what it leaves resting is at least one
// lot; every number here follows those rules, so a plan the chain would refuse is
// never offered.
//
// Prices are given as quote atoms per one whole base unit (10^precision base atoms),
// the unit a price is typed in.

import { ceilPrice } from './covenant.js';
import { gcdBig, leafProductFits } from './covenant-flow.js';

const big = (v) => BigInt(v ?? 0);

// The most orders one trade takes: each is its own transaction, sent one after the
// other.
export const MAX_ORDERS_PER_TRADE = 6;
// A market order goes no further than this past the best price on the book.
export const MARKET_BOUND_PCT = 5n;

// The covenant terms of a relay offer, as numbers. null for anything that is not a
// covenant order selling `receive` for `pay`, unexpired, at a sane rate.
export function covenantQuote(o, receive, pay, nowSec = Math.floor(Date.now() / 1000)) {
  const ct = o && (o.covenant || o.Covenant);
  if (!ct) return null;
  if (String(o.offer_asset || '').toLowerCase() !== receive || String(o.want_asset || '').toLowerCase() !== pay) return null;
  if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= nowSec) return null;
  const num = big(ct.rate_num ?? ct.rateNum), den = big(ct.rate_den ?? ct.rateDen);
  const minLot = big(ct.min_lot ?? ct.minLot);
  const locked = big(o.offer_amount);
  if (num <= 0n || den <= 0n || locked <= 0n) return null;
  return { offer: o, offerId: o.offer_id, num, den, minLot: minLot > 0n ? minLot : 1n, locked };
}

// The terms of an interactive maker's same-chain offer selling `receive` for `pay`, as
// numbers. The maker co-signs a fill of `take` base atoms at the daemon's proRata: the
// wallet receives floor(offer * take / base) and pays ceil(want * take / base). null for
// anything else: a covenant, a leaf order, a cross-chain or confidential-book offer.
export function interactiveQuote(o, receive, pay, nowSec = Math.floor(Date.now() / 1000)) {
  if (!o || o.covenant || o.Covenant || o.resting_leaf || o.restingLeaf || o.cross_chain || o.confidential) return null;
  const sc = o.same_chain || o.sameChain;
  if (!sc || !(sc.maker_recv_address || sc.makerRecvAddress)) return null;
  if (String(o.offer_asset || '').toLowerCase() !== receive || String(o.want_asset || '').toLowerCase() !== pay) return null;
  if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= nowSec) return null;
  const offer = big(o.offer_amount), want = big(o.want_amount), baseAmt = big(o.base_amount);
  if (offer <= 0n || want <= 0n || baseAmt <= 0n) return null;
  const baseAsset = String((o.pair && o.pair.base_asset) || '').toLowerCase();
  const baseIsReceive = baseAsset === receive;
  // What the offer can still be filled for, in base atoms: the relay's active_amount (the book's
  // statuses), which a part fill lowers while the signed amounts stay as they were. A take past
  // it is refused by the relay.
  let active = o._active != null ? big(o._active) : baseAmt;
  if (active > baseAmt) active = baseAmt;
  if (active <= 0n) return null;
  const locked = baseIsReceive ? active : (offer * active) / baseAmt;
  if (locked <= 0n) return null;
  return { offer: o, offerId: o.offer_id, num: want, den: offer, minLot: 1n, locked, interactive: true,
    baseAmt, active, baseIsReceive };
}

// An interactive fill near `filled` receive atoms, in the maker's own terms: the base
// atoms to take, and what that receives and pays at the daemon's proRata. Receiving the
// base, the take is what is received; paying it, the least take that receives `filled`.
export function interactiveSlice(q, filled) {
  let take = q.baseIsReceive ? filled : (filled * q.num + q.den - 1n) / q.den;
  const most = q.active ?? q.baseAmt;
  if (take > most) take = most;
  const recv = (q.den * take) / q.baseAmt;
  const pays = (q.num * take + q.baseAmt - 1n) / q.baseAmt;
  return { take, filled: recv, pays };
}

// The terms of an order resting in an operator's tree (`resting_leaf`) selling
// `receive` for `pay`, as numbers, held at what its coin holds now (the relay's
// locator; the relay moves it at every fill), when it is one of `operatorKey`'s.
// null for anything else.
export function restingQuote(o, receive, pay, operatorKey, nowSec = Math.floor(Date.now() / 1000)) {
  const t = o && (o.resting_leaf || o.restingLeaf);
  if (!t) return null;
  if (String(o.offer_asset || '').toLowerCase() !== receive || String(o.want_asset || '').toLowerCase() !== pay) return null;
  if (Number(o.expires_at_unix || 0) > 0 && Number(o.expires_at_unix) <= nowSec) return null;
  if (!operatorKey || String(t.operator_key || '').toLowerCase() !== String(operatorKey).toLowerCase()) return null;
  const num = big(t.rate_num), den = big(t.rate_den), minLot = big(t.min_lot);
  const locked = big(o._active ?? t.value);
  if (num <= 0n || den <= 0n || locked <= 0n) return null;
  return { offer: o, offerId: o.offer_id, num, den, minLot: minLot > 0n ? minLot : 1n, locked, resting: true };
}

// The one resting order a trade fills whole, when the best one of them prices at least
// as well as every covenant order and holds the whole trade: side 'buy' receives
// `amount` base atoms, side 'sell' pays `amount` base atoms. Returns { q, filled
// (receive atoms), pays (pay atoms, the price) } or null; a limit `price` (quote atoms
// per whole base unit) bounds it.
export function planResting({ resting, covenants = [], side, amount, price = null, basePrecision }) {
  const best = (list) => list.reduce((b, q) => (!b || rateLess(q, b) ? q : b), null);
  const r = best(resting || []), c = best(covenants || []);
  if (!r || (c && rateLess(c, r))) return null;
  const a = big(amount), unit = 10n ** BigInt(basePrecision || 0);
  // Buying, the order sells the base: it fills `amount`. Selling, the order sells the
  // quote for the base: the wallet's `amount` base buys as much as it pays for.
  const filled = side === 'buy' ? a : (a * r.den) / r.num;
  if (filled <= 0n || filled > r.locked || lotFit(r, filled) !== filled) return null;
  const pays = (filled * r.num + r.den - 1n) / r.den;
  if (price != null) {
    const p = big(price);
    if (side === 'buy' ? pays * unit > p * filled : filled * unit < p * pays) return null;
  }
  return { q: r, filled, pays };
}

// a/b < c/d, exactly.
const rateLess = (a, b) => a.num * b.den < b.num * a.den;

// The amount of an order to take so that what the covenant leaves resting is either
// nothing or at least one lot, at most `want`. 0n when no such amount exists.
export function lotFit(q, want) {
  let f = want < q.locked ? want : q.locked;
  if (f < q.minLot) return 0n;
  const rest = q.locked - f;
  if (rest > 0n && rest < q.minLot) {
    f = q.locked - q.minLot;
    if (f < q.minLot) return 0n;
  }
  return f;
}

// The plan of a trade. side 'buy' receives `amount` base atoms paying the quote;
// side 'sell' pays `amount` base atoms receiving the quote. `price` (quote atoms per
// whole base unit) bounds a limit order; a market order is bounded MARKET_BOUND_PCT
// past the best order. Returns { side, receive, pay, slices, got, gave, baseDone,
// baseLeft } where each slice is { offerId, offer, filled (receive atoms), pays (pay
// atoms) }, and for an interactive maker's offer (taken only with `interactive`) also
// { take (base atoms, the maker's terms), interactive: true }.
export function planTrade({ offers, base, quote, side, amount, price = null, basePrecision, nowSec, interactive = false }) {
  if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
  const want = big(amount);
  if (want <= 0n) throw new Error('the amount must be more than zero');
  const unit = 10n ** BigInt(basePrecision);
  const receive = side === 'buy' ? base : quote;
  const pay = side === 'buy' ? quote : base;
  const quotes = (offers || []).map((o) => covenantQuote(o, receive, pay, nowSec)
    || (interactive ? interactiveQuote(o, receive, pay, nowSec) : null)).filter(Boolean);
  // Cheapest first: the fewest atoms paid for each atom received. The same order is
  // best for both sides, since a sell pays the base and receives the quote.
  quotes.sort((a, b) => (rateLess(a, b) ? -1 : rateLess(b, a) ? 1 : 0));
  const lim = price != null ? big(price) : null;
  if (lim != null && lim <= 0n) throw new Error('the price must be more than zero');
  // A price bound per side, in exact integers. Buying, an order's rate (quote atoms per
  // base atom) must not exceed price/unit; selling, the base paid per quote atom
  // (num/den) must not exceed unit/price.
  const withinLimit = (q) => (side === 'buy' ? q.num * unit <= lim * q.den : q.num * lim <= unit * q.den);
  const best = quotes[0];
  const withinMarket = (q) => q.num * best.den * 100n <= (100n + MARKET_BOUND_PCT) * best.num * q.den;
  const slices = [];
  let left = want, got = 0n, gave = 0n;
  for (const q of quotes) {
    if (left <= 0n || slices.length >= MAX_ORDERS_PER_TRADE) break;
    if (lim != null ? !withinLimit(q) : !withinMarket(q)) break;
    let filled;
    if (side === 'buy') {
      filled = lotFit(q, left);
    } else {
      // The most of the order whose price fits what is left to pay.
      filled = lotFit(q, (left * q.den) / q.num);
    }
    if (filled <= 0n) continue;
    if (q.interactive) {
      const x = interactiveSlice(q, filled);
      if (x.filled <= 0n || x.pays <= 0n) continue;
      if (side === 'sell' && x.pays > left) continue;
      slices.push({ offerId: q.offerId, offer: q.offer, filled: x.filled, pays: x.pays, take: x.take, interactive: true });
      got += x.filled; gave += x.pays;
      left -= side === 'buy' ? x.filled : x.pays;
      continue;
    }
    const pays = ceilPrice(filled, q.num, q.den);
    slices.push({ offerId: q.offerId, offer: q.offer, filled, pays });
    got += filled; gave += pays;
    left -= side === 'buy' ? filled : pays;
  }
  const baseDone = side === 'buy' ? got : gave;
  return { side, receive, pay, slices, got, gave, baseDone, baseLeft: want - baseDone };
}

// The worst price an approved plan pays, in quote atoms per whole base unit: a purchase's
// highest, a sale's lowest. A trade that falls through to other orders never goes past it.
export function worstPrice(plan, side, basePrecision) {
  const unit = 10n ** BigInt(basePrecision);
  let w = null;
  for (const s of plan.slices) {
    const f = big(s.filled), p = big(s.pays);
    if (f <= 0n || p <= 0n) continue;
    // Buying: quote paid per base received, rounded up; selling: quote received per base paid, down.
    const x = side === 'buy' ? (p * unit + f - 1n) / f : (f * unit) / p;
    if (w == null || (side === 'buy' ? x > w : x < w)) w = x;
  }
  return w;
}

// What replaces orders that failed when taken (their maker did not answer, someone took them
// first): a plan over the orders not yet tried, for the base the failed ones left, at `price`
// or better, giving no more than `budget` of what is paid and taking at most `maxSlices`
// orders, so the trade stays inside what was approved.
export function fallThrough({ offers, tried, base, quote, side, amount, price, basePrecision, nowSec, budget, maxSlices }) {
  const left = (offers || []).filter((o) => !tried.has(o.offer_id));
  if (big(amount) <= 0n || maxSlices <= 0 || !left.length) return { slices: [], gave: 0n, got: 0n, baseDone: 0n };
  const p = planTrade({ offers: left, base, quote, side, amount, price, basePrecision, nowSec });
  const slices = [];
  let gave = 0n, got = 0n;
  for (const s of p.slices) {
    if (slices.length >= maxSlices || gave + s.pays > big(budget)) break;
    slices.push(s); gave += s.pays; got += s.filled;
  }
  return { slices, gave, got, baseDone: side === 'buy' ? got : gave };
}

// The order that rests with what a limit order did not fill: the wallet sells what it
// pays, at the limit price exactly. Buying, it sells the quote for the base still
// wanted; selling, it sells the base still offered. The rate comes from the price, so
// the numbers in the covenant stay small. Returns { sell, want, sellAtoms, wantAtoms,
// rateNum, rateDen, minLot } or null when nothing is left to rest.
// A limit order's options (the provider protocol's `placeOrder`): post only, `rest: false`,
// `min_fill` (base atoms) and `take_back_after` (seconds from now, an hour to a week). The
// web wallet's site-orders.js reads the same options for user mode, with the same refusals.
export const TAKE_BACK_MIN = 3600;
export const TAKE_BACK_MAX = 7 * 86400;
export const ORDER_FEATURES = Object.freeze(['order-post-only', 'order-no-rest', 'order-min-fill', 'order-take-back-after']);
export function readOrderOptions(p, type) {
  const has = (k) => p && p[k] !== undefined && p[k] !== null;
  const asked = ['post_only', 'rest', 'min_fill', 'take_back_after'].filter(has);
  if (asked.length && type !== 'limit') throw new Error(asked.join(', ') + ': options of a limit order');
  if (has('post_only') && typeof p.post_only !== 'boolean') throw new Error('post_only must be true or false');
  if (has('rest') && typeof p.rest !== 'boolean') throw new Error('rest must be true or false');
  const postOnly = p ? p.post_only === true : false;
  const rest = !(p && p.rest === false);
  if (postOnly && !rest) throw new Error('post_only and rest: false cannot be asked together: one only rests, the other never does');
  let minFill = null;
  if (has('min_fill')) {
    if (!/^\d+$/.test(String(p.min_fill)) || big(p.min_fill) <= 0n) throw new Error('min_fill must be a positive number of base atoms');
    minFill = big(p.min_fill);
  }
  let takeBackAfter = null;
  if (has('take_back_after')) {
    const s = Number(p.take_back_after);
    if (!Number.isInteger(s) || s < TAKE_BACK_MIN || s > TAKE_BACK_MAX) throw new Error(`take_back_after must be whole seconds from ${TAKE_BACK_MIN} (an hour) to ${TAKE_BACK_MAX} (a week)`);
    takeBackAfter = s;
  }
  return { postOnly, rest, minFill, takeBackAfter };
}

// The resting order with its smallest lot from `min_fill` (base atoms): as is for a sale, at
// the price for a purchase (rounded up, in the quote it sells). Unchanged without one.
export function withMinFill(rest, minFill, { side, price, basePrecision }) {
  if (!rest || minFill == null) return rest;
  const unit = 10n ** BigInt(basePrecision);
  const lot = side === 'sell' ? big(minFill) : (big(minFill) * big(price) + unit - 1n) / unit;
  if (lot > rest.sellAtoms) throw new Error('the smallest fill is more than the order; nothing was placed');
  return { ...rest, minLot: lot > 0n ? lot : 1n };
}

export function restTerms({ base, quote, side, baseLeft, price, basePrecision }) {
  const left = big(baseLeft), p = big(price);
  if (left <= 0n) return null;
  if (p <= 0n) throw new Error('the price must be more than zero');
  const unit = 10n ** BigInt(basePrecision);
  let sell, wantAsset, sellAtoms, rateNum, rateDen;
  if (side === 'sell') {
    // Sells `left` base; a taker pays ceil(f * price / unit) quote for f base.
    sell = base; wantAsset = quote; sellAtoms = left;
    const g = gcdBig(p, unit); rateNum = p / g; rateDen = unit / g;
  } else {
    // Sells the quote that buys `left` base at the price, rounded down so it never
    // pays above it; a taker pays ceil(f * unit / price) base for f quote.
    sell = quote; wantAsset = base; sellAtoms = (left * p) / unit;
    const g = gcdBig(unit, p); rateNum = unit / g; rateDen = p / g;
  }
  if (sellAtoms <= 0n) throw new Error('what is left of this order is too small to rest on the book');
  if (!leafProductFits(sellAtoms, rateNum, rateDen)) {
    throw new Error('this amount and price are too large to rest on the book together: try a smaller amount or a rounder price');
  }
  const minLot = sellAtoms / 1000n > 0n ? sellAtoms / 1000n : 1n;
  return { sell, want: wantAsset, sellAtoms, wantAtoms: ceilPrice(sellAtoms, rateNum, rateDen), rateNum, rateDen, minLot };
}

// Where one of the wallet's resting orders stands, from the relay's fill records of
// its pair (`fills`, oldest first) and the order's record: the outpoint it rests at,
// what it still holds, what it has filled, and its fills. A fill undone by the chain
// counts for nothing until it is in a block again.
export function orderProgress(rec, fills) {
  const mine = (fills || []).filter((f) => f.offer_id === rec.offer_id && f.maker_pubkey === rec.maker_pubkey && f.state !== 'undone');
  let at = rec.txid && rec.vout != null ? `${rec.txid}:${rec.vout}` : null;
  let holds = big(rec.sell_atoms);
  const chain = [];
  // Follow the order from where it was placed, one fill to the next.
  for (let i = 0; i < mine.length + 1; i++) {
    const f = mine.find((x) => x.spent === at);
    if (!f) break;
    chain.push(f);
    holds = big(f.remainder);
    at = f.remainder > 0 && f.rest ? `${f.txid}:${f.rest.vout}` : null;
  }
  const filled = big(rec.sell_atoms) - holds;
  const credited = chain.reduce((s, f) => s + big(f.credit && f.credit.value), 0n);
  return {
    restsAt: at,
    holds,
    filled,
    credited,
    fills: chain.map((f) => ({ txid: f.txid, filled: String(f.filled), credit: String((f.credit && f.credit.value) || 0), state: f.state, height: f.height })),
    final: chain.length > 0 && chain.every((f) => f.state === 'final'),
  };
}

// One spend of a resting order, read from the spending transaction as the order's FILL
// leaf reads it: input k spends the order, output 2k pays the maker's credit to its
// payout script, output 2k+1 is the order resting again under its own script (a partial
// fill) or anything else (a full fill). `tx` is the explorer's transaction (`vout` with
// `scriptpubkey`, `value`, `asset`), `held` what the order held before. Returns null when
// the spend is not a fill of this order (its credit output does not pay the maker: the
// order taken back, or not this order at all).
export function fillOfSpend(tx, k, held, { orderSpk, makerSpk }) {
  const credit = tx && tx.vout && tx.vout[2 * k];
  if (!credit || String(credit.scriptpubkey || '').toLowerCase() !== String(makerSpk).toLowerCase()) return null;
  const rest = tx.vout[2 * k + 1];
  const restsAgain = !!rest && String(rest.scriptpubkey || '').toLowerCase() === String(orderSpk).toLowerCase() && rest.value != null;
  const remainder = restsAgain ? big(rest.value) : 0n;
  return { txid: tx.txid, filled: big(held) - remainder, credit: big(credit.value), remainder, next: restsAgain ? { txid: tx.txid, vout: 2 * k + 1 } : null };
}

// An order's progress read from the chain (`spends`, its fills in order, each from
// fillOfSpend, with `confirmed`), each fill settled only where the relay's record of it
// says final. The relay's records live in its memory, so the chain is what says how much
// an order filled; the relay only says when a fill is final.
export function progressFromChain(rec, spends, relayFills) {
  const finalTx = new Set((relayFills || []).filter((f) => f.offer_id === rec.offer_id && f.maker_pubkey === rec.maker_pubkey && f.state === 'final').map((f) => f.txid));
  let holds = big(rec.sell_atoms), credited = 0n, restsAt = rec.txid && rec.vout != null ? `${rec.txid}:${rec.vout}` : null;
  const fills = [];
  for (const f of spends) {
    holds = f.remainder; credited += f.credit;
    restsAt = f.next ? `${f.next.txid}:${f.next.vout}` : null;
    const settled = finalTx.has(f.txid);
    fills.push({ txid: f.txid, filled: String(f.filled), credit: String(f.credit), state: settled ? 'final' : f.confirmed ? 'confirmed' : 'mempool', standing: settled ? 'settled' : 'sent' });
  }
  return { restsAt, holds, filled: big(rec.sell_atoms) - holds, credited, fills, final: fills.length > 0 && fills.every((f) => f.state === 'final') };
}

// Where a fill the wallet took stands, from the relay's record of it: 'sent' until the
// relay records it in a block and calls it final, 'settled' once it does. An undone
// fill is sent again (its transaction is back in the node's mempool).
export function fillStanding(txid, fills) {
  const rec = (fills || []).filter((f) => f.txid === txid);
  if (!rec.length) return { state: 'sent', relay: null };
  const last = rec[rec.length - 1];
  return { state: last.state === 'final' ? 'settled' : 'sent', relay: last.state };
}
