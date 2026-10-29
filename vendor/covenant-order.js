// ---------------------------------------------------------------------------
// SeqOB passive-CLOB order flow — the front-end logic that turns the byte-exact
// covenant (covenant.js) into a PLACE-ORDER / WATCH-FOR-FILL experience:
//
//   place(order)      -> derive the covenant scriptPubKey, work out the funding
//                        amount, and produce the CovenantTerms the maker posts
//                        to the relay. The maker then FUNDS the covenant spk from
//                        their balance (host send path) and can go OFFLINE.
//   onMatched(msg)    -> when the relay's matcher crosses this order, if THIS
//                        wallet is the aggressor (taker) build the permissionless
//                        FILL spend against the resting covenant and broadcast it.
//                        If this wallet is the resting maker it signs NOTHING —
//                        the taker settles; the maker just reflects order_status.
//   cancel(...)       -> stop advertising (relay OfferCancel) and, after expiry,
//                        reclaim the funds via the REFUND leaf.
//   postExisting(...) -> post an order whose coin already rests on the chain (an
//                        offboard from leaves into the order's address), once the
//                        output there pays the terms' script with exactly its amount.
//
// The covenant scriptPubKey + FILL witness + fill recipe are 100% pure JS
// (covenant.js, byte-matched to the chain). The ONE thing that is NOT expressible
// with the wallet's currently-bundled libs is assembling + signing the final raw
// Elements FILL transaction (a taproot-script-path covenant input with a custom
// final witness, an explicit asset-B maker-credit output, an optional self-
// replicating remainder, plus the taker's own signed asset-B funding inputs).
// LWK's exposed PSET/TxBuilder surface cannot inject such an input, and the only
// raw-Elements script-spend builders it exposes (buildSeqHtlcClaimTx /
// xchainSeqClaim) are HTLC-shaped and sign internally. So the terminal assembly
// is routed through a single documented host seam, hooks.buildCovenantFillTx,
// which the wallet fulfils with a small Rust/wasm helper mirroring
// buildSeqHtlcClaimTx (see the report's "remaining integration steps"). This
// module builds and byte-verifies everything that helper consumes.
// ---------------------------------------------------------------------------

import { deriveTaptree, verifyAgainstSPK, planFill, ceilPrice, bytesToHex, hexToBytes, NUMS, LOCKTIME_THRESHOLD } from './covenant.js';
import { buildCovenantOffer, leafProductFits } from './covenant-flow.js';

// --- CovenantTerms (seqob.v1.Offer field 23) <-> Order ----------------------

// buildCovenantTerms maps a derived order into the exact CovenantTerms message a
// taker re-derives and verifies. All asset ids / keys are INTERNAL byte order
// hex, as on-chain introspection returns them (the same convention leaf.go uses).
export function buildCovenantTerms(order, covenantTxid, covenantVout, tap){
  tap = tap || deriveTaptree(order);
  const internalKey = order.internalKey ? hexToBytes(order.internalKey) : NUMS;
  return {
    covenant_txid: covenantTxid,
    covenant_vout: covenantVout >>> 0,
    asset_a: hexOf(order.assetA),
    asset_b: hexOf(order.assetB),
    rate_num: String(BigInt(order.rateNum)),
    rate_den: String(BigInt(order.rateDen)),
    maker_prog: hexOf(order.makerProg),           // bytes (32) — v1 taproot payout program
    maker_prog_ver: (order.makerVer == null ? 1 : order.makerVer) >>> 0,
    min_lot: String(BigInt(order.minLot)),
    expiry_locktime: Number(order.expiryLocktime) >>> 0,
    maker_x: hexOf(order.makerX),                 // bytes (32)
    internal_key: bytesToHex(internalKey),        // bytes (32) — NUMS by default
    merkle_path: tap.merklePath.map(bytesToHex),  // repeated bytes (32 each)
  };
}

// orderFromCovenantTerms reconstructs the covenant Order a taker fills, from a
// relay-served CovenantTerms (field names tolerant of snake/camel).
export function orderFromCovenantTerms(ct){
  const g = (...names) => { for (const n of names) if (ct[n] !== undefined && ct[n] !== null) return ct[n]; return undefined; };
  return {
    assetA: g('asset_a','assetA'),
    assetB: g('asset_b','assetB'),
    rateNum: BigInt(g('rate_num','rateNum') || 0),
    rateDen: BigInt(g('rate_den','rateDen') || 0),
    makerProg: g('maker_prog','makerProg'),
    makerVer: Number(g('maker_prog_ver','makerProgVer') ?? 1),
    minLot: BigInt(g('min_lot','minLot') || 0),
    expiryLocktime: Number(g('expiry_locktime','expiryLocktime') || 0),
    makerX: g('maker_x','makerX'),
    internalKey: g('internal_key','internalKey'),
    _txid: g('covenant_txid','covenantTxid'),
    _vout: Number(g('covenant_vout','covenantVout') || 0),
  };
}

