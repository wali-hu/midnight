# Midnight gotchas

Five traps that cost me real debugging time building on Midnight `preview`, written down so they
cost you none. Each one has the symptom first, because that is what you will be searching for.

Every item here was hit on a live deployment, not read about. Where I found the cause in a
Midnight repo or my own, I say which.

---

## 1. `kernel.blockTime*` compares SECONDS, and milliseconds fail silently

**Symptom:** your deadline check never fires. Or always fires. The simulator passes either way.

```compact
// WRONG - a JS Date.now() value is ~1000x too large, so this is always true
assert(kernel.blockTimeLessThan(deadlineMs), "expired");
```

A millisecond timestamp is roughly a date 30,000 years out. `blockTimeLessThan` therefore returns
true forever, and an expiry that can never trigger looks exactly like an expiry that works - until
the day it was supposed to stop something.

**Why it is nasty:** it fails *open*. The happy path is unaffected, every test that exercises "not
yet expired" passes, and the defect only exists in the branch nobody tested.

**Guard it on both sides.** Reject a value that *looks* like milliseconds before you build a proof:

```ts
if (deadline > 100_000_000_000n) throw new Error('deadline looks like milliseconds; expected seconds');
```

**Related:** deadlines under about a minute are unusable in practice, because proving alone takes
45-90s for a non-trivial circuit. By the time the proof exists, the deadline has passed.

---

## 2. `@midnight-ntwrk/compact-js` advertises a CommonJS build it does not ship

**Symptom:**

```
Cannot find module '.../node_modules/@midnight-ntwrk/compact-js/dist/cjs/effect/index.js'
```

- a path that appears nowhere in your code.

The package's export map points `require` at `./dist/cjs/effect/index.js`. On disk there is `dts`
and `esm`, and no `cjs`.

**And the obvious workaround does not work.** Writing `await import('...')` is correct, but under
`"module": "commonjs"` TypeScript **downlevels it to `require()`**, which takes the same broken
path. Your source says `import` and your output says `require`.

**What works** - keep it out of TypeScript's reach entirely:

```ts
const esmImport: (spec: string) => Promise<any> =
  new Function('s', 'return import(s)') as (spec: string) => Promise<any>;

const { NodeZkConfigProvider } = await esmImport('@midnight-ntwrk/midnight-js-node-zk-config-provider');
```

**The wider lesson:** this constraint holds for a whole *file*, not one import. I wrote the warning
in a comment at the top of a file and then broke it in a new method 40 minutes later. A note beside
one import does not defend the next one somebody writes.

---

## 3. Two copies of `onchain-runtime-v3` at the same version

**Symptom:** every `callTx` dies with one of

```
expected instance of StateValue
ContractState … has unexpected type
expected instance of ChargedState
```

while deploys, joins and local circuit derivations all work perfectly.

**Cause:** `StateValue` is WASM-backed, so `instanceof` between two copies is **false**. The indexer
decodes on-chain state with one copy; the runtime executes your circuit expecting the other.

**The trap:** every version-level check says the tree is clean, because `npm ls` prints a **version,
not a path**:

```
├─┬ @midnight-ntwrk/compact-runtime@0.16.0
│ └── @midnight-ntwrk/onchain-runtime-v3@3.0.0 overridden   ← same version
└─┬ @midnight-ntwrk/midnight-js-protocol@4.1.1
  └── @midnight-ntwrk/onchain-runtime-v3@3.0.0 overridden   ← same version
```

**Check the filesystem, not the version:**

```bash
find node_modules -type d -name 'onchain-runtime-v3'   # must print exactly ONE line
```

**The fix needs BOTH lines** - `overrides` alone does not work, because npm satisfies it by nesting:

```jsonc
"dependencies": { "@midnight-ntwrk/onchain-runtime-v3": "3.0.0" },  // forces hoisting to the root
"overrides":    { "@midnight-ntwrk/onchain-runtime-v3": "3.0.0" }   // forces the single version
```

**A second way to reintroduce it:** loading compiled circuits from a directory *outside* your
package binds that directory's own `node_modules`. Always load artifacts from a copy staged inside
your project.

---

## 4. `1010: Invalid Transaction: Custom error: 170` - the fee proof expired while you were proving

**Symptom:** the transaction builds fine, the proof succeeds, and submission is rejected. Code 170
is `InvalidDustSpendProof`.

**Cause:** the DUST spend proof is built at *balance* time and validated at *submit* time. With

```ts
.withDustOptions({ feeBlocksMargin: 5, ... })
```

that proof is valid for ~30 seconds on preview - and a non-trivial circuit takes **45-90 seconds**
to prove. The fee proof expires while the real proof is still being built.

**Why the default looked fine:** the sample tooling only ever called tiny circuits that prove in a
couple of seconds. The margin is adequate right up until your circuit is real.

```ts
.withDustOptions({ feeBlocksMargin: 60, ... })   // ~6 minutes
```

**The same error, but only on the third write:** every landed transaction moves your wallet's dust,
and the in-memory view lags the chain. Balancing against a stale view proves against dust that is
already spent. **Settle the wallet state before each write**, in exactly one place - I had four
modules each with their own submit helper and none of them had the settle.

---

## 5. "Deployed" and "callable" are different questions

**Symptom:** the contract is on chain, indexer-confirmed, green on every dashboard - and the button
does nothing, or fails after a 90-second proof with an error about fees.

Two real instances, one afternoon apart:

**(a) The registry nobody could join.** `RelayerRegistry.register` calls
`receiveUnshielded(stakeColor(), amount)` - **the transaction must carry the coins** or it cannot
balance. Total issuance of the stake token was zero, so registration was impossible for everyone.
The contract had been deployed and confirmed for days.

**(b) The image with no proving keys.** My container build context excluded the compiled circuits,
so the deployed service could **read** Midnight perfectly - chain state is public and needs no
circuits - and could **never write**. Every health check passed. The first failure would have been
a user pressing a button during a demo.

**What I do now:** report three separate facts per contract instead of one green tick.

```
on chain?  ·  circuits present in this build?  ·  callable from here?
```

A single tick collapses three questions into one, and the two that disappear are the ones that
break later.

**Ask, before calling anything done:** what must exist *at run time* for this button to work?
Coins that have not been minted, artifacts not in the image, config never set - none of those show
up in a deployment check.

---

## The meta-lesson

Four of these five are invisible on a developer machine by construction. They appear only in a
container, only after a deploy, or only on the *second* call.

So the acceptance test that finds them is not a health check - it is **one real transaction, end to
end**. A single real write exercised the proof server, the fee balance, the private-state volume,
the module resolution and the circuit artifacts at once. Testing those separately took a day and
still missed things.

---

*Written by [@wali-hu](https://github.com/wali-hu) while building
[Phantom Protocol](https://phantomproto.com) on Midnight preview, August 2026.*
