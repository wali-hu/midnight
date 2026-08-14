// NotePool - executed, not just compiled.
//
// Compilation proves syntax. It does not prove the contract is sound. The test that matters here is
// the NEGATIVE one: a Merkle path whose leaf is somebody else's note must be REJECTED. If that
// passes, the contract mints money.

import { Contract, ledger } from '../build/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const POOL_ID = b32('phantom-notepool-test');
// The blob is opaque to the contract, so these tests can use a constant. Its real content is
// exercised in tools/notes.mjs and end-to-end by notepool-recover.mjs.
const BLOB = new Uint8Array(100);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ── the private state: one note (secret, amount, rand) plus whatever the tree tells us ──
const makeState = (secret, rand) => ({ secret, rand });

// Witnesses. Deliberately dumb: they just hand over private data. Everything they return is
// untrusted input as far as the circuit is concerned - which is the whole point of the test below.
const witnesses = {
  noteSecret: ({ privateState }) => [privateState, privateState.secret],
  noteRand: ({ privateState }) => [privateState, privateState.rand],
  outRand: ({ privateState }) => [privateState, privateState.rand],
  changeRand: ({ privateState }) => [privateState, privateState.rand],
    // NotePool now has joint-ownership circuits, and the Contract constructor requires EVERY
    // witness to be present even when unused. Zeros are safe: a zero half opens no real note.
    jointSecretA: ({ privateState }) => [privateState, new Uint8Array(32)],
    jointSecretB: ({ privateState }) => [privateState, new Uint8Array(32)],
  // Look the commitment up in the real tree and return its authentication path.
  notePath: ({ ledger: led, privateState }, commitment) => {
    const path = led.notes.findPathForLeaf(commitment);
    if (path === undefined) throw new Error('no path: commitment not in tree');
    return [privateState, path];
  },
};

function freshContext(secret, rand) {
  const contract = new Contract(witnesses);
  const ctorCtx = rt.createConstructorContext(makeState(secret, rand), '0'.repeat(64));
  const { currentContractState, currentPrivateState } = contract.initialState(ctorCtx, POOL_ID);
  const ctx = rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), currentContractState, currentPrivateState,
  );
  return { contract, ctx };
}

console.log('\n════ NotePool - real execution ════\n');

// ── 1. deposit inserts a leaf ────────────────────────────────────────────────
const aliceSecret = randomBytes(32);
const aliceRand = randomBytes(32);
const { contract, ctx } = freshContext(aliceSecret, aliceRand);

let led = ledger(ctx.currentQueryContext.state);
const before = led.notes.isFull;   // touch the tree so a bad build fails loudly here
const dep = contract.impureCircuits.deposit(ctx, 100n, BLOB);
Object.assign(ctx, dep.context);
led = ledger(ctx.currentQueryContext.state);
check('deposit(100) executes and inserts a leaf', led.notes.firstFree() === 1n,
      `firstFree=${led.notes.firstFree()}`);

// ── 2. the owner can spend that note ─────────────────────────────────────────
let spendOk = true, spendErr = '';
try {
  const sp = contract.impureCircuits.spend(ctx, 100n);
  Object.assign(ctx, sp.context);
} catch (e) { spendOk = false; spendErr = String(e.message ?? e).slice(0, 90); }
check('owner spends their own note', spendOk, spendErr);

led = ledger(ctx.currentQueryContext.state);
let nulCount = 0; for (const _ of led.nullifiers) nulCount++;
check('a nullifier was published', nulCount === 1, `nullifiers=${nulCount}`);

// ── 3. the same note cannot be spent twice ───────────────────────────────────
let double = false, doubleErr = '';
try { contract.impureCircuits.spend(ctx, 100n); double = true; }
catch (e) { doubleErr = String(e.message ?? e); }
check('double-spend is REJECTED', !double && /already spent/i.test(doubleErr),
      double ? 'it succeeded - double-spend possible!' : doubleErr.slice(0, 60));

