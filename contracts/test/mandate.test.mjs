// MandateRegistry - executed, not just compiled.
//
// The positive test proves nothing on its own: any contract that does no checks will let an honest
// agent through. What decides whether this is a mandate system or a decoration is whether the
// ATTACKS fail, and fail INSIDE THE CIRCUIT - not in the test harness. Every negative test below
// therefore hands the circuit a genuine, verifiable Merkle path, exactly as a real attacker could,
// and asserts on the circuit's own error message.

import { Contract, ledger } from '../build-mandate/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const hex = (u) => Buffer.from(u).toString('hex');
const REGISTRY_ID = b32('phantom-mandate-test');

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};
/** An attack "passes" only if the CIRCUIT rejected it with the expected message. */
const rejected = (name, run, expect) => {
  let ok = false, err = '';
  try { run(); } catch (e) { err = String(e.message ?? e); ok = expect.test(err); }
  check(name, ok, ok ? err.replace(/^.*failed assert: /, '') : (err || '🚨 IT SUCCEEDED'));
};

// ── identities ─────────────────────────────────────────────────────────────────
const principal = randomBytes(32);
const agent = randomBytes(32);
const mSecret = randomBytes(32);   // shared principal↔agent: derives the state chain
const mRand = randomBytes(32);
const LIMIT = 1000n;
// SECONDS. Was milliseconds, which made the on-chain expiry check a no-op - the simulator passed
// anyway. See MandateRegistry.compact's header and tools/time-probe.mjs.
const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600);
const ALLOWED = b32('tool.weather.example');
const NOT_ALLOWED = b32('sketchy.exfil.example');

// A one-entry allow-list: the path is 8 default siblings. The ROOT is computed by the contract's own
// `allowRootFor`, never by a TypeScript reimplementation of Midnight's Merkle hashing.
const emptyPath = (n) => Array.from({ length: n }, () => ({ sibling: { field: 0n }, goes_left: false }));
const allowPathFor = (leaf) => ({ leaf, path: emptyPath(8) });

// ── the witness table ──────────────────────────────────────────────────────────
// Everything the circuit is told, it is told from here - and none of it is trusted. `over` lets a
// test replace any single value, which is how the attacks are built.
function makeWitnesses(over = {}) {
  const w = {
    principalSecret: principal, agentSecret: agent, mandateSecret: mSecret, mandateRand: mRand,
    limit: LIMIT, expiry: EXPIRY, allowRoot: 0n,
    principalPk: null, agentPk: null,          // filled in once the contract can derive them
    spent: 0n, step: 0n,
    mandatePathFor: null, statePathFor: null,  // (ledger, cm) => path
    ...over,
  };
  const treePath = (tree, cm, what) => {
    const p = tree.findPathForLeaf(cm);
    if (p === undefined) throw new Error(`HARNESS BROKEN: ${what} ${hex(cm).slice(0, 12)}… not in tree`);
    return p;
  };
  return {
    _w: w,
    contract: new Contract({
      principalSecret: ({ privateState }) => [privateState, w.principalSecret],
      agentSecret: ({ privateState }) => [privateState, w.agentSecret],
      mandateSecret: ({ privateState }) => [privateState, w.mandateSecret],
      mandateRand: ({ privateState }) => [privateState, w.mandateRand],
      mandateLimit: ({ privateState }) => [privateState, w.limit],
      mandateExpiry: ({ privateState }) => [privateState, w.expiry],
      mandateAllowRoot: ({ privateState }) => [privateState, w.allowRoot],
      mandatePrincipalPk: ({ privateState }) => [privateState, w.principalPk],
      mandateAgentPk: ({ privateState }) => [privateState, w.agentPk],
      stateSpent: ({ privateState }) => [privateState, w.spent],
      stateStep: ({ privateState }) => [privateState, w.step],
      allowPath: ({ privateState }, cp) => [privateState, allowPathFor(w.allowLeaf ?? cp)],
      mandatePath: ({ ledger: l, privateState }, cm) =>
        [privateState, w.mandatePathFor ? w.mandatePathFor(l, cm) : treePath(l.mandates, cm, 'mandate')],
      statePath: ({ ledger: l, privateState }, cm) =>
        [privateState, w.statePathFor ? w.statePathFor(l, cm) : treePath(l.states, cm, 'state')],
    }),
  };
}

function freshCtx() {
  const { contract } = makeWitnesses();
  const ctorCtx = rt.createConstructorContext({}, '0'.repeat(64));
  const init = contract.initialState(ctorCtx, REGISTRY_ID);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
}

console.log('\n════ MandateRegistry - real execution ════\n');

