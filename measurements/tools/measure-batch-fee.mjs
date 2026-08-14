// D2 - MEASURE the fee of a BATCHED transaction.
//
//   node measure-batch-fee.mjs [count]
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS NODE EXISTS
//
// `11_TOKEN_DESIGN §5` calls batching "the single biggest lever" and prices it as
//
//     batch of n  ≈  1 + 0.1(n-1)  DUST
//
// and then labels that line, honestly, as an EXTRAPOLATION from the size/fee curve - not a
// measurement. Every capital figure in §5 rests on it: "an operator that batches well needs ~8x less
// capital", 1,537,200 NIGHT dropping to 181,390. If the real curve is flatter the numbers are
// pessimistic; if it is steeper, the entire operator economics are wrong in the direction that
// matters, and nobody would find out until an operator ran out of DUST on a live deployment.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW IT IS MEASURED, AND WHAT THAT DOES AND DOES NOT PROVE
//
// `Transaction.prototype.merge` is a real ledger operation (verified against the API, not recalled),
// so a batch is built by MERGING REAL TRANSACTIONS TAKEN OFF PREVIEW and calling
// `tx.fees(LedgerParameters.initialParameters())` at each step. Same method that produced the 1.098
// single-transaction median in 09_ECONOMICS §1 - so the two numbers are comparable, which they would
// not be if this used a different estimator.
//
// ⚠️ The indexer's own `fee` field reads `1` for every transaction at every size. It is flat, and it
// is NOT the DUST amount. 09_ECONOMICS §1 records that trap; anyone reading fees from the indexer
// gets a straight line and concludes batching is free.
//
// What this measures: how the fee of ONE transaction grows as more work is merged into it.
// What it does NOT measure: our own batching of user operations, which does not exist yet. Merging
// unrelated on-chain transactions is the closest available proxy, and it is a proxy - said here
// rather than left for a reader to assume otherwise.

import { LedgerParameters, Transaction } from '@midnight-ntwrk/ledger-v8';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { pick as pickNet } from './env.mjs';

const env = pickNet(process.env.MN_NETWORK ?? 'preview');
const WANT = Number(process.argv[2] ?? 12);
const LOGS = new URL('logs/', import.meta.url).pathname;
const params = LedgerParameters.initialParameters();

const q = async (body) => (await fetch(env.indexer, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})).json();

console.log(`network ${env.networkId}  -  collecting ${WANT} real transactions…`);

const tip = (await q({ query: '{ block { height } }' })).data.block.height;
const txs = [];
let h = tip, scanned = 0;
while (txs.length < WANT && scanned < 400) {
  const d = await q({
    query: `query($h:Int!){ block(offset:{height:$h}){ transactions { hash raw
              ... on RegularTransaction { fee } contractActions { __typename } } } }`,
    variables: { h },
  });
  for (const t of d.data?.block?.transactions ?? []) {
    const hexs = t.raw.replace(/^0x/, '');
    try {
      const tx = Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(hexs, 'hex'));
      txs.push({
        hash: t.hash.slice(0, 10), bytes: hexs.length / 2, tx,
        fee: tx.fees(params),
        kind: [...new Set((t.contractActions ?? []).map((a) => a.__typename))].join(',') || 'transfer',
        indexerFee: t.fee,
      });
    } catch { /* not every transaction shape deserialises; skip rather than guess */ }
    if (txs.length >= WANT) break;
  }
  h--; scanned++;
}

if (txs.length < 2) {
  console.error(`only ${txs.length} usable transactions found in ${scanned} blocks - cannot measure a batch.`);
  process.exit(1);
}

const DUST = (specks) => Number(specks) / 1e15;
console.log(`\ncollected ${txs.length} transactions from blocks ${h + 1}..${tip}\n`);
console.log('  hash        bytes  kind            indexerFee   REAL fee (DUST)');
console.log('  ' + '─'.repeat(68));
for (const t of txs) {
  console.log(`  ${t.hash}  ${String(t.bytes).padStart(6)}  ${t.kind.padEnd(14)} ` +
              `${String(t.indexerFee).padStart(8)}   ${DUST(t.fee).toFixed(6)}`);
}

