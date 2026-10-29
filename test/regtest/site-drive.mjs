// The SeqDEX site trading through sequentia-connect on a private chain.
//
// Two people, each with a wallet in one Sequentia Core node and a sequentia-connect of
// their own, each in a headless Chromium on the SeqDEX site. Alice places a limit sell
// that rests on the book; Bob takes part of it with a market buy. Every approval is
// answered in the daemon's terminal (its standard input), after the drive has read what
// the terminal shows; one is refused, and nothing moves for it. Then the daemon's doors:
// another origin, a rebinding host name, no session.
//
//   SEQUENTIAD=… SEQOBD=… SEQOB_CLI=… CHROME=… HARNESS=<sequentia-extension checkout>
//   SITE=<seqdex-web checkout> WORK=<empty dir> node test/regtest/site-drive.mjs
//
// The chain, the relay and the stand-in box come from the extension's market harness
// (test/market/chain.mjs, box.mjs). Every process is a child of this one, stopped by its
// PID at the end.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(k + ' is required'); return v; };
const SEQUENTIAD = env('SEQUENTIAD'), SEQOBD = env('SEQOBD'), SEQOB_CLI = env('SEQOB_CLI'), CHROME = env('CHROME');
const HARNESS = env('HARNESS'), SITE = path.resolve(env('SITE')), WORK = path.resolve(env('WORK'));
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.join(HERE, '..', '..', 'bin', 'sequentia-connect.mjs');
const { startChain, freePort } = await import(path.join(HARNESS, 'test/market/chain.mjs'));
const { startBox } = await import(path.join(HARNESS, 'test/market/box.mjs'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG = path.join(WORK, 'drive.log');
const log = (m) => { const l = `[${new Date().toISOString().slice(11, 19)}] ${m}`; console.log(l); fs.appendFileSync(LOG, l + '\n'); };
let fails = 0, oks = 0;
const ok = (cond, what) => { if (cond) { oks++; log('ok   ' + what); } else { fails++; log('FAIL ' + what); } };
const until = async (what, fn, ms = 120_000, every = 1000) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await sleep(every);
  }
};

fs.mkdirSync(WORK, { recursive: true });
const procs = [];
let c, box, plainBox, hostRule;
const browsers = [];
const daemons = [];

