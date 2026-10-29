// The provider protocol's methods, answered from a person's own stack: a Sequentia
// Core wallet, a Lightning node (SeqLN or CLN), a leaf wallet (`arca`) and, for BTC on
// its own chain, a Bitcoin Core wallet. Each part is optional; a method whose part is
// not configured is not listed in getCapabilities, and refused if called.
//
// Silent methods answer at once. Every method that signs, pays or places something asks
// the owner in the terminal first (approve.mjs) and does nothing on any answer but yes.
import fs from 'node:fs';
import path from 'node:path';
import { amountToAtoms } from './rpc.mjs';
import { market as makeMarket } from './market.mjs';
import { Rejected } from './approve.mjs';
import { PROVIDER } from './server.mjs';

const SILENT_NO_SESSION = new Set(['getCapabilities', 'getNetwork', 'getWalletMode', 'getAccounts', 'connect']);
const notConnected = () => Object.assign(new Error('this site is not connected; call connect first'), { code: 'no_session' });
const isHex64 = (s) => /^[0-9a-f]{64}$/.test(String(s || ''));

// Asset names and precisions for the approval's words, from the registry the
// configuration names (the testnet's /registry/index.minimal.json) and the node's labels.
export function assetMeta({ registry, core }) {
  let idx = {};
  let at = 0;
  async function refresh() {
    if (!registry || Date.now() - at < 300_000) return;
    at = Date.now();
    try { const r = await fetch(registry); if (r.ok) idx = await r.json(); } catch {}
  }
  const labels = {};
  async function loadLabels() {
    if (!core) return;
    try { const l = await core.ncall('dumpassetlabels'); for (const [k, v] of Object.entries(l)) labels[v] = k; } catch {}
  }
  const ready = Promise.all([refresh(), loadLabels()]);
  const meta = {
    ready,
    ticker: (h) => (h === 'BTC' ? 'BTC' : (idx[h] && idx[h][1]) || labels[h] || h.slice(0, 8) + '…'),
    precision: async (h) => { await refresh(); return h === 'BTC' ? 8 : (idx[h] && Number.isInteger(idx[h][3]) ? idx[h][3] : 8); },
    precisionSync: (h) => (h === 'BTC' ? 8 : (idx[h] && Number.isInteger(idx[h][3]) ? idx[h][3] : 8)),
    fmt: (h, atoms) => {
      const p = meta.precisionSync(h);
      const a = BigInt(atoms); const u = 10n ** BigInt(p);
      const i = a / u, f = (a % u).toString().padStart(p, '0').replace(/0+$/, '');
      return i.toString() + (f ? '.' + f : '');
    },
  };
  return meta;
}

