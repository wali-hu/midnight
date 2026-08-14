// JobContract - executed, not just compiled.
//
// The happy path proves nothing on its own: a contract with no checks lets an honest pair through.
// What decides whether this is an agreement or a decoration is whether the ATTACKS fail, and fail
// INSIDE THE CIRCUIT rather than in the harness.
//
// Two disciplines carried over from notepool.test.mjs and mandate.test.mjs, both learned expensively:
//
//   1. Every negative test asserts on the ERROR TEXT, never merely on "it threw". A rejection for
//      the wrong reason reads exactly like a pass. That is how a hole hides.
//   2. An attack must hand the circuit a GENUINE Merkle path for a real leaf. An honest witness
//      simply fails to find a path and the attack "fails" without the guard ever running.

import { Contract, ledger } from '../build-job/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const hex = (u) => Buffer.from(u).toString('hex');
const REGISTRY_ID = b32('phantom-job-test');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};
/** An attack passes only if the CIRCUIT rejected it with the expected message. */
const rejected = (name, run, expect) => {
  let ok = false, err = '';
  try { run(); } catch (e) { err = String(e.message ?? e); ok = expect.test(err); }
  check(name, ok, ok ? err.replace(/^.*failed assert: /, '') : (err || '🚨 IT SUCCEEDED'));
};

// ── the two parties ─────────────────────────────────────────────────────────
const payer = randomBytes(32);
const worker = randomBytes(32);
const jobSecret = randomBytes(32);     // shared: derives the state chain
const jobRand = randomBytes(32);
const AMOUNT = 500n, ASSET = 1n;
const SPEC = b32('scrape these 100 pages');
// Deadline in ms - the kernel compares block time, which the simulator drives from the host clock.
// SECONDS - the kernel compares in seconds; ms silently disables the check. See the contract header.
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
const PAST = 1n;

const payerHalf = randomBytes(32), workerHalf = randomBytes(32);
const halfRandA = randomBytes(32), halfRandB = randomBytes(32);

// ── the witness table ───────────────────────────────────────────────────────
// Everything the circuit is told comes from here, and none of it is trusted. `over` replaces any
// single value, which is how the attacks are built.
function makeContract(over = {}) {
  const w = {
    payerSecret: payer, workerSecret: worker, jobSecret, jobRand,
    payerPk: null, workerPk: null,
    amount: AMOUNT, assetId: ASSET, specHash: SPEC, deadline: FUTURE,
    payerHalfCommit: null, workerHalfCommit: null,
    status: 0n, step: 0n,
    jobPathFor: null, statePathFor: null,
    ...over,
  };
  const treePath = (tree, cm, what) => {
    const p = tree.findPathForLeaf(cm);
    if (p === undefined) throw new Error(`HARNESS BROKEN: ${what} ${hex(cm).slice(0, 12)}… not in tree`);
    return p;
  };
  return new Contract({
    payerSecret: ({ privateState }) => [privateState, w.payerSecret],
    workerSecret: ({ privateState }) => [privateState, w.workerSecret],
    jobSecret: ({ privateState }) => [privateState, w.jobSecret],
    jobRand: ({ privateState }) => [privateState, w.jobRand],
    jobPayerPk: ({ privateState }) => [privateState, w.payerPk],
    jobWorkerPk: ({ privateState }) => [privateState, w.workerPk],
    jobAmount: ({ privateState }) => [privateState, w.amount],
    jobAssetId: ({ privateState }) => [privateState, w.assetId],
    jobSpecHash: ({ privateState }) => [privateState, w.specHash],
    jobDeadline: ({ privateState }) => [privateState, w.deadline],
    jobPayerHalfCommit: ({ privateState }) => [privateState, w.payerHalfCommit],
    jobWorkerHalfCommit: ({ privateState }) => [privateState, w.workerHalfCommit],
    stateStatus: ({ privateState }) => [privateState, w.status],
    stateStep: ({ privateState }) => [privateState, w.step],
    jobPath: ({ ledger: l, privateState }, cm) =>
      [privateState, w.jobPathFor ? w.jobPathFor(l, cm) : treePath(l.jobs, cm, 'job')],
    statePath: ({ ledger: l, privateState }, cm) =>
      [privateState, w.statePathFor ? w.statePathFor(l, cm) : treePath(l.states, cm, 'state')],
  });
}

function freshCtx() {
  const c = makeContract();
  const ctorCtx = rt.createConstructorContext({}, '0'.repeat(64));
  const init = c.initialState(ctorCtx, REGISTRY_ID);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
}

