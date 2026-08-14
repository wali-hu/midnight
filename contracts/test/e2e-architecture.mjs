// End-to-end simulation of the architecture in SESSION-LOG §3.4.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS REAL HERE AND WHAT IS NOT - read this before quoting any number below
//
// REAL (executed circuits, via @midnight-ntwrk/compact-runtime):
//   * DepositAttest    - attest / mintFromDeposit / spend / transfer
//   * MandateRegistry  - issue / proveSpend / revoke
//   Every rejection printed below with "failed assert:" came out of a circuit, not out of this file.
//
// MODELED (plain JavaScript in this file, clearly marked `chain.` and `relayer.`):
//   * the execution chain (a BSC-shaped pool with balances, an event log and a payout ledger)
//   * the relayer, the attester daemons, and the crash/retry behaviour
//   These are a model of code that DOES NOT EXIST YET (§6: ChainAdapter, Midnight adapter). They
//   prove the DESIGN composes. They do not prove any deployed system does.
//
// So: this file is evidence that the three flows fit together and that the seams reject what they
// should. It is NOT evidence that the bridge is built. Do not let it be cited as the latter.
// ─────────────────────────────────────────────────────────────────────────────

import { Contract as DepositContract, ledger as depositLedger }
  from '../build-deposit/contract/index.js';
import { Contract as MandateContract, ledger as mandateLedger }
  from '../build-mandate/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const hex = (u) => Buffer.from(u).toString('hex');
const BLOB = new Uint8Array(100);

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const rejected = (name, run, re) => {
  let succeeded = false, err = '';
  try { run(); succeeded = true; } catch (e) { err = String(e.message ?? e); }
  if (succeeded) return check(name, false, '⚠️  IT SUCCEEDED - this is an exploit');
  check(name, re.test(err), err.replace(/\s+/g, ' ').replace(/^.*failed assert: /, '').slice(0, 72));
};
const section = (s) => console.log(`\n──────── ${s} ────────`);

// ═════════════════════════════════════════════════════════════════════════════
// MODELED: the execution chain. BSC today; the point of the ChainAdapter is that Solana and Base
// present this same surface. Everything a real adapter must provide is a method here.
// ═════════════════════════════════════════════════════════════════════════════
const chain = {
  id: 97,
  pool: '0xPool',
  poolBalance: 0n,          // what the pool custodies, in total
  events: [],               // deposit events, as a light client / RPC watcher would see them
  paidOut: new Set(),       // nullifiers already paid - the idempotency key for withdraw
  internal: new Map(),      // in-pool balances: agent↔agent settles here and nets to zero externally

  deposit(from, amount) {
    const ev = { txHash: `0x${randomBytes(8).toString('hex')}`, logIndex: this.events.length,
                 from, amount };
    this.events.push(ev);
    this.poolBalance += amount;
    return ev;
  },

  // The deposit identifier. Binding chainId and pool address is what makes the same tx hash on two
  // chains two different deposits - without it, a Base deposit could be replayed as a BSC one.
  depositId(ev) {
    return b32(`${this.id}:${this.pool}:${ev.txHash}:${ev.logIndex}`);
  },

  // What an honest attester does: go and look. Returns undefined when there is nothing there, which
  // is the whole reason an honest attester cannot be talked into signing an invented deposit.
  findDeposit(depositIdBytes) {
    return this.events.find((ev) => hex(this.depositId(ev)) === hex(depositIdBytes));
  },

  // In-pool settlement - agent↔agent. Nets to zero on-chain: no external transfer, pool total
  // unchanged. This is what `verify:settlement-onchain` measures on the real stack.
  settleInPool(from, to, amount) {
    this.internal.set(from, (this.internal.get(from) ?? 0n) - amount);
    this.internal.set(to, (this.internal.get(to) ?? 0n) + amount);
  },

  // Withdraw. Gated on the Midnight nullifier, and idempotent on it. `recipient` is bound into the
  // user-authored proof on the real chain; here the model simply refuses to let the caller choose it.
  payout(nullifier, recipient, amount, { failAfterDebit = false } = {}) {
    const key = hex(nullifier);
    if (this.paidOut.has(key)) throw new Error('payout: nullifier already paid');
    if (amount > this.poolBalance) throw new Error('payout: pool is short');
    // Crash injection: the transaction reverts, so NOTHING is committed. Modeling a partial write
    // here would be modeling a bug the EVM does not have.
    if (failAfterDebit) throw new Error('payout: RPC died before the tx landed');
    this.paidOut.add(key);
    this.poolBalance -= amount;
    return { to: recipient, amount };
  },
};

