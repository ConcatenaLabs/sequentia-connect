// JSON-RPC to a Sequentia Core (or Bitcoin Core) node, with the credentials read from
// this computer: a cookie file, or a user and a password file. The credentials are
// held in this process only; nothing here ever hands them to a site.
import fs from 'node:fs';

export function readSecret(file) {
  return fs.readFileSync(file, 'utf8').trim();
}

// cfg: { url, wallet?, cookie? | user + passwordFile? }
export function rpcClient(cfg) {
  if (!cfg || !cfg.url) throw new Error('a node needs its RPC url');
  const base = cfg.url.replace(/\/+$/, '');
  const auth = () => {
    if (cfg.cookie) return readSecret(cfg.cookie);
    if (cfg.user) return cfg.user + ':' + (cfg.passwordFile ? readSecret(cfg.passwordFile) : (cfg.password || ''));
    return null;
  };
  async function call(method, params = [], { wallet = cfg.wallet } = {}) {
    const url = wallet ? `${base}/wallet/${encodeURIComponent(wallet)}` : base + '/';
    const a = auth();
    let r;
    try {
      r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(a ? { authorization: 'Basic ' + Buffer.from(a).toString('base64') } : {}) },
        body: JSON.stringify({ jsonrpc: '1.0', id: 1, method, params }),
      });
    } catch (e) { throw new Error(`the node at ${base} is not answering (${e.cause?.code || e.message})`); }
    if (r.status === 401) throw new Error(`the node at ${base} refused the credentials in this computer's configuration`);
    let j;
    try { j = await r.json(); } catch { throw new Error(`the node at ${base} answered HTTP ${r.status}`); }
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; throw e; }
    return j.result;
  }
  return { call, wcall: (m, p) => call(m, p), ncall: (m, p) => call(m, p, { wallet: null }), base, wallet: cfg.wallet, auth };
}

// "1.23456789" or 1.23456789 (an amount as a node prints it, always eight decimals of
// the asset's atoms) -> atoms as a BigInt, without passing through a float product.
export function amountToAtoms(v) {
  const s = typeof v === 'number' ? v.toFixed(8) : String(v);
  const neg = s.startsWith('-');
  const [i, f = ''] = (neg ? s.slice(1) : s).split('.');
  const atoms = BigInt(i || '0') * 100000000n + BigInt((f + '00000000').slice(0, 8));
  return neg ? -atoms : atoms;
}
export function atomsToAmount(a) {
  const n = BigInt(a);
  const neg = n < 0n; const x = neg ? -n : n;
  return (neg ? '-' : '') + (x / 100000000n).toString() + '.' + (x % 100000000n).toString().padStart(8, '0');
}
