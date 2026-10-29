"""sequentia-connect over a SeqLN node, on SeqLN's own anchored regtest chain.

Two SeqLN nodes and a GOLD channel between them, from SeqLN's test framework. The
daemon fronts l2 (and the chain's Sequentia Core node); the test talks to it as a site
does, over HTTP with an allowed Origin, and answers each approval on the daemon's
terminal after reading it:

- connect, then lnChannels: the GOLD channel, its spendable and receivable sides;
- createInvoice for 3,000,000 GOLD atoms (above l2's channel reserve), approved: l1 pays it, l2 holds 3,000,000 more;
- payInvoice of l1's invoice for 500 GOLD atoms, refused: nothing is paid;
- the same, approved: paid, with the preimage l1's invoice was made with.

Run from a SeqLN checkout's tests directory, with its virtual environment:

    cd <seqln>/tests && TEST_NETWORK=sequentia-regtest SEQUENTIA_CONNECT=<this checkout> \\
      PATH=<seqln>/lightningd:<seqln>/cli:<dir of sequentiad>:$PATH \\
      python -m pytest <this checkout>/test/seqln/test_connect_lightning.py -p no:cacheprovider
"""
from fixtures import *  # noqa: F401,F403
from utils import TEST_NETWORK, wait_for

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request

import pytest

pytestmark = pytest.mark.skipif(TEST_NETWORK != 'sequentia-regtest',
                                reason='needs TEST_NETWORK=sequentia-regtest')

PAR = 10**8
ORIGIN = 'https://sequentiatestnet.com'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


class Daemon:
    def __init__(self, workdir, cfg):
        self.dir = os.path.join(workdir, 'connect')
        os.makedirs(self.dir, exist_ok=True)
        with open(os.path.join(self.dir, 'config.json'), 'w') as f:
            json.dump(cfg, f, indent=2)
        self.port = cfg['listen']
        self.log = open(os.path.join(self.dir, 'terminal.log'), 'w+')
        bin_ = os.path.join(os.environ['SEQUENTIA_CONNECT'], 'bin', 'sequentia-connect.mjs')
        self.proc = subprocess.Popen(['node', bin_, '--datadir', self.dir], stdin=subprocess.PIPE,
                                     stdout=self.log, stderr=self.log, text=True)
        self.mark = 0
        self.wait_terminal('sequentia-connect ', 'serves: ')
        self.session = None

    def terminal(self):
        self.log.flush()
        with open(self.log.name) as f:
            return f.read()

    def wait_terminal(self, *needles, timeout=60):
        t0 = time.time()
        while time.time() - t0 < timeout:
            t = self.terminal()[self.mark:]
            if all(n in t for n in needles):
                return t
            time.sleep(0.2)
        raise AssertionError('the terminal never showed {}: {}'.format(needles, self.terminal()[-2000:]))

    def answer(self, title, expect, yes):
        t = self.wait_terminal(title, 'Approve? Type yes or no: ')
        shown = t[t.index(title):]
        for e in expect:
            assert e in shown, 'the approval should show {!r}: {}'.format(e, shown)
        self.mark = len(self.terminal())
        self.proc.stdin.write('yes\n' if yes else 'no\n')
        self.proc.stdin.flush()
        return shown

    def request(self, method, params=None):
        body = json.dumps({'method': method, 'params': params or {}}).encode()
        headers = {'origin': ORIGIN, 'content-type': 'application/json'}
        if self.session:
            headers['x-sequentia-session'] = self.session
        req = urllib.request.Request('http://127.0.0.1:{}/v1/request'.format(self.port), data=body, headers=headers)
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.loads(r.read())

    def request_async(self, method, params=None):
        import threading
        out = {}
        th = threading.Thread(target=lambda: out.update(self.request(method, params)))
        th.start()
        return th, out

    def stop(self):
        self.proc.terminate()
        self.proc.wait(timeout=10)
        self.log.close()


