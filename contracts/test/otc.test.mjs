// OtcEscrow - executed, not just compiled.
//
// The whole point of this contract is that ONE order serves MANY takers at DIFFERENT prices. A test
// that posts an order and fills it once in full proves none of that: it would pass against a
// contract with no band, no partial fills and no remainder accounting - i.e. against a plain swap.
//
// So the happy path here is the real shape: post → fill at the BOTTOM of the band → fill again at
// the TOP → claim proceeds and the unsold remainder. Everything else is an attack on the band, the
// remainder, or the ticket.

import { Contract, ledger, pureCircuits } from '../build-otc/contract/index.js';
import * as rt from '@midnight-ntwrk/compact-runtime';
import { randomBytes } from 'node:crypto';

const b32 = (s) => { const u = new Uint8Array(32); Buffer.from(s).copy(u); return u; };
const hex = (u) => Buffer.from(u).toString('hex');
const POOL_ID = b32('phantom-otc-test');

const SCALE = 1_000_000n;         // priceScale() - buy units per sell unit
const UNIT = 1_000_000n;          // 6 decimals
const SELL = 1n, BUY = 2n;        // asset ids

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
const MAKER = randomBytes(32);
const TAKER1 = randomBytes(32);
const TAKER2 = randomBytes(32);
const MAKER_TICKET_RAND = randomBytes(32);

// Every witness this contract reads, in one mutable table. `w()` swaps the whole set, which is how
// an attack is expressed: change exactly one value and re-run the same circuit.
let W = {};
const resetW = () => {
  W = {
    noteSecret: MAKER, noteRand: b32('maker-note-r'), noteAmount: 0n, noteAsset: SELL,
    ticketRand: MAKER_TICKET_RAND,
    outRand: b32('out-r'), changeRand: b32('change-r'), proceedsRand: b32('proceeds-r'),
  };
};
resetW();

const contract = new Contract({
  noteSecret: ({ privateState }) => [privateState, W.noteSecret],
  noteRand: ({ privateState }) => [privateState, W.noteRand],
  noteAmount: ({ privateState }) => [privateState, W.noteAmount],
  noteAsset: ({ privateState }) => [privateState, W.noteAsset],
  ticketRand: ({ privateState }) => [privateState, W.ticketRand],
  outRand: ({ privateState }) => [privateState, W.outRand],
  changeRand: ({ privateState }) => [privateState, W.changeRand],
  proceedsRand: ({ privateState }) => [privateState, W.proceedsRand],
  notePath: ({ ledger: l, privateState }, cm) => {
    // `W.notePathFor` lets a test present a path for a DIFFERENT leaf than the one the circuit
    // derived - which is exactly what an attacker can do, since the path is a witness and tree
    // leaves are public. Without it, no test here could reach the leaf-binding assert.
    const want = W.notePathFor ?? cm;
    const p = l.notes.findPathForLeaf(want);
    if (p === undefined) throw new Error(`HARNESS: ${hex(want).slice(0, 12)}… not in the tree`);
    return [privateState, p];
  },
});

function freshCtx() {
  const init = contract.initialState(rt.createConstructorContext({}, '0'.repeat(64)), POOL_ID);
  return rt.createCircuitContext(
    rt.dummyContractAddress(), '0'.repeat(64), init.currentContractState, init.currentPrivateState);
}
const read = (c) => ledger(c.currentQueryContext.state);
const C = contract.impureCircuits;

console.log('\n════ OtcEscrow - real execution ════\n');

check('priceScale() is 1e6', pureCircuits.priceScale() === SCALE);

let ctx = freshCtx();
const MAKER_PK = C.ownerPk(ctx, MAKER).result;
const T1_PK = C.ownerPk(ctx, TAKER1).result;
const T2_PK = C.ownerPk(ctx, TAKER2).result;

// ── funding ───────────────────────────────────────────────────────────────────
// Notes are minted with faucetNote, whose randomness comes from `outRand` - so the opening is known
// here exactly as a real wallet would know its own.
const MAKER_SELL = 100n * UNIT;
const T1_BUY = 60n * UNIT;
const T2_BUY = 60n * UNIT;
const WHALE_BUY = 500n * UNIT;   // see the over-fill test

