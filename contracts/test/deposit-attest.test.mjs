// DepositAttest - executed, not just compiled.
//
// This contract is the ONLY place in the design where something enters the system that no proof of
// ours can check: "a deposit landed on BSC". So the tests that matter are not the happy path. They
// are the attacks a relayer or a partial quorum would actually run:
//
//   * mint with fewer than THRESHOLD attestations
//   * cite one attester three times to fake a quorum
//   * re-point a genuinely attested deposit at the relayer's own key
//   * change the amount after the attesters signed
//   * reuse an attestation for a different claim
//   * mint the same deposit twice
//   * equivocate: get a quorum onto two contradictory claims for one deposit
//
// Every one of these must be rejected BY AN IN-CIRCUIT ASSERT, not by the harness. Where a test
// could pass because the harness threw first, that is called out.

import { Contract, ledger } from '../build-deposit/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const POOL_ID = b32('phantom-deposit-attest-test');
const BLOB = new Uint8Array(100);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// A negative test is only meaningful if the circuit did the rejecting AND for the stated reason.
// `expectReject` fails loudly when the call succeeds, and also when it fails for the wrong reason -
// otherwise a typo in the harness reads as a security property.
const expectReject = (name, fn, re) => {
  let succeeded = false, err = '';
  try { fn(); succeeded = true; } catch (e) { err = String(e.message ?? e); }
  if (succeeded) return check(name, false, '⚠️  IT SUCCEEDED - this is an exploit');
  check(name, re.test(err), err.replace(/\s+/g, ' ').slice(0, 80));
};

// ── the private state carries every witness; the "current actor" is whatever is in it ──
const makeState = () => ({
  secret: randomBytes(32),          // note owner
  rand: randomBytes(32),            // note blinding
  attesterSecret: randomBytes(32),  // who is attesting right now
  mintRand: randomBytes(32),
  outRand: randomBytes(32),
  changeRand: randomBytes(32),
});

const witnesses = {
  noteSecret:     ({ privateState }) => [privateState, privateState.secret],
  noteRand:       ({ privateState }) => [privateState, privateState.rand],
  attesterSecret: ({ privateState }) => [privateState, privateState.attesterSecret],
  mintRand:       ({ privateState }) => [privateState, privateState.mintRand],
  outRand:        ({ privateState }) => [privateState, privateState.outRand],
  changeRand:     ({ privateState }) => [privateState, privateState.changeRand],
  notePath: ({ ledger: led, privateState }, commitment) => {
    const path = led.notes.findPathForLeaf(commitment);
    if (path === undefined) throw new Error('no path: commitment not in tree');
    return [privateState, path];
  },
};

// ── the five enrolled attesters, plus one outsider who is NOT enrolled ──
const attesterSecrets = Array.from({ length: 5 }, () => randomBytes(32));
const outsiderSecret = randomBytes(32);

// Pure circuits need a context too; build a throwaway one just to derive public values.
const contract = new Contract(witnesses);
const state0 = makeState();

// Derive each attester's public key with the contract's OWN circuit rather than a JS
// reimplementation of the hash - same discipline as commitFor in the recovery tool. A JS copy would
// drift, and the thing that drifts is the thing being verified.
function derivePk(secret) {
  const c = new Contract(witnesses);
  const ctorCtx = rt.createConstructorContext(makeState(), '0'.repeat(64));
  const init = c.initialState(ctorCtx, POOL_ID, b32('x0'), b32('x1'), b32('x2'), b32('x3'), b32('x4'));
  const ctx = rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState,
  );
  return c.circuits.attesterPk(ctx, secret).result;
}

const attesterPks = attesterSecrets.map(derivePk);
const outsiderPk = derivePk(outsiderSecret);

function freshContext() {
  const c = new Contract(witnesses);
  const ps = makeState();
  const ctorCtx = rt.createConstructorContext(ps, '0'.repeat(64));
  const init = c.initialState(ctorCtx, POOL_ID, ...attesterPks);
  const ctx = rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState,
  );
  return { c, ctx, ps };
}

// Run a circuit and fold the resulting state back in - the harness equivalent of the tx landing.
const call = (c, ctx, name, ...args) => {
  const r = c.impureCircuits[name](ctx, ...args);
  Object.assign(ctx, r.context);
  return r;
};

// Act as a given attester for the next call.
const asAttester = (ctx, secret) => { ctx.currentPrivateState.attesterSecret = secret; };

console.log('\n════ DepositAttest - real execution ════\n');

const { c, ctx } = freshContext();
let led = ledger(ctx.currentQueryContext.state);