// ── derive the public keys and the allow-list root with the CONTRACT ───────────
const boot = makeWitnesses();
let ctx = freshCtx();
const PRINCIPAL_PK = boot.contract.impureCircuits.principalPk(ctx, principal).result;
const AGENT_PK = boot.contract.impureCircuits.agentPk(ctx, agent).result;
const ALLOW_ROOT = boot.contract.impureCircuits.allowRootFor(ctx, ALLOWED).result;
check('contract derives principalPk / agentPk / allow-list root',
      PRINCIPAL_PK.length === 32 && AGENT_PK.length === 32 && typeof ALLOW_ROOT === 'bigint',
      `allowRoot=${String(ALLOW_ROOT).slice(0, 18)}…`);

const base = { principalPk: PRINCIPAL_PK, agentPk: AGENT_PK, allowRoot: ALLOW_ROOT };
const actor = (over = {}) => makeWitnesses({ ...base, ...over }).contract;

const count = (it) => { let n = 0; for (const _ of it) n++; return n; };
const read = (c) => ledger(c.currentQueryContext.state);

// `mandatePath` is called with the commitment the circuit just derived, so running proveSpend with a
// given set of witnesses and capturing that argument yields that mandate's commitment exactly.
function mandateCommitmentOf(c, over = {}) {
  let seen = null;
  try {
    makeWitnesses({ ...base, ...over, mandatePathFor: (_l, cm) => { seen = cm; throw new Error('probe'); } })
      .contract.impureCircuits.proveSpend(c, 1n, ALLOWED);
  } catch { /* expected: the probe stops here */ }
  if (seen === null) throw new Error('HARNESS BROKEN: could not capture the mandate commitment');
  return seen;
}

/**
 * A hostile path witness: always hands over the GENUINE path for `cm`, whatever the circuit asked
 * for. This is what an attacker can actually do - tree leaves are public - and it is the only way
 * these tests reach the in-circuit check rather than dying in the harness.
 */
const pathFixedTo = (pick, cm) => (l) => {
  const p = pick(l).findPathForLeaf(cm);
  if (p === undefined) throw new Error('HARNESS BROKEN: attack leaf is not in the tree');
  return p;
};
const REAL_MANDATE_CM = mandateCommitmentOf(ctx);

// ── 1. issue ───────────────────────────────────────────────────────────────────
ctx = freshCtx();
Object.assign(ctx, actor().impureCircuits.issue(ctx).context);
let l = read(ctx);
check('issue() records one mandate and one state note',
      l.mandates.firstFree() === 1n && l.states.firstFree() === 1n,
      `mandates=${l.mandates.firstFree()} states=${l.states.firstFree()}`);
check('issue() reveals no limit, principal, agent or allow-list on chain',
      Object.keys(l).filter((k) => /limit|principal|agent|allow/i.test(k)).length === 0,
      `ledger fields: ${Object.keys(l).join(', ')}`);

// ── 2. a spend inside the mandate ──────────────────────────────────────────────
let spendOk = true, spendErr = '';
try { Object.assign(ctx, actor().impureCircuits.proveSpend(ctx, 300n, ALLOWED).context); }
catch (e) { spendOk = false; spendErr = String(e.message ?? e).slice(0, 90); }
check('agent spends 300 of a 1000 mandate', spendOk, spendErr);

l = read(ctx);
check('the old state note was nullified', count(l.spentStates) === 1, `spentStates=${count(l.spentStates)}`);
check('a fresh state note replaced it', l.states.firstFree() === 2n, `states=${l.states.firstFree()}`);

// ── 3. a second spend, still inside the limit ─────────────────────────────────
let ok2 = true, err2 = '';
try {
  Object.assign(ctx, actor({ spent: 300n, step: 1n }).impureCircuits.proveSpend(ctx, 600n, ALLOWED).context);
} catch (e) { ok2 = false; err2 = String(e.message ?? e).slice(0, 90); }
check('second spend 600 (total 900 ≤ 1000)', ok2, err2);
l = read(ctx);
check('two nullifiers, three state notes - unlinkable to each other',
      count(l.spentStates) === 2 && l.states.firstFree() === 3n,
      `nullifiers=${count(l.spentStates)} states=${l.states.firstFree()}`);

// ── 4. THE LIMIT ───────────────────────────────────────────────────────────────
// 900 spent, 200 more would be 1100. The agent supplies the real state note and a genuine path;
// only the in-circuit comparison stands between it and an over-spend.
rejected('spending past the limit is REJECTED',
  () => actor({ spent: 900n, step: 2n }).impureCircuits.proveSpend(ctx, 200n, ALLOWED),
  /exceed the mandate limit/i);

// ── 5. REWIND - the attack the "running total in a Map" design would have allowed ──
// The agent re-uses state 1 (spent = 300), which it legitimately held a moment ago, to pretend it
// has only spent 300. The nullifier of that state is already published.
rejected('REWINDING to an older state is REJECTED',
  () => actor({ spent: 300n, step: 1n }).impureCircuits.proveSpend(ctx, 200n, ALLOWED),
  /already used/i);