W.outRand = b32('maker-note-r');
ctx = C.faucetNote(ctx, MAKER_PK, SELL, MAKER_SELL).context;
W.outRand = b32('t1-note-r');
ctx = C.faucetNote(ctx, T1_PK, BUY, T1_BUY).context;
W.outRand = b32('t2-note-r');
ctx = C.faucetNote(ctx, T2_PK, BUY, T2_BUY).context;

// A taker rich enough that ONLY the remaining-amount ceiling can stop an over-fill. With a small
// note the over-fill test is stopped by "your note does not cover the payment" instead - a DIFFERENT
// guard - so deleting the ceiling changed nothing and the test still passed. Found by mutation.
W.outRand = b32('whale-note-r');
ctx = C.faucetNote(ctx, T1_PK, BUY, WHALE_BUY).context;

// A REAL note in the WRONG asset, in the tree, openable by TAKER1. Without it the wrong-asset test
// is stopped by the merkle path check (no such commitment exists), never reaching the asset check.
W.outRand = b32('t1-sell-note-r');
ctx = C.faucetNote(ctx, T1_PK, SELL, 50n * UNIT).context;

W.outRand = b32('out-r');
check('five notes funded', read(ctx).notes.firstFree() === 5n);

// ── 1. post an order with a real band ─────────────────────────────────────────
const P_MIN = 950_000n;    // 0.95 BUY per SELL
const P_MAX = 1_050_000n;  // 1.05
const post = () => C.postOrder(ctx, SELL, BUY, MAKER_SELL, P_MIN, P_MAX);
{
  ctx = post().context;
  const TICKET = C.ticketFor(ctx, MAKER_PK, SELL, BUY, MAKER_SELL, P_MIN, P_MAX, MAKER_TICKET_RAND).result;
  const e = read(ctx).escrows.lookup(TICKET);
  check('posting escrows the full amount at the stated band',
        e.remaining === MAKER_SELL && e.proceeds === 0n && e.open === true &&
        e.priceMin === P_MIN && e.priceMax === P_MAX,
        `remaining=${e.remaining}`);

  // THE INVARIANT THAT STRANDS MONEY IF BROKEN. The ticket is the claim key, not a note. If it were
  // inserted as a leaf it would be spendable as a note AND findable by anyone walking the tree.
  check('the ticket is NOT a merkle leaf - it is the claim key, not a note',
        read(ctx).notes.findPathForLeaf(TICKET) === undefined);
  check('the maker\'s note is spent - the value is in the escrow, not in both places',
        read(ctx).nullifiers.size() === 1n);
  globalThis.TICKET = TICKET;
}
const TICKET = globalThis.TICKET;

// ── 2. attacks on the band ────────────────────────────────────────────────────
// Each uses a REAL taker note and a REAL path - the only thing wrong is the price.
const asTaker = (secret, noteR, amount, fn) => {
  const prev = { ...W };
  W.noteSecret = secret; W.noteRand = noteR; W.noteAmount = amount; W.noteAsset = BUY;
  try { return fn(); } finally { W = prev; }
};

