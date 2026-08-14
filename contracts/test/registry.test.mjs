// RelayerRegistry - executed, not just compiled.
//
// The property that matters is the unbonding delay, because it is the only thing standing between
// "priority is proportional to stake" and "priority can be rented for one burst and handed back".
// So it is tested in BOTH directions against a real clock:
//
//   before the release time → REJECTED
//   after the release time  → ACCEPTED        ← this one waits the delay out for real
//
// The second case is the whole point. A delay that is only ever tested by being refused is
// indistinguishable from a check that refuses everything - including the honest operator who waited.
// That costs the delay nothing to pass and would strand real stake.
//
// How the second case is done matters, because the obvious way does not work and fails GREEN-ish -
// it fails with the contract's own "still unbonding" message, which reads like the contract being
// right rather than the test being wrong. Measured 2026-08-12 (TimeProbe.compact):
//
//   * the simulator's block clock is `secondsSinceEpoch`, in SECONDS, sampled ONCE when the
//     CircuitContext is created;
//   * it does NOT advance while that context is alive - sleeping 73 seconds and re-calling on the
//     same context changes nothing;
//   * a FRESH context picks up the current wall clock, and `createCircuitContext`'s 7th parameter
//     sets it explicitly.
//
// So the wait is not slept, it is a LATER BLOCK: the same contract state, re-entered through a
// context whose block time is past the release date. That is what a real chain does, it is
// deterministic, and it takes no time. The first attempt here really did sleep 73 seconds and was
// still refused - the sleep was measuring nothing.
//
// ⚠️ Pass that parameter as a NUMBER OF SECONDS. It is used as `BigInt(time ?? Date.now()/1000)`, so
// a `Date` object silently becomes MILLISECONDS and every block-time comparison turns always-true -
// the same units bug this contract exists to guard against, one layer down in the test harness.

import { Contract, ledger, pureCircuits } from '../build-registry/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const zero32 = new Uint8Array(32);
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));

const REGISTRY_ID = b32('phantom-relayer-test');
const PPT_TOKEN_ID = b32('phantom-ppt-test');
const PPT_ADDR = { bytes: b32('ppt-contract-address') };
const UNBOND = 60n;                       // the floor - see minUnbondingSeconds()
const PPT = 1_000_000n;                   // 6 decimals

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const rejected = (name, run, expect) => {
  let ok = false, err = '';
  try { run(); } catch (e) { err = String(e.message ?? e); ok = expect.test(err); }
  check(name, ok, ok ? err.replace(/^.*failed assert: /, '') : (err || '🚨 IT SUCCEEDED'));
};

// ── identities ─────────────────────────────────────────────────────────────────
const ALICE = randomBytes(32);     // operator 1
const BOB = randomBytes(32);       // operator 2
const MALLORY = randomBytes(32);   // registered by nobody
const GOV = randomBytes(32);
const NOT_GOV = randomBytes(32);

let opSecret = ALICE, govSecret = GOV;
const contract = new Contract({
  operatorSecret: ({ privateState }) => [privateState, opSecret],
  governanceSecret: ({ privateState }) => [privateState, govSecret],
});

/** Run `fn` as a given operator / governance key, then put the witnesses back. */
const as = (secret, fn) => { const prev = opSecret; opSecret = secret; try { return fn(); } finally { opSecret = prev; } };
const asGov = (secret, fn) => { const prev = govSecret; govSecret = secret; try { return fn(); } finally { govSecret = prev; } };

const toUser = (addr) => ({ is_left: false, left: { bytes: zero32 }, right: { bytes: addr } });

function deploy(unbondSeconds = UNBOND, governance = null) {
  const ctorCtx = rt.createConstructorContext({}, '0'.repeat(64));
  const init = contract.initialState(
    ctorCtx, REGISTRY_ID, PPT_TOKEN_ID, PPT_ADDR, unbondSeconds,
    governance ?? GOV_PK);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
}

/**
 * The same contract state, re-entered in a LATER BLOCK.
 *
 * `atSeconds` is seconds since the epoch - see the header. Nothing about the stored state changes;
 * only the block clock the circuit compares against moves.
 */
function atBlockTime(ctx, atSeconds) {
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64),
    ctx.currentQueryContext.state, ctx.currentPrivateState,
    undefined, undefined, Number(atSeconds));
}

const read = (c) => ledger(c.currentQueryContext.state);

console.log('\n════ RelayerRegistry - real execution ════\n');

// ── 0. keys, derived BY THE CONTRACT ──────────────────────────────────────────
let GOV_PK = zero32;
const boot = deploy(UNBOND, zero32);
const ALICE_PK = contract.impureCircuits.operatorPk(boot, ALICE).result;
const BOB_PK = contract.impureCircuits.operatorPk(boot, BOB).result;
GOV_PK = contract.impureCircuits.governancePk(boot, GOV).result;
check('the contract derives operator and governance keys, and they differ',
      Buffer.compare(ALICE_PK, BOB_PK) !== 0 && Buffer.compare(ALICE_PK, GOV_PK) !== 0);