def test_connect_over_seqln(node_factory, bitcoind, directory):
    gold = bitcoind.issue_asset(1000)
    bitcoind.set_fee_rates({bitcoind.POLICY_ASSET: PAR, gold: PAR})
    l1, l2 = node_factory.get_nodes(2)
    addr = l1.rpc.newaddr('bech32')['bech32']
    txid = bitcoind.send(addr, 10 * PAR, gold)
    bitcoind.generate_block(1, wait_for_mempool=[txid])
    wait_for(lambda: any(o['status'] == 'confirmed' for o in l1.rpc.listfunds()['outputs']))
    l1.rpc.connect(l2.info['id'], 'localhost', l2.port)
    res = l1.rpc.call('fundchannel', {'id': l2.info['id'], 'amount': PAR, 'asset': gold, 'announce': False})
    bitcoind.generate_block(6, wait_for_mempool=res['txid'])
    wait_for(lambda: all(c['state'] == 'CHANNELD_NORMAL' for c in l1.rpc.listpeerchannels()['channels']))
    wait_for(lambda: all(c['state'] == 'CHANNELD_NORMAL' for c in l2.rpc.listpeerchannels()['channels']))

    cli = shutil.which('lightning-cli')
    cfg = {
        'listen': free_port(),
        'origins': [ORIGIN],
        'mode': 'user',
        'core': {'url': 'http://127.0.0.1:{}'.format(bitcoind.rpcport), 'wallet': 'lightningd-tests', 'user': 'rpcuser', 'password': 'rpcpass'},
        'lightning': [{'cli': cli, 'args': ['--lightning-dir={}'.format(l2.daemon.lightning_dir), '--network=sequentia-regtest'], 'chain': 'sequentia'}],
    }
    d = Daemon(directory, cfg)
    try:
        caps = d.request('getCapabilities')['result']
        assert caps['provider'] == 'sequentia-connect'
        for m in ('lnChannels', 'createInvoice', 'payInvoice'):
            assert m in caps['methods']
        assert d.request('lnChannels') == {'error': 'this site is not connected; call connect first', 'code': 'no_session'}

        th, out = d.request_async('connect')
        d.answer('A site asks to connect', ['from ' + ORIGIN, 'It will see: '], True)
        th.join()
        d.session = out['result']['session']

        chans = d.request('lnChannels')['result']
        print('lnChannels', chans)
        gold_ch = [c for c in chans['channels'] if c['kind'] == gold]
        assert len(gold_ch) == 1 and gold_ch[0]['state'] == 'CHANNELD_NORMAL'
        assert int(gold_ch[0]['spendable']) == 0 and int(gold_ch[0]['receivable']) > 0

        # Receive: an invoice on l2 for 3,000,000 GOLD atoms, which l1 pays.
        th, out = d.request_async('createInvoice', {'amount': '3000000', 'asset': gold, 'memo': 'sx1 receive'})
        shown = d.answer('A site asks for an invoice to receive', ['Receive 0.03 ', 'over Lightning on your SeqLN node', 'Memo: sx1 receive'], True)
        th.join()
        print('createInvoice approval:', shown)
        bolt11 = out['result']['bolt11']
        assert bolt11.startswith('lnsqrt')
        before = sum(int(c['to_us_msat']) for c in l2.rpc.listpeerchannels()['channels'])
        r = l1.rpc.call('pay', {'bolt11': bolt11, 'asset': gold})
        assert r['status'] == 'complete'
        wait_for(lambda: sum(int(c['to_us_msat']) for c in l2.rpc.listpeerchannels()['channels']) == before + 3000000 * 1000)

        # Pay: l1's invoice for 500 GOLD atoms, refused first, then approved.
        inv = l1.rpc.call('invoice', {'amount_msat': 500 * 1000, 'label': 'sx1-pay', 'description': 'sx1 pay', 'asset': gold})
        th, out = d.request_async('payInvoice', {'bolt11': inv['bolt11'], 'asset': gold})
        d.answer('A site asks to pay an invoice', ['Pay 0.000005', 'For: sx1 pay', inv['payment_hash']], False)
        th.join()
        assert out == {'error': 'the user rejected the request', 'code': 'rejected'}, out
        assert l1.rpc.listinvoices('sx1-pay')['invoices'][0]['status'] == 'unpaid'

        th, out = d.request_async('payInvoice', {'bolt11': inv['bolt11'], 'asset': gold})
        d.answer('A site asks to pay an invoice', ['Pay 0.000005'], True)
        th.join()
        print('payInvoice', out)
        assert out['result']['paid'] is True
        got = l1.rpc.listinvoices('sx1-pay')['invoices'][0]
        assert got['status'] == 'paid' and got['payment_preimage'] == out['result']['preimage']
        print('terminal:\n' + d.terminal())
    finally:
        d.stop()
