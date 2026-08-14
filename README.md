# Midnight: engineering work from Phantom Protocol

Everything I have built on [Midnight](https://midnight.network) while building
[Phantom Protocol](https://phantomproto.com), a privacy-preserving settlement layer where
**Midnight is the ledger of record** and execution stays on the chain that holds the money.

Four parts, one repository.

| Folder | What is in it |
|---|---|
| **[`contracts/`](contracts/)** | Eight Compact contracts, all live on `preview` and indexer-confirmed - including a **2-of-2 note neither party nor the operator can spend alone**. Mutation-tested. |
| **[`measurements/`](measurements/)** | Numbers I measured because I could not find them written down: the fee curve, DUST decimals, cold-vs-warm sync. **Two of them overturned my own design documents.** |
| **[`service-patterns/`](service-patterns/)** | What changes when a real service depends on Midnight: background wallet start, a serialised write queue, artifact staging, preflight checks. |
| **[`gotchas/`](gotchas/)** | Five traps that cost me real debugging time, with symptom, cause and fix. |

---

## The short version

**Eight contracts, all deployed and confirmed by the public indexer** - the block heights are a
third party reading the chain, not this repo reporting on itself.

| Contract | Block |
|---|---|
| `NotePool` - shielded notes + the 2-of-2 joint note | 373928 / 374225 |
| `MandateRegistry` - an agent proves it stayed inside a budget without revealing the budget | 376527 |
| `PPT` - fixed supply, monotone issuance | 396064 |
| `RelayerRegistry` - staked operators, no slashing by design | 396068 |
| `JobContract` - a two-party agreement bound to a joint note | 396244 |
| `DepositAttest` - 3-of-5 cross-chain deposit attestation | 397472 |
| `OtcEscrow` - a price *range*, filled in pieces | 399909 |
| `TimeProbe` - a measurement contract |  |

**Verify any of it yourself:**

```
joint-note fund    fb6016693647bf6f0787e5eaa6920ff3ebca9906a082f00136589fc878a7459a   block 405031
joint-note claim   1eee0ea7f003aea71c8ecfdfe811b518e7fca881f0162cf5299d297a2f5ddaab   block 405038
PPT issuance       ce6a6a025c71cb4a6590520bc6ecf73dfaf27866a0bad00cd803940178e43001   block 408415
```

https://explorer.preview.midnight.network/transaction/1eee0ea7f003aea71c8ecfdfe811b518e7fca881f0162cf5299d297a2f5ddaab

---

## The one thing I would point at

A payment locked to a key derived from two *public* halves:

```
owner = jointOwnerPk( ownerPk(sA), ownerPk(sB) )
```

Neither party can move it. Neither can the operator. Nothing on chain distinguishes it from an
ordinary note, so an observer cannot even tell an escrow exists.

**And proving that it works proves nothing.** It says nothing about whether the second half is
load-bearing. So the test also attempts a claim with **one half and a guess for the other**:

```
one half + a guess   →   REFUSED in 1.4s inside the circuit - no transaction, no fee
both halves          →   claimed in 67s
```

The refusal is the evidence. The success is just the demo.

---

## Two findings worth contributing upstream

1. **`@midnight-ntwrk/compact-js` advertises a CommonJS build it does not ship.** And the obvious
   workaround fails silently, because TypeScript downlevels `await import()` to `require()` under
   `module: commonjs` - so your source says `import` and your output takes the same broken path.

2. **`kernel.blockTime*` compares SECONDS.** A millisecond timestamp makes a deadline check
   **silently always-true**, and the simulator still passes. It fails *open*, which is the worst
   direction for an expiry to fail in.

Both are written up in [`gotchas/`](gotchas/) with the symptom first, because that is what you will
be searching for.

---

## What is not claimed here

The BSC leg of the joint-note settlement is proven on chain but is **not wired to any button** yet -
and the live product says so on the page rather than letting a viewer assume. Two measurements in
[`measurements/`](measurements/) carry explicit caveats about what they do *not* establish.

I would rather report a gap than round it up.

---

*By [@wali-hu](https://github.com/wali-hu) - sole engineer on Phantom Protocol.
[phantomproto.com](https://phantomproto.com)*
