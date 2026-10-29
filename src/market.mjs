// Market and limit orders between two Sequentia assets, settled from a Sequentia Core
// wallet: `placeOrder`, `getOrders` and `cancelOrder` of the provider protocol.
//
// The book is the on-chain relay's covenant orders, both ways round, read by this
// daemon itself (the site's numbers are never used). The plan is the extension's own
// arithmetic (vendor/market-plan.js), so the two wallets take the same orders for the
// same request. Each order taken is one transaction that pays its maker on the chain and
// this wallet in the same transaction, or nothing: SeqDEX's taker (`seqob-cli covfill`)
// builds it, checks the order against the chain, and has the Core wallet sign its own
// inputs. What a limit order does not fill rests as a covenant order funded from the
// Core wallet, its maker credits paid to a taproot address of that wallet, listed on
// the relay by this daemon once its funding is in a block. Every fee is paid in the
// asset the wallet gives.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { planTrade, restTerms, orderProgress, MAX_ORDERS_PER_TRADE } from '../vendor/market-plan.js';
import { planPlaceOrder, postExisting } from '../vendor/covenant-order.js';
import { orderExpiryTime, lockState } from '../vendor/covenant-flow.js';
import { secp256k1, schnorr } from '../vendor/btc.js';
import * as seqob from '../vendor/seqob.js';
import { amountToAtoms, atomsToAmount } from './rpc.mjs';
import { run } from './tools.mjs';
import { Rejected } from './approve.mjs';

export const ORDER_SECONDS = 86400;
const FILL_VSIZE = 1500n;
const FUND_VSIZE = 500n;
const REF_FEERATE_KVB = 2000n;   // rfa per 1000 vB, before the node's own floor
const big = (v) => BigInt(v ?? 0);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const hex = (b) => Buffer.from(b).toString('hex');
const rev = (h) => String(h).match(/../g).reverse().join('');
const isHex64 = (s) => /^[0-9a-f]{64}$/.test(String(s || ''));

