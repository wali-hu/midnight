// PPT - executed, not just compiled.
//
// The only property this contract really has is "1,000,000,000 and no more". A test suite that
// mints a bit and checks the counter went up proves nothing about it: every broken cap in history
// passes that test. So the positive cases here are a control, and the weight is on four attacks
// that a naive fixed-supply contract loses:
//
//   1. mint one unit past the cap                      - the obvious one
//   2. mint an amount that WRAPS Uint<64> past the cap  - the one that is not obvious
//   3. burn, then re-mint into the freed headroom       - the one that looks like correct accounting
//   4. mint without the issuer's secret                 - because ownPublicKey() would not stop it
//
// Attack 2 is worth reading before anything else. `mintUnshieldedToken` takes Uint<64>, so an
// attacker may name any amount up to 2^64-1. With `issued` sitting at the cap, an amount of
// 2^64 - TOTAL_SUPPLY makes the sum exactly 2^64, which NARROWS TO ZERO. A contract that asserts on
// the narrowed sum sees `0 <= TOTAL_SUPPLY`, accepts, mints 17.4 quintillion units, and RESETS its
// own issuance counter to zero. Both the cap and the supply are gone in one transaction, and every
// individual line of that contract looks right.
//
// Attack 3 is the same shape one level up: it does not overflow anything, it just asks the wrong
// counter. See PPT.compact's header.

import { Contract, ledger, pureCircuits } from '../build-ppt/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const zero32 = new Uint8Array(32);

const TOKEN_ID = b32('phantom-ppt-test');
const ONE_PPT = 1_000_000n;                       // 6 decimals - see PPT.compact "UNITS"
const TOTAL = 1_000_000_000_000_000n;             // 1e9 PPT
const MAX_U64 = (1n << 64n) - 1n;

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  - ' + detail : ''}`);
  ok ? pass++ : fail++;
};
/** An attack "passes" only when the CIRCUIT rejected it, with the message we expected. */
const rejected = (name, run, expect) => {
  let ok = false, err = '';
  try { run(); } catch (e) { err = String(e.message ?? e); ok = expect.test(err); }
  check(name, ok, ok ? err.replace(/^.*failed assert: /, '') : (err || '🚨 IT SUCCEEDED'));
};

// ── the issuer ─────────────────────────────────────────────────────────────────
const ISSUER_SECRET = randomBytes(32);
const IMPOSTOR_SECRET = randomBytes(32);

let currentSecret = ISSUER_SECRET;
const contract = new Contract({
  issuerSecret: ({ privateState }) => [privateState, currentSecret],
});

/** A recipient that is a plain user address, not a contract. */
const toUser = (addr) => ({ is_left: false, left: { bytes: zero32 }, right: { bytes: addr } });
const ALICE = toUser(b32('alice'));

function freshCtx(issuerCommit) {
  const ctorCtx = rt.createConstructorContext({}, '0'.repeat(64));
  const init = contract.initialState(ctorCtx, TOKEN_ID, issuerCommit);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
}

const read = (c) => ledger(c.currentQueryContext.state);

console.log('\n════ PPT - real execution ════\n');

// ── 0. the constant, and the issuer commitment derived BY THE CONTRACT ─────────
check('totalSupply() is 1,000,000,000 PPT at 6 decimals',
      pureCircuits.totalSupply() === TOTAL, `${pureCircuits.totalSupply()} base units`);

// Bootstrap: derive issuerPk with the contract itself. The commitment sealed at construction has to
// come from the same hashing the circuit will later perform, or issuance is locked out forever.
const bootCtx = freshCtx(zero32);
const ISSUER_PK = contract.impureCircuits.issuerPk(bootCtx, ISSUER_SECRET).result;
const IMPOSTOR_PK = contract.impureCircuits.issuerPk(bootCtx, IMPOSTOR_SECRET).result;
check('the contract derives issuerPk, and two secrets give two different ones',
      ISSUER_PK.length === 32 && Buffer.compare(ISSUER_PK, IMPOSTOR_PK) !== 0);

/** A brand-new PPT deployment whose issuer is ISSUER_SECRET. */
const deploy = () => freshCtx(ISSUER_PK);

// ── 1. issuance works at all (the control every attack below depends on) ──────
{
  let ctx = deploy();
  const r = contract.impureCircuits.issue(ctx, 1000n * ONE_PPT, ALICE);
  ctx = r.context;
  const l = read(ctx);
  check('issuing 1,000 PPT records cumulative issuance',
        l.issued === 1000n * ONE_PPT && l.burned === 0n, `issued=${l.issued}`);
  check('circulating() == issued - burned',
        contract.impureCircuits.circulating(ctx).result === 1000n * ONE_PPT);
  check('pptColor() is a 32-byte colour derived from (tokenId, this contract)',
        contract.impureCircuits.pptColor(ctx).result.length === 32);
}