// ── the attacks must reach the CIRCUIT ───────────────────────────────────────
// An earlier version of these two tests "passed" because the test harness threw before the circuit
// ever ran - a false green. To attack properly we need Alice's real commitment, so the hostile
// witness can hand over a genuine, verifiable path for a note the attacker does not own.
//
// `notePath` is called with the commitment the circuit just derived, so running spend() with a
// given secret/rand/amount and capturing that argument yields that note's commitment exactly.
function commitmentOf(ctx, secret, rand, amount) {
  let seen = null;
  const probe = new Contract({
    noteSecret: ({ privateState }) => [privateState, secret],
    noteRand: ({ privateState }) => [privateState, rand],
    outRand: ({ privateState }) => [privateState, rand],
    changeRand: ({ privateState }) => [privateState, rand],
    // NotePool now has joint-ownership circuits, and the Contract constructor requires EVERY
    // witness to be present even when unused. Zeros are safe: a zero half opens no real note.
    jointSecretA: ({ privateState }) => [privateState, new Uint8Array(32)],
    jointSecretB: ({ privateState }) => [privateState, new Uint8Array(32)],
    notePath: ({ privateState }, commitment) => { seen = commitment; throw new Error('probe'); },
  });
  try { probe.impureCircuits.spend(ctx, amount); } catch { /* expected: probe stops here */ }
  if (seen === null) throw new Error('probe failed to capture the commitment');
  return seen;
}

// A hostile path witness: always hands over a GENUINE path for `cm`, whatever the circuit asked for.
// If that path does not exist the harness is broken, and it must say so loudly rather than let an
// attack "fail" for the wrong reason - that is how a false green happens.
const pathFixedTo = (cm) => (l) => {
  const p = l.notes.findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: attack leaf is not in the tree');
  return p;
};

function aliceNoteSetup() {
  const f = freshContext(aliceSecret, aliceRand);
  Object.assign(f.ctx, f.contract.impureCircuits.deposit(f.ctx, 100n, BLOB).context);
  return { f, aliceCm: commitmentOf(f.ctx, aliceSecret, aliceRand, 100n) };
}

const bobSecret = randomBytes(32);
const payeeRand = randomBytes(32), chgRand = randomBytes(32);

/** A contract wired to one identity, with an honest-or-hostile path witness. */
function actor(secret, rand, pathFor) {
  return new Contract({
    noteSecret: ({ privateState }) => [privateState, secret],
    noteRand: ({ privateState }) => [privateState, rand],
    outRand: ({ privateState }) => [privateState, payeeRand],
    changeRand: ({ privateState }) => [privateState, chgRand],
    // NotePool now has joint-ownership circuits, and the Contract constructor requires EVERY
    // witness to be present even when unused. Zeros are safe: a zero half opens no real note.
    jointSecretA: ({ privateState }) => [privateState, new Uint8Array(32)],
    jointSecretB: ({ privateState }) => [privateState, new Uint8Array(32)],
    notePath: ({ ledger: l, privateState }, cm) => [privateState, pathFor(l, cm)],
  });
}
const honestPath = (l, cm) => {
  const p = l.notes.findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: commitment not in tree');
  return p;
};

// ── 4. a valid path + the WRONG amount must be rejected BY THE CIRCUIT ───────
// The witness hands over Alice's genuine path (checkRoot would pass), but the circuit is asked to
// spend 999 from a note worth 100. Amount is bound into the commitment, so the derived commitment
// no longer matches the path's leaf.
let wrongAmt = false, wrongAmtErr = '';
try {
  const { f, aliceCm } = aliceNoteSetup();
  actor(aliceSecret, aliceRand, pathFixedTo(aliceCm))
    .impureCircuits.spend(f.ctx, 999n);   // real path, wrong amount
  wrongAmt = true;
} catch (e) { wrongAmtErr = String(e.message ?? e); }
check('valid path + WRONG amount is rejected by the circuit',
      !wrongAmt && /path is not for this note/i.test(wrongAmtErr),
      wrongAmt ? '🚨 amount is NOT bound into the commitment' : wrongAmtErr.slice(0, 70));

// ── 5. THE ONE THAT MATTERS ──────────────────────────────────────────────────
// Mallory owns nothing. She supplies a GENUINE path for Alice's leaf (tree leaves are public) and
// derives the nullifier from her own secret. checkRoot passes. The only thing standing between her
// and Alice's note is `assert(p.leaf == cm)`.
let stolen = false, stolenErr = '';
try {
  const { f, aliceCm } = aliceNoteSetup();
  // Hostile: ignore the commitment asked for, return a real path for ALICE's leaf.
  actor(randomBytes(32), randomBytes(32), pathFixedTo(aliceCm))
    .impureCircuits.spend(f.ctx, 100n);
  stolen = true;
} catch (e) { stolenErr = String(e.message ?? e); }

