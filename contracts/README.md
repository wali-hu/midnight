# Midnight Compact contracts - eight, all live on preview

Compact contracts from [Phantom Protocol](https://phantomproto.com), a
privacy-preserving settlement layer where **Midnight is the ledger of record** and execution stays
on the chain that holds the money.

Every contract here is **deployed on Midnight `preview` and confirmed by the public indexer** - the
block heights below are a third party reading the chain, not this repo reporting on itself.

| Contract | What it does | Block |
|---|---|---|
| `NotePool.compact` | shielded notes, plus a **2-of-2 jointly-owned note** neither party nor the operator can spend alone | 373928 / 374225 |
| `MandateRegistry.compact` | an agent proves it stayed inside a spending budget **without revealing the budget** | 376527 |
| `PPT.compact` | fixed-supply token; issuance is monotone and the cap is on *cumulative* issuance | 396064 |
| `RelayerRegistry.compact` | staked operators, unbonding, **deliberately no slashing** | 396068 |
| `JobContract.compact` | a two-party agreement bound to a joint note by half-commitments | 396244 |
| `DepositAttest.compact` | 3-of-5 attestation that a deposit happened on another chain | 397472 |
| `OtcEscrow.compact` | a price **range**, filled in pieces by different takers at different prices | 399909 |
| `TimeProbe.compact` | a measurement contract, written to answer a question the docs did not |  |

---

## The interesting one: a note neither party can spend alone

```
owner = jointOwnerPk( ownerPk(sA), ownerPk(sB) )     ← from the two PUBLIC halves
```

Two agents agree a job. The payment moves into a note owned by both keys together. From that moment
**the payer cannot take it back, the worker cannot take it early, and the operator cannot touch it
at all.** No escrow provider, no arbitrator, nobody to trust.

### The design bug I shipped first, and how I found it

My original construction was `skJob = H(sA ‖ sB)` - derive one joint secret from both halves.

**It locked nothing.** Somebody has to compute `Poseidon(skJob)` to *create* the note, hashing is
not homomorphic, so that somebody knows both halves and can spend alone. In our architecture that
somebody was us - the exact party the design existed to exclude.

I found it by reading §2.2 of my own spec against §4.1, which contradicted each other. Not by a
failing test: every test passed, because the tests were written by the same person holding the same
misunderstanding.

The fix needs **no new circuit**. The payer passes the joint owner to the ordinary `transfer`. No
elliptic curve, only Poseidon.

### Two things that are not obvious

- **Holding both halves is necessary and NOT sufficient - the opening travels too.** My first
  simulator run failed because the note was funded with one blinding factor and claimed with
  another.
- **Every witness object must supply every witness**, even unused ones. The `Contract` constructor
  requires the full set; adding `jointSecretA`/`jointSecretB` broke three unrelated files.

---

## Testing: every security property is broken on purpose

A green suite proves the happy path. It says nothing about whether your guard is load-bearing - and
a guard nobody has tried to break is a comment with syntax highlighting.

So each `*.mutate.mjs` file **removes an assertion and requires the suite to go red**.

**This caught a real one.** A mutation run left `OtcEscrow.compact` without

```compact
assert(e.open, "this order has already been claimed");
```

- a double-claim money printer, in a contract that was about to be deployed. It was caught because
the mutation harness noticed the suite had *not* gone red, not because anyone reviewed the diff.

### The strongest single test in this repo

Proving the 2-of-2 note *works* proves nothing. It says nothing about whether the second half is
load-bearing. So the test also attempts a claim with **one half and a guess for the other**:

```
ONE half + a guess  →  REFUSED in 1.4s, inside the circuit - no transaction, no fee spent
BOTH halves         →  claimed in 67s
```

**The refusal is the evidence. The success is just the demo.**

Verify it yourself:

```
joint fund   fb6016693647bf6f0787e5eaa6920ff3ebca9906a082f00136589fc878a7459a   block 405031
joint claim  1eee0ea7f003aea71c8ecfdfe811b518e7fca881f0162cf5299d297a2f5ddaab   block 405038
```

https://explorer.preview.midnight.network/transaction/1eee0ea7f003aea71c8ecfdfe811b518e7fca881f0162cf5299d297a2f5ddaab

---

## Design decisions worth arguing with

**`RelayerRegistry` has no slashing, and that is deliberate.** A relayer never authors content, so
there is no provable fault to punish. Censorship in particular cannot be proven on chain - an
operator ignoring your job is indistinguishable from one that never received it, so a rule against
it punishes the innocent as readily as the guilty. Enforcement is economic: an operator that stops
serving stops earning.

**That argument does NOT extend to verifiers.** A verifier's entire job is to author a judgement,
and a lying verifier is exactly the fault slashing exists for. Arbitration therefore cannot reuse
this registry - it needs a stake instrument with confiscation, which is a different contract and a
deliberate economic decision.

**Unbonding removes stake from the denominator immediately**, not when the wait ends. `totalStaked`
is the denominator of everyone else's priority share, so capital that has announced it is leaving
must stop buying capacity the moment it announces - otherwise an operator holds priority through
its own exit.

**`PPT`'s cap is on cumulative issuance**, so burning never frees room to mint again. `issued` is
monotone; a burn is counted separately and never subtracted.

---

## Build

```bash
compact compile src/NotePool.compact build-notepool
npm test              # simulator suites
npm run mutate        # break each guard, require red
```

Built against Compact `0.31.x`. Note that a contract compiling proves nothing about whether it
executes - see the [gotchas repo](https://github.com/wali-hu/midnight-gotchas), particularly the
duplicate-runtime item, which makes every `callTx` fail while compilation stays perfectly clean.

---

*By [@wali-hu](https://github.com/wali-hu) · [phantomproto.com](https://phantomproto.com)*