// ── 0. the attester set is enrolled and sealed ───────────────────────────────
let enrolled = 0; for (const _ of led.attesters) enrolled++;
check('constructor enrols 5 attesters', enrolled === 5, `attesters=${enrolled}`);

// ── the deposit being attested ───────────────────────────────────────────────
// depositId is what the client derives from the execution chain's own event:
// H(chainId ‖ poolAddress ‖ txHash ‖ logIndex). Here it is opaque bytes, which is all the contract
// ever sees.
const DEPOSIT_ID = b32('bsc97:0xPool:0xabc123:logIdx7');
const daveSecret = randomBytes(32);
const daveOwnerPk = c.circuits.ownerPk(ctx, daveSecret).result;
const AMOUNT = 250n;

const claim = c.circuits.claimKey(ctx, DEPOSIT_ID, daveOwnerPk, AMOUNT).result;

console.log('── the quorum forms ──');

// ── 1. an outsider cannot attest ─────────────────────────────────────────────
asAttester(ctx, outsiderSecret);
expectReject('a NON-enrolled key cannot attest',
  () => call(c, ctx, 'attest', claim), /not an enrolled attester/i);

// ── 2. one real attestation ──────────────────────────────────────────────────
asAttester(ctx, attesterSecrets[0]);
call(c, ctx, 'attest', claim);
led = ledger(ctx.currentQueryContext.state);
let voteCount = 0; for (const _ of led.votes) voteCount++;
check('an enrolled attester can attest', voteCount === 1, `votes=${voteCount}`);

// ── 3. the same attester cannot attest twice ─────────────────────────────────
// Without this, one attester reaches a 3-of-5 threshold alone.
expectReject('the SAME attester cannot attest the same claim twice',
  () => call(c, ctx, 'attest', claim), /already attested/i);

// ── 4. one attestation is not a quorum ───────────────────────────────────────
// Cited three times, deliberately: this is exactly how someone would try to fake a quorum from one
// vote, and it must be the DISTINCTNESS assert that stops it.
expectReject('1 attestation cited 3× is NOT a quorum',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[0], attesterPks[0]),
  /distinct/i);

// ── 5. two attestations are still not a quorum ───────────────────────────────
asAttester(ctx, attesterSecrets[1]);
call(c, ctx, 'attest', claim);
expectReject('2 of 5 is below the threshold',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /has not attested/i);

// ── 6. the third attestation completes the quorum ────────────────────────────
asAttester(ctx, attesterSecrets[2]);
call(c, ctx, 'attest', claim);

console.log('\n── what the relayer would try, holding a real 3-of-5 quorum ──');

// ── 7. redirect the deposit to the relayer's own key ─────────────────────────
// THE attack this contract exists to stop. The relayer has three genuine attestations in hand; it
// simply submits the mint naming itself as the owner. The recipient is inside the claim hash, so the
// vote lookup misses.
const mallorySecret = randomBytes(32);
const malloryPk = c.circuits.ownerPk(ctx, mallorySecret).result;
expectReject('relayer CANNOT re-point an attested deposit at its own key',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, malloryPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /has not attested/i);

// ── 8. inflate the amount after the attesters signed ─────────────────────────
expectReject('relayer CANNOT inflate the amount the attesters signed',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, 999999n, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /has not attested/i);

// ── 9. reuse this quorum for a DIFFERENT deposit ─────────────────────────────
const OTHER_DEPOSIT = b32('bsc97:0xPool:0xdeadbeef:logIdx0');
expectReject('an attestation cannot be replayed onto a different deposit',
  () => call(c, ctx, 'mintFromDeposit', OTHER_DEPOSIT, daveOwnerPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /has not attested/i);

// ── 10. name attesters who never voted ───────────────────────────────────────
expectReject('naming attesters who never voted is rejected',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, AMOUNT, BLOB,
             attesterPks[2], attesterPks[3], attesterPks[4]),
  /has not attested/i);

console.log('\n── the honest mint ──');

// ── 11. the real mint ────────────────────────────────────────────────────────
led = ledger(ctx.currentQueryContext.state);
const leavesBefore = led.notes.firstFree();
// The minter picks the blinding and seals it to the owner. Record it so Dave can spend below -
// this is the note-blob mechanism, and without it the money is unspendable.
const mintRandUsed = ctx.currentPrivateState.mintRand;
call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, AMOUNT, BLOB,
     attesterPks[0], attesterPks[1], attesterPks[2]);