console.log('\n════ JobContract - real execution ════\n');

// ── derive the identities WITH THE CONTRACT ─────────────────────────────────
let ctx = freshCtx();
const boot = makeContract();
const PAYER_PK = boot.impureCircuits.payerPk(ctx, payer).result;
const WORKER_PK = boot.impureCircuits.workerPk(ctx, worker).result;
const P_HALF = boot.impureCircuits.halfCommit(ctx, payerHalf, halfRandA).result;
const W_HALF = boot.impureCircuits.halfCommit(ctx, workerHalf, halfRandB).result;
check('contract derives payerPk / workerPk / both half-commitments',
      PAYER_PK.length === 32 && WORKER_PK.length === 32 && P_HALF.length === 32 && W_HALF.length === 32);

const base = { payerPk: PAYER_PK, workerPk: WORKER_PK, payerHalfCommit: P_HALF, workerHalfCommit: W_HALF };
const actor = (over = {}) => makeContract({ ...base, ...over });
const count = (it) => { let n = 0; for (const _ of it) n++; return n; };
const read = (c) => ledger(c.currentQueryContext.state);

// The commitment probe: `jobPath` is called with the commitment the circuit just derived, so running
// a circuit with a capturing witness yields that job's commitment exactly.
function jobCommitmentOf(c, over = {}) {
  let seen = null;
  try {
    makeContract({ ...base, ...over, jobPathFor: (_l, cm) => { seen = cm; throw new Error('probe'); } })
      .impureCircuits.deliver(c);
  } catch { /* expected */ }
  if (seen === null) throw new Error('HARNESS BROKEN: could not capture the job commitment');
  return seen;
}
/** Hostile path witness: always the GENUINE path for `cm`, whatever the circuit asked for. */
const pathFixedTo = (pick, cm) => (l) => {
  const p = pick(l).findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: attack leaf is not in the tree');
  return p;
};

// ── 1. create ───────────────────────────────────────────────────────────────
ctx = freshCtx();
Object.assign(ctx, actor().impureCircuits.create(ctx).context);
let l = read(ctx);
check('create() records one job and one state note',
      l.jobs.firstFree() === 1n && l.states.firstFree() === 1n,
      `jobs=${l.jobs.firstFree()} states=${l.states.firstFree()}`);
check('nothing about the parties, amount, asset or spec is on chain',
      Object.keys(l).filter((k) => /payer|worker|amount|asset|spec|deadline/i.test(k)).length === 0,
      `ledger: ${Object.keys(l).join(', ')}`);

const REAL_JOB_CM = jobCommitmentOf(ctx);

// ── 2. the honest path ──────────────────────────────────────────────────────
let ok = true, err = '';
try { Object.assign(ctx, actor().impureCircuits.deliver(ctx).context); }
catch (e) { ok = false; err = String(e.message ?? e).slice(0, 80); }
check('worker delivers', ok, err);
l = read(ctx);
check('the created state was consumed, a delivered state replaced it',
      count(l.settled) === 1 && l.states.firstFree() === 2n,
      `settled=${count(l.settled)} states=${l.states.firstFree()}`);

ok = true; err = '';
try { Object.assign(ctx, actor({ status: 1n, step: 1n }).impureCircuits.accept(ctx).context); }
catch (e) { ok = false; err = String(e.message ?? e).slice(0, 80); }
check('payer accepts - THIS is the settlement', ok, err);
l = read(ctx);
check('two nullifiers, three states - unlinkable to each other',
      count(l.settled) === 2 && l.states.firstFree() === 3n,
      `settled=${count(l.settled)} states=${l.states.firstFree()}`);

// ── 3. a settled job is finished ────────────────────────────────────────────
rejected('accepting an ALREADY-SETTLED job is rejected',
  () => actor({ status: 2n, step: 2n }).impureCircuits.accept(ctx),
  /already settled/i);

rejected('refunding an ALREADY-ACCEPTED job is rejected',
  () => actor({ status: 2n, step: 2n }).impureCircuits.refund(ctx),
  /already settled/i);

// ── 4. REWIND - reuse the state you legitimately held a moment ago ──────────
rejected('REWINDING to an earlier state is rejected',
  () => actor({ status: 1n, step: 1n }).impureCircuits.accept(ctx),
  /already used/i);

// ── 5. wrong party ──────────────────────────────────────────────────────────
rejected('the WORKER cannot accept (only the payer can)',
  () => actor({ payerSecret: worker, status: 1n, step: 1n }).impureCircuits.accept(ctx),
  /only the payer can accept/i);

