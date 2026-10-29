// Approval in the terminal the daemon runs in. Every connect from a new site and every
// request that signs, pays or places something is shown here, whole, and waits for its
// owner to type "yes". One request is shown at a time; anything but "yes" (or "y")
// refuses it, and so does silence for `timeoutMs`. Nothing is signed before the answer.
import readline from 'node:readline';

export function terminalApprover({ input = process.stdin, output = process.stderr, timeoutMs = 5 * 60_000 } = {}) {
  const rl = readline.createInterface({ input, terminal: false });
  const lines = [];
  let waiter = null;
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else lines.push(l); });
  let chain = Promise.resolve();

  function ask({ title, origin, lines: body = [] }) {
    const run = async () => {
      lines.length = 0;   // a line typed before the question is not its answer
      const bar = '─'.repeat(64);
      output.write(`\n${bar}\n${title}\n  from ${origin}\n${body.map((l) => '  ' + l).join('\n')}\n${bar}\nApprove? Type yes or no: `);
      const answer = await new Promise((resolve) => {
        const t = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
        waiter = (l) => { clearTimeout(t); resolve(l); };
      });
      const ok = answer != null && /^(y|yes)$/i.test(answer.trim());
      output.write(answer == null ? '\n(no answer: refused)\n' : ok ? 'approved\n' : 'refused\n');
      return ok;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }
  return { ask, close: () => rl.close() };
}

export class Rejected extends Error {
  constructor() { super('the user rejected the request'); this.code = 'rejected'; }
}