led = ledger(ctx.currentQueryContext.state);
check('a 3-of-5 quorum mints the note', led.notes.firstFree() === leavesBefore + 1n,
      `firstFree=${led.notes.firstFree()}`);
check('the deposit is recorded as minted', led.minted.member(DEPOSIT_ID));
check('the note blob was published alongside', led.noteBlobs.size() === 1n,
      `blobs=${led.noteBlobs.size()}`);

// ── 12. the same deposit cannot mint twice ───────────────────────────────────
expectReject('the SAME deposit cannot be minted twice',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, daveOwnerPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /already minted/i);

// ── 13. equivocation ─────────────────────────────────────────────────────────
// The hardest case, and the reason `minted` is keyed by depositId and not by claim. Three attesters
// now sign a SECOND, contradictory claim for the SAME deposit - a different owner. The quorum is
// genuine. The mint must still fail.
const equivClaim = c.circuits.claimKey(ctx, DEPOSIT_ID, malloryPk, AMOUNT).result;
asAttester(ctx, attesterSecrets[0]); call(c, ctx, 'attest', equivClaim);
asAttester(ctx, attesterSecrets[1]); call(c, ctx, 'attest', equivClaim);
asAttester(ctx, attesterSecrets[2]); call(c, ctx, 'attest', equivClaim);
expectReject('a SECOND full quorum on a contradictory claim still cannot double-mint',
  () => call(c, ctx, 'mintFromDeposit', DEPOSIT_ID, malloryPk, AMOUNT, BLOB,
             attesterPks[0], attesterPks[1], attesterPks[2]),
  /already minted/i);

console.log('\n── the minted note is real money, owned by the right key ──');

// ── 14. Dave can spend it ────────────────────────────────────────────────────
// A note nobody can spend is not a successful mint. This is the check that the deposit actually
// arrived as value: Dave supplies his own secret and the blinding from the blob.
ctx.currentPrivateState.secret = daveSecret;
ctx.currentPrivateState.rand = mintRandUsed;
let spent = true, spendErr = '';
try { call(c, ctx, 'spend', AMOUNT); } catch (e) { spent = false; spendErr = String(e.message ?? e); }
check('the depositor can SPEND the minted note', spent, spendErr.slice(0, 80));
led = ledger(ctx.currentQueryContext.state);
let nulls = 0; for (const _ of led.nullifiers) nulls++;
check('spending published a nullifier', nulls === 1, `nullifiers=${nulls}`);

// ── 15. Mallory cannot spend a note minted to Dave ───────────────────────────
// THE ATTACK MUST REACH THE CIRCUIT. A naive version of this test passes because the harness cannot
// find a path for Mallory's commitment and throws first - a false green, and exactly the failure
// mode SESSION-LOG §7 warns about. So Mallory is given a HOSTILE path witness that always hands
// over a genuine, verifiable path for DAVE's leaf (tree leaves are public, so she really does have
// this). Now only the leaf-binding assert can stop her.
{
  const { c: c2, ctx: ctx2 } = freshContext();
  const dSecret = randomBytes(32);
  const dPk = c2.circuits.ownerPk(ctx2, dSecret).result;
  const cl = c2.circuits.claimKey(ctx2, DEPOSIT_ID, dPk, AMOUNT).result;
  for (let i = 0; i < 3; i++) { asAttester(ctx2, attesterSecrets[i]); call(c2, ctx2, 'attest', cl); }
  const dRand = ctx2.currentPrivateState.mintRand;
  call(c2, ctx2, 'mintFromDeposit', DEPOSIT_ID, dPk, AMOUNT, BLOB,
       attesterPks[0], attesterPks[1], attesterPks[2]);

  // Dave's real leaf, recomputed with the contract's own circuit rather than a JS copy.
  const daveCm = c2.circuits.commitFor(ctx2, dPk, AMOUNT, dRand).result;

  const mSecret = randomBytes(32);
  const hostile = new Contract({
    ...witnesses,
    noteSecret: ({ privateState }) => [privateState, mSecret],
    noteRand:   ({ privateState }) => [privateState, dRand],
    notePath: ({ ledger: l, privateState }) => {
      const p = l.notes.findPathForLeaf(daveCm);
      // Loudly, not silently: if this is missing the test would "pass" for the wrong reason.
      if (p === undefined) throw new Error('HARNESS BROKEN: Dave\'s leaf is not in the tree');
      return [privateState, p];
    },
  });
  expectReject('Mallory CANNOT spend Dave\'s minted note with a borrowed path',
    () => hostile.impureCircuits.spend(ctx2, AMOUNT), /path is not for this note/i);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  -  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
