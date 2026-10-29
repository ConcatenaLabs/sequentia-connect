// The command-line tools of the stack, run without a shell: the Lightning node's CLI,
// the leaf wallet's CLI and the SeqDEX taker. Each answers JSON; a failure is passed on
// with the tool's own last words.
import { execFile } from 'node:child_process';

export function run(cmd, args, { env, timeoutMs = 10 * 60_000, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { env: env ? { ...process.env, ...env } : process.env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // A CLI that answers JSON says why in its `message`; anything else, in its last words.
        let said = null;
        try { const j = JSON.parse(String(stdout)); said = j && (j.message || (j.error && (j.error.message || j.error))) ; } catch {}
        if (!said) said = String(stderr || stdout || '').trim().split('\n').filter(Boolean).slice(-2).join(' ');
        const e = new Error(said || err.message);
        e.stdout = stdout; e.stderr = stderr;
        return reject(e);
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

export async function runJSON(cmd, args, opts) {
  const { stdout } = await run(cmd, args, opts);
  try { return JSON.parse(stdout); } catch { throw new Error(`${cmd} printed something other than JSON`); }
}

// A Core Lightning node (SeqLN, its Sequentia fork, or CLN on Bitcoin): its
// lightning-cli and the arguments that reach it (--lightning-dir, --network, …).
// `chain` says which network its channels are on: 'sequentia' or 'bitcoin'.
export function lightningNode({ cli, args = [], chain = 'sequentia' }) {
  const call = (method, params = []) => runJSON(cli, [...args, method, ...params.map(String)]);
  const callNamed = (method, named) => runJSON(cli, [...args, '-k', method, ...Object.entries(named).filter(([, v]) => v != null).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)]);
  return { chain, call, callNamed };
}

// The leaf wallet (`arca`): its binary and its data directory.
export function leafWallet({ cli, datadir, env = {} }) {
  const call = (args) => runJSON(cli, [...args, '--datadir', datadir], { env });
  return { call };
}