// ═════════════════════════════════════════════════════════════════════════════
// REAL: Midnight side
// ═════════════════════════════════════════════════════════════════════════════
const POOL_ID = b32('phantom-e2e-pool');
const REGISTRY_ID = b32('phantom-e2e-registry');

// ── DepositAttest wiring ──
const depState = () => ({
  secret: randomBytes(32), rand: randomBytes(32), attesterSecret: randomBytes(32),
  mintRand: randomBytes(32), outRand: randomBytes(32), changeRand: randomBytes(32),
});
const depWitnesses = {
  noteSecret:     ({ privateState }) => [privateState, privateState.secret],
  noteRand:       ({ privateState }) => [privateState, privateState.rand],
  attesterSecret: ({ privateState }) => [privateState, privateState.attesterSecret],
  mintRand:       ({ privateState }) => [privateState, privateState.mintRand],
  outRand:        ({ privateState }) => [privateState, privateState.outRand],
  changeRand:     ({ privateState }) => [privateState, privateState.changeRand],
    // NotePool now has joint-ownership circuits, and the Contract constructor requires EVERY
    // witness to be present even when unused. Zeros are safe: a zero half opens no real note.
    jointSecretA: ({ privateState }) => [privateState, new Uint8Array(32)],
    jointSecretB: ({ privateState }) => [privateState, new Uint8Array(32)],
  notePath: ({ ledger: l, privateState }, cm) => {
    const p = l.notes.findPathForLeaf(cm);
    if (p === undefined) throw new Error('no path: commitment not in tree');
    return [privateState, p];
  },
};

const attesterSecrets = Array.from({ length: 5 }, () => randomBytes(32));

function bootDeposit(attesterPks) {
  const c = new DepositContract(depWitnesses);
  const ctorCtx = rt.createConstructorContext(depState(), '0'.repeat(64));
  const init = c.initialState(ctorCtx, POOL_ID, ...attesterPks);
  const ctx = rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
  return { c, ctx };
}
// Bootstrap once with placeholder keys purely to derive the real attester pks with the contract's
// own circuit - never a JS reimplementation of the hash.
const boot = bootDeposit(Array.from({ length: 5 }, (_, i) => b32(`boot${i}`)));
const attesterPks = attesterSecrets.map((s) => boot.c.circuits.attesterPk(boot.ctx, s).result);

const { c: dep, ctx: depCtx } = bootDeposit(attesterPks);
const depCall = (name, ...args) => {
  const r = dep.impureCircuits[name](depCtx, ...args);
  Object.assign(depCtx, r.context);
  return r;
};
const depRead = () => depositLedger(depCtx.currentQueryContext.state);

// ── MandateRegistry wiring ──
const principalSecret = randomBytes(32);
const agentSecret = randomBytes(32);
const mSecret = randomBytes(32);
const mRand = randomBytes(32);
const LIMIT = 1000n;
const EXPIRY = BigInt(Date.now() + 30 * 24 * 3600 * 1000);
const emptyPath = (n) => Array.from({ length: n }, () => ({ sibling: { field: 0n }, goes_left: false }));