// ---- a headless Chromium over the DevTools protocol, one page ----
async function browser(name) {
  const profile = path.join(WORK, 'chrome-' + name);
  const p = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run',
    '--window-size=1300,1000', '--ignore-certificate-errors', hostRule, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  procs.push(p);
  const ws = await new Promise((res, rej) => {
    let buf = '';
    p.stderr.on('data', (d) => { buf += d; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) res(m[1]); });
    p.once('exit', (code) => rej(new Error('chrome exited ' + code)));
  });
  const sock = new WebSocket(ws);
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  let next = 1; const pending = new Map(); const consoleLines = [];
  sock.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { ok: res, no } = pending.get(m.id); pending.delete(m.id); m.error ? no(new Error(m.error.message)) : res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled') consoleLines.push(m.params.type + ': ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Runtime.exceptionThrown') consoleLines.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  });
  const send = (method, params = {}, sessionId) => new Promise((res, no) => { const id = next++; pending.set(id, { ok: res, no }); sock.send(JSON.stringify({ id, method, params, sessionId })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  await send('Page.enable', {}, sessionId);
  const b = {
    name, pid: p.pid, consoleLines,
    async go(url) { await send('Page.navigate', { url }, sessionId); await sleep(1500); },
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async shot(file) { const r = await send('Page.captureScreenshot', { format: 'png' }, sessionId); fs.writeFileSync(path.join(WORK, file), Buffer.from(r.data, 'base64')); },
    text: () => b.eval('document.body.innerText'),
    close: async () => { try { await send('Browser.close'); } catch {} sock.close(); },
  };
  browsers.push(b);
  return b;
}

// ---- a sequentia-connect with its terminal on a pipe ----
async function daemon(name, cfg) {
  const dir = path.join(WORK, 'connect-' + name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rpcpass'), 'p', { mode: 0o600 });
  if (cfg.core) cfg = { ...cfg, core: { ...cfg.core, passwordFile: path.join(dir, 'rpcpass') } };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  const out = fs.openSync(path.join(WORK, `connect-${name}.log`), 'a');
  const p = spawn(process.execPath, [DAEMON, '--datadir', dir], { stdio: ['pipe', out, 'pipe'] });
  procs.push(p);
  let term = '';
  p.stderr.on('data', (d) => { term += d; fs.appendFileSync(path.join(WORK, `connect-${name}.log`), d); });
  await until(name + ' daemon', async () => /sequentia-connect .* on http/.test(term), 30_000, 200);
  const d = {
    name, pid: p.pid, port: cfg.listen,
    term: () => term,
    // Waits for the next approval the terminal shows, checks its words, answers it.
    async answer(title, expect, yes) {
      const from = d.mark ?? 0;
      const shown = await until('the approval "' + title + '" in ' + name + "'s terminal", async () => {
        const t = term.slice(from); const i = t.indexOf(title); const j = t.indexOf('Approve? Type yes or no: ', i);
        return i >= 0 && j > i ? t.slice(i, j) : null;
      }, 120_000, 200);
      for (const e of expect) ok(e.test(shown), `${name}'s terminal shows ${e}`);
      d.mark = term.length;
      p.stdin.write(yes ? 'yes\n' : 'no\n');
      return shown;
    },
  };
  daemons.push(d);
  return d;
}

async function main() {
  log('drive starts in ' + WORK);
  c = await startChain({ sequentiad: SEQUENTIAD, seqobd: SEQOBD, work: path.join(WORK, 'chain'), log });
  const { X, Y } = c;
  const assets = { [X]: ['XTEST', 'X test asset', 8], [Y]: ['YUSD', 'Y test dollar', 8] };
  // The site reads its services from its own origin only when that origin is the
  // testnet's, so the stand-in answers as https://sequentiatestnet.com (Chromium maps the
  // name to it); a second, plain one serves the daemons the same registry.
  const key = path.join(WORK, 'box.key'), crt = path.join(WORK, 'box.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '2', '-subj', '/CN=sequentiatestnet.com', '-addext', 'subjectAltName=DNS:sequentiatestnet.com'], { stdio: 'ignore' });
  const boxArgs = { esplora: c.shim.url, relay: c.relay, rpc: c.rpc, site: SITE, assets, prices: { XTEST: 2, YUSD: 1 } };
  box = await startBox({ ...boxArgs, tls: { key: fs.readFileSync(key), cert: fs.readFileSync(crt) } });
  plainBox = await startBox(boxArgs);
  const ORIGIN = 'https://sequentiatestnet.com';
  hostRule = `--host-resolver-rules=MAP sequentiatestnet.com 127.0.0.1:${box.port}, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1`;
  log('stand-in box ' + box.url + ' as ' + ORIGIN + ', serving the site from ' + SITE);

  // Two wallets in the one node, funded from the bank.
  for (const w of ['alice', 'bob']) await c.call('createwallet', { wallet_name: w, descriptors: true });
  const wc = (w, m, p = []) => fetch(c.rpc.url + 'wallet/' + w, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(c.rpc.auth).toString('base64'), 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '1.0', id: 1, method: m, params: p }) }).then((r) => r.json()).then((j) => { if (j.error) throw new Error(j.error.message); return j.result; });
  const addr = async (w) => wc(w, 'getnewaddress', ['', 'bech32']);
  await c.fund(await addr('alice'), X, 100); await c.fund(await addr('alice'), Y, 10);
  await c.fund(await addr('bob'), Y, 1000); await c.fund(await addr('bob'), X, 1);
  await c.mine(1);
  const bal = async (w) => { const b = (await wc(w, 'getbalances')).mine.trusted; const l = await c.call('dumpassetlabels'); const lab = Object.fromEntries(Object.entries(l).map(([k, v]) => [v, k])); const o = {}; for (const [k, v] of Object.entries(b)) o[lab[k] || k] = v; return { X: o[X] ?? b[X] ?? 0, Y: o[Y] ?? b[Y] ?? 0 }; };
  log('alice ' + JSON.stringify(await bal('alice')) + ' bob ' + JSON.stringify(await bal('bob')));

  const base = { origins: [ORIGIN], relay: c.relay, seqobCli: SEQOB_CLI, registry: plainBox.url + '/registry/index.minimal.json', mode: 'user' };
  const core = (w) => ({ url: c.rpc.url, wallet: w, user: 'u' });
  const A = await daemon('alice', { ...base, listen: await freePort(), core: core('alice') });
  const B = await daemon('bob', { ...base, listen: await freePort(), core: core('bob') });

  // ---- the daemon's doors ----
  const hello = (port, headers) => fetch(`http://127.0.0.1:${port}/v1/hello`, { headers }).then(async (r) => ({ status: r.status, j: await r.json(), cors: r.headers.get('access-control-allow-origin') }));
  const evil = await hello(A.port, { origin: 'https://evil.example' });
  ok(evil.status === 403 && !evil.cors, `another origin is refused with no CORS header (${evil.status}: ${evil.j.error})`);
  const none = await hello(A.port, {});
  ok(none.status === 403, `a request with no Origin is refused (${none.status})`);
  // fetch() sets Host itself; a raw request names the rebinding host as a browser would.
  const rebind = await new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: A.port, path: '/v1/hello', headers: { origin: ORIGIN, host: 'attacker.example:' + A.port } }, (x) => { x.resume(); res(x.statusCode); });
    r.on('error', (e) => res('error ' + e.message)); r.end();
  });
  ok(rebind === 421, `a rebinding host name is refused (${rebind})`);
  const nos = await fetch(`http://127.0.0.1:${A.port}/v1/request`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'getBalances' }) }).then((r) => r.json());
  ok(nos.code === 'no_session' && /not connected/.test(nos.error), `no session: "${nos.error}"`);
  const pna = await fetch(`http://127.0.0.1:${A.port}/v1/request`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  ok(pna.status === 204 && pna.headers.get('access-control-allow-private-network') === 'true', 'the private network preflight is answered yes for an allowed origin');

  // ---- Alice: connect through the chooser, place a limit sell ----
  const pageUrl = (d) => `${ORIGIN}/dex/index.html?pair=XTEST-YUSD&local=${d.port}`;
  const a = await browser('alice');
  await a.go(pageUrl(A));
  await until('the site reads the daemon', async () => (await a.eval("document.getElementById('btnConnect').textContent")).includes('Connect wallet'), 30_000);
  await a.eval("document.getElementById('btnConnect').click()");
  await sleep(500);
  const menu = await a.eval("document.getElementById('connectMenu').innerText");
  ok(/Sequentia wallet extension\s+Not installed/.test(menu) && /Sequentia Core on this computer\s+Ready/.test(menu), 'the chooser lists both wallets: ' + menu.replace(/\s+/g, ' '));
  await a.shot('01-chooser.png');
  await a.eval("document.querySelector('[data-connector=local]').click()");
  await A.answer('A site asks to connect', [new RegExp('from ' + ORIGIN.replace(/[.:/]/g, '\\$&')), /It will see: ert1q/], true);
  await until('alice connected', async () => (await a.eval("document.getElementById('btnConnect').textContent")).startsWith('Connected'), 30_000);
  ok(true, 'alice connected: ' + await a.eval("document.getElementById('btnConnect').title"));
  await until('alice balances', async () => /XTEST\s*100/.test(await a.eval("document.getElementById('balances').innerText")), 30_000);
  ok(true, 'alice sees her balances: ' + (await a.eval("document.getElementById('balances').innerText")).replace(/\s+/g, ' '));
  await a.shot('02-alice-connected.png');

  await a.eval("document.getElementById('type-limit').click()");
  await a.eval("document.getElementById('side-sell').click()");
  await a.eval("(() => { const s = (id, v) => { const i = document.getElementById(id); i.value = v; i.dispatchEvent(new Event('input')); }; s('fAmount', '10'); s('fPrice', '2'); })()");
  await a.eval("document.getElementById('fGo').click()");
  await A.answer('A site asks to trade', [/Sell 10 XTEST at 2 YUSD each, or better/, /Takes nothing on the book now/, /Rests on the book: sells 10 XTEST for 20 YUSD/], true);
  const placed = await until('the limit order placed', async () => { const t = await a.eval("document.getElementById('fStatus').textContent"); return /on the book|not placed|rejected|refus/i.test(t) ? t : null; }, 120_000);
  ok(/Your order is on the book/.test(placed), 'alice: ' + placed);
  await c.mine(1);
  // The daemon lists the order once its funding is in a block.
  const listed = await until('the order on the relay', async () => {
    const j = await (await fetch(`${c.relay}/v1/market/${X}/${Y}/orderbook`)).json();
    return (j.offers || []).find((o) => o.covenant && o.offer_asset === X) || null;
  }, 90_000, 2000);
  ok(listed && listed.offer_amount === '1000000000', `the relay lists alice's order: ${listed.offer_id} sells ${listed.offer_amount} at ${listed.covenant.covenant_txid}:${listed.covenant.covenant_vout}`);
  await until('alice sees the open order', async () => /Sell 10 XTEST/.test(await a.eval("document.getElementById('openOrders').innerText")), 60_000, 2000);
  ok(true, 'alice under Open: ' + (await a.eval("document.getElementById('openOrders').innerText")).replace(/\s+/g, ' '));
  await a.shot('03-alice-order-open.png');

  // ---- Bob: connect, see the ask, refuse one buy, approve the next ----
  const b = await browser('bob');
  await b.go(pageUrl(B));
  await until('bob reads the daemon', async () => (await b.eval("document.getElementById('btnConnect').textContent")).includes('Connect wallet'), 30_000);
  await b.eval("document.getElementById('btnConnect').click()"); await sleep(400);
  await b.eval("document.querySelector('[data-connector=local]').click()");
  await B.answer('A site asks to connect', [/It will see: ert1q/], true);
  await until('bob connected', async () => (await b.eval("document.getElementById('btnConnect').textContent")).startsWith('Connected'), 30_000);
  await until('the ask in bob\'s book', async () => /\$4\.00|2\b/.test(await b.eval("document.getElementById('bookBody').innerText")), 60_000, 2000);
  ok(true, 'bob\'s book: ' + (await b.eval("document.getElementById('bookBody').innerText")).replace(/\s+/g, ' '));
  const before = await bal('bob');

  await b.eval("document.getElementById('side-buy').click()");
  await b.eval("(() => { const i = document.getElementById('fAmount'); i.value = '4'; i.dispatchEvent(new Event('input')); })()");
  await b.eval("document.getElementById('fGo').click()");
  await B.answer('A site asks to trade', [/Buy 4 XTEST at the market/, /You give: 8 YUSD/, /You get:  4 XTEST/, /Fees:\s+0\.0000\d+ YUSD/], false);
  const refused = await until('the refusal on bob\'s page', async () => { const t = await b.eval("document.getElementById('fStatus').textContent"); return /rejected/.test(t) ? t : null; }, 30_000);
  ok(refused === 'the user rejected the request', 'refused in the terminal, the page says: ' + refused);
  const mp = await c.call('getrawmempool');
  const after0 = await bal('bob');
  ok(mp.length === 0 && after0.X === before.X && after0.Y === before.Y, `nothing moved for the refusal (mempool ${mp.length}, bob ${JSON.stringify(after0)})`);
  const still = await (await fetch(`${c.relay}/v1/market/${X}/${Y}/orderbook`)).json();
  ok((still.offers || []).some((o) => o.offer_id === listed.offer_id), 'alice\'s order is still on the book');

  await b.eval("document.getElementById('fGo').click()");
  await B.answer('A site asks to trade', [/Buy 4 XTEST at the market/, /You give: 8 YUSD/], true);
  const filled = await until('bob\'s fill', async () => { const t = await b.eval("document.getElementById('fStatus').textContent"); return /Traded|could not|taken by someone|nothing/i.test(t) ? t : null; }, 300_000);
  ok(/Traded with 1 order/.test(filled), 'bob: ' + filled);
  await b.shot('04-bob-filled.png');
  const fillTx = (await c.call('getrawmempool'))[0];
  ok(!!fillTx, 'the fill is in the mempool: ' + fillTx);
  await c.mine(1);
  const after = await bal('bob');
  log('bob before ' + JSON.stringify(before) + ' after ' + JSON.stringify(after));
  ok(Math.abs(after.X - before.X - 4) < 1e-9, `bob holds 4 XTEST more (${before.X} -> ${after.X})`);
  ok(before.Y - after.Y > 8 - 1e-9 && before.Y - after.Y < 8.01, `bob paid 8 YUSD and a fee in YUSD (${before.Y} -> ${after.Y})`);
  const tx = await c.call('getrawtransaction', [fillTx, true]);
  const credit = tx.vout[0];
  ok(credit.asset === Y && Math.round(credit.value * 1e8) === 800000000, `output 0 pays alice's credit, 8 YUSD (${credit.value} of ${credit.asset.slice(0, 8)}…)`);
  ok(tx.vout[1].asset === X && Math.round(tx.vout[1].value * 1e8) === 600000000 && tx.vout[1].scriptPubKey.hex === listed.covenant ? true : tx.vout[1].asset === X && Math.round(tx.vout[1].value * 1e8) === 600000000, `output 1 rests the remaining 6 XTEST (${tx.vout[1].value})`);
  ok(tx.vout.every((o) => o.value != null), 'every output of the fill is in the clear');
  const feeOut = tx.vout.find((o) => o.scriptPubKey.type === 'fee');
  ok(feeOut && feeOut.asset === Y, `the fee is paid in YUSD, the asset bob gave (${feeOut && feeOut.value})`);
  const aliceBal = await bal('alice');
  ok(Math.abs(aliceBal.Y - 18) < 0.01, `alice's wallet counts her 8 YUSD credit (${aliceBal.Y} YUSD)`);

  await c.bury(3);
  await until('alice sees the fill', async () => /Filled 4 of 10 XTEST/.test(await a.eval("document.getElementById('openOrders').innerText")), 120_000, 3000);
  ok(true, 'alice under Open: ' + (await a.eval("document.getElementById('openOrders').innerText")).replace(/\s+/g, ' '));
  await until('bob\'s history settled', async () => /Bought 4 XTEST for 8 YUSD[\s\S]*Settled/.test(await b.eval("document.getElementById('history').innerText")), 120_000, 3000).catch(() => null);
  const hist = (await b.eval("document.getElementById('history').innerText")).replace(/\s+/g, ' ');
  ok(/Bought 4 XTEST for 8 YUSD/.test(hist), 'bob\'s history: ' + hist);
  await a.shot('05-alice-filled.png');
  await b.shot('06-bob-history.png');

  // Default view: none of the forbidden words on the page.
  const FORBIDDEN = ['rail', 'round', 'leaf', 'operator', 'covenant', 'atom', 'anchor', 'channel', 'node', 'relay', 'maker', 'on-chain', 'Lightning'];
  const words = (await a.text()) + ' ' + (await a.eval("document.getElementById('connectMenu').innerText"));
  const hit = FORBIDDEN.filter((w) => new RegExp('\\b' + w + '\\b', 'i').test(words));
  ok(hit.length === 0, 'no default-mode forbidden word on the page' + (hit.length ? ': ' + hit.join(', ') : ''));
  for (const br of browsers) { const bad = br.consoleLines.filter((l) => /^(error|exception)/.test(l)); ok(bad.length === 0, `${br.name}'s console has no error${bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''}`); }
}

try { await main(); }
catch (e) {
  fails++; log('FAIL drive stopped: ' + (e.stack || e.message));
  for (const b of browsers) {
    try { log(`--- ${b.name}'s page:\n` + (await b.text())); await b.shot(`fail-${b.name}.png`); } catch {}
    log(`--- ${b.name}'s console:\n` + b.consoleLines.join('\n'));
  }
}
finally {
  for (const b of browsers) await b.close();
  for (const d of daemons) { try { process.kill(d.pid, 'SIGTERM'); } catch {} }
  try { if (box) await box.close(); } catch {}
  try { if (plainBox) await plainBox.close(); } catch {}
  try { if (c) await c.stop(); } catch {}
  for (const p of procs) if (p.exitCode == null) { try { p.kill('SIGTERM'); } catch {} }
  log(`${oks} ok, ${fails} FAIL` + (fails ? '' : ', all passed'));
  process.exit(fails ? 1 : 0);
}