rejected('filling BELOW the band is REJECTED',
  () => asTaker(TAKER1, b32('t1-note-r'), T1_BUY,
    () => C.fillOrder(ctx, TICKET, 10n * UNIT, 9n * UNIT)),   // implied 0.90 < 0.95
  /below the maker's band/);

rejected('filling ABOVE the band is REJECTED',
  () => asTaker(TAKER1, b32('t1-note-r'), T1_BUY,
    () => C.fillOrder(ctx, TICKET, 10n * UNIT, 11n * UNIT)),  // implied 1.10 > 1.05
  /above the maker's band/);

// Paid from the WHALE note, so "your note does not cover the payment" cannot fire first and the
// remaining-amount ceiling is the only guard that can stop this. 200 units at price 1.0 = 200 paid,
// well inside a 500-unit note.
rejected('filling MORE than remains is REJECTED',
  () => asTaker(TAKER1, b32('whale-note-r'), WHALE_BUY,
    () => C.fillOrder(ctx, TICKET, 200n * UNIT, 200n * UNIT)),
  /exceeds what is left/);

// ⚠️ NO ALTERNATION IN THIS EXPECTATION. It used to read
//     /pay in the asset the maker is buying|merkle path is not for this note/
// and that OR is what made it useless: the test passed on the PATH check, never reaching the asset
// check, so deleting the asset check changed nothing. An expectation that accepts two messages
// cannot tell you which guard ran.
rejected('paying in the WRONG asset is REJECTED',
  () => { const prev = { ...W };
          W.noteSecret = TAKER1; W.noteRand = b32('t1-sell-note-r');
          W.noteAmount = 50n * UNIT; W.noteAsset = SELL;   // a REAL note, in the tree, wrong asset
          try { return C.fillOrder(ctx, TICKET, 10n * UNIT, 10n * UNIT); } finally { W = prev; } },
  /pay in the asset the maker is buying/);

// ── 2b. THE SOUNDNESS LINE - `assert(path.leaf == commitment)` ────────────────
//
// The attack this stops: tree leaves are PUBLIC and the path is a WITNESS, so a spender can present
// somebody else's leaf, derive a nullifier from their OWN secret, and spend a note they never owned.
// `checkRoot(merkleTreePathRoot(path))` alone proves only that SOME leaf is in the tree.
//
// Here taker 1 has a REAL note and a REAL, VERIFIABLE path - for the MAKER's note. Everything the
// circuit can check about the path succeeds. Only the binding to their own commitment fails.
{
  const makerNoteCm = C.commitFor(ctx, MAKER_PK, SELL, MAKER_SELL, b32('maker-note-r')).result;
  rejected("presenting SOMEONE ELSE'S leaf is REJECTED - the membership proof is bound to YOUR note",
    () => { const prev = { ...W };
            W.noteSecret = TAKER1; W.noteRand = b32('t1-note-r');
            W.noteAmount = T1_BUY; W.noteAsset = BUY;
            W.notePathFor = makerNoteCm;          // a real leaf, a real path, the wrong owner
            try { return C.fillOrder(ctx, TICKET, 10n * UNIT, 10n * UNIT); }
            finally { W = prev; } },
    /merkle path is not for this note/);
}

// ── 3. TWO takers, TWO different prices inside the band ───────────────────────
// This is the property the whole design exists for.
const BOTTOM = 950_000n, TOP = 1_050_000n;
const FILL1 = 40n * UNIT, PAY1 = (40n * UNIT * BOTTOM) / SCALE;   // exactly the floor
const FILL2 = 30n * UNIT, PAY2 = (30n * UNIT * TOP) / SCALE;      // exactly the ceiling
{
  ctx = asTaker(TAKER1, b32('t1-note-r'), T1_BUY,
    () => C.fillOrder(ctx, TICKET, FILL1, PAY1)).context;
  let e = read(ctx).escrows.lookup(TICKET);
  check('taker 1 fills 40 at the FLOOR of the band - inclusive, not off by one',
        e.remaining === MAKER_SELL - FILL1 && e.proceeds === PAY1,
        `remaining=${e.remaining} proceeds=${e.proceeds}`);

  ctx = asTaker(TAKER2, b32('t2-note-r'), T2_BUY,
    () => C.fillOrder(ctx, TICKET, FILL2, PAY2)).context;
  e = read(ctx).escrows.lookup(TICKET);
  check('taker 2 fills 30 at the CEILING - one order, two takers, two prices',
        e.remaining === MAKER_SELL - FILL1 - FILL2 && e.proceeds === PAY1 + PAY2,
        `remaining=${e.remaining} proceeds=${e.proceeds}`);

  check('30 SELL units remain unsold - a partial order stays open',
        e.remaining === 30n * UNIT && e.open === true);
}

// ── 4. the maker claims proceeds AND the remainder ────────────────────────────
{
  const before = read(ctx).notes.firstFree();
  const e = read(ctx).escrows.lookup(TICKET);
  const expectProceeds = e.proceeds, expectRemainder = e.remaining;

  ctx = C.claim(ctx, SELL, BUY, MAKER_SELL, P_MIN, P_MAX).context;
  const after = read(ctx).escrows.lookup(TICKET);

  check('claiming closes the order', after.open === false);
  check('claim mints exactly TWO notes - proceeds and remainder',
        read(ctx).notes.firstFree() === before + 2n);

  // The notes are checked by RECOMPUTING their commitments with the contract's own circuit and
  // finding them in the tree. Trusting firstFree() alone would pass if the amounts were wrong.
  const proceedsCm = C.commitFor(ctx, MAKER_PK, BUY, expectProceeds, b32('proceeds-r')).result;
  const remainderCm = C.commitFor(ctx, MAKER_PK, SELL, expectRemainder, b32('out-r')).result;
  check('the proceeds note is really in the tree, for the right asset and amount',
        read(ctx).notes.findPathForLeaf(proceedsCm) !== undefined, `${expectProceeds} of asset ${BUY}`);
  check('the remainder note is really in the tree, for the right asset and amount',
        read(ctx).notes.findPathForLeaf(remainderCm) !== undefined, `${expectRemainder} of asset ${SELL}`);

  check('proceeds are what the two fills actually paid',
        expectProceeds === PAY1 + PAY2, `${expectProceeds}`);
}

// ── 5. a claimed order is finished ────────────────────────────────────────────
rejected('claiming twice is REJECTED - no double payout',
  () => C.claim(ctx, SELL, BUY, MAKER_SELL, P_MIN, P_MAX), /already been claimed/);

rejected('filling a claimed order is REJECTED',
  () => asTaker(TAKER1, b32('t1-note-r'), T1_BUY,
    () => C.fillOrder(ctx, TICKET, 1n * UNIT, 1n * UNIT)),
  /claimed and is closed/);

// ── 6. the ticket opening is the authorisation ────────────────────────────────
// The ticket KEY is public - a taker has to see it. What is private is the opening.
rejected('a stranger who knows the public ticket cannot claim it',
  () => { const prev = { ...W }; W.noteSecret = TAKER1;
          try { return C.claim(freshCtxWithOrder(), SELL, BUY, MAKER_SELL, P_MIN, P_MAX); }
          finally { W = prev; } },
  /no such order/);

rejected('the maker with the WRONG ticket randomness cannot claim',
  () => { const prev = { ...W }; W.ticketRand = randomBytes(32);
          try { return C.claim(freshCtxWithOrder(), SELL, BUY, MAKER_SELL, P_MIN, P_MAX); }
          finally { W = prev; } },
  /no such order/);

rejected('claiming with DIFFERENT parameters than were posted is REJECTED',
  () => C.claim(freshCtxWithOrder(), SELL, BUY, MAKER_SELL, P_MIN, P_MAX + 1n), /no such order/);

/** A fresh contract with one open order, for the authorisation tests. */
function freshCtxWithOrder() {
  const prev = { ...W };
  resetW();
  try {
    let c = freshCtx();
    W.outRand = b32('maker-note-r');
    c = C.faucetNote(c, MAKER_PK, SELL, MAKER_SELL).context;
    W.outRand = b32('out-r');
    return C.postOrder(c, SELL, BUY, MAKER_SELL, P_MIN, P_MAX).context;
  } finally { W = prev; }
}

// ── 7. posting nonsense ───────────────────────────────────────────────────────
rejected('an inverted band is REJECTED',
  () => C.postOrder(freshCtx(), SELL, BUY, MAKER_SELL, P_MAX, P_MIN), /band is inverted/);
rejected('a band starting at zero is REJECTED - it lets a taker fill for free',
  () => C.postOrder(freshCtx(), SELL, BUY, MAKER_SELL, 0n, P_MAX), /starting at zero/);
rejected('trading an asset for itself is REJECTED',
  () => C.postOrder(freshCtx(), SELL, SELL, MAKER_SELL, P_MIN, P_MAX), /for itself/);

const verdict = fail === 0;
console.log(`\n${verdict ? '✅' : '❌'} OtcEscrow: ${pass} passed, ${fail} failed\n`);
process.exit(verdict ? 0 : 1);
