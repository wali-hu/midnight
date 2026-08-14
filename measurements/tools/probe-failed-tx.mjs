// D3, part 2 - CAUSE a failure and find out WHERE it costs.
//
//   node probe-failed-tx.mjs
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY SCANNING THE CHAIN WAS NOT ENOUGH
//
// `measure-failed-fee.mjs` scanned 250 preview blocks and found 33 transactions, ALL of them
// SUCCESS. That is a real observation and it is not an answer: "no failure landed this week" says
// nothing about what a failure costs. To measure the cost you have to cause one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE HYPOTHESIS THIS TESTS - and it contradicts 11_TOKEN_DESIGN §3
//
// §3 argues there is no need to slash a relayer, partly on this line:
//
//   > "Submits an invalid transaction → The chain rejects it. The relayer burns its own DUST.
//   >  It is already the only party that loses."
//
// That assumes an invalid transaction REACHES the chain and is rejected there. But a Compact
// `assert` is a CIRCUIT CONSTRAINT, and constraints are checked while the proof is being built -
// on the submitter's own machine, before anything is broadcast. If that is right, an
// assert-violating transaction never exists, is never submitted, and costs ZERO DUST: the chain
// never sees it and the relayer burns nothing.
//
// The distinction matters for the token design, because it splits "invalid" into two kinds that
// behave completely differently:
//
//   CIRCUIT-INVALID   violates an assert (price outside the band, spending someone else's note)
//                     → fails LOCALLY at proving. Costs nothing. Never lands. Cannot be spam.
//   STATE-INVALID     proof is valid, but the ledger moved (nullifier already used, stale root)
//                     → is built, IS submitted, lands as FAILURE, and DOES cost the fee.
//
// This probe measures the first kind directly against the LIVE contract on preview: it asks the
// deployed OtcEscrow to fill an order at a price outside the maker's band, which the circuit forbids.
// Nothing is spent if the hypothesis holds - which is itself the finding.

import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Contract } from '../contracts/build-otc/contract/index.js';
import { trace, withHeartbeat, resolveNetwork, resolveSeed, providersFor, LOGS } from './preview-deploy.mjs';
import { openWallet } from './wallet.mjs';
import { findDeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUILD = path.resolve(HERE, '..', 'contracts', 'build-otc');
const sha = (s) => new Uint8Array(createHash('sha256').update(s).digest());

const deployed = JSON.parse(readFileSync(path.join(LOGS, 'otcescrow-preview.json'), 'utf8'));
const fill = JSON.parse(readFileSync(path.join(LOGS, 'otcescrow-fill-preview.json'), 'utf8'));
const POOL_ID = sha(process.env.OTC_POOL_LABEL ?? 'phantom-otc-v1');

const UNIT = 1_000_000n;
const TAKER = sha('phantom-otc-taker-v1');
const TICKET = Uint8Array.from(Buffer.from(fill.ticket, 'hex'));

let W = {
  noteSecret: TAKER, noteRand: sha('taker-note-r'), noteAmount: 200n * UNIT, noteAsset: 2n,
  ticketRand: sha('phantom-otc-ticket-rand-v1'),
  outRand: sha('out-r'), changeRand: sha('change-r'), proceedsRand: sha('proceeds-r'),
};
const witnesses = {
  noteSecret: ({ privateState }) => [privateState, W.noteSecret],
  noteRand: ({ privateState }) => [privateState, W.noteRand],
  noteAmount: ({ privateState }) => [privateState, W.noteAmount],
  noteAsset: ({ privateState }) => [privateState, W.noteAsset],
  ticketRand: ({ privateState }) => [privateState, W.ticketRand],
  outRand: ({ privateState }) => [privateState, W.outRand],
  changeRand: ({ privateState }) => [privateState, W.changeRand],
  proceedsRand: ({ privateState }) => [privateState, W.proceedsRand],
  notePath: ({ ledger: l, privateState }, cm) => {
    const p = l.notes.findPathForLeaf(cm);
    if (p === undefined) throw new Error(`commitment ${Buffer.from(cm).toString('hex').slice(0, 12)}… not in the on-chain tree`);
    return [privateState, p];
  },
};

const env = resolveNetwork();
const { seed } = resolveSeed(env);
const { wallet, provider } = await withHeartbeat('openWallet', () => openWallet(env, seed));

const result = { when: new Date().toISOString(), network: env.networkId, contract: deployed.address };

try {
  const compiled = CompiledContract.make('OtcEscrow', Contract).pipe(
    CompiledContract.withWitnesses(witnesses),
    CompiledContract.withCompiledFileAssets(BUILD),
  );
  const providers = providersFor(env, BUILD, 'phantom-otc', provider, seed);
  const joined = await withHeartbeat('findDeployedContract', () => findDeployedContract(providers, {
    compiledContract: compiled, contractAddress: deployed.address,
    privateStateId: 'otcescrow', initialPrivateState: {},
  }));

  // The order is real and still open: F2 left 60 units unsold with a band of 0.95-1.05.
  // This offers 0.50 - comfortably outside it, and forbidden by `fillOrder`'s floor assert.
  const BAD_FILL = 10n * UNIT, BAD_PAY = 5n * UNIT;   // implied price 0.50
  trace(`attempting a fill at price 0.50 against a band of 0.95-1.05 - the circuit must refuse it`);

  const t0 = Date.now();
  try {
    await joined.callTx.fillOrder(TICKET, BAD_FILL, BAD_PAY);
    result.outcome = 'ACCEPTED';
    console.log('\n  🚨 THE OUT-OF-BAND FILL WAS ACCEPTED. That is a contract bug, not a fee measurement.');
  } catch (e) {
    const msg = String(e?.message ?? e);
    const seconds = ((Date.now() - t0) / 1000).toFixed(1);
    // A local proving failure names the assert. A chain rejection names a transaction or a block.
    const local = /below the maker's band|failed assert/i.test(msg);
    result.outcome = local ? 'REFUSED LOCALLY AT PROVING' : 'REFUSED ELSEWHERE';
    result.seconds = Number(seconds);
    result.error = msg.split('\n')[0].slice(0, 200);

    console.log(`\n── result after ${seconds}s ──────────────────────────────────────────`);
    console.log(`  ${result.outcome}`);
    console.log(`  ${result.error}`);
    console.log('');
    if (local) {
      console.log('  MEASURED: an assert-violating transaction costs ZERO DUST.');
      console.log('  It is refused while the proof is being CONSTRUCTED, on this machine. No');
      console.log('  transaction is created, nothing is broadcast, and the chain never sees it.');
      console.log('');
      console.log('  → 11_TOKEN_DESIGN §3 says "submits an invalid transaction -> the chain rejects');
      console.log('    it, the relayer burns its own DUST". For CIRCUIT-invalid transactions that is');
      console.log('    wrong: nothing is burned because nothing is submitted. The conclusion (no');
      console.log('    slashing needed) survives and is in fact STRONGER - such a transaction cannot');
      console.log('    even be constructed, so it is not a fault to be punished, it is an');
      console.log('    impossibility. The stated mechanism is what needs correcting.');
    }
  }
} finally {
  mkdirSync(LOGS, { recursive: true });
  writeFileSync(path.join(LOGS, 'failed-tx-probe.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\nwritten → logs/failed-tx-probe.json`);
  await wallet.stop();
}
