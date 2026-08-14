# Midnight preview - measured, not assumed

Numbers I needed while building on Midnight `preview`, that I could not find written down, so I
measured them. Two of them **overturned my own design documents**.

Everything here has a script that reproduces it. Where a number is imprecise I say so, because a
measurement quoted as a constant is worse than no measurement.

---

## 1. Fees are dominated by SIZE, not fixed

```
fee ≈ 0.097143 + 67.1751e-6 × bytes        R² = 0.9814,  n = 30
```

`measure-batch-fee.mjs`

**Why it mattered:** my token-design document assumed cost was mostly fixed, and sized batching
economics on that assumption - "batch n operations, pay roughly once." If the fee is dominated by
size, a batch of n operations carries n × the bytes and the saving largely disappears.

**What I can and cannot claim.** The chain has three links and I measured the first one:

- (a) fee scales with bytes - **measured**, above
- (b) a batch of n operations carries n × the bytes - **NOT measured**; my merge experiment failed
  39/39 on segment-id collisions
- (c) therefore batching saves little - follows only if (b) holds

So the safe statement is *"fee is dominated by size, so a mostly-fixed cost model does not hold."*
The unsafe one is *"batching caps at 1.2×."* If Midnight aggregates proofs in a way I did not test,
the conclusion inverts. **I list this because the temptation to quote the tidy number was real.**

---

## 2. A circuit-invalid transaction costs ZERO fee

`measure-failed-fee.mjs`, `probe-failed-tx.mjs`

A transaction whose circuit does not satisfy its constraints is rejected **before fees apply**. It
costs the submitter nothing and the network nothing.

**Why it mattered:** my design had a paragraph about a griefing vector where an attacker burns a
relayer's fee balance with deliberately invalid transactions. That vector does not exist. The
defence I had designed was solving a problem the protocol had already solved.

**Note the asymmetry with #4 below:** *invalid* is free, but *expired-fee-proof* is a different
rejection with a different cause, and the two look similar from the outside.

---

## 3. DUST is 15 decimals, not 6

Confirmed two independent ways:

- **generation arithmetic:** ~0.71 DUST per NIGHT per day against a known NIGHT balance
- **accrual measurement:** raw balance sampled hours apart on a live wallet

```
15 dp → 16,536 DUST      → ~3 days of accrual on a wallet funded days ago    plausible
 6 dp → 1.65e13 DUST     → 3.1 billion days on a network weeks old           impossible
```

I nearly shipped a status page overstating a fee balance by **1e9**.

**Honest caveat on the rate.** My accrual measurement implies decimals of ~14.6-14.9 rather than
exactly 15, a factor of ~1.5 I cannot attribute confidently - it could be the elapsed-time estimate,
the generation rate being approximate, or accrual not being perfectly linear. None of that changes
the conclusion, since 6 is wrong by nine orders of magnitude. **But do not quote
`0.7143 × NIGHT/day` as a protocol constant on the strength of a short window.** My data is
consistent with it; it does not confirm it. Those are different things.

---

## 4. Wallet sync: ~650s cold, ~9s warm

`net-compare.mjs`

This single number changed our architecture. A service that awaits the wallet at boot is offline for
**eleven minutes on every restart**. Ours starts the wallet in the background and answers read
requests immediately - contract state is public and needs no wallet at all.

**And a bug that only a warm sync could expose.** Balance state arrives as a stream whose first
emission is empty. Taking that first value gives you zero. On a 650s cold sync the real value
arrives before anything asks; on a warm 9s sync it does not.

> **A bug that appears only when things get *faster* is the one that reaches a live deployment.** Every
> slow path hides it, development is always slow, and the first well-cached live run is where
> it detonates.

---

## 5. Liveness is a derivative

`liveness.mjs`

A hung process is not a dead process. Two concurrent deploys taking the same exclusive LevelDB lock
produced a second process that blocked **forever with zero CPU, zero I/O, and no error** - `ps`
said "running" for hours.

`liveness.mjs` samples CPU and I/O twice and returns one of three verdicts - `WORKING`,
`NO PROGRESS`, `GONE` - because "is it alive?" and "is it doing anything?" are different questions
and only the second one matters.

This later caught a zombie SSH holding a torn-down pipe: alive locally, dead remotely, and an output
file of **0 bytes** that could equally have meant "ran and found nothing."

---

## Running these

```bash
npm install
node tools/measure-batch-fee.mjs      # the fee curve
node tools/measure-failed-fee.mjs     # invalid-tx cost
node tools/net-compare.mjs            # cold vs warm sync
node tools/liveness.mjs <pid> 15      # is it working, or just alive?
```

Needs a funded preview wallet seed in `MIDNIGHT_WALLET_SEED` and a local proof server on `:6300`.

---

## Why publish this

Every number here cost me hours, and two of them corrected documents I had written with confidence.
Measuring your own assumptions is cheap; discovering them wrong in front of a partner is not.

**If you re-measure any of these and get a different answer, please open an issue.** I would rather
be corrected than quoted.

---

*By [@wali-hu](https://github.com/wali-hu) · [phantomproto.com](https://phantomproto.com)*