// ── 6. lying about spent-so-far, with a real path for a DIFFERENT state ────────
// The agent claims spent = 0 while handing over a genuine path for the live state note. checkRoot
// would pass; `assert(path.leaf == commitment)` is the only thing that stops it.
rejected('claiming spent=0 with a borrowed path is REJECTED',
  () => actor({
    spent: 0n, step: 2n,
    statePathFor: (l2) => {
      // the genuine path for the CURRENT (spent=900) state note, whatever the circuit asked for
      const live = actor({ spent: 900n, step: 2n });
      let cm = null;
      try {
        makeWitnesses({ ...base, spent: 900n, step: 2n,
          statePathFor: (_l, c) => { cm = c; throw new Error('probe'); },
        }).contract.impureCircuits.proveSpend(ctx, 1n, ALLOWED);
      } catch { /* probe */ }
      if (cm === null) throw new Error('HARNESS BROKEN: could not capture the live state commitment');
      const p = l2.states.findPathForLeaf(cm);
      if (p === undefined) throw new Error('HARNESS BROKEN: live state not in tree');
      return p;
    },
  }).impureCircuits.proveSpend(ctx, 50n, ALLOWED),
  /state path is not for this state/i);

// ── 7. an imposter agent ───────────────────────────────────────────────────────
rejected('a DIFFERENT agent cannot spend the mandate',
  () => actor({ agentSecret: randomBytes(32), spent: 900n, step: 2n })
          .impureCircuits.proveSpend(ctx, 10n, ALLOWED),
  /not the agent named/i);

// ── 8. a counterparty that is not on the allow-list ───────────────────────────
rejected('paying a counterparty off the allow-list is REJECTED',
  () => actor({ spent: 900n, step: 2n }).impureCircuits.proveSpend(ctx, 10n, NOT_ALLOWED),
  /not on the allow-list/i);

// ── 9. forging the allow-list membership ──────────────────────────────────────
// The agent hands over a path whose leaf is the ALLOWED tool while paying the sketchy one - the
// same borrowed-path trick, one level down.
rejected('a borrowed allow-list path is REJECTED',
  () => actor({ spent: 900n, step: 2n, allowLeaf: ALLOWED })
          .impureCircuits.proveSpend(ctx, 10n, NOT_ALLOWED),
  /allow-list path is not for this counterparty/i);

// ── 10. raising the limit at spend time ───────────────────────────────────────
// The agent opens "its" mandate with limit = 999999. The limit is bound into the mandate commitment,
// so the derived commitment is no longer the one in the tree.
// The attacker hands over the GENUINE path for the real mandate, so checkRoot would pass; the
// leaf↔commitment binding is the only thing left.
rejected('opening the mandate with a BIGGER limit is REJECTED',
  () => actor({
    limit: 999999n, spent: 900n, step: 2n,
    mandatePathFor: pathFixedTo((l2) => l2.mandates, REAL_MANDATE_CM),
  }).impureCircuits.proveSpend(ctx, 5000n, ALLOWED),
  /mandate path is not for this mandate/i);

// ── 11. an expired mandate ────────────────────────────────────────────────────
{
  const c2 = freshCtx();
  const past = { ...base, expiry: 1n };   // 1 ms after the epoch
  Object.assign(c2, makeWitnesses(past).contract.impureCircuits.issue(c2).context);
  rejected('an EXPIRED mandate cannot be spent',
    () => makeWitnesses(past).contract.impureCircuits.proveSpend(c2, 1n, ALLOWED),
    /expired/i);
}

// ── 12. an unissued mandate ───────────────────────────────────────────────────
// Same trick: a mandate of the attacker's own invention, backed by a real mandate's path.
rejected('a mandate that was never issued cannot be spent',
  () => actor({
    mandateRand: randomBytes(32), spent: 900n, step: 2n,
    mandatePathFor: pathFixedTo((l2) => l2.mandates, REAL_MANDATE_CM),
  }).impureCircuits.proveSpend(ctx, 10n, ALLOWED),
  /mandate path is not for this mandate/i);

// ── 13. revocation ─────────────────────────────────────────────────────────────
{
  const c3 = freshCtx();
  Object.assign(c3, actor().impureCircuits.issue(c3).context);

  rejected('a NON-principal cannot revoke',
    () => actor({ principalSecret: randomBytes(32) }).impureCircuits.revoke(c3),
    /only the principal can revoke/i);

  let revOk = true, revErr = '';
  try { Object.assign(c3, actor().impureCircuits.revoke(c3).context); }
  catch (e) { revOk = false; revErr = String(e.message ?? e).slice(0, 90); }
  check('the principal revokes', revOk, revErr);

  const l3 = read(c3);
  check('revocation leaves NO live state note', l3.states.firstFree() === 1n && count(l3.spentStates) === 1,
        `states=${l3.states.firstFree()} nullified=${count(l3.spentStates)}`);

  rejected('after revocation the agent CANNOT spend',
    () => actor().impureCircuits.proveSpend(c3, 1n, ALLOWED),
    /already used/i);
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ FAILURES'}  -  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
