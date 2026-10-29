// The HTTP face of the daemon: the website provider protocol on the loopback address.
//
//   GET  /v1/hello            {provider, version}: whether this daemon is here
//   POST /v1/request          {method, params} -> {result} | {error, code}
//   GET  /v1/events?after=n   {events: [{n, event, data}], next}, held open up to 25 s
//
// Who may ask:
// - only a browser page whose Origin is in the allow-list (`origins` in the
//   configuration); any other origin, and a request with no Origin at all, is refused
//   with no CORS headers, so a page elsewhere cannot even read the refusal;
// - only through a Host header naming this loopback address and port, so a site that
//   points a DNS name of its own at 127.0.0.1 (DNS rebinding) is refused as well;
// - every method past the silent ones only with the session its origin was given when
//   its owner approved the connect in the terminal.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROVIDER = 'sequentia-connect';

export function startServer({ port, origins, stack, datadir, version, log = () => {} }) {
  const allowed = new Set(origins.map((o) => o.replace(/\/+$/, '')));
  const sessFile = path.join(datadir, 'sessions.json');
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(sessFile, 'utf8')); } catch { sessions = {}; }
  const saveSessions = () => fs.writeFileSync(sessFile, JSON.stringify(sessions, null, 2), { mode: 0o600 });

  const events = [];
  let seq = 0;
  const waiting = new Set();
  function emit(event, data, origin = null) {
    events.push({ n: ++seq, event, data, origin });
    while (events.length > 200) events.shift();
    for (const w of waiting) w();
  }

  const hostOk = (h) => h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ? String(req.headers.origin) : null;
    const send = (code, obj, extra = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra });
      res.end(JSON.stringify(obj));
    };
    if (!hostOk(req.headers.host)) return send(421, { error: 'this daemon answers only at its loopback address' });
    if (!origin || !allowed.has(origin)) {
      log(`refused a request from ${origin || 'no origin'}: not in the allow-list`);
      return send(403, { error: 'this site is not allowed to reach this daemon: add its origin to the configuration', code: 'origin' });
    }
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': 'content-type, x-sequentia-session',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      vary: 'Origin',
    };
    // A public site reaching the loopback address: Chromium's private network check
    // asks the daemon first, and goes on only when the daemon says yes.
    if (req.headers['access-control-request-private-network'] === 'true') cors['access-control-allow-private-network'] = 'true';
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const token = req.headers['x-sequentia-session'] ? String(req.headers['x-sequentia-session']) : null;
    const sess = token && sessions[token] && sessions[token].origin === origin ? sessions[token] : null;

    if (req.method === 'GET' && url.pathname === '/v1/hello') return send(200, { provider: PROVIDER, version }, cors);

    if (req.method === 'GET' && url.pathname === '/v1/events') {
      const after = Number(url.searchParams.get('after') || 0);
      const due = () => events.filter((e) => e.n > after && (!e.origin || e.origin === origin));
      let out = due();
      if (!out.length) {
        await new Promise((resolve) => {
          const t = setTimeout(done, 25_000);
          function done() { clearTimeout(t); waiting.delete(done); resolve(); }
          waiting.add(done);
          req.on('close', done);
        });
        out = due();
      }
      if (res.writableEnded || res.destroyed) return;
      return send(200, { events: out.map(({ n, event, data }) => ({ n, event, data })), next: out.length ? out[out.length - 1].n : Math.max(after, 0) }, cors);
    }

    if (req.method === 'POST' && url.pathname === '/v1/request') {
      let body;
      try {
        const chunks = [];
        let size = 0;
        for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('too large'); chunks.push(c); }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch { return send(400, { error: 'the request is not JSON of at most 64 KiB' }, cors); }
      const method = String(body.method || '');
      const params = body.params && typeof body.params === 'object' ? body.params : {};
      const ctx = {
        origin, connected: !!sess,
        grant: async (account) => {
          const t = crypto.randomBytes(32).toString('hex');
          sessions[t] = { origin, at: Date.now() };
          saveSessions();
          return { ...account, session: t };
        },
        emit: (event, data) => emit(event, data, origin),
      };
      try {
        const result = await stack.handle(method, params, ctx);
        log(`${origin} ${method}: ok`);
        return send(200, { result }, cors);
      } catch (e) {
        const msg = (e && e.message) || String(e);
        log(`${origin} ${method}: ${msg}`);
        return send(200, { error: msg, code: e && e.code }, cors);
      }
    }
    send(404, { error: 'no such path' }, cors);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({
      server, port: server.address().port, emit,
      revoke(origin) {
        for (const [t, s] of Object.entries(sessions)) if (s.origin === origin) delete sessions[t];
        saveSessions();
        emit('disconnect', {}, origin);
        emit('accountsChanged', { accounts: [] }, origin);
      },
      close: () => new Promise((r) => { for (const w of waiting) w(); server.closeAllConnections?.(); server.close(() => r()); }),
    }));
  });
}
