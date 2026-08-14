// D3 - MEASURE the DUST cost of a FAILED transaction.
//
//   node measure-failed-fee.mjs [blocksToScan]
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS AN OPERATOR-MARGIN QUESTION, NOT A CURIOSITY
//
// 11_TOKEN_DESIGN §7 Q4 lists it as open, and §3 leans on the answer without having it:
//
//   > "Submits an invalid transaction → The chain rejects it. The relayer burns its own DUST.
//   >  It is already the only party that loses."
//
// That sentence is load-bearing for the NO-SLASHING argument. If a failed transaction were free, a
// relayer could spam invalid submissions at no cost and "it is already the only party that loses"
// would be false. And it cuts the other way too: the operator's 40% fee share must cover DUST on
// EVERY transaction it submits, including the ones that fail. An operator that budgets only for
// successes is under-capitalised by exactly the failure rate.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS ACTUALLY BEING ASKED
//
// Midnight splits a transaction into a GUARANTEED phase and a FALLIBLE phase. So "did it cost
// anything" is really three questions:
//
//   1. Does a FAILURE appear on chain at all, or is it dropped before inclusion?
//   2. If it is included, is the FULL fee charged, or only the guaranteed part?
//   3. Is a PARTIAL_SUCCESS charged like a success or like a failure?
//
// The indexer exposes `transactionResult { status segments { id success } }` - SUCCESS / PARTIAL_SUCCESS / FAILURE
// - so this is measured, not reasoned about. The fee itself comes from
// `tx.fees(LedgerParameters.initialParameters())`, the same estimator as D2 and 09_ECONOMICS §1, so
// all three numbers are comparable.
//
// ⚠️ A failed transaction that is never INCLUDED in a block cannot be measured this way at all - it
// leaves no on-chain record. That limit is reported rather than papered over: this measures the cost
// of failures that LAND, which is the case the operator actually pays for.