function mandateActor(over = {}) {
  const w = { limit: LIMIT, expiry: EXPIRY, spent: 0n, step: 0n, allowRoot: 0n,
              principalPk: null, agentPk: null, ...over };
  const treePath = (tree, cm, what) => {
    const p = tree.findPathForLeaf(cm);
    if (p === undefined) throw new Error(`HARNESS BROKEN: ${what} not in tree`);
    return p;
  };
  return new MandateContract({
    principalSecret: ({ privateState }) => [privateState, principalSecret],
    agentSecret:     ({ privateState }) => [privateState, w.agentSecret ?? agentSecret],
    mandateSecret:   ({ privateState }) => [privateState, mSecret],
    mandateRand:     ({ privateState }) => [privateState, mRand],
    mandateLimit:    ({ privateState }) => [privateState, w.limit],
    mandateExpiry:   ({ privateState }) => [privateState, w.expiry],
    mandateAllowRoot:({ privateState }) => [privateState, w.allowRoot],
    mandatePrincipalPk: ({ privateState }) => [privateState, w.principalPk],
    mandateAgentPk:     ({ privateState }) => [privateState, w.agentPk],
    stateSpent: ({ privateState }) => [privateState, w.spent],
    stateStep:  ({ privateState }) => [privateState, w.step],
    allowPath:  ({ privateState }, cp) => [privateState, { leaf: cp, path: emptyPath(8) }],
    mandatePath: ({ ledger: l, privateState }, cm) => [privateState, treePath(l.mandates, cm, 'mandate')],
    statePath:   ({ ledger: l, privateState }, cm) => [privateState, treePath(l.states, cm, 'state')],
  });
}

const mBoot = mandateActor();
const mCtorCtx = rt.createConstructorContext({}, '0'.repeat(64));
const mInit = mBoot.initialState(mCtorCtx, REGISTRY_ID);
const manCtx = rt.createCircuitContext(
  rt.dummyContractAddress(), '0'.repeat(64), mInit.currentContractState, mInit.currentPrivateState);

const PRINCIPAL_PK = mBoot.impureCircuits.principalPk(manCtx, principalSecret).result;
const AGENT_PK = mBoot.impureCircuits.agentPk(manCtx, agentSecret).result;
const COUNTERPARTY = b32('agent.bob.example');
const ALLOW_ROOT = mBoot.impureCircuits.allowRootFor(manCtx, COUNTERPARTY).result;
const mBase = { principalPk: PRINCIPAL_PK, agentPk: AGENT_PK, allowRoot: ALLOW_ROOT };
const manCall = (actor, name, ...args) => {
  const r = actor.impureCircuits[name](manCtx, ...args);
  Object.assign(manCtx, r.context);
  return r;
};
const manRead = () => mandateLedger(manCtx.currentQueryContext.state);

// ═════════════════════════════════════════════════════════════════════════════
// MODELED: the attester daemon and the relayer
// ═════════════════════════════════════════════════════════════════════════════

// An honest attester. The ONLY thing that makes the bridge work: it goes and looks at the execution
// chain, and refuses to sign what it does not find. Everything else in this contract is arithmetic
// around this one behaviour.
const honestAttester = (i) => ({
  name: `attester-${i}`,
  attest(depositId, ownerPk, amount) {
    const ev = chain.findDeposit(depositId);
    if (!ev) throw new Error(`${this.name} refuses: no such deposit on chain ${chain.id}`);
    if (ev.amount !== amount) throw new Error(`${this.name} refuses: amount does not match the log`);
    const claim = dep.circuits.claimKey(depCtx, depositId, ownerPk, amount).result;
    depCtx.currentPrivateState.attesterSecret = attesterSecrets[i];
    depCall('attest', claim);          // REAL circuit
    return claim;
  },
});

const relayer = {
  // The relayer never authors content; it forwards and pays fees. Here it can only pass through what
  // the attesters already signed.
  mint(depositId, ownerPk, amount, whichAttesters) {
    const rand = randomBytes(32);
    depCtx.currentPrivateState.mintRand = rand;
    depCall('mintFromDeposit', depositId, ownerPk, amount, BLOB, ...whichAttesters.map((i) => attesterPks[i]));
    return rand;                        // on a live deployment this is sealed into the blob
  },
};

const totalMinted = () => {
  // What Midnight believes is owned, tracked alongside so the invariant can be asserted.
  return ledgerTotals.minted;
};
const ledgerTotals = { minted: 0n, withdrawn: 0n };

console.log('\n════════════════════════════════════════════════════════');
console.log('  Phantom - end-to-end architecture simulation');
console.log('  Midnight = ledger  ·  execution chain = custody  ·  relayer = the only bridge');
console.log('════════════════════════════════════════════════════════');

