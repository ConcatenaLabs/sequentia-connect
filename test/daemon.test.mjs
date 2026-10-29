// The daemon's doors and its terminal approvals, with a stand-in stack: who may ask
// (origin allow-list, loopback Host, session), what the terminal shows and what an
// answer other than yes does, and the amount arithmetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { startServer } from '../src/server.mjs';
import { terminalApprover, Rejected } from '../src/approve.mjs';
import { amountToAtoms, atomsToAmount } from '../src/rpc.mjs';

const ORIGIN = 'https://sequentiatestnet.com';

function raw(port, { method = 'GET', path: p = '/v1/hello', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function withDaemon(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sequentia-connect-test-'));
  const input = new PassThrough(), output = new PassThrough();
  let shown = '';
  output.on('data', (d) => { shown += d; });
  const approver = terminalApprover({ input, output, timeoutMs: 2000 });
  const signed = [];
  const stack = {
    async handle(method, params, ctx) {
      if (method === 'getCapabilities') return { provider: 'sequentia-connect', methods: ['connect', 'sign'] };
      if (method === 'connect') {
        if (!(await approver.ask({ title: 'A site asks to connect', origin: ctx.origin, lines: ['It will see: tb1qtest'] }))) throw new Rejected();
        return ctx.grant({ address: 'tb1qtest' });
      }
      if (!ctx.connected) throw Object.assign(new Error('this site is not connected; call connect first'), { code: 'no_session' });
      if (method === 'sign') {
        if (!(await approver.ask({ title: 'A site asks to sign', origin: ctx.origin, lines: ['Sign ' + params.what] }))) throw new Rejected();
        signed.push(params.what);
        return { ok: true };
      }
      throw new Error('no such method');
    },
  };
  const srv = await startServer({ port: 0, origins: [ORIGIN], stack, datadir: dir, version: 'test' });
  // The server checks Host against the port it was given; with port 0 it learns its own.
  srv.server.close(); await new Promise((r) => setTimeout(r, 10));
  const port = await new Promise((r) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const real = await startServer({ port, origins: [ORIGIN], stack, datadir: dir, version: 'test' });
  const say = (line) => input.write(line + '\n');
  try { await fn({ port, say, shown: () => shown, signed, dir }); }
  finally { await real.close(); approver.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

const post = (port, method, params, headers = {}) => raw(port, { method: 'POST', path: '/v1/request', headers: { host: `127.0.0.1:${port}`, origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ method, params }) });
const waitShown = async (shown, what) => { for (let i = 0; i < 200 && !shown().includes(what); i++) await new Promise((r) => setTimeout(r, 10)); };

test('only an allowed origin, through the loopback Host, gets an answer', async () => withDaemon(async ({ port }) => {
  const ok = await raw(port, { headers: { host: `127.0.0.1:${port}`, origin: ORIGIN } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.provider, 'sequentia-connect');
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
  const other = await raw(port, { headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' } });
  assert.equal(other.status, 403);
  assert.equal(other.headers['access-control-allow-origin'], undefined, 'a refused origin cannot even read the refusal');
  const none = await raw(port, { headers: { host: `127.0.0.1:${port}` } });
  assert.equal(none.status, 403);
  const rebind = await raw(port, { headers: { host: `attacker.example:${port}`, origin: ORIGIN } });
  assert.equal(rebind.status, 421);
  const pna = await raw(port, { method: 'OPTIONS', path: '/v1/request', headers: { host: `127.0.0.1:${port}`, origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(pna.status, 204);
  assert.equal(pna.headers['access-control-allow-private-network'], 'true');
}));

test('nothing past connect without a session; a refused connect gives none', async () => withDaemon(async ({ port, say, shown }) => {
  const r0 = await post(port, 'sign', { what: 'x' });
  assert.equal(r0.json.code, 'no_session');
  const p = post(port, 'connect');
  await waitShown(shown, 'Approve?');
  assert.match(shown(), /A site asks to connect\n {2}from https:\/\/sequentiatestnet\.com\n {2}It will see: tb1qtest/);
  say('no');
  const r1 = await p;
  assert.equal(r1.json.error, 'the user rejected the request');
  assert.equal(r1.json.result, undefined);
}));

test('a signature only on "yes", for the session of the origin that connected', async () => withDaemon(async ({ port, say, shown, signed }) => {
  const c = post(port, 'connect'); await waitShown(shown, 'Approve?'); say('yes');
  const session = (await c).json.result.session;
  assert.match(session, /^[0-9a-f]{64}$/);
  const h = { 'x-sequentia-session': session };
  for (const answer of ['nope', 'n', '']) {
    const before = shown().length;
    const p = post(port, 'sign', { what: 'tx-' + answer }, h);
    for (let i = 0; i < 200 && !shown().slice(before).includes('Approve?'); i++) await new Promise((r) => setTimeout(r, 10));
    say(answer);
    assert.equal((await p).json.error, 'the user rejected the request', `"${answer}" refuses`);
  }
  assert.deepEqual(signed, []);
  const before = shown().length;
  const p = post(port, 'sign', { what: 'tx-1' }, h);
  for (let i = 0; i < 200 && !shown().slice(before).includes('Approve?'); i++) await new Promise((r) => setTimeout(r, 10));
  assert.match(shown().slice(before), /A site asks to sign\n {2}from https:\/\/sequentiatestnet\.com\n {2}Sign tx-1/);
  say('yes');
  assert.deepEqual((await p).json.result, { ok: true });
  assert.deepEqual(signed, ['tx-1']);
  const stolen = await post(port, 'sign', { what: 'tx-2' }, { ...h, origin: 'https://other.example' });
  assert.equal(stolen.status, 403, 'a session is good only for its own origin');
  const forged = await post(port, 'sign', { what: 'tx-3' }, { 'x-sequentia-session': 'ff'.repeat(32) });
  assert.equal(forged.json.code, 'no_session');
}));

test('silence refuses', async () => withDaemon(async ({ port, shown, signed }) => {
  const c = post(port, 'connect');
  await waitShown(shown, 'Approve?');
  const r = await c;   // the approver times out after 2 s in this test
  assert.equal(r.json.error, 'the user rejected the request');
  assert.match(shown(), /no answer: refused/);
  assert.deepEqual(signed, []);
}));

test('amounts as the node prints them, to atoms and back, exactly', () => {
  assert.equal(amountToAtoms(991.99997), 99199997000n);
  assert.equal(amountToAtoms('0.00000001'), 1n);
  assert.equal(amountToAtoms(21000000), 2100000000000000n);
  assert.equal(amountToAtoms('-1.5'), -150000000n);
  assert.equal(atomsToAmount(99199997000n), '991.99997000');
  assert.equal(atomsToAmount(1n), '0.00000001');
});