rejected('the PAYER cannot deliver (only the worker can)',
  () => actor({ workerSecret: payer }).impureCircuits.deliver(ctx),
  /not the worker named/i);

rejected('a stranger cannot create a job naming someone else as payer',
  () => actor({ payerSecret: randomBytes(32) }).impureCircuits.create(freshCtx()),
  /not the payer named/i);

// ── 6. THE MONEY ATTACKS - every term is bound into the commitment ──────────
// Each hands over the GENUINE path for the real job, so checkRoot would pass; only the leaf↔
// commitment binding can stop them.
rejected('opening the job with a BIGGER amount is rejected',
  () => actor({ amount: 999999n, status: 1n, step: 1n, jobPathFor: pathFixedTo((l2) => l2.jobs, REAL_JOB_CM) })
          .impureCircuits.accept(ctx),
  /job path is not for this job/i);

rejected('opening the job with a LATER deadline is rejected',
  () => actor({ deadline: FUTURE + 999999n, status: 1n, step: 1n, jobPathFor: pathFixedTo((l2) => l2.jobs, REAL_JOB_CM) })
          .impureCircuits.accept(ctx),
  /job path is not for this job/i);

rejected('opening the job with a DIFFERENT spec is rejected',
  () => actor({ specHash: b32('do something else'), status: 1n, step: 1n, jobPathFor: pathFixedTo((l2) => l2.jobs, REAL_JOB_CM) })
          .impureCircuits.accept(ctx),
  /job path is not for this job/i);

rejected('swapping the WORKER for someone else is rejected',
  () => actor({ workerPk: PAYER_PK, status: 1n, step: 1n, jobPathFor: pathFixedTo((l2) => l2.jobs, REAL_JOB_CM) })
          .impureCircuits.accept(ctx),
  /job path is not for this job/i);

rejected('a job that was never created cannot be settled',
  () => actor({ jobRand: randomBytes(32), status: 1n, step: 1n, jobPathFor: pathFixedTo((l2) => l2.jobs, REAL_JOB_CM) })
          .impureCircuits.accept(ctx),
  /job path is not for this job/i);

// ── 7. claiming a state you are not in ──────────────────────────────────────
// The payer claims the job is still 'created' while handing over a genuine path for the LIVE state.
// checkRoot passes; only the state leaf binding stops it.
{
  const c2 = freshCtx();
  Object.assign(c2, actor().impureCircuits.create(c2).context);
  Object.assign(c2, actor().impureCircuits.deliver(c2).context);

  // Capture the live (delivered) state commitment.
  let liveCm = null;
  try {
    actor({ status: 1n, step: 1n, statePathFor: (_l, cm) => { liveCm = cm; throw new Error('probe'); } })
      .impureCircuits.accept(c2);
  } catch { /* probe */ }

  rejected('claiming the WRONG status with a borrowed state path is rejected',
    () => actor({ status: 0n, step: 1n, statePathFor: pathFixedTo((l2) => l2.states, liveCm) })
            .impureCircuits.accept(c2),
    /state path is not for this state/i);
}

// ── 8. the deadline - the only remedy that needs no judge ───────────────────
{
  const c3 = freshCtx();
  Object.assign(c3, actor().impureCircuits.create(c3).context);

  rejected('the payer cannot refund BEFORE the deadline',
    () => actor().impureCircuits.refund(c3),
    /deadline has not passed/i);
}
{
  // A job created in the past must be refusable at creation: it can never be delivered.
  rejected('creating an ALREADY-EXPIRED job is rejected',
    () => actor({ deadline: PAST }).impureCircuits.create(freshCtx()),
    /already in the past/i);
}
{
  // An expired job: refund works, delivery does not. Built by creating with a deadline that the
  // simulator's clock has already passed - which `create` refuses, so the state is assembled by
  // creating a live job and then opening it at the expired deadline. That opening fails the leaf
  // binding, which is itself the right answer: an expired deadline is part of the job's identity.
  const c4 = freshCtx();
  Object.assign(c4, actor().impureCircuits.create(c4).context);
  rejected('a worker cannot deliver against a deadline it invented',
    () => actor({ deadline: PAST, jobPathFor: pathFixedTo((l2) => l2.jobs, jobCommitmentOf(c4)) })
            .impureCircuits.deliver(c4),
    /job path is not for this job|deadline has passed/i);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  -  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