function hexOf(v){ return typeof v === 'string' ? v.toLowerCase() : bytesToHex(v); }

// --- place order ------------------------------------------------------------

// planPlaceOrder derives the covenant an order needs, WITHOUT any wallet I/O.
// params:
//   assetA/assetB  32-byte internal-order asset id hex (A rests, B pays for it)
//   sellAtoms      atoms of A to lock in the covenant (>= minLot)
//   rateNum/rateDen  price: a taker owes ceil(filled*num/den) of B
//   minLot         dust-griefing floor on filled and on any remainder
//   expiryLocktime absolute lock the maker may REFUND-reclaim after: a median
//                  time (unix seconds, >= 500,000,000) or a block height (below)
//   makerProg      32-byte v1-taproot program that receives the asset-B credit
//                  (a taproot output THIS wallet controls, so it can spend it).
//                  It must be a plain key, never an Arca leaf or board script:
//                  one maker-and-operator signature pair over such a script
//                  spends two equal credits paid to it at once.
//   makerX         32-byte x-only key authorizing the REFUND leaf (wallet key)
//   internalKey    optional, and only the NUMS point: any other key is a key
//                  path that takes the order back from under a taker, which
//                  takers and the relay refuse, so it is refused here too
// Returns { order, tap, spkHex, sellAtoms, requiredBForFull } — the maker then
// funds spkHex with sellAtoms of A and posts buildCovenantTerms(order, txid,vout).
export function planPlaceOrder(params){
  const {
    assetA, assetB, sellAtoms, rateNum, rateDen, minLot,
    expiryLocktime, makerProg, makerX, internalKey,
  } = params;
  const sell = BigInt(sellAtoms);
  if (sell < BigInt(minLot)) throw new Error(`sell ${sell} below min_lot ${minLot}`);
  if (internalKey && bytesToHex(hexToBytes(internalKey)) !== bytesToHex(NUMS))
    throw new Error(`internal key ${bytesToHex(hexToBytes(internalKey))} is not the NUMS point: it is a key path that takes ` +
      'the order back from under any taker; takers and the relay refuse such an order, so the wallet places only NUMS-keyed ones');
  const order = {
    assetA, assetB,
    rateNum: BigInt(rateNum), rateDen: BigInt(rateDen), minLot: BigInt(minLot),
    makerProg, makerVer: 1, expiryLocktime: Number(expiryLocktime), makerX,
    ...(internalKey ? { internalKey } : {}),
  };
  const tap = deriveTaptree(order);
  return {
    order, tap,
    spkHex: bytesToHex(tap.scriptPubKey),
    sellAtoms: sell,
    requiredBForFull: ceilPrice(sell, rateNum, rateDen),
  };
}

// place() drives the full maker flow: derive -> fund the covenant spk from the
// wallet -> post the signed CovenantTerms offer. Wallet I/O is injected so the
// pure derivation stays testable.
//   hooks.spkToAddress(spkHex) -> Promise<addressString>   (LWK Address for the network)
//   hooks.fundToAddress(address, assetHex, atoms) -> Promise<{txid, vout}>
//   hooks.postCovenantOffer(offer) -> Promise<any>          (seqob.postCovenantOffer)
export async function place(params, hooks){
  const plan = planPlaceOrder(params);
  const address = await hooks.spkToAddress(plan.spkHex);
  const { txid, vout } = await hooks.fundToAddress(address, hexOf(params.assetA), plan.sellAtoms);
  const covenant = buildCovenantTerms(plan.order, txid, vout, plan.tap);
  const posted = await hooks.postCovenantOffer({ order: plan.order, covenant, plan });
  return { plan, address, txid, vout, covenant, posted };
}

// --- post an order whose coin already rests on the chain -------------------

