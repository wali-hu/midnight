# Running Midnight on a live deployment: the parts that only break after you ship

Patterns from a Midnight deployment that real users hit, written as guidance rather than as a
drop-in library. Most Midnight examples are correct and small. This is what changes when a service
depends on it.

Nothing here is theoretical. Every item is something I got wrong first, and the note says what
breaks without it.

---

## The four measured facts that shaped every decision below

| Measured | Consequence |
|---|---|
| cold wallet sync **~650s**, warm **~9s** | never await the wallet at boot |
| proving takes **45 to 90s** per non-trivial circuit | the fee-proof margin must exceed it |
| the private-state store takes an **exclusive lock** | exactly one process, ever |
| chain state is **public** | reads need no wallet at all |

That last one is the leverage. Your read paths work while the wallet is still syncing, so a restart
is not eleven minutes of blank pages.

---

## 1. Start the wallet in the background, never await it

A cold sync is roughly 650 seconds. Awaiting it during boot takes your entire API offline for eleven
minutes on every restart, waiting for a wallet most requests never touch.

Start it and return immediately. Report progress from a status endpoint. The read-only routes answer
from the first second, because contract state is public.

**Make it a singleton, and default it off.** The private-state store is LevelDB with an exclusive
lock: a second holder blocks forever, with no CPU, no error and no timeout. That is not a crash you
debug, it is a process that looks healthy and does nothing. Gating it behind an explicit
`MIDNIGHT_ENABLED` means an accidental start cannot wedge your deploy tooling.

**Report four states, all honestly:** disabled with its reason, syncing with elapsed seconds, ready,
and failed with the error. A UI that only handles `ready` shows a blank box for eleven minutes, at
exactly the moment somebody is being shown the product.

**Watch for the balance read race.** Balance arrives as a stream whose first emission is empty.
Taking it gives you zero. This is invisible on a cold sync and appears the moment your store is warm,
which is the worst possible ordering: it hides during development and detonates on the first fast run.

---

## 2. One write at a time, with a global ceiling

The wallet, the fee balancer and the private-state store are each single-resource. Two concurrent
writes race on all three.

**Keep the rate limit global, never per-IP.** Behind a reverse proxy `req.ip` is your proxy's
container address, so a per-IP rule is simply wrong. In an agent-facing product it is also hostile:
agents are first-class users, and an IP rule makes them indistinguishable from a botnet. This is a
circuit breaker on a shared fee float, not a quota.

**Settle wallet state before every write.** Each landed transaction moves your dust and the
in-memory view lags the chain. Balancing against a stale view proves against dust that is already
spent, and it surfaces as `1010: Invalid Transaction: Custom error: 170` on the *third* write, not
the first.

Put that settle in exactly one place. I originally had four modules each with their own submit
helper, and not one of them had it.

---

## 3. Get the circuits into the image

**The failure this prevents:** my container build context excluded the compiled circuits, so the
deployed service could read Midnight perfectly and could never write. Every health check passed.
Every local test passed. The first failure would have been a user pressing a button.

Two rules learned the hard way:

- **Stage an explicit list, and hard-error on a missing directory.** Staging everything came to
  360MB, because every contract ships its own proving keys and most are never called. An explicit
  list can go stale, so it must fail loudly rather than skip silently.
- **Load artifacts from the staged copy, never in place.** Loading from a directory outside your
  package binds *that* directory's `node_modules`, which is how you end up with two copies of
  `onchain-runtime-v3` and `expected instance of StateValue` on every call.

---

## 4. Ask the deploy questions before deploying

Two questions cost me a full deploy cycle each, and both are answerable locally in about a minute:

1. **Does `npm ci` accept this lockfile inside the image?** A lockfile is an npm-version artifact.
   Written by npm 11 locally, rejected by the image's npm 10, with `Missing: <package> from lock
   file`. Regenerate it inside the image, always.
2. **Does any dependency demand a newer Node than the image ships?** `EBADENGINE` is a *warning*, so
   the build succeeds and the failure moves to runtime on the deployed box.

**Wire the check as a gate, not a habit.** I wrote this check and then deployed without running it,
hitting the exact failure it exists to catch. It belongs as step 0 of the deploy script, refusing to
continue on failure.

> A check you have to remember is a check you will eventually skip. Put it on the path you cannot
> avoid walking.

---

## 5. Report three facts per contract, not one tick

```
on chain?   .   circuits present in this build?   .   callable from here?
```

Two real cases, one afternoon apart, where "deployed and indexer-confirmed" was true and the button
did not work:

- a registry nobody could join, because the token its `register` circuit requires had never been
  minted
- a service that could read every contract and write to none, because the proving keys were not in
  the image

A single green tick collapses three questions into one. The two that disappear are the ones that
break later.

---

## 6. Configuration that survives a deploy

If your deploy regenerates its env file from a template, then anything hand-added on the box
survives exactly until the next deploy. Contract addresses belong in the template, which is
version-controlled and non-secret. The wallet seed belongs in a secret manager, injected at deploy
time.

**Leave an anchor line for the seed** in the template. Without the line present, a `sed`
substitution silently matches nothing and the seed never arrives, and the service disables itself,
which reads as broken UI rather than as missing config.

**Keep the proof server private.** `expose`, not `ports`. This is a privacy requirement rather than
hardening: proving consumes a circuit's private inputs, so a prover anyone can reach is one that can
be handed the very data the circuit exists to hide.

**Persist the private-state store on a volume**, or every redeploy costs a cold 650s sync instead of
a warm 9s one. And verify the mount path against where the SDK actually writes: I first mounted a
path I had invented, which would have existed, stayed empty forever, preserved nothing, and looked
correct in review.

---

## Environment

```bash
MIDNIGHT_ENABLED=on
MIDNIGHT_WALLET_SEED=          # from a secret manager, never the repo
MIDNIGHT_STATE_PASSWORD=       # encrypts the local store; must not change once it exists
MIDNIGHT_PROOF_SERVER=http://proof-server:6300
MIDNIGHT_INDEXER=https://indexer.preview.midnight.network/api/v4/graphql
MIDNIGHT_FEE_BLOCKS_MARGIN=60  # ~6 min; the default ~30s expires mid-proof
```

---

*By [@wali-hu](https://github.com/wali-hu). Companion: [`../gotchas/`](../gotchas/) has the five
traps with symptom, cause and fix.*