check("Mallory CANNOT spend Alice's note with a borrowed path",
      !stolen && /path is not for this note/i.test(stolenErr),
      stolen ? '🚨 SOUNDNESS HOLE - funds stealable' : stolenErr.slice(0, 70));

// ═══════════════════════════════════════════════════════════════════════════
// TRANSFER - one note in, two notes out (payee + change)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n── transfer ──');

// Alice deposits 100, then pays Bob 30 (change 70).
let tCtx, bobPk;
{
  const f = freshContext(aliceSecret, aliceRand);
  const alice = actor(aliceSecret, aliceRand, honestPath);
  Object.assign(f.ctx, alice.impureCircuits.deposit(f.ctx, 100n, BLOB).context);

  // Bob's public key - derived from HIS secret; Alice only ever receives this value.
  const pkRes = alice.impureCircuits.ownerPk(f.ctx, bobSecret);
  bobPk = pkRes.result;
  Object.assign(f.ctx, pkRes.context);

  let ok = true, err = '';
  try { Object.assign(f.ctx, alice.impureCircuits.transfer(f.ctx, bobPk, 100n, 30n, BLOB, BLOB).context); }
  catch (e) { ok = false; err = String(e.message ?? e).slice(0, 80); }
  check('transfer 100 → 30 to Bob + 70 change', ok, err);

  const l = ledger(f.ctx.currentQueryContext.state);
  check('two new leaves inserted (payee + change)', l.notes.firstFree() === 3n,
        `firstFree=${l.notes.firstFree()}`);
  tCtx = f.ctx;
}

// Bob can spend exactly what he was paid.
{
  const bob = actor(bobSecret, payeeRand, honestPath);
  let ok = true, err = '';
  try { bob.impureCircuits.spend(tCtx, 30n); } catch (e) { ok = false; err = String(e.message ?? e).slice(0, 70); }
  check('Bob can spend the 30 he received', ok, err);
}

// Bob cannot spend more than he was paid. He supplies the GENUINE path for his own 30-note (an
// honest witness would have failed to find a path at all, which would prove nothing) and asks the
// circuit for 70. The amount is bound into the commitment, so the leaf no longer matches.
{
  const bobCm30 = commitmentOf(tCtx, bobSecret, payeeRand, 30n);
  let stole = false, err = '';
  try {
    actor(bobSecret, payeeRand, pathFixedTo(bobCm30)).impureCircuits.spend(tCtx, 70n);
    stole = true;
  } catch (e) { err = String(e.message ?? e); }
  check('Bob CANNOT spend 70 (he was paid 30)',
        !stole && /path is not for this note/i.test(err),
        stole ? '🚨 amount not bound - Bob inflated his own note' : err.slice(0, 60));
}

// Value conservation: sending more than the note holds must be rejected.
{
  const f = freshContext(aliceSecret, aliceRand);
  const alice = actor(aliceSecret, aliceRand, honestPath);
  Object.assign(f.ctx, alice.impureCircuits.deposit(f.ctx, 100n, BLOB).context);
  let minted = false, err = '';
  try { alice.impureCircuits.transfer(f.ctx, bobPk, 100n, 150n, BLOB, BLOB); minted = true; }
  catch (e) { err = String(e.message ?? e); }
  check('sending MORE than the note holds is rejected',
        !minted && /more than the note holds/i.test(err),
        minted ? '🚨 VALUE CREATED FROM NOTHING' : err.slice(0, 60));
}

// The money-printer: lie about the input amount to mint a fat change note.
// Alice's note is 100, but she claims it is 1000 and sends 30 - hoping for 970 of change.
// The commitment binds the amount, so her derived commitment no longer matches the path's leaf.
{
  const { f, aliceCm } = aliceNoteSetup();          // real 100-note in the tree
  let printed = false, err = '';
  try {
    // Genuine path for the genuine 100-note, so checkRoot would pass - the only thing that can
    // stop her is the leaf↔commitment binding.
    actor(aliceSecret, aliceRand, pathFixedTo(aliceCm))
      .impureCircuits.transfer(f.ctx, bobPk, 1000n, 30n, BLOB, BLOB);
    printed = true;
  } catch (e) { err = String(e.message ?? e); }
  check('inflating the INPUT amount is rejected',
        !printed && /path is not for this note/i.test(err),
        printed ? '🚨 MONEY PRINTER - change note minted from nothing' : err.slice(0, 60));
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  -  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
