// Joint ownership - the lock, executed rather than asserted.
//
// THE REQUIREMENT (owner, 2026-08-11): two agents agree a job, the payment locks, and it releases
// only when the work is done. Nobody has to be trusted - not the counterparty, and NOT US.
//
// THE CONSTRUCTION THAT DID NOT LOCK, and which this replaces:
//     skJob = H(sA ‖ sB);  owner = ownerPk(skJob)
// Somebody has to compute `owner` to create the note, hashing is not homomorphic, so that somebody
// knows both halves - and can spend alone. In the facilitator that somebody is us: `jobSync.ts`
// derives BOTH halves from one master secret.
//
// THE ONE UNDER TEST:
//     owner = jointOwnerPk(ownerPk(sA), ownerPk(sB))     ← from the PUBLIC halves
//
// ── WHY THE NEGATIVE TESTS USE A HOSTILE PATH WITNESS ────────────────────────────────────────────
// If a lone holder of sA simply guesses sB, the derived commitment matches no leaf and the *witness*
// throws "no path" - before the circuit runs. That is a FALSE GREEN: it proves the harness stopped,
// not that the contract rejects. `notepool.test.mjs` was fixed for exactly this once already.
//
// So every attack below hands the attacker a GENUINE Merkle path for the REAL joint note, whatever
// commitment the circuit asks for. The rejection then has to come from `assert(p.leaf == cm)` inside
// the circuit - which is the line actually being tested.

import { Contract, ledger } from '../build/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const POOL_ID = b32('phantom-notepool-joint');
const BLOB = new Uint8Array(100);
const AMOUNT = 100n;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ── identities ───────────────────────────────────────────────────────────────────────────────────
// sA never leaves A, sB never leaves B. The facilitator has neither - that is the whole point, so
// there is deliberately no variable here that holds both until §5.
const sA = randomBytes(32);          // payer's half
const sB = randomBytes(32);          // worker's half
const funderSecret = randomBytes(32);
const funderRand = randomBytes(32);
const chgRand = randomBytes(32);
const workerPayoutSecret = randomBytes(32);   // where B wants the money to land

// ── THE JOINT NOTE'S BLINDING FACTOR, AND WHY IT NEEDS SAYING ────────────────────────────────────
// The funder chooses `r` when it pays the joint owner, and `claimJoint` recomputes the commitment
// from (owner, amount, r) - so the claimer MUST have that same `r` or it derives a commitment that
// is in no tree. Holding both halves is necessary and NOT sufficient: the opening travels too.
//
// That is exactly what `noteBlobs` is for - the opening, encrypted, published beside the commitment.
// The first run of this suite failed here because the test used one value for the funding blind and
// another for the claim, which is the same mistake a real integration would make.
const jointRand = randomBytes(32);

/** Build a contract wired to one identity, with a chosen (honest or hostile) path witness. */
function actor({ secret = funderSecret, rand = funderRand, jA = null, jB = null, pathFor }) {
  return new Contract({
    noteSecret: ({ privateState }) => [privateState, secret],
    noteRand: ({ privateState }) => [privateState, rand],
    outRand: ({ privateState }) => [privateState, jointRand],
    changeRand: ({ privateState }) => [privateState, chgRand],
    // An attacker who lacks a half must still return SOMETHING - a real attacker would guess.
    jointSecretA: ({ privateState }) => [privateState, jA ?? randomBytes(32)],
    jointSecretB: ({ privateState }) => [privateState, jB ?? randomBytes(32)],
    notePath: ({ ledger: l, privateState }, cm) => [privateState, pathFor(l, cm)],
  });
}

const honestPath = (l, cm) => {
  const p = l.notes.findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: commitment not in tree');
  return p;
};
/** Always returns a genuine path for `cm`, whatever was asked for. This is what forces the attack
 *  to be rejected by the CIRCUIT rather than by the witness. */
const pathFixedTo = (cm) => (l) => {
  const p = l.notes.findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: the attack leaf is not in the tree');
  return p;
};