export function makeStack({ cfg, core, bitcoin, lightning, leaves, approver, datadir, version, log = () => {} }) {
  const meta = assetMeta({ registry: cfg.registry, core });
  const mkt = core && cfg.relay && cfg.seqobCli ? makeMarket({ core, relay: cfg.relay.replace(/\/+$/, ''), seqobCli: cfg.seqobCli, datadir, meta, log }) : null;
  const stateFile = path.join(datadir, 'state.json');
  const state = (() => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; } })();
  const saveState = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  let network = null;
  const mode = cfg.mode === 'developer' ? 'developer' : 'user';

  async function chainInfo() {
    if (network) return network;
    if (core) {
      const ci = await core.ncall('getblockchaininfo');
      network = { network: ci.chain === 'test' ? 'sequentia-testnet' : ci.chain, genesis: await core.ncall('getblockhash', [0]) };
    } else if (leaves) {
      const i = await leaves.call(['info']);
      network = { network: i.chain === 'test' ? 'sequentia-testnet' : i.chain, genesis: i.genesis_hash || (i.wallet && i.wallet.genesis_hash) || null };
    } else network = { network: 'unknown', genesis: null };
    return network;
  }

  // The account a site sees: one Sequentia address of the Core wallet, kept, unblinded
  // (transparent by default), and the BTC address of the Bitcoin wallet when there is one.
  async function accountOf() {
    const n = await chainInfo();
    if (!state.address && core) {
      const a = await core.wcall('getnewaddress', ['sequentia-connect', 'bech32']);
      const info = await core.wcall('getaddressinfo', [a]);
      state.address = info.unconfidential || a;
      saveState();
    }
    if (!state.address && leaves) { state.address = (await leaves.call(['address'])).address; saveState(); }
    if (!state.btcAddress && bitcoin) { state.btcAddress = await bitcoin.wcall('getnewaddress', ['sequentia-connect', 'bech32']); saveState(); }
    return { network: n.network, address: state.address, btcAddress: state.btcAddress || null, openampAid: null };
  }

  const methods = ['getCapabilities', 'getNetwork', 'getWalletMode', 'connect', 'getAccounts', 'getBalances', 'getAddress'];
  if (mkt) methods.push('placeOrder', 'getOrders', 'cancelOrder');
  if (lightning.length) methods.push('lnChannels', 'createInvoice', 'payInvoice');
  if (leaves) methods.push('getLeafBalances', 'getLeafAddress', 'requestLeafReceive');

  const lnFor = (asset) => {
    const want = !asset || asset === 'BTC' ? 'bitcoin' : 'sequentia';
    const n = lightning.find((l) => l.chain === want);
    if (!n) throw new Error(want === 'bitcoin' ? 'no Lightning node on Bitcoin is configured here' : 'no SeqLN node is configured here');
    return n;
  };
  const lnAsset = (asset) => (!asset || asset === 'BTC' ? null : asset);

  const handlers = {
    getCapabilities: async () => ({ provider: PROVIDER, version, network: (await chainInfo().catch(() => ({ network: null }))).network, methods, features: [
      ...(core ? ['sequentia-core'] : []), ...(bitcoin ? ['bitcoin-core'] : []), ...lightning.map((l) => 'lightning-' + l.chain), ...(leaves ? ['leaves'] : []),
    ], events: ['accountsChanged', 'disconnect', 'modeChanged'] }),
    getNetwork: () => chainInfo(),
    getWalletMode: async () => ({ mode }),
    getAccounts: async (p, ctx) => ({ accounts: ctx.connected ? [await accountOf()] : [] }),
    connect: async (p, ctx) => {
      const account = await accountOf();
      if (ctx.connected) return account;
      const ok = await approver.ask({ title: 'A site asks to connect', origin: ctx.origin, lines: [
        `It will see: ${account.address}${account.btcAddress ? ' and ' + account.btcAddress : ''}, and your balances.`,
        'It can ask for trades and payments; each one is shown here first, and nothing is signed until you approve it.',
      ] });
      if (!ok) throw new Rejected();
      return ctx.grant(account);
    },
    getAddress: async () => ({ address: (await accountOf()).address }),

    // Every asset the Core wallet holds in the clear and in blinded coins alike, its
    // policy asset (the Sequence token) one asset among the others; BTC from the
    // Bitcoin wallet, on its own chain; Lightning balances apart, per channel.
    getBalances: async () => {
      const assets = {};
      if (core) {
        for (const u of await core.wcall('listunspent', [0])) {
          if (u.spendable === false || !isHex64(u.asset)) continue;
          assets[u.asset] = ((BigInt(assets[u.asset] || 0)) + amountToAtoms(u.amount)).toString();
        }
      }
      let btc = '0';
      if (bitcoin) { const b = await bitcoin.wcall('getbalances'); btc = (amountToAtoms(b.mine.trusted) + amountToAtoms(b.mine.untrusted_pending || 0)).toString(); }
      return { assets, btc, openamp: {} };
    },

    placeOrder: (p, ctx) => mkt.placeOrder(p, ctx, approver),
    getOrders: (p, ctx) => mkt.getOrders(ctx),
    cancelOrder: (p, ctx) => mkt.cancelOrder(p, ctx),

    lnChannels: async () => {
      const channels = [];
      for (const n of lightning) {
        const { channels: chs = [] } = await n.call('listpeerchannels');
        for (const c of chs) {
          const kind = n.chain === 'bitcoin' ? 'BTC' : (c.channel_asset || c.asset || null);
          const msat = (v) => (v == null ? null : (BigInt(String(v).replace(/msat$/, '')) / 1000n).toString());
          channels.push({ kind, scid: c.short_channel_id || null, state: c.state, spendable: msat(c.spendable_msat) || '0', receivable: msat(c.receivable_msat) });
        }
      }
      return { deployed: lightning.length > 0, channels };
    },
    createInvoice: async (p, ctx) => {
      const n = lnFor(p.asset);
      const amount = BigInt(p.amount || 0);
      if (amount <= 0n) throw new Error('the amount must be more than zero');
      const tk = p.asset && p.asset !== 'BTC' ? meta.ticker(p.asset) : 'BTC';
      const ok = await approver.ask({ title: 'A site asks for an invoice to receive', origin: ctx.origin, lines: [
        `Receive ${meta.fmt(p.asset || 'BTC', amount)} ${tk} over Lightning on your ${n.chain === 'bitcoin' ? 'Bitcoin' : 'SeqLN'} node`, ...(p.memo ? [`Memo: ${String(p.memo).slice(0, 120)}`] : []),
      ] });
      if (!ok) throw new Rejected();
      const label = 'sequentia-connect-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
      const asset = lnAsset(p.asset);
      const r = await n.callNamed('invoice', { amount_msat: (amount * 1000n).toString(), label, description: String(p.memo || 'sequentia-connect'), ...(asset ? { asset } : {}) });
      return { bolt11: r.bolt11, payment_hash: r.payment_hash };
    },
    payInvoice: async (p, ctx) => {
      if (!/^ln/i.test(String(p.bolt11 || ''))) throw new Error('bolt11 must be a Lightning invoice');
      const n = lnFor(p.asset);
      const d = await n.call('decode', [p.bolt11]);
      const amountMsat = d.amount_msat != null ? BigInt(String(d.amount_msat).replace(/msat$/, '')) : null;
      if (amountMsat == null) throw new Error('this invoice names no amount; this connector pays only invoices that do');
      const tk = p.asset && p.asset !== 'BTC' ? meta.ticker(p.asset) : 'BTC';
      const ok = await approver.ask({ title: 'A site asks to pay an invoice', origin: ctx.origin, lines: [
        `Pay ${meta.fmt(p.asset || 'BTC', amountMsat / 1000n)} ${tk} over Lightning from your ${n.chain === 'bitcoin' ? 'Bitcoin' : 'SeqLN'} node`,
        `To: ${d.payee || 'unknown'}`, `For: ${String(d.description || '').slice(0, 120) || '(no description)'}`, `Payment hash: ${d.payment_hash}`,
      ] });
      if (!ok) throw new Rejected();
      const asset = lnAsset(p.asset);
      const r = await n.callNamed('pay', { bolt11: p.bolt11, ...(asset ? { asset } : {}) });
      if (r.status !== 'complete') throw new Error('the payment did not complete: ' + (r.status || 'unknown'));
      return { paid: true, preimage: r.payment_preimage };
    },

    getLeafBalances: async () => {
      if (mode !== 'developer') throw new Error('leaves are a developer-mode rail: turn developer mode on in the wallet\'s Settings');
      // The mailbox first, read and every coin in it checked (it signs nothing), so a
      // coin paid out of round counts as soon as it is there.
      await leaves.call(['mailbox']).catch(() => {});
      const b = await leaves.call(['balance', '--without-bitcoin']);
      const out = {};
      for (const [asset, v] of Object.entries(b.arca || {})) {
        const states = typeof v === 'object' && v ? Object.fromEntries(Object.entries(v.states || v).filter(([k]) => k !== 'total').map(([k, x]) => [k, String(x)])) : {};
        const total = v && v.total != null ? String(v.total) : Object.values(states).reduce((s, x) => s + BigInt(x), 0n).toString();
        out[asset] = { total, states };
      }
      return { leaves: out, onchain: b.sequentia_onchain || {}, value: b.total || null };
    },
    getLeafAddress: async () => {
      if (mode !== 'developer') throw new Error('leaves are a developer-mode rail: turn developer mode on in the wallet\'s Settings');
      if (!state.leafAddress) { const a = await leaves.call(['address']); state.leafAddress = a.address; saveState(); }
      return { address: state.leafAddress };
    },
    requestLeafReceive: async (p, ctx) => {
      if (mode !== 'developer') throw new Error('leaves are a developer-mode rail: turn developer mode on in the wallet\'s Settings');
      const ok = await approver.ask({ title: 'A site asks for a leaf receive request', origin: ctx.origin, lines: ['A single-use request: a fresh key and owner nonce of your leaf wallet, and its mailbox.'] });
      if (!ok) throw new Rejected();
      const r = await leaves.call(['receive']);
      return { request: r.request || r.text || r };
    },
  };

  return {
    meta, market: mkt, methods,
    async handle(method, params, ctx) {
      if (!methods.includes(method)) throw new Error(`this wallet does not serve ${method}`);
      if (!SILENT_NO_SESSION.has(method) && !ctx.connected) throw notConnected();
      return handlers[method](params, ctx);
    },
  };
}