// ── 1. the deployment floor ───────────────────────────────────────────────────
// A registry with no delay is a registry with no unbonding. The value is governance's choice; that
// it is non-zero is the contract's.
check('minUnbondingSeconds() is 60', pureCircuits.minUnbondingSeconds() === 60n);
rejected('deploying with an unbonding period of ZERO is REJECTED', () => deploy(0n),
         /below the floor/);
rejected('deploying one second under the floor is REJECTED', () => deploy(59n), /below the floor/);
check('deploying at exactly the floor is allowed - the check is not off by one',
      read(deploy(60n)).unbondingSeconds === 60n);

// ── 2. registration ───────────────────────────────────────────────────────────
let ctx = deploy();
{
  ctx = contract.impureCircuits.register(ctx, b32('alice-night'), b32('alice.relay'), 1000n * PPT).context;
  const l = read(ctx);
  const rec = l.operators.lookup(ALICE_PK);
  check('registering locks stake and records the operator',
        rec.stake === 1000n * PPT && rec.active === true && l.totalStaked === 1000n * PPT,
        `stake=${rec.stake} totalStaked=${l.totalStaked}`);
  check('unbonding starts empty', rec.unbonding === 0n && rec.unbondAt === 0n);

  rejected('registering twice with the same secret is REJECTED',
           () => contract.impureCircuits.register(ctx, b32('x'), b32('y'), PPT), /already registered/);
  rejected('registering with no stake is REJECTED',
           () => as(BOB, () => contract.impureCircuits.register(ctx, b32('x'), b32('y'), 0n)),
           /not a capacity claim/);

  ctx = as(BOB, () => contract.impureCircuits.register(ctx, b32('bob-night'), b32('bob.relay'), 500n * PPT)).context;
  check('a second operator is a separate record, and totalStaked is their sum',
        read(ctx).operators.size() === 2n && read(ctx).totalStaked === 1500n * PPT,
        `totalStaked=${read(ctx).totalStaked}`);
}

// ── 3. acting on a record you do not hold the secret for ──────────────────────
// There is no caller identity anywhere in this contract. `ownPublicKey()` is a witness on Midnight,
// so a contract that consulted it would let Mallory through here.
rejected('topping up as an unregistered secret is REJECTED',
         () => as(MALLORY, () => contract.impureCircuits.topUp(ctx, PPT)), /not a registered operator/);
rejected('unbonding as an unregistered secret is REJECTED',
         () => as(MALLORY, () => contract.impureCircuits.requestUnbond(ctx, PPT, nowSec() + 3600n)),
         /not a registered operator/);

// ── 4. top-up ─────────────────────────────────────────────────────────────────
{
  ctx = contract.impureCircuits.topUp(ctx, 250n * PPT).context;
  check('topping up raises both the operator stake and the denominator',
        read(ctx).operators.lookup(ALICE_PK).stake === 1250n * PPT && read(ctx).totalStaked === 1750n * PPT);
  rejected('topping up by zero is REJECTED', () => contract.impureCircuits.topUp(ctx, 0n), /top-up of zero/);
}

// ── 5. THE UNBONDING DELAY - the near edge ────────────────────────────────────
rejected('a release date sooner than the unbonding period is REJECTED',
         () => contract.impureCircuits.requestUnbond(ctx, PPT, nowSec() + 30n),
         /unbonding delay is too short/);

// ── 6. THE UNBONDING DELAY - the far edge, which is the C1 trap ───────────────
// `kernel.blockTime*` compares in SECONDS. `Date.now()` is MILLISECONDS. A ms value passes every
// "far enough in the future" check and lands ~55,000 years out - the stake would be locked forever
// by a client-side unit bug, with nothing anywhere reporting an error.
{
  const MS = BigInt(Date.now());
  check('the millisecond value really is ~1000x the second value - this is the bug being caught',
        MS / nowSec() > 900n, `${MS} vs ${nowSec()}`);
  rejected('a release date given in MILLISECONDS is REJECTED',
           () => contract.impureCircuits.requestUnbond(ctx, PPT, MS),
           /unreasonably far away/);
  rejected('a release date beyond the 30-day horizon is REJECTED',
           () => contract.impureCircuits.requestUnbond(ctx, PPT, nowSec() + 31n * 86400n),
           /unreasonably far away/);
}

// ── 7. a valid request ────────────────────────────────────────────────────────
const RELEASE_AT = nowSec() + 70n;   // 10s of slack over the 60s floor, for the request itself
{
  rejected('unbonding more than is staked is REJECTED',
           () => contract.impureCircuits.requestUnbond(ctx, 9999n * PPT, RELEASE_AT),
           /more than is staked/);

  ctx = contract.impureCircuits.requestUnbond(ctx, 250n * PPT, RELEASE_AT).context;
  const rec = read(ctx).operators.lookup(ALICE_PK);
  check('the request moves stake into `unbonding` and sets the release time',
        rec.stake === 1000n * PPT && rec.unbonding === 250n * PPT && rec.unbondAt === RELEASE_AT);

  // Capital on its way out stops buying priority the moment it announces, not when it leaves.
  check('the priority denominator drops IMMEDIATELY, before the wait has elapsed',
        read(ctx).totalStaked === 1500n * PPT, `totalStaked=${read(ctx).totalStaked}`);

  rejected('a second request while one is outstanding is REJECTED',
           () => contract.impureCircuits.requestUnbond(ctx, PPT, RELEASE_AT), /already outstanding/);
}