export function market({ core, relay, seqobCli, datadir, meta, log = () => {} }) {
  const file = path.join(datadir, 'orders.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { orders: [], trades: [] }; } };
  const save = (s) => fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  const seedFile = path.join(datadir, 'maker.seed');
  if (!fs.existsSync(seedFile)) fs.writeFileSync(seedFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const seed = () => fs.readFileSync(seedFile, 'utf8').trim();
  // Two keys per resting order, both drawn from this daemon's own seed: the one that
  // signs its listing on the relay, and the one that alone can take it back after its
  // time. Neither is the Core wallet's.
  const keyOf = (purpose, id) => crypto.createHash('sha256').update(`sequentia-connect/${purpose}/${seed()}/${id}`).digest();
  const relayGet = async (p) => {
    const r = await fetch(relay + p, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('the order book is unreachable right now (HTTP ' + r.status + ')');
    return r.json();
  };

  async function feeIn(asset, vsize) {
    const rates = await core.ncall('getfeeexchangerates');
    const rate = rates[asset];
    if (!(Number(rate) > 0)) throw new Error('the network takes no fees in ' + meta.ticker(asset) + ' right now, and a trade pays its fees in the asset it gives');
    let floor = REF_FEERATE_KVB;
    try { const ni = await core.ncall('getnetworkinfo'); const f = amountToAtoms(ni.relayfee); if (f > floor) floor = f; } catch {}
    return ceilDiv(ceilDiv(floor * vsize, 1000n) * 100000000n, BigInt(rate));
  }

  // The orders of one market, each at what it can be filled for now.
  async function offersOf(base, quote) {
    const out = [];
    for (const [b, q] of [[base, quote], [quote, base]]) {
      const j = await relayGet(`/v1/market/${b}/${q}/orderbook`);
      if (!j) continue;
      (j.offers || []).forEach((o, i) => {
        const st = (j.statuses || [])[i];
        if (st && st.active_amount != null) o = { ...o, offer_amount: String(st.active_amount), _signed_amount: o.offer_amount };
        out.push(o);
      });
    }
    return out;
  }

  async function heldAtoms(asset) {
    const u = await core.wcall('listunspent', [0, 9999999, [], false, { asset }]);
    return u.filter((x) => x.spendable !== false && (!x.amountblinder || /^0+$/.test(x.amountblinder))).reduce((s, x) => s + amountToAtoms(x.amount), 0n);
  }

  async function tipMedianTime() {
    const c = await core.ncall('getblockchaininfo');
    return Number(c.mediantime);
  }

  // A one-use RPC door for the taker: a random user and password on a loopback port,
  // passed on to the Core wallet with this computer's real credentials, for the methods
  // a fill needs and nothing else, shut when the fill is done. The real credentials never
  // appear on a command line, which other users of the machine can read.
  const TAKER_METHODS = new Set(['getblockchaininfo', 'getnetworkinfo', 'getfeeexchangerates', 'gettxout', 'getrawtransaction', 'decoderawtransaction',
    'listunspent', 'lockunspent', 'getnewaddress', 'getaddressinfo', 'signrawtransactionwithwallet', 'testmempoolaccept', 'sendrawtransaction',
    'getrawmempool', 'getmempoolentry', 'getblockcount', 'getbestblockhash', 'decodescript', 'getsidechaininfo', 'dumpassetlabels', 'getblockhash', 'getblock', 'getblockheader', 'gettransaction', 'getbalances', 'getbalance']);
  async function takerDoor() {
    const user = 'connect', pass = crypto.randomBytes(24).toString('hex');
    const want = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    const seen = new Set();
    const srv = http.createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const deny = (msg) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: null, error: { code: -32601, message: msg }, id: 1 })); };
      if (req.headers.authorization !== want) { res.writeHead(401); res.end(); return; }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { return deny('bad request'); }
      const one = async (b) => {
        if (!TAKER_METHODS.has(b.method)) return { result: null, error: { code: -32601, message: 'refused by sequentia-connect: ' + b.method }, id: b.id };
        seen.add(b.method);
        const onWallet = /^\/wallet\//.test(req.url);
        try { return { result: await core.call(b.method, b.params || [], { wallet: onWallet ? core.wallet : null }), error: null, id: b.id }; }
        catch (e) { return { result: null, error: { code: e.code ?? -1, message: e.message }, id: b.id }; }
      };
      const out = Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    return { url: `http://${user}:${pass}@127.0.0.1:${srv.address().port}`, seen, close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
  }

  async function fillOne(s, payAsset, feeAtoms, base, quote) {
    const door = await takerDoor();
    try {
      const o = s.offer;
      const args = ['covfill', '-relay', relay, '-base', o.pair.base_asset, '-quote', o.pair.quote_asset, '-offer-id', o.offer_id, '-maker-pubkey', o.maker_pubkey,
        '-amount', s.filled.toString(), '-seq-rpc', door.url, '-seq-wallet', core.wallet, '-fee-asset', payAsset, '-spend-fee', feeAtoms.toString(),
        '-max-pay', s.pays.toString()];
      const { stdout } = await run(seqobCli, args, { timeoutMs: 5 * 60_000 });
      const m = stdout.match(/SWAP SETTLED: txid ([0-9a-f]{64})/);
      if (!m) throw new Error('the taker did not say what it broadcast');
      log(`filled ${o.offer_id}: ${m[1]} (node methods used: ${[...door.seen].join(', ')})`);
      return m[1];
    } finally { await door.close(); }
  }

  // Checks the request and answers what the approval shows and what runs after it.
  async function prepare(params) {
    const { type, base, quote, side } = params || {};
    if (type !== 'market' && type !== 'limit') throw new Error("type must be 'market' or 'limit'");
    if (side !== 'buy' && side !== 'sell') throw new Error("side must be 'buy' or 'sell'");
    if (quote === 'BTC' || base === 'BTC') throw new Error('a trade against BTC settles over Lightning, which this connector does not trade on yet; nothing moved');
    if (!isHex64(base) || !isHex64(quote) || base === quote) throw new Error('base and quote must be two different 64-hex asset ids');
    const amount = big(params.amount);
    if (amount <= 0n) throw new Error('the amount must be more than zero');
    const price = type === 'limit' ? big(params.price) : null;
    if (type === 'limit' && !(price > 0n)) throw new Error('a limit order needs its price');
    const bp = await meta.precision(base);
    const offers = await offersOf(base, quote);
    const plan = planTrade({ offers, base, quote, side, amount, price, basePrecision: bp, nowSec: Math.floor(Date.now() / 1000) });
    if (type === 'market' && !plan.slices.length) throw new Error('nothing on the book can be traded at this market right now');
    const rest = type === 'limit' && plan.baseLeft > 0n ? restTerms({ base, quote, side, baseLeft: plan.baseLeft, price, basePrecision: bp }) : null;
    const payAsset = plan.pay;
    const fillFee = await feeIn(payAsset, FILL_VSIZE);
    const restFee = rest ? await feeIn(rest.sell, FUND_VSIZE) : 0n;
    const gives = new Map();
    const add = (a, v) => gives.set(a, (gives.get(a) || 0n) + v);
    add(payAsset, plan.gave + fillFee * BigInt(plan.slices.length));
    if (rest) add(rest.sell, rest.sellAtoms + restFee);
    for (const [a, v] of gives) {
      const held = await heldAtoms(a);
      if (held < v) throw new Error(`this wallet holds ${meta.fmt(a, held)} ${meta.ticker(a)}, and the trade with its fees needs ${meta.fmt(a, v)}`);
    }
    const t = (a) => meta.ticker(a), f = (a, v) => meta.fmt(a, v);
    const lines = [
      `${side === 'buy' ? 'Buy' : 'Sell'} ${f(base, amount)} ${t(base)} ${type === 'limit' ? 'at ' + f(quote, price) + ' ' + t(quote) + ' each, or better' : 'at the market'}`,
      `Market: ${t(base)} / ${t(quote)}  (${base.slice(0, 8)}… / ${quote.slice(0, 8)}…)`,
      ...(plan.slices.length ? [`Takes ${plan.slices.length} order${plan.slices.length > 1 ? 's' : ''} on the book now:`, `  You give: ${f(plan.pay, plan.gave)} ${t(plan.pay)}`, `  You get:  ${f(plan.receive, plan.got)} ${t(plan.receive)}`,
        `  Fees:     ${f(payAsset, fillFee * BigInt(plan.slices.length))} ${t(payAsset)} (one transaction per order)`] : ['Takes nothing on the book now.']),
      ...(rest ? [`Rests on the book: sells ${f(rest.sell, rest.sellAtoms)} ${t(rest.sell)} for ${f(rest.want, rest.wantAtoms)} ${t(rest.want)}, funded now (fee ${f(rest.sell, restFee)} ${t(rest.sell)}),`,
        `  filled by anyone at your price; what is left can be taken back after ${ORDER_SECONDS / 3600} hours`] : []),
      ...(type === 'market' && plan.baseLeft > 0n ? [`The book holds only ${f(base, plan.baseDone)} ${t(base)} near the best price; the rest is not traded`] : []),
    ];
    return { plan, rest, payAsset, fillFee, restFee, lines, base, quote, side, type, price, amount };
  }

  async function placeRest(p, origin) {
    const { rest } = p;
    const st = load();
    const id = seqob.randHex(16);
    let credit;
    try { credit = await core.wcall('getnewaddress', ['sequentia-connect credit', 'bech32m']); }
    catch (e) {
      if (/legacy wallet/i.test(e.message)) throw new Error('resting an order needs a descriptor wallet in Sequentia Core, whose taproot addresses receive what the order is paid: create one with createwallet and descriptors=true');
      throw e;
    }
    const info = await core.wcall('getaddressinfo', [credit]);
    if (Number(info.witness_version) !== 1 || !isHex64(info.witness_program)) throw new Error('the Core wallet gave no taproot address for the order\'s credits');
    const refundPriv = keyOf('refund', id);
    const makerX = hex(schnorr.getPublicKey(refundPriv));
    const expiry = orderExpiryTime(await tipMedianTime(), ORDER_SECONDS);
    const plan = planPlaceOrder({
      assetA: rev(rest.sell), assetB: rev(rest.want), sellAtoms: rest.sellAtoms, rateNum: rest.rateNum, rateDen: rest.rateDen, minLot: rest.minLot,
      expiryLocktime: expiry, makerProg: info.witness_program, makerX,
    });
    const address = (await core.ncall('decodescript', [plan.spkHex])).address;
    if (!address) throw new Error('the node cannot name the order\'s address');
    const offerPriv = keyOf('offer', id);
    const rec = {
      id, origin, at: Date.now(), market: { base: p.base, quote: p.quote }, side: p.side, price: String(p.price), base_amount: p.plan.baseLeft.toString(),
      sell: rest.sell, want: rest.want, sell_atoms: rest.sellAtoms.toString(), want_atoms: rest.wantAtoms.toString(), rate_num: rest.rateNum.toString(), rate_den: rest.rateDen.toString(),
      min_lot: rest.minLot.toString(), expiry, maker_prog: info.witness_program, maker_x: makerX, credit_address: credit, spk: plan.spkHex,
      offer_id: id, maker_pubkey: hex(secp256k1.getPublicKey(offerPriv, true)), txid: null, vout: null,
    };
    st.orders.push(rec); save(st);
    const txid = await core.call('sendtoaddress', {
      address, amount: Number(atomsToAmount(rest.sellAtoms)), assetlabel: rest.sell, fee_asset_label: rest.sell, replaceable: false, avoid_reuse: false,
    });
    const tx = await core.wcall('getrawtransaction', [txid, true]).catch(() => null) || await core.ncall('getrawtransaction', [txid, true]);
    const vout = tx.vout.findIndex((o) => o.scriptPubKey && o.scriptPubKey.hex === plan.spkHex);
    if (vout < 0) throw new Error('the funding transaction ' + txid + ' pays no output to the order');
    const s2 = load(); const r2 = s2.orders.find((o) => o.id === id); Object.assign(r2, { txid, vout }); save(s2);
    return { id, txid, vout };
  }

  // Lists each order whose funding is in a block and that the relay does not list yet.
  async function progress() {
    const st = load();
    let changed = false;
    for (const rec of st.orders) {
      if (rec.withdrawn_txid || !rec.txid || rec.posted_at) continue;
      try {
        const tx = await core.wcall('gettransaction', [rec.txid]);
        if (!(tx.confirmations > 0)) continue;
        seqob.setSeqobBase(relay);
        const now = Math.floor(Date.now() / 1000);
        await postExisting({
          assetA: rev(rec.sell), assetB: rev(rec.want), sellAtoms: big(rec.sell_atoms), rateNum: big(rec.rate_num), rateDen: big(rec.rate_den), minLot: big(rec.min_lot),
          expiryLocktime: rec.expiry, makerProg: rec.maker_prog, makerX: rec.maker_x, txid: rec.txid, vout: rec.vout, offerId: rec.offer_id, makerPubkey: rec.maker_pubkey,
          nowUnix: now, ttlSecs: Math.max(60, Math.min(7 * 86400 - 60, rec.expiry - now - 60)),
        }, {
          fetchOutput: async (txid, vout) => {
            const t = await core.ncall('getrawtransaction', [txid, true]);
            const o = t.vout[vout];
            return o ? { scriptPubKey: o.scriptPubKey.hex, asset: o.asset ?? null, value: o.value != null ? amountToAtoms(o.value).toString() : null } : null;
          },
          postCovenantOffer: (offer) => seqob.postCovenantOffer(offer, keyOf('offer', rec.id)),
        });
        rec.posted_at = now; rec.post_error = null; changed = true;
        log(`listed order ${rec.id} at ${rec.txid}:${rec.vout}`);
      } catch (e) {
        const m = String(e.message || e);
        if (/already/i.test(m)) { rec.posted_at = Math.floor(Date.now() / 1000); rec.post_error = null; }
        else rec.post_error = m;
        changed = true;
      }
    }
    if (changed) save(st);
  }

  async function fillsOf(a, b) {
    try { const j = await relayGet(`/v1/market/${a}/${b}/fills?limit=500`); return (j && j.fills) || []; } catch { return []; }
  }

  return {
    progress,
    async placeOrder(params, ctx, approver) {
      const p = await prepare(params);
      const ok = await approver.ask({ title: 'A site asks to trade', origin: ctx.origin, lines: p.lines });
      if (!ok) throw new Rejected();
      const trade = { trade: seqob.randHex(12), at: Date.now(), origin: ctx.origin, market: { base: p.base, quote: p.quote }, side: p.side, type: p.type, kind: 'chain', order: null, fills: [] };
      const failed = [];
      let filled = 0, gave = 0n, got = 0n;
      for (const s of p.plan.slices.slice(0, MAX_ORDERS_PER_TRADE)) {
        try {
          const txid = await fillOne(s, p.payAsset, p.fillFee, p.base, p.quote);
          filled++; gave += s.pays; got += s.filled;
          trade.fills.push({ txid, base: (p.side === 'buy' ? s.filled : s.pays).toString(), quote: (p.side === 'buy' ? s.pays : s.filled).toString() });
        } catch (e) { failed.push({ offer: s.offerId, error: e.message }); }
      }
      let order = null, orderError = null;
      if (p.rest) {
        try { order = (await placeRest(p, ctx.origin)).id; trade.order = order; }
        catch (e) { orderError = e.message; }
      }
      const st = load(); st.trades.push(trade); save(st);
      progress().catch(() => {});
      return { trade: trade.trade, filled, failed, order, order_error: orderError, gave: gave.toString(), got: got.toString() };
    },

    async getOrders(ctx) {
      await progress().catch(() => {});
      const st = load();
      const median = await tipMedianTime().catch(() => Math.floor(Date.now() / 1000));
      const orders = [];
      for (const rec of st.orders.filter((o) => o.origin === ctx.origin)) {
        const fills = await fillsOf(rec.sell, rec.want);
        const pr = orderProgress(rec, fills);
        const lock = lockState(rec.expiry, { medianTime: median });
        const baseOf = (sellAtoms) => (rec.side === 'sell' ? sellAtoms : ceilDiv(sellAtoms * big(rec.rate_num), big(rec.rate_den)));
        const state = rec.withdrawn_txid ? 'withdrawn' : !rec.posted_at ? 'placing' : pr.holds === 0n ? (pr.final ? 'filled' : 'filling') : pr.filled > 0n ? 'open' : 'open';
        orders.push({
          order: rec.id, market: rec.market, side: rec.side, price: rec.price, at: rec.at, amount: rec.base_amount,
          filled: (rec.side === 'sell' ? pr.filled : baseOf(pr.filled) > big(rec.base_amount) ? big(rec.base_amount) : baseOf(pr.filled)).toString(),
          holds: pr.holds.toString(), sell: rec.sell, state, settled: pr.final,
          take_back_from: rec.expiry, take_back_from_text: new Date(rec.expiry * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          can_take_back: false, fills: pr.fills, note: rec.post_error || (lock && lock.locked === false ? 'its time has run out' : null),
        });
      }
      const trades = [];
      for (const t of st.trades.filter((x) => x.origin === ctx.origin)) {
        const fills = [];
        for (const f of t.fills) {
          const recs = (await fillsOf(t.market.base, t.market.quote)).concat(await fillsOf(t.market.quote, t.market.base)).filter((x) => x.txid === f.txid);
          const last = recs[recs.length - 1];
          fills.push({ ...f, state: last && last.state === 'final' ? 'settled' : 'sent' });
        }
        trades.push({ trade: t.trade, at: t.at, market: t.market, side: t.side, type: t.type, kind: t.kind, order: t.order,
          state: fills.length && fills.every((f) => f.state === 'settled') ? 'settled' : 'sent', fills });
      }
      return { orders, trades };
    },

    async cancelOrder(params, ctx) {
      const st = load();
      const rec = st.orders.find((o) => o.id === (params && params.order) && o.origin === ctx.origin);
      if (!rec) throw new Error('no such order of this site');
      if (rec.withdrawn_txid) throw new Error('this order was taken back already');
      const median = await tipMedianTime();
      if (median < rec.expiry) {
        throw new Error('this order can be taken back from ' + new Date(rec.expiry * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC; until then it stays on the book for anyone to fill at your price');
      }
      throw new Error('taking an order back is not served by this connector yet: its refund key is in ' + path.join(datadir, 'maker.seed') + ' (order ' + rec.id + ')');
    },
  };
}