// ═════════════════════════════════════════════════════════════════════════════
section('ZONE 2 - DEPOSIT   (execution chain first, then the Midnight note)');
// ═════════════════════════════════════════════════════════════════════════════

const daveSecret = randomBytes(32);
const davePk = dep.circuits.ownerPk(depCtx, daveSecret).result;

// 1. The money really moves, on the public chain, before anything is claimed about it.
const ev = chain.deposit('0xDave', 250n);
const depositId = chain.depositId(ev);
check('BSC: Dave deposits 250 into the pool', chain.poolBalance === 250n,
      `poolBalance=${chain.poolBalance} tx=${ev.txHash.slice(0, 10)}…`);

// 2. THE ATTACK THAT MATTERS. Before any honest attestation exists, the relayer tries to mint a
// deposit that never happened. It has no votes, so the circuit refuses.
const ghostId = b32('97:0xPool:0xGHOST:0');
rejected('relayer CANNOT mint a deposit that never happened',
  () => relayer.mint(ghostId, davePk, 1000000n, [0, 1, 2]), /has not attested/i);

// 3. ...and it cannot get the attestations either, because honest attesters go and look.
let refusals = 0;
for (let i = 0; i < 3; i++) {
  try { honestAttester(i).attest(ghostId, davePk, 1000000n); }
  catch (e) { if (/refuses: no such deposit/.test(String(e.message))) refusals++; }
}
check('all 3 honest attesters REFUSE the invented deposit', refusals === 3, `refusals=${refusals}/3`);

// 4. The real deposit: three attesters independently confirm it against the chain.
for (let i = 0; i < 3; i++) honestAttester(i).attest(depositId, davePk, 250n);
let voteCount = 0; for (const _ of depRead().votes) voteCount++;
check('3 of 5 attesters confirm the REAL deposit against the chain', voteCount === 3,
      `votes=${voteCount}`);

// 5. A partial quorum still cannot mint - checked here, in the full flow, not just in the unit test.
rejected('2-of-5 is not enough even with a real deposit',
  () => relayer.mint(depositId, davePk, 250n, [0, 1, 3]), /has not attested/i);

// 6. The mint.
const daveRand = relayer.mint(depositId, davePk, 250n, [0, 1, 2]);
ledgerTotals.minted += 250n;
check('Midnight: the note is minted to Dave', depRead().notes.firstFree() === 1n,
      `leaves=${depRead().notes.firstFree()}`);
check('the deposit is consumed and cannot mint again', depRead().minted.member(depositId));

// 7. Idempotency - the relayer retries after a timeout, as it would on a live deployment.
rejected('a retried mint is refused, not duplicated',
  () => relayer.mint(depositId, davePk, 250n, [0, 1, 2]), /already minted/i);

check('INVARIANT: pool custody == notes issued', chain.poolBalance === totalMinted(),
      `chain=${chain.poolBalance} midnight=${totalMinted()}`);

// ═════════════════════════════════════════════════════════════════════════════
section('ZONE 1 - AGENT → AGENT   (mandate finalizes on Midnight, payment settles in the pool)');
// ═════════════════════════════════════════════════════════════════════════════

// 8. The principal issues the mandate. Limit, agent, principal and allow-list are all inside the
// proof - the chain learns none of them.
manCall(mandateActor(mBase), 'issue');
check('Midnight: mandate issued (limit/agent/allow-list all private)',
      manRead().mandates.firstFree() === 1n && manRead().states.firstFree() === 1n);

// 9. The agent proves it may spend 100 to Bob. Nothing about the mandate is revealed.
manCall(mandateActor({ ...mBase, spent: 0n, step: 0n }), 'proveSpend', 100n, COUNTERPARTY);
check('agent proves a 100 spend is within mandate', manRead().spentStates.size() === 1n);

// 10. The two things the mandate is for.
rejected('agent CANNOT spend over the limit',
  () => manCall(mandateActor({ ...mBase, spent: 100n, step: 1n }), 'proveSpend', 5000n, COUNTERPARTY),
  /exceed the mandate limit/i);