// ── 8. THE DELAY FIRES - both directions, on a real clock ─────────────────────
rejected('withdrawing BEFORE the release time is REJECTED',
         () => contract.impureCircuits.withdrawStake(ctx, toUser(b32('alice-wallet'))),
         /still unbonding/);

rejected('withdrawing with no request outstanding is REJECTED',
         () => as(BOB, () => contract.impureCircuits.withdrawStake(ctx, toUser(b32('bob-wallet')))),
         /no unbond request/);

{
  // One second BEFORE the release date, in a block of its own. This is the tight edge: it shares a
  // block clock with nothing else, so a PASS here would mean the comparison is off by one.
  rejected('withdrawing one second BEFORE the release time is REJECTED',
           () => contract.impureCircuits.withdrawStake(
                   atBlockTime(ctx, RELEASE_AT - 1n), toUser(b32('alice-wallet'))),
           /still unbonding/);

  // One second AFTER. Only the block clock differs from the line above.
  const after = contract.impureCircuits.withdrawStake(
    atBlockTime(ctx, RELEASE_AT + 1n), toUser(b32('alice-wallet'))).context;
  const rec = read(after).operators.lookup(ALICE_PK);
  check('withdrawing AFTER the release time is ALLOWED - the delay fires, and fires on TIME',
        rec.unbonding === 0n && rec.unbondAt === 0n && rec.stake === 1000n * PPT,
        `refused at ${RELEASE_AT - 1n}, allowed at ${RELEASE_AT + 1n}`);
  check('the withdrawal does NOT touch the remaining stake or the denominator',
        read(after).totalStaked === 1500n * PPT);
  ctx = after;
}

// ── 9. leaving is not a fault ─────────────────────────────────────────────────
{
  const off = contract.impureCircuits.setActive(ctx, false).context;
  check('an operator can deactivate without giving up stake - a graceful exit is not a fault',
        read(off).operators.lookup(ALICE_PK).active === false &&
        read(off).operators.lookup(ALICE_PK).stake === 1000n * PPT);
  const on = contract.impureCircuits.setActive(off, true).context;
  check('and can come back', read(on).operators.lookup(ALICE_PK).active === true);
  const moved = contract.impureCircuits.setEndpoint(on, b32('alice.relay.new')).context;
  check('an endpoint change does not disturb stake or joinedEpoch',
        read(moved).operators.lookup(ALICE_PK).stake === 1000n * PPT);
}

// ── 10. governance ────────────────────────────────────────────────────────────
{
  const l = read(ctx);
  check('the split is 40 / 20 / 40 out of the box',
        l.feeOperatorBps === 4000n && l.feeBurnBps === 2000n && l.feeTeamBps === 4000n);

  rejected('setting the split without the governance secret is REJECTED',
           () => asGov(NOT_GOV, () => contract.impureCircuits.setFeeSplit(ctx, 10000n, 0n, 0n)),
           /not governance/);
  rejected('a split that does not total 100% is REJECTED',
           () => contract.impureCircuits.setFeeSplit(ctx, 4000n, 2000n, 3999n),
           /must total exactly 100%/);
  rejected('advancing the epoch without governance is REJECTED',
           () => asGov(NOT_GOV, () => contract.impureCircuits.advanceEpoch(ctx)), /not governance/);

  const g = contract.impureCircuits.setFeeSplit(ctx, 5000n, 2000n, 3000n).context;
  check('governance can change the split when it totals 100%',
        read(g).feeOperatorBps === 5000n && read(g).feeTeamBps === 3000n);
}

// ── 11. no slashing - 11_TOKEN_DESIGN §3 ─────────────────────────────────────
// A source check, so it is done against the source. The positive control runs first: a "must not
// appear" check reads as PASS both when the string is absent and when the reader went blind.
{
  const src = readFileSync(new URL('../src/RelayerRegistry.compact', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  check('POSITIVE CONTROL: the reader can see `requestUnbond` in the source',
        code.includes('requestUnbond'));
  for (const forbidden of ['slash', 'challenge', 'proveCensorship', 'disputeReceipt']) {
    check(`NO \`${forbidden}\` circuit - 11_TOKEN_DESIGN §3`, !new RegExp(forbidden, 'i').test(code));
  }
}

const verdict = fail === 0;
console.log(`\n${verdict ? '✅' : '❌'} RelayerRegistry: ${pass} passed, ${fail} failed\n`);
process.exit(verdict ? 0 : 1);