import { LedgerParameters, Transaction } from '@midnight-ntwrk/ledger-v8';
import { writeFileSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { pick as pickNet } from './env.mjs';

const env = pickNet(process.env.MN_NETWORK ?? 'preview');
const SCAN = Number(process.argv[2] ?? 300);
const LOGS = new URL('logs/', import.meta.url).pathname;
const params = LedgerParameters.initialParameters();
const DUST = (specks) => Number(specks) / 1e15;

/**
 * Query the indexer, and TREAT AN ERROR AS AN ERROR.
 *
 * ⚠️ This function used to end in `.json()` and every caller did `d.data?.block?.transactions ?? []`.
 * When the query was malformed the indexer replied `{"data":null,"errors":[…]}`, the `??` turned that
 * into an empty array, and the tool printed a confident verdict - "NO failed transaction was found"
 * - from a query that had never run. Zero transactions across 250 blocks, including zero SUCCESSES,
 * on a chain where D2 had just read 40 in 90 blocks.
 *
 * Same family as AGENT-GRAPH RC10 and RC4: an EMPTY result read as a CLEAN result. The `??` operator
 * is where it hides, because it converts "I could not answer" into "the answer is nothing".
 */
const q = async (body) => {
  const res = await fetch(env.indexer, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}`);
  const j = await res.json();
  if (j.errors) throw new Error(`indexer rejected the query: ${JSON.stringify(j.errors)}`);
  return j;
};

const tip = (await q({ query: '{ block { height } }' })).data.block.height;
console.log(`network ${env.networkId} - scanning ${SCAN} blocks back from ${tip} for non-SUCCESS transactions…\n`);

const rows = [];
let h = tip;
for (let i = 0; i < SCAN; i++, h--) {
  const d = await q({
    query: `query($h:Int!){ block(offset:{height:$h}){ transactions { hash raw
              ... on RegularTransaction { fee transactionResult { status segments { id success } } }
              contractActions { __typename } } } }`,
    variables: { h },
  });
  for (const t of d.data?.block?.transactions ?? []) {
    const status = t.transactionResult?.status ?? 'UNKNOWN';
    const hexs = (t.raw ?? '').replace(/^0x/, '');
    let fee = null;
    try {
      fee = Transaction.deserialize('signature', 'proof', 'binding', Buffer.from(hexs, 'hex')).fees(params);
    } catch { /* undeserialisable shape - skipped rather than guessed at */ }
    rows.push({
      h, hash: t.hash.slice(0, 10), bytes: hexs.length / 2, status,
      segments: t.transactionResult?.segments ?? null,
      dust: fee === null ? null : DUST(fee),
      kind: [...new Set((t.contractActions ?? []).map((a) => a.__typename))].join(',') || 'transfer',
    });
  }
}

// POSITIVE CONTROL. If a scan of hundreds of blocks yields nothing at all, the instrument is broken,
// not the chain - and reporting "no failures found" from a broken instrument is worse than reporting
// nothing. This is the check that was missing when the malformed query returned zero rows.
if (rows.length === 0) {
  console.error(`BROKEN INSTRUMENT: 0 transactions across ${SCAN} blocks - not even a SUCCESS.`);
  console.error('  A live chain does not go that quiet; the scan itself has failed.');
  console.error('  Refusing to report a verdict about failures from a scan that found nothing at all.');
  process.exit(1);
}

const byStatus = {};
for (const r of rows) (byStatus[r.status] ??= []).push(r);

console.log(`${rows.length} transactions across ${SCAN} blocks\n`);
console.log('  status            count   median DUST   median bytes   DUST per 1000 bytes');
console.log('  ' + '─'.repeat(74));

const stats = {};
for (const [status, list] of Object.entries(byStatus)) {
  const withFee = list.filter((r) => r.dust !== null);
  if (!withFee.length) { console.log(`  ${status.padEnd(16)} ${String(list.length).padStart(5)}   (no fee computable)`); continue; }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const mDust = med(withFee.map((r) => r.dust));
  const mBytes = med(withFee.map((r) => r.bytes));
  stats[status] = { count: list.length, medianDust: mDust, medianBytes: mBytes, perKb: (mDust / mBytes) * 1000 };
  console.log(`  ${status.padEnd(16)} ${String(list.length).padStart(5)}   ${mDust.toFixed(6)}      ${String(mBytes).padStart(7)}        ${((mDust / mBytes) * 1000).toFixed(6)}`);
}

// ── the failures themselves ───────────────────────────────────────────────────
const bad = rows.filter((r) => r.status === 'FAILURE' || r.status === 'PARTIAL_SUCCESS');
if (bad.length) {
  console.log('\n  every non-SUCCESS transaction found:');
  console.log('  block      hash        bytes   status            DUST        segments');
  console.log('  ' + '─'.repeat(80));
  for (const r of bad.slice(0, 25)) {
    console.log(`  ${r.h}  ${r.hash}  ${String(r.bytes).padStart(6)}  ${r.status.padEnd(16)} ` +
                `${r.dust === null ? '   n/a   ' : r.dust.toFixed(6)}  ${JSON.stringify(r.segments)}`);
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────
console.log('\n── verdict ───────────────────────────────────────────────────────────');
const S = stats.SUCCESS, F = stats.FAILURE, P = stats.PARTIAL_SUCCESS;
if (!F && !P) {
  console.log('  NO failed or partially-failed transaction was found on chain in this window.');
  console.log('  That is a RESULT, not a gap: it means failures are not landing on preview right now,');
  console.log('  so the cost of a landed failure cannot be measured from public data today.');
  console.log('  It does NOT mean failures are free - an invalid transaction rejected BEFORE inclusion');
  console.log('  leaves no on-chain record at all, and that case is invisible to this method.');
} else {
  // Compared PER BYTE, because D2 measured that ~94% of a fee is size - comparing raw medians would
  // mostly compare transaction sizes and call the difference a failure discount.
  for (const [name, st] of [['FAILURE', F], ['PARTIAL_SUCCESS', P]]) {
    if (!st || !S) continue;
    const ratio = st.perKb / S.perKb;
    console.log(`  ${name}: ${st.medianDust.toFixed(6)} DUST median (${st.count} seen)`);
    console.log(`    per-byte cost is ${ratio.toFixed(3)}x a SUCCESS` +
                `  → ${ratio > 0.9 ? 'charged essentially the FULL fee' : ratio < 0.1 ? 'charged almost NOTHING' : 'charged a PARTIAL fee'}`);
  }
}

mkdirSync(LOGS, { recursive: true });
writeFileSync(path.join(LOGS, 'failed-tx-fee.json'), JSON.stringify({
  when: new Date().toISOString(), network: env.networkId,
  blocksScanned: SCAN, blockRange: [h + 1, tip], transactions: rows.length,
  stats, nonSuccess: bad,
  caveat: 'Only failures INCLUDED IN A BLOCK are visible. A transaction rejected before inclusion leaves no record.',
}, null, 2) + '\n');
console.log('\nwritten → logs/failed-tx-fee.json');