rejected('agent CANNOT pay someone off the allow-list',
  () => manCall(mandateActor({ ...mBase, spent: 100n, step: 1n }), 'proveSpend', 10n,
                b32('sketchy.exfil.example')),
  /not on the allow-list/i);

// 11. The note moves on Midnight: Dave → Bob 100, change 150.
const bobSecret = randomBytes(32);
const bobPk = dep.circuits.ownerPk(depCtx, bobSecret).result;
const bobRand = randomBytes(32), changeRand = randomBytes(32);
Object.assign(depCtx.currentPrivateState,
  { secret: daveSecret, rand: daveRand, outRand: bobRand, changeRand });
depCall('transfer', bobPk, 250n, 100n, BLOB, BLOB);
check('Midnight: 250 → Bob 100 + change 150, one nullifier, two new leaves',
      depRead().notes.firstFree() === 3n && depRead().nullifiers.size() === 1n,
      `leaves=${depRead().notes.firstFree()} nullifiers=${depRead().nullifiers.size()}`);

// 12. The execution-chain leg: in-pool, so it nets to zero externally.
const poolBefore = chain.poolBalance;
chain.settleInPool('dave', 'bob', 100n);
check('execution chain: the payment settles IN POOL and nets to zero on-chain',
      chain.poolBalance === poolBefore,
      `poolBalance unchanged at ${chain.poolBalance}`);
check('INVARIANT: pool custody still == notes issued', chain.poolBalance === totalMinted(),
      `chain=${chain.poolBalance} midnight=${totalMinted()}`);

// ═════════════════════════════════════════════════════════════════════════════
section('ZONE 3 - WITHDRAW   (Midnight first - the nullifier - then the chain payout)');
// ═════════════════════════════════════════════════════════════════════════════

// 13. Bob burns his note on Midnight FIRST. Publishing the nullifier before the payout is what makes
// a double withdrawal impossible; the other order would pay twice for one note.
Object.assign(depCtx.currentPrivateState, { secret: bobSecret, rand: bobRand });
depCall('spend', 100n);
// Derive the nullifier with the contract's OWN circuits rather than picking it out of the ledger by
// index - set iteration order is not a contract, and the whole point of `noteNullifier` being
// exported is that a wallet can compute this itself. This is also exactly what the withdraw watcher
// must do on the real stack.
const bobCm = dep.circuits.commitFor(depCtx, bobPk, 100n, bobRand).result;
const bobNullifier = dep.circuits.noteNullifier(depCtx, bobSecret, bobCm).result;
check('the withdraw nullifier is derivable off-chain and is the one on chain',
      depRead().nullifiers.member(bobNullifier), `nul=${hex(bobNullifier).slice(0, 12)}…`);
check('Midnight: Bob nullifies his 100 note', depRead().nullifiers.size() === 2n,
      `nullifiers=${depRead().nullifiers.size()}`);

// 14. THE CRASH. The nullifier is public, the payout dies mid-flight. This is the exact divergence
// SESSION-LOG §3.2 Q1 worried about: Midnight says spent, the chain has not paid.
let crashed = false;
try { chain.payout(bobNullifier, '0xBob', 100n, { failAfterDebit: true }); }
catch { crashed = true; }
check('the payout crashes after the nullifier is public (worst-case divergence)', crashed,
      'note burnt on Midnight, nothing paid on chain');

// 15. Recovery: the relayer retries. Same nullifier, same result, money not lost.
const paid = chain.payout(bobNullifier, '0xBob', 100n);
ledgerTotals.withdrawn += 100n;
check('retry pays exactly once - divergence is temporary and self-healing',
      paid.amount === 100n && chain.poolBalance === 150n, `poolBalance=${chain.poolBalance}`);

// 16. Replay. The relayer submits the same payout again - the whole reason withdraw is keyed on the
// nullifier and not on a request id.
rejected('the same nullifier CANNOT be paid twice',
  () => chain.payout(bobNullifier, '0xBob', 100n), /already paid/i);

// 17. And Bob cannot burn the note twice to get a second nullifier.
rejected('Bob CANNOT double-spend the note on Midnight',
  () => depCall('spend', 100n), /already spent/i);

