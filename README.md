# sequentia-connect

Lets a website you allow use your own Sequentia stack: a Sequentia Core wallet, a
Lightning node (SeqLN, or Core Lightning on Bitcoin), and the `arca` leaf wallet,
with every signature and payment approved by you in the terminal where the daemon
runs. Sequentia is a Bitcoin sidechain for asset tokenization and disintermediated
exchanges; the SeqDEX site (https://sequentiatestnet.com/dex/) connects to this
daemon as it connects to Ambra browser, the browser extension.

The daemon speaks the Sequentia website provider protocol, the same one the
extension speaks
([`sequentia-extension/doc/PROVIDER.md`](https://github.com/ConcatenaLabs/sequentia-extension/blob/master/doc/PROVIDER.md)),
over HTTP on your computer's loopback address. A site sends a method name and its
parameters; the daemon reads the chain, the order book and your wallets itself,
shows you what the request would do, and acts only on your "yes". Your keys, your
node passwords and your wallet files never leave your computer, and the site never
sees them.

## What it serves

| Method | What it does | Asks you |
| --- | --- | --- |
| `getCapabilities`, `getNetwork`, `getWalletMode` | who it is, which chain, which mode | no |
| `connect` | gives the site your Sequentia address (and your BTC address when a Bitcoin wallet is configured) and a session | yes, once per site |
| `getAccounts`, `getBalances`, `getAddress` | your addresses; every asset your Core wallet holds, each in its own atoms; BTC from your Bitcoin wallet | no |
| `placeOrder` | a market or limit order between two Sequentia assets | yes |
| `getOrders` | your resting orders and trades, and where each stands | no |
| `cancelOrder` | says from when an order can be taken back; the daemon does not take one back itself (its refund key is in `maker.seed`) | — |
| `lnChannels` | your Lightning channels, per asset: spendable and receivable | no |
| `createInvoice` | an invoice on your node, for BTC or a Sequentia asset | yes |
| `payInvoice` | pays an invoice from your node | yes |
| `getLeafBalances`, `getLeafAddress` | your leaf wallet's coins by state, and its on-chain address (developer mode) | no |
| `requestLeafReceive` | a single-use receive request of your leaf wallet (developer mode) | yes |

A method whose part of the stack is not configured is not listed in
`getCapabilities`, and a site that asks for it anyway is refused.

**Orders.** The book is the on-chain relay's covenant orders, read both ways round
by the daemon itself; the plan of a trade is the same arithmetic the extension uses
(`vendor/market-plan.js`). Each order taken is one transaction that pays its maker
and you together, or nothing: SeqDEX's taker (`seqob-cli covfill`) builds it,
checks the order against the chain, and has your Core wallet sign its own inputs.
The taker reaches your node through a one-use door the daemon opens on the loopback
address, with a random password and only the methods a fill needs, so your node's
real credentials never appear on a command line. What a limit order does not fill
rests on the book as a covenant order funded from your Core wallet: what it is paid
goes to a taproot address of that wallet, so resting an order needs a descriptor
wallet (`createwallet` with `descriptors=true`). The daemon lists it on the relay
once its funding is in a block. Every fee is paid in the asset you give. A limit
order takes the provider protocol's options, listed in `getCapabilities`: post only
(refused if it would take an order now), `rest: false` (nothing rests), a smallest
fill, and a take-back time from an hour to a week (a day without one). The key
that signs an order's listing and the key that alone can take it back after its
time are drawn from `maker.seed` in the daemon's directory; keep that file as you
keep a wallet backup.

**Approvals.** Each one names the site, then what moves: what you give, what you
get, the fees, and anything left resting. Type `yes` (or `y`) to approve. Anything
else refuses it, and so does five minutes of silence; the site is told "the user
rejected the request" and nothing is signed or sent.

## Install and run

Node.js 20 or later; nothing to install from a package registry. For orders, the
`seqob-cli` binary from [`ConcatenaLabs/seqdex`](https://github.com/ConcatenaLabs/seqdex)
(`cd daemon && go build ./cmd/seqob-cli`).

    git clone https://github.com/ConcatenaLabs/sequentia-connect
    mkdir -p ~/.sequentia-connect && $EDITOR ~/.sequentia-connect/config.json
    node sequentia-connect/bin/sequentia-connect.mjs

Leave it running in its terminal: that is where it asks you. `--datadir <dir>` (or
`SEQUENTIA_CONNECT_DIR`) keeps its files somewhere else; `--config <file>` names
another configuration.

Then open the site, press **Connect wallet** and choose **Sequentia Core on this
computer**. A site reaches the daemon at `http://127.0.0.1:7419`; when you run it on
another port, open the site once with `?local=<port>` (SeqDEX keeps it).

## Configuration

`config.json` in the daemon's directory:

```json
{
  "listen": 7419,
  "origins": ["https://sequentiatestnet.com"],
  "mode": "user",
  "core": { "url": "http://127.0.0.1:18891", "wallet": "trading", "cookie": "/home/you/.sequentia/testnet/.cookie" },
  "relay": "https://sequentiatestnet.com/seqob",
  "seqobCli": "/home/you/bin/seqob-cli",
  "registry": "https://sequentiatestnet.com/registry/index.minimal.json",
  "bitcoin": { "url": "http://127.0.0.1:48332", "wallet": "btc", "cookie": "/home/you/.bitcoin/testnet4/.cookie" },
  "lightning": [
    { "cli": "/usr/local/bin/lightning-cli", "args": ["--lightning-dir=/home/you/.seqln", "--network=sequentia-testnet"], "chain": "sequentia" },
    { "cli": "/usr/local/bin/lightning-cli", "args": ["--lightning-dir=/home/you/.lightning", "--network=testnet4"], "chain": "bitcoin" }
  ],
  "leaves": { "cli": "/home/you/bin/arca", "datadir": "/home/you/.arca" }
}
```

- `origins`: the sites allowed to reach the daemon, exactly as the browser names
  them (scheme, host, port). Every other origin is refused, and so is a request with
  no origin at all.
- `mode`: `user` or `developer`. A site follows it as it follows the extension's
  mode; the leaf wallet's methods answer in developer mode only.
- `core`: your Sequentia Core node's RPC address and the wallet to use, with its
  cookie file, or `user` and `passwordFile`. The daemon reads the secret from that
  file at each call and keeps it nowhere else.
- `relay`, `seqobCli`: the order book and the taker; without them no order method
  is served. `registry`: asset names and precisions for the approvals.
- `bitcoin`: a Bitcoin Core wallet, for BTC on its own chain.
- `lightning`: one entry per node, its `lightning-cli` and the arguments that reach
  it; `chain` is `sequentia` for SeqLN on Sequentia, `bitcoin` for a node on Bitcoin.
- `leaves`: the `arca` binary and the leaf wallet's directory. The wallet must
  already exist (`arca create`). `arca` reaches its node over plain HTTP, so a node
  served over HTTPS needs a loopback forwarder in front of it.

Every part is optional, but the configuration names at least `core` or `leaves`.

## How a site is kept to what you allow

- The daemon listens on `127.0.0.1` only.
- It answers only requests whose `Origin` is in `origins`, with CORS headers for that
  origin alone; a page elsewhere cannot even read its refusal.
- It answers only through a `Host` of its own loopback address and port, so a site
  that points a DNS name of its own at `127.0.0.1` is refused too.
- A public site reaching the loopback address is asked about by the browser first
  (Chromium's private network check); the daemon says yes for an allowed origin only.
- Every method past the silent ones needs the session that origin was given when you
  approved its connect; a session is good for its own origin only. Sessions are kept
  in `sessions.json`; delete it to make every site connect again.
- Anything that signs, pays or places something waits for your answer in the
  terminal, one request at a time.

## Why a daemon on your computer

Two other ways to reach a person's own stack were weighed against it.

- **Behind the browser extension** (a native-messaging host the extension calls):
  no open port, and the extension already binds each request to its site. But it
  needs the extension installed to work at all, a manifest installed into each
  browser, and it ties the stack to Chromium; a person who runs their own node and
  no extension could not connect.
- **A proxy to the node's RPC** (the site builds transactions and the node signs
  them): the site would compose what it asks to have signed, and an approval of a
  raw RPC call cannot tell a person what moves.

The daemon needs neither the extension nor a particular browser, keeps every
decision about what to sign on the person's own computer, and speaks the protocol
sites already use, so a site supports it by adding a connector, not a code path.

## Tests

    node --test test/*.test.mjs

runs the daemon's doors and approvals with a stand-in stack. Against real parts:

- `test/regtest/site-drive.mjs`: the SeqDEX site in headless Chromium trading through
  two daemons and two Core wallets on a private anchored chain (a post-only limit
  order with a smallest fill and a one-hour take-back placed and part of it taken, a
  post-only order that would trade refused, one approval refused with nothing moved,
  the doors refused).
  It uses the chain and the stand-in box of the extension's market harness; its header
  lists what it needs.
- `test/seqln/test_connect_lightning.py`: channels, an invoice received and an
  invoice paid (and one refused) through the daemon in front of a SeqLN node, on
  SeqLN's own anchored regtest chain; run from a SeqLN checkout, as its header says.

`vendor/` holds the extension's order arithmetic, covenant builder and relay client,
unchanged (`vendor/EXTENSION_COMMIT` names the commit), and `market-plan.js` with its
import paths pointed here.

## License

MIT, see [LICENSE](LICENSE).