// postExisting publishes an order whose coin something other than this wallet's
// own send put on the chain: an offboard from leaves into the order's address, or
// any funding the maker made elsewhere. Nothing is funded and nothing is signed
// but the offer. The relay is told nothing the chain does not show: the output at
// (txid, vout) is read through the host (`hooks.fetchOutput`), and the offer is
// posted only when that output pays the very script the terms make, holds asset A
// in the clear, and holds exactly `sellAtoms` (the relay lists a covenant only
// when its outpoint holds exactly the offer amount).
//   params: planPlaceOrder's (asset ids in INTERNAL order, as the leaf commits
//           them; the offer's pair is their display form), plus
//     txid, vout       where the order rests
//     offerId          the offer's id (16 random bytes in hex by convention)
//     makerPubkey      the 33-byte hex key the offer is signed with
//     nowUnix, ttlSecs the offer's created and expiry times on the relay (the
//                      covenant's own REFUND lock is in the terms)
//   hooks.fetchOutput(txid, vout) -> Promise<{ scriptPubKey, asset, value }>
//                      the output as the wallet's node or explorer reads it:
//                      script hex, asset DISPLAY hex (null when blinded),
//                      value atoms (null when blinded)
//   hooks.postCovenantOffer(offer) -> Promise<any>   (seqob.postCovenantOffer, signing)
// Returns { plan, covenant, offer, posted }. Throws before posting on any mismatch.
export async function postExisting(params, hooks){
  const plan = planPlaceOrder(params);
  if (!leafProductFits(plan.sellAtoms, plan.order.rateNum, plan.order.rateDen))
    throw new Error('the order\'s amount and rate overflow the fill leaf\'s arithmetic: no taker could fill it');
  const txid = String(params.txid || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error('the order\'s txid must be 64 hex');
  const vout = Number(params.vout);
  if (!Number.isInteger(vout) || vout < 0) throw new Error('the order\'s vout must be a non-negative integer');
  const out = await hooks.fetchOutput(txid, vout);
  if (!out) throw new Error(`no output ${txid}:${vout} on the chain`);
  verifyAgainstSPK(plan.order, out.scriptPubKey);
  const displayA = revHex(hexOf(params.assetA)), displayB = revHex(hexOf(params.assetB));
  if (out.asset == null || out.value == null) throw new Error(`output ${txid}:${vout} hides its asset or value: an order rests in the clear`);
  if (String(out.asset).toLowerCase() !== displayA) throw new Error(`output ${txid}:${vout} holds asset ${out.asset}, and the order sells ${displayA}`);
  if (BigInt(out.value) !== plan.sellAtoms) throw new Error(`output ${txid}:${vout} holds ${out.value}, and the order sells ${plan.sellAtoms}: the relay lists an order only at exactly its amount`);
  const covenant = buildCovenantTerms(plan.order, txid, vout, plan.tap);
  const offer = buildCovenantOffer({
    assetA: displayA, assetB: displayB, sellAtoms: plan.sellAtoms, recvAtoms: plan.requiredBForFull,
    covenant, makerPubkey: params.makerPubkey, offerId: params.offerId,
    nowUnix: params.nowUnix, ttlSecs: params.ttlSecs, allowPartial: true, minLot: plan.order.minLot,
  });
  const posted = await hooks.postCovenantOffer(offer);
  return { plan, covenant, offer, posted };
}

function revHex(h){ return String(h).match(/../g).reverse().join(''); }

// --- taker: settle a Matched cross against a resting covenant ---------------

// planFillFromMatched validates a From.matched carrying a resting covenant and
// returns the FILL recipe the taker broadcasts. It is TRUSTLESS: it re-derives
// the covenant scriptPubKey from the advertised terms and (when an on-chain spk
// is supplied) confirms it equals the funded UTXO's actual spk, so a lying relay
// cannot redirect funds. The covenant input is always index 0 of the FILL tx
// (credit at output 0, remainder at output 1), matching the input-bound map.
//
// matched: { offer_id, fill_base_amount, resting_is_covenant, covenant(Terms),
//            covenant_locked }
// onchainSpkHex (optional): the funded UTXO's real scriptPubKey, fetched from the
//   explorer for covenant_txid:vout — pass it to enforce the equality check.
export function planFillFromMatched(matched, onchainSpkHex, opts){
  opts = opts || {};
  if (!truthy(matched.resting_is_covenant, matched.restingIsCovenant))
    throw new Error('matched order is not a covenant (interactive settlement path)');
  const ct = matched.covenant || matched.Covenant;
  if (!ct) throw new Error('matched is missing covenant terms');
  const order = orderFromCovenantTerms(ct);

  // Re-derive + (if given the on-chain spk) verify the covenant is exactly what
  // the terms claim. A non-NUMS internal key is refused unless explicitly opted
  // into (a hidden maker key-path cancel/rug).
  const tap = onchainSpkHex
    ? verifyAgainstSPK(order, onchainSpkHex, !!opts.makerCancellableOK)
    : deriveTaptree(order);
  if (!onchainSpkHex && !opts.makerCancellableOK && bytesToHex(tap.internalKey) !== bytesToHex(NUMS))
    throw new Error('non-NUMS internal key: maker-cancellable order; refusing to fill without opt-in');

  const locked = BigInt(pick(matched, 'covenant_locked', 'covenantLocked') || 0);
  const filled = BigInt(pick(matched, 'fill_base_amount', 'fillBaseAmount') || 0);
  const plan = planFill(order, locked, filled, 0);   // covenant is input 0

  return {
    order, tap, plan,
    // Everything the FILL tx needs, cross-checked. The maker credit at output 0
    // is asset B (= what the maker wants), value >= requiredB, spk = maker_prog.
    creditAsset: hexOf(order.assetB),
    creditProg: hexOf(order.makerProg),
    creditProgVer: order.makerVer,
    creditValue: plan.requiredB,
    remainderAsset: hexOf(order.assetA),
    remainderValue: plan.remainder,       // 0 for a full fill
    remainderSpkHex: bytesToHex(plan.orderSpk),   // == covenant spk (self-replicating)
    partial: plan.partial,
    covenantTxid: order._txid, covenantVout: order._vout,
    covenantAsset: hexOf(order.assetA),
    covenantLocked: locked,
    // The covenant input's witness: [FILL leaf, control block]. No signature.
    covenantWitness: plan.witness.map(bytesToHex),
    fillLeafHex: bytesToHex(plan.fillLeaf),
    controlBlockHex: bytesToHex(plan.controlBlock),
  };
}

// settleFill drives the taker settlement: build the FILL recipe, hand it to the
// wasm host to assemble + sign + broadcast the raw Elements FILL tx, and report
// progress. The covenant input needs no signature; the host signs only the
// taker's own asset-B funding inputs.
//
//   hooks.fetchUtxoSpk(txid, vout) -> Promise<spkHex|null>   (explorer lookup; optional)
//   hooks.fetchUtxoValue(txid, vout) -> Promise<atoms|null>   (the coin's explicit value; optional)
//   hooks.buildCovenantFillTx(recipe) -> Promise<{rawHex, txid?}>   THE wasm seam
//   hooks.broadcast(rawHex) -> Promise<txid>
//   hooks.onStatus(msg)     -> progress (optional)
export async function settleFill(matched, hooks){
  const status = (m) => { try { hooks.onStatus && hooks.onStatus(m); } catch {} };
  status('Verifying the resting order…');
  let onchainSpk = null;
  if (hooks.fetchUtxoSpk){
    try { onchainSpk = await hooks.fetchUtxoSpk(pickCt(matched)._txid, pickCt(matched)._vout); } catch {}
  }
  // The locked amount is read from the coin, never taken on the relay's word. An order the relay
  // re-pointed at its remainder after a partial fill can still advertise its earlier size, and a
  // fill sized against that pays the covenant's asset out unbalanced: consensus refuses it as
  // "bad-txns-in-ne-out, value in != value out", after the user has confirmed.
  if (hooks.fetchUtxoValue){
    let held = null;
    try { held = await hooks.fetchUtxoValue(pickCt(matched)._txid, pickCt(matched)._vout); } catch {}
    if (held != null && BigInt(held) !== BigInt(pick(matched, 'covenant_locked', 'covenantLocked') || 0)){
      if (BigInt(pick(matched, 'fill_base_amount', 'fillBaseAmount') || 0) > BigInt(held))
        throw new Error('this resting order holds less than the fill now (part of it was taken); nothing was sent, take another offer');
      matched = { ...matched, covenant_locked: String(BigInt(held)) };
    }
  }
  const recipe = planFillFromMatched(matched, onchainSpk, hooks.opts);
  if (!hooks.buildCovenantFillTx)
    throw new Error('covenant FILL tx assembly needs the buildCovenantFillTx wasm helper (not yet in this build)');
  status('Building your FILL spend…');
  const built = await hooks.buildCovenantFillTx(recipe);
  status('Broadcasting…');
  const txid = await hooks.broadcast(built.rawHex);
  status('Settling. Anchor-bound to Bitcoin.');
  return { txid, recipe };
}

function pickCt(matched){ return orderFromCovenantTerms(matched.covenant || matched.Covenant || {}); }

// --- refund / cancel --------------------------------------------------------

// planRefund re-derives the covenant an order placed and returns the REFUND recipe
// the wasm helper (buildCovenantRefundTx) consumes to reclaim the locked asset A.
// It is the maker's mirror of planFillFromMatched: pure derivation, no wallet I/O.
//   order        the covenant Order this wallet placed (assetA/B, rate, minLot,
//                expiryLocktime, makerProg, makerX, internalKey)
//   utxo         { txid, vout, locked }  — the funded covenant UTXO being reclaimed
// Returns every byte-exact field the refund tx needs: the covenant scriptPubKey
// (the sighash prevout), the REFUND leaf, its control block, and the CLTV expiry.
export function planRefund(order, utxo){
  const tap = deriveTaptree(order);
  return {
    covenantTxid: utxo.txid,
    covenantVout: (utxo.vout >>> 0),
    covenantAsset: hexOf(order.assetA),
    covenantLocked: String(BigInt(utxo.locked)),
    covenantSpkHex: bytesToHex(tap.scriptPubKey),
    refundLeafHex: bytesToHex(tap.refundLeaf),
    controlBlockHex: bytesToHex(tap.refundControlBlock),
    expiryLocktime: Number(order.expiryLocktime) >>> 0,
    // The maker key the REFUND leaf commits to (== order.makerX) is the wallet's
    // BIP86 internal key; makerKeyPath tells the helper which key to sign with.
    makerX: hexOf(order.makerX),
    tap,
  };
}

// cancel stops advertising the order on the relay immediately (OfferCancel), and,
// once the covenant's lock has passed (a height lock: tip >= expiry; a median-time
// lock: the tip's median time > expiry), reclaims the locked asset A via the
// REFUND leaf. Pre-expiry the on-chain funds are untouchable by anyone but a
// taker paying the price — that is the point — so the relay cancel just delists it
// and reports the funds as reclaimable-after-expiry (never a failure).
//   hooks.relayCancel(offerId) -> Promise<any>              (seqob.signAndCancel)
//   hooks.buildCovenantRefundTx(recipe) -> Promise<{rawHex, txid?}>  (wasm seam; maker sig)
//   hooks.broadcast(rawHex) -> Promise<txid>
//   refundParams: { recipe, tipHeight, tipTime, expiryLocktime }  (recipe from
//                  planRefund merged with fee/addresses; tipHeight, or for a
//                  median-time lock tipTime, the tip's median time, decides
//                  mature vs immature)
export async function cancel(offerId, refundParams, hooks){
  const out = { delisted: false, refundTxid: null, reclaimable: null, matured: false };
  if (hooks.relayCancel){ try { await hooks.relayCancel(offerId); out.delisted = true; } catch (e){ out.delistError = e.message; } }
  if (refundParams){
    const expiry = Number(refundParams.expiryLocktime != null ? refundParams.expiryLocktime : (refundParams.recipe && refundParams.recipe.expiryLocktime));
    const timeLock = expiry >= LOCKTIME_THRESHOLD;
    const tip = Number(timeLock ? refundParams.tipTime : refundParams.tipHeight);
    out.matured = Number.isFinite(tip) && Number.isFinite(expiry) && (timeLock ? tip > expiry : tip >= expiry);
    if (out.matured && hooks.buildCovenantRefundTx){
      const built = await hooks.buildCovenantRefundTx(refundParams.recipe || refundParams);
      out.refundTxid = await hooks.broadcast(built.rawHex);
    } else {
      // Not yet matured (or no on-chain funds): surface WHEN the maker may reclaim,
      // rather than failing — the delist already stopped new fills.
      out.reclaimable = timeLock ? { afterTime: expiry } : { afterHeight: expiry };
    }
  }
  return out;
}

// --- helpers ----------------------------------------------------------------

function truthy(...vs){ for (const v of vs) if (v === true || v === 'true' || v === 1) return true; return false; }
function pick(obj, ...names){ for (const n of names){ if (obj && obj[n] !== undefined && obj[n] !== null) return obj[n]; } return undefined; }

export const __test__ = { buildCovenantTerms, orderFromCovenantTerms, planPlaceOrder, planFillFromMatched, planRefund, cancel, postExisting, hexOf, revHex };