// ── 2. the cap is REACHABLE, exactly ──────────────────────────────────────────
// Asserted before any rejection test, because a cap that is off by one LOW rejects the last unit and
// would make every attack below "pass" for the wrong reason.
let atCap = deploy();
{
  atCap = contract.impureCircuits.issue(atCap, TOTAL, ALICE).context;
  check('the whole 1e9 supply can be issued - the cap is not off by one',
        read(atCap).issued === TOTAL, `issued=${read(atCap).issued}`);
}

// ── 3. ATTACK 1 - one unit past the cap ───────────────────────────────────────
rejected('mint 1 base unit past the cap is REJECTED',
         () => contract.impureCircuits.issue(atCap, 1n, ALICE),
         /exceed the fixed supply/);

// ── 4. ATTACK 2 - the wrapping amount ─────────────────────────────────────────
// issued == TOTAL, so this amount makes the sum exactly 2^64. Against a contract that checks the
// NARROWED sum it reads as zero, passes the cap, and mints 17.4 quintillion units.
const WRAP_AMOUNT = (1n << 64n) - TOTAL;
check('the wrapping amount is a legal Uint<64> - the attacker can really name it',
      WRAP_AMOUNT <= MAX_U64 && (TOTAL + WRAP_AMOUNT) % (1n << 64n) === 0n,
      `${WRAP_AMOUNT} (sum wraps to 0)`);
rejected('mint an amount that WRAPS Uint<64> past the cap is REJECTED',
         () => contract.impureCircuits.issue(atCap, WRAP_AMOUNT, ALICE),
         /exceed the fixed supply/);
rejected('mint the maximum Uint<64> from an empty contract is REJECTED',
         () => contract.impureCircuits.issue(deploy(), MAX_U64, ALICE),
         /exceed the fixed supply/);

// ── 5. ATTACK 3 - burn, then re-mint into the "freed" headroom ────────────────
// The headline property. A burn is not an un-mint: it must not restore issuance capacity.
{
  let ctx = contract.impureCircuits.burn(atCap, 400_000_000n * ONE_PPT).context;
  const l = read(ctx);
  check('burning 400M PPT records destruction and leaves `issued` UNTOUCHED',
        l.burned === 400_000_000n * ONE_PPT && l.issued === TOTAL,
        `issued=${l.issued} burned=${l.burned}`);
  check('circulating() drops to 600M PPT',
        contract.impureCircuits.circulating(ctx).result === 600_000_000n * ONE_PPT);

  rejected('re-minting into the burned headroom is REJECTED - a burn is not an un-mint',
           () => contract.impureCircuits.issue(ctx, 1n, ALICE),
           /exceed the fixed supply/);

  rejected('burning more than was ever issued is REJECTED',
           () => contract.impureCircuits.burn(ctx, TOTAL),
           /cannot burn more than was ever issued/);
}

// ── 6. ATTACK 4 - issuing without the issuer's secret ─────────────────────────
// Note what is NOT being tested: there is no caller identity to check. `ownPublicKey()` is a witness
// on Midnight - the caller supplies it - so a contract that gated on it would let this through.
rejected('issuing with the wrong secret is REJECTED',
         () => { currentSecret = IMPOSTOR_SECRET;
                 try { return contract.impureCircuits.issue(deploy(), ONE_PPT, ALICE); }
                 finally { currentSecret = ISSUER_SECRET; } },
         /not the issuer/);

rejected('issuing zero is REJECTED', () => contract.impureCircuits.issue(deploy(), 0n, ALICE),
         /issue of zero/);
rejected('burning zero is REJECTED', () => contract.impureCircuits.burn(atCap, 0n),
         /burn of zero/);

// ── 7. the claim that "burn" makes coins unspendable - checked, not asserted ──
// PPT.compact's header says burned coins are permanently unspendable BECAUSE no circuit can send
// them. That is a claim about the source, so it is verified against the source.
//
// `grep -a` discipline (AGENT-GRAPH RC4): a "string must not appear" check reads as PASS both when
// the string is absent and when the reader went blind, so the positive control runs first. Here the
// file is read directly, which cannot go binary-blind - but the control is kept because the check is
// worthless without knowing the reader works.
{
  const src = readFileSync(new URL('../src/PPT.compact', import.meta.url), 'utf8');
  const code = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
  check('POSITIVE CONTROL: the reader can see mintUnshieldedToken in the source',
        code.includes('mintUnshieldedToken'));
  check('no circuit can send PPT out of this contract - `sendUnshielded` does not appear',
        !code.includes('sendUnshielded'));
  check('NO SLASH CIRCUIT - 11_TOKEN_DESIGN §3',
        !/\bslash/i.test(code));
}

console.log(`\n${fail === 0 ? '✅' : '❌'} PPT: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