// ── THE SIZE/FEE CURVE - which is what actually decides batching ──────────────
//
// The merge experiment below FAILS on real chain data (every pair collides on segment_id), so the
// batching question is answered from the structure of the fee instead: fit fee against SIZE and read
// off the fixed and per-byte components.
//
// That split IS the batching economics. Batching amortises whatever is FIXED per transaction and
// amortises NOTHING that scales with bytes - a batch of n user operations is still n operations'
// worth of bytes. So the per-op floor is the per-byte term, and no batch size gets below it.
{
  const calls = txs.filter((t) => t.kind === 'ContractCall');
  if (calls.length >= 4) {
    const n = calls.length;
    const X = calls.map((t) => t.bytes), Y = calls.map((t) => DUST(t.fee));
    const sx = X.reduce((a, b) => a + b, 0), sy = Y.reduce((a, b) => a + b, 0);
    const sxx = X.reduce((a, b) => a + b * b, 0);
    const sxy = X.reduce((a, b, i) => a + b * Y[i], 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const intercept = (sy - slope * sx) / n;
    const mean = sy / n;
    const ssT = Y.reduce((a, y) => a + (y - mean) ** 2, 0);
    const ssR = Y.reduce((a, y, i) => a + (y - (intercept + slope * X[i])) ** 2, 0);
    const r2 = 1 - ssR / ssT;

    console.log('\n── the fee is a LINE IN SIZE, not a flat per-transaction cost ──────────');
    console.log(`  fee(bytes) = ${intercept.toFixed(6)} + ${(slope * 1e6).toFixed(4)}e-6 * bytes   (n=${n} ContractCalls, R2 ${r2.toFixed(4)})`);
    const typical = Math.round(X.reduce((a, b) => a + b, 0) / n);
    const sizePart = slope * typical;
    console.log(`  at a typical ${typical} bytes:  fixed ${intercept.toFixed(4)} + size ${sizePart.toFixed(4)}` +
                `  ->  ${((sizePart / (sizePart + intercept)) * 100).toFixed(0)}% of the fee is SIZE`);
    console.log('\n  WHAT THIS MEANS FOR BATCHING (11_TOKEN_DESIGN §5):');
    console.log(`    §5 assumes the fee is MOSTLY FIXED and models batch(n) = 1 + 0.1(n-1).`);
    console.log(`    Measured, only ${intercept.toFixed(3)} DUST is fixed. Batching amortises THAT and nothing else.`);
    const opBytes = Math.min(...X);
    const floor = slope * opBytes;
    console.log(`    Per-op FLOOR = ${floor.toFixed(6)} DUST (the per-byte term for a ${opBytes}-byte op).`);
    console.log(`    A single such op costs ${(intercept + floor).toFixed(6)}, so the BEST batching can ever do`);
    console.log(`    is ${((intercept + floor) / floor).toFixed(2)}x - not the 8-9x §5 projects.`);
    globalThis.__fit = { n, intercept, slope, r2, typical, opBytes, floor,
                         bestCaseSpeedup: (intercept + floor) / floor };
  }
}

// ── the merge experiment ──────────────────────────────────────────────────────
// Kept even though it fails, because the failure is the finding: transactions taken off chain CANNOT
// be merged - every pair collides on segment_id. Batching is therefore not something an operator can
// do to other people's finished transactions; the operations have to be built into one transaction
// from the start, with distinct segments. That is a design constraint on our own batching, and it is
// better recorded as a measured refusal than as an assumption.
console.log('\nmerging, and re-measuring the fee at every step:\n');
console.log('   n   merged fee (DUST)   per-op   vs single   MODEL 1+0.1(n-1)   model error');
console.log('  ' + '─'.repeat(76));

const single = DUST(txs[0].fee);
let acc = txs[0].tx;
const curve = [{ n: 1, dust: single, perOp: single, model: 1 }];
console.log(`   1   ${single.toFixed(6)}          ${single.toFixed(6)}   1.00x        ` +
            `1.000000           ${((single - 1) / 1 * 100).toFixed(1)}%`);

let refused = 0;
for (let i = 1; i < txs.length; i++) {
  let merged;
  try { merged = acc.merge(txs[i].tx); }
  catch (e) { refused++; console.log(`   -   merge refused (${String(e?.message ?? e).slice(0, 40)}) - skipping`); continue; }
  acc = merged;
  const n = curve.length + 1;
  const dust = DUST(acc.fees(params));
  const perOp = dust / n;
  const model = 1 + 0.1 * (n - 1);
  curve.push({ n, dust, perOp, model });
  console.log(`  ${String(n).padStart(2)}   ${dust.toFixed(6)}          ${perOp.toFixed(6)}   ` +
              `${(single / perOp).toFixed(2)}x        ${model.toFixed(6)}           ` +
              `${(((dust - model) / model) * 100).toFixed(1)}%`);
}

// ── verdict ───────────────────────────────────────────────────────────────────
const last = curve[curve.length - 1];
const marginal = curve.length > 1 ? (last.dust - curve[0].dust) / (last.n - 1) : null;

console.log('\n── measured ──────────────────────────────────────────────────────────');
console.log(`  single transaction        ${single.toFixed(6)} DUST`);
console.log(`  batch of ${String(last.n).padStart(2)}               ${last.dust.toFixed(6)} DUST`);
console.log(`  per user-op in that batch ${last.perOp.toFixed(6)} DUST   (${(single / last.perOp).toFixed(2)}x better)`);
if (marginal !== null) {
  console.log(`  MARGINAL cost per extra op ${marginal.toFixed(6)} DUST`);
  console.log(`  §5 model assumes            0.100000 DUST marginal`);
  const verdict = marginal < 0.1 ? 'CHEAPER than the model - §5 is pessimistic'
                : marginal > 0.1 ? 'MORE EXPENSIVE than the model - §5 UNDERSTATES the capital needed'
                : 'matches the model';
  console.log(`  → ${verdict}`);
}
if (refused) console.log(`  (${refused} merges refused - transactions that conflict cannot be batched)`);

mkdirSync(LOGS, { recursive: true });
const out = path.join(LOGS, 'batch-fee.json');
writeFileSync(out, JSON.stringify({
  when: new Date().toISOString(), network: env.networkId,
  blocksScanned: scanned, blockRange: [h + 1, tip],
  singleDust: single, batchSize: last.n, batchDust: last.dust, perOpDust: last.perOp,
  marginalDustPerExtraOp: marginal, modelMarginal: 0.1, mergesRefused: refused,
  curve,
  note: 'Batch built by merging REAL preview transactions. A proxy for our own batching, which does not exist yet.',
}, null, 2) + '\n');
console.log(`\nwritten → logs/batch-fee.json`);