check('INVARIANT: pool custody == notes issued − withdrawn',
      chain.poolBalance === totalMinted() - ledgerTotals.withdrawn,
      `chain=${chain.poolBalance} midnight=${totalMinted() - ledgerTotals.withdrawn}`);

// ═════════════════════════════════════════════════════════════════════════════
section('CENSORSHIP - the failure the design accepts, and why it is only delay');
// ═════════════════════════════════════════════════════════════════════════════

// 18. A censoring relayer. Dave deposits again; the relayer simply never submits the mint. The
// attestations are already on Midnight, so the claim stays permanently mintable BY ANYONE - the
// user self-relays. Censorship costs time, never money. This is why censorship is NOT slashable:
// there is nothing to prove, and nothing was lost.
const ev2 = chain.deposit('0xDave', 400n);
const depositId2 = chain.depositId(ev2);
for (let i = 0; i < 3; i++) honestAttester(i).attest(depositId2, davePk, 400n);
check('relayer censors: attestations exist, nothing submitted',
      depRead().minted.member(depositId2) === false, 'claim is pending, not lost');

// The user submits it themselves - the identical call, because the mint is permissionless.
const daveRand2 = relayer.mint(depositId2, davePk, 400n, [0, 1, 2]);
ledgerTotals.minted += 400n;
check('user self-relays and the claim lands unchanged', depRead().minted.member(depositId2),
      `leaves=${depRead().notes.firstFree()}`);
check('INVARIANT: pool custody == notes issued − withdrawn',
      chain.poolBalance === totalMinted() - ledgerTotals.withdrawn,
      `chain=${chain.poolBalance} midnight=${totalMinted() - ledgerTotals.withdrawn}`);

// ═════════════════════════════════════════════════════════════════════════════
section('THE REMAINING TRUST SURFACE - stated, not hidden');
// ═════════════════════════════════════════════════════════════════════════════

// 19. A DISHONEST quorum. Three attesters collude and sign a deposit that is not on the chain. The
// contract accepts it, because the contract cannot read BSC. This test asserts the WEAKNESS, so that
// it can never be quietly lost - if someone later claims the bridge is trustless, this goes red.
const fakeId = b32('97:0xPool:0xFRAUD:0');
const dishonest = (i) => {
  const claim = dep.circuits.claimKey(depCtx, fakeId, davePk, 999n).result;
  depCtx.currentPrivateState.attesterSecret = attesterSecrets[i];
  depCall('attest', claim);
};
[0, 1, 2].forEach(dishonest);
relayer.mint(fakeId, davePk, 999n, [0, 1, 2]);
ledgerTotals.minted += 999n;      // Midnight now believes in money the pool does not hold
check('⚠️  a 3-of-5 COLLUDING quorum CAN mint a fake deposit - known and accepted',
      depRead().minted.member(fakeId), 'only a light client would prevent this');

// 20. ...but the fraud is objectively provable by anyone with a node. That is what makes it
// slashable, and it is the entire reason `slashFalseAttestation` is worth building.
const provablyFalse = chain.findDeposit(fakeId) === undefined;
check('the fraud is REFUTABLE against the execution chain by anyone',
      provablyFalse && depRead().minted.member(fakeId),
      'claim names chain+pool+tx+logIndex; the chain has no such event');

// This one deliberately breaks the invariant, which is exactly what a fraud looks like from outside.
const claimed = totalMinted() - ledgerTotals.withdrawn;
check('and it shows up immediately as an insolvent pool', chain.poolBalance < claimed,
      `custody=${chain.poolBalance} < claimed=${claimed} - anyone can compute this`);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  -  ${pass} passed, ${fail} failed`);
console.log(`
Summary of what this run demonstrated:
  • deposit  - chain first, note derived, idempotent, invented deposits refused by honest attesters
  • agent↔agent - mandate proved privately on Midnight, payment nets to zero in the pool
  • withdraw - nullifier first, payout idempotent, a mid-flight crash self-heals with no loss
  • censorship - costs delay only; the user self-relays the identical call
  • the ONE remaining trust surface - a colluding quorum - is real, bounded, and refutable
`);
process.exit(fail === 0 ? 0 : 1);
