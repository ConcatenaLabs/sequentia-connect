#!/usr/bin/env node
// sequentia-connect: lets a website you allow use your own Sequentia Core wallet,
// Lightning node and leaf wallet, with every signature approved here, in this terminal.
//
//   sequentia-connect [--config <file>] [--datadir <dir>]
//
// The configuration (JSON, by default <datadir>/config.json) names the parts of the
// stack and the sites allowed to reach it; README.md lists every field.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rpcClient } from '../src/rpc.mjs';
import { terminalApprover } from '../src/approve.mjs';
import { startServer } from '../src/server.mjs';
import { makeStack } from '../src/stack.mjs';
import { lightningNode, leafWallet } from '../src/tools.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : null;
}
const datadir = path.resolve(arg('--datadir') || process.env.SEQUENTIA_CONNECT_DIR || path.join(os.homedir(), '.sequentia-connect'));
fs.mkdirSync(datadir, { recursive: true, mode: 0o700 });
const cfgFile = path.resolve(arg('--config') || path.join(datadir, 'config.json'));
let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')); }
catch (e) { console.error(`sequentia-connect: cannot read the configuration ${cfgFile}: ${e.message}`); process.exit(1); }

const log = (m) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const core = cfg.core ? rpcClient(cfg.core) : null;
const bitcoin = cfg.bitcoin ? rpcClient(cfg.bitcoin) : null;
const lightning = (cfg.lightning || []).map(lightningNode);
const leaves = cfg.leaves ? leafWallet(cfg.leaves) : null;
if (!core && !leaves) { console.error('sequentia-connect: the configuration names neither a Sequentia Core wallet ("core") nor a leaf wallet ("leaves")'); process.exit(1); }
if (!Array.isArray(cfg.origins) || !cfg.origins.length) { console.error('sequentia-connect: the configuration allows no site ("origins")'); process.exit(1); }

const approver = terminalApprover();
const stack = makeStack({ cfg, core, bitcoin, lightning, leaves, approver, datadir, version: VERSION, log });
const port = Number(cfg.listen || 7419);
const srv = await startServer({ port, origins: cfg.origins, stack, datadir, version: VERSION, log });
const net = await stack.handle('getNetwork', {}, { connected: false }).catch((e) => ({ network: 'unreachable: ' + e.message }));
log(`sequentia-connect ${VERSION} on http://127.0.0.1:${srv.port} (${net.network}); allowed sites: ${cfg.origins.join(', ')}; mode ${cfg.mode === 'developer' ? 'developer' : 'user'}`);
log(`serves: ${stack.methods.join(', ')}`);

// Orders resting on the book are listed once their funding is in a block.
const tick = setInterval(() => { if (stack.market) stack.market.progress().catch(() => {}); }, 15_000);
const stop = async () => { clearInterval(tick); approver.close(); await srv.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