function freshCtx(contract) {
  const ctorCtx = rt.createConstructorContext({}, '0'.repeat(64));
  const { currentContractState, currentPrivateState } = contract.initialState(ctorCtx, POOL_ID);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), currentContractState, currentPrivateState);
}

console.log('\n════ NotePool - joint ownership: a note NOBODY can spend alone ════\n');

// ── 0. the public halves ─────────────────────────────────────────────────────────────────────────
// Each side computes its OWN public half from its OWN secret. Neither sends a secret anywhere.
const funder = actor({ pathFor: honestPath });
let ctx = freshCtx(funder);

const pkA = funder.circuits.ownerPk(ctx, sA).result;
const pkB = funder.circuits.ownerPk(ctx, sB).result;
const jointOwner = funder.circuits.jointOwnerPk(ctx, pkA, pkB).result;

check('the joint owner is computable from the PUBLIC halves alone',
      jointOwner instanceof Uint8Array && jointOwner.length === 32,
      `owner=${Buffer.from(jointOwner).toString('hex').slice(0, 16)}…`);

// A joint owner must not collide with either single owner, or a joint note could be drained by one
// party using the ordinary `spend`.
check('the joint owner differs from both single owners',
      Buffer.compare(jointOwner, pkA) !== 0 && Buffer.compare(jointOwner, pkB) !== 0);

// Order matters: jointOwnerPk(pkA,pkB) and jointOwnerPk(pkB,pkA) must be different notes, or the
// two roles would be interchangeable and "payer" would stop meaning anything.
check('the halves are ORDERED - (A,B) is not the same note as (B,A)',
      Buffer.compare(jointOwner, funder.circuits.jointOwnerPk(ctx, pkB, pkA).result) !== 0);

// ── 1. funding needs NO new circuit and NO secret ────────────────────────────────────────────────
// The payer just pays `jointOwner` with the ordinary transfer, exactly as it would any other payee.
Object.assign(ctx, funder.impureCircuits.deposit(ctx, AMOUNT, BLOB).context);
Object.assign(ctx, funder.impureCircuits.transfer(ctx, jointOwner, AMOUNT, AMOUNT, BLOB, BLOB).context);

let led = ledger(ctx.currentQueryContext.state);
check('the joint note was funded with the ORDINARY transfer - no new funding circuit',
      led.notes.firstFree() === 3n, `leaves=${led.notes.firstFree()}`);

/** The joint note's real commitment, captured from the argument the circuit passes to `notePath`. */
function jointCommitment(ctx) {
  let seen = null;
  const probe = actor({
    jA: sA, jB: sB, rand: jointRand,
    pathFor: (_l, cm) => { seen = cm; throw new Error('probe'); },
  });
  try { probe.impureCircuits.claimJoint(ctx, pkB, AMOUNT, BLOB); } catch { /* expected */ }
  if (seen === null) throw new Error('probe failed to capture the joint commitment');
  return seen;
}
const jointCm = jointCommitment(ctx);
check('the funded leaf IS the joint note', led.notes.findPathForLeaf(jointCm) !== undefined,
      `cm=${Buffer.from(jointCm).toString('hex').slice(0, 16)}…`);

// ── 2. A ALONE cannot claim ──────────────────────────────────────────────────────────────────────
// A holds sA and is handed a genuine path for the real joint note. The rejection must come from the
// circuit, not from a missing path.
const payoutPk = funder.circuits.ownerPk(ctx, workerPayoutSecret).result;

let aWon = false, aErr = '';
try {
  actor({ jA: sA, jB: null, rand: jointRand, pathFor: pathFixedTo(jointCm) })
    .impureCircuits.claimJoint(ctx, payoutPk, AMOUNT, BLOB);
  aWon = true;
} catch (e) { aErr = String(e.message ?? e); }
check('the PAYER alone cannot claim, even with a genuine path',
      !aWon && /path is not for this joint note/i.test(aErr),
      aWon ? 'IT SUCCEEDED - the note is not locked' : aErr.slice(0, 70));

// ── 3. B ALONE cannot claim ──────────────────────────────────────────────────────────────────────
let bWon = false, bErr = '';
try {
  actor({ jA: null, jB: sB, rand: jointRand, pathFor: pathFixedTo(jointCm) })
    .impureCircuits.claimJoint(ctx, payoutPk, AMOUNT, BLOB);
  bWon = true;
} catch (e) { bErr = String(e.message ?? e); }
check('the WORKER alone cannot claim, even with a genuine path',
      !bWon && /path is not for this joint note/i.test(bErr),
      bWon ? 'IT SUCCEEDED - the worker can take the money before doing the work' : bErr.slice(0, 70));

// ── 4. WE cannot claim ───────────────────────────────────────────────────────────────────────────
// This is the requirement that the old construction failed. The facilitator holds neither half.
let usWon = false, usErr = '';
try {
  actor({ jA: null, jB: null, rand: jointRand, pathFor: pathFixedTo(jointCm) })
    .impureCircuits.claimJoint(ctx, payoutPk, AMOUNT, BLOB);
  usWon = true;
} catch (e) { usErr = String(e.message ?? e); }
check('the FACILITATOR cannot claim - it holds neither half',
      !usWon && /path is not for this joint note/i.test(usErr),
      usWon ? 'IT SUCCEEDED - users still have to trust us' : usErr.slice(0, 70));

// ── 5. together they CAN claim - the positive case ───────────────────────────────────────────────
// A suite that only ever rejects proves nothing: it would pass against a contract where claimJoint
// always throws. This is settlement - A has handed sA to B, so B now holds both.
let settled = false, settleErr = '';
try {
  const claim = actor({ jA: sA, jB: sB, rand: jointRand, pathFor: honestPath })
    .impureCircuits.claimJoint(ctx, payoutPk, AMOUNT, BLOB);
  Object.assign(ctx, claim.context);
  settled = true;
} catch (e) { settleErr = String(e.message ?? e); }
check('BOTH halves together DO claim it - settlement works', settled, settleErr.slice(0, 80));

led = ledger(ctx.currentQueryContext.state);
check('the payout note was created for the worker', led.notes.firstFree() === 4n,
      `leaves=${led.notes.firstFree()}`);

// ── 6. it cannot be claimed twice ────────────────────────────────────────────────────────────────
let twice = false, twiceErr = '';
try {
  actor({ jA: sA, jB: sB, rand: jointRand, pathFor: honestPath })
    .impureCircuits.claimJoint(ctx, payoutPk, AMOUNT, BLOB);
  twice = true;
} catch (e) { twiceErr = String(e.message ?? e); }
check('a settled job cannot be claimed again',
      !twice && /already spent/i.test(twiceErr),
      twice ? 'IT SUCCEEDED - the payment can be taken twice' : twiceErr.slice(0, 60));

// ── 7. the amount is bound ───────────────────────────────────────────────────────────────────────
// The agreed amount is frozen at creation. Claiming a different one must fail, or a worker could
// settle for more than was agreed.
const ctx2 = (() => {
  const f = actor({ pathFor: honestPath });
  const c = freshCtx(f);
  Object.assign(c, f.impureCircuits.deposit(c, AMOUNT, BLOB).context);
  Object.assign(c, f.impureCircuits.transfer(c, jointOwner, AMOUNT, AMOUNT, BLOB, BLOB).context);
  return c;
})();
let wrongAmt = false, wrongErr = '';
try {
  actor({ jA: sA, jB: sB, rand: jointRand, pathFor: pathFixedTo(jointCommitment(ctx2)) })
    .impureCircuits.claimJoint(ctx2, payoutPk, AMOUNT + 1n, BLOB);
  wrongAmt = true;
} catch (e) { wrongErr = String(e.message ?? e); }
check('claiming a DIFFERENT amount than agreed is rejected',
      !wrongAmt && /path is not for this joint note/i.test(wrongErr),
      wrongAmt ? 'IT SUCCEEDED - the amount is not bound' : wrongErr.slice(0, 60));

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed\n`);
console.log('WHAT THIS PROVES: the payment locks on funding and opens only when both halves are');
console.log('present. Not the payer, not the worker, and not the facilitator can move it alone.\n');
process.exit(fail === 0 ? 0 : 1);
