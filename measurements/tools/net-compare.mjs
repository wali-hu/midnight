// Which public network can we actually work on - preview or preprod?
//
// The owner's preference is preview, with preprod as the fallback "if preview doesn't work".
// That is a question of fact, so it gets measured rather than argued:
//
//   1. is the indexer up, and how long is the chain?
//   2. does a wallet SYNC? (this is the one that decides it - an unreachable balance is no balance)
//   3. does the faucet respond?
//
//   node net-compare.mjs [seconds]     default 240s budget per network
//
// Read-only: nothing is submitted, nothing is signed.

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { PREVIEW, PREPROD } from './env.mjs';
import { openWallet } from './wallet.mjs';

const BUDGET = Number(process.argv[2] ?? 240) * 1000;
const ONLY = process.env.ONLY;   // 'preview' | 'preprod' - run one at a time to keep RAM free

const SEED_FILE = new URL('.devwallet-seed', import.meta.url).pathname;
if (!existsSync(SEED_FILE)) writeFileSync(SEED_FILE, randomBytes(32).toString('hex'));
const SEED = readFileSync(SEED_FILE, 'utf8').trim();

const enc = (a) => { try { return a?.toBech32m?.() ?? String(a); } catch { return '?'; } };

async function height(env) {
  const t = Date.now();
  const r = await fetch(env.indexer, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ block { height } }' }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  return { height: j?.data?.block?.height ?? null, ms: Date.now() - t };
}

async function faucetAlive(env) {
  if (!env.faucet) return 'n/a';
  try {
    const r = await fetch(env.faucet, { method: 'GET', signal: AbortSignal.timeout(15_000) });
    return `HTTP ${r.status}`;
  } catch (e) { return `unreachable (${String(e.message ?? e).slice(0, 40)})`; }
}

// The decisive test: unshielded + dust only (see wallet.mjs for why shielded is skipped).
// MN_SHIELDED=1 to include the shielded scan - that is what OOMs, and reproducing it is useful.
async function walletSync(env, budgetMs) {
  const t = Date.now();
  const { wallet } = await openWallet(env, SEED, {
    withShielded: process.env.MN_SHIELDED === '1',
    waitForSync: false,   // the wait is what we are timing, below, under our own budget
  });

  const timeout = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`no sync within ${budgetMs / 1000}s`)), budgetMs).unref?.());

  try {
    const un = await Promise.race([wallet.unshielded.waitForSyncedState(), timeout]);
    const du = await Promise.race([wallet.dust.waitForSyncedState(), timeout]);
    const coins = un.availableCoins ?? [];
    return {
      ok: true, ms: Date.now() - t,
      address: enc(un.address),
      night: coins.length,
      dustRegistered: coins.filter((c) => c.meta?.registeredForDustGeneration).length,
      dust: String(du.balance?.(new Date()) ?? 0n),
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t, error: String(e.message ?? e).slice(0, 70) };
  } finally {
    try { await wallet.stop(); } catch { /* best effort */ }
  }
}

const nets = [['preview', PREVIEW], ['preprod', PREPROD]].filter(([n]) => !ONLY || n === ONLY);

for (const [name, env] of nets) {
  console.log(`\n════ ${name} ════`);
  try {
    const h = await height(env);
    console.log(`  indexer   : height=${h.height} (${h.ms}ms)`);
  } catch (e) { console.log('  indexer   : UNREACHABLE -', String(e.message ?? e).slice(0, 60)); }
  console.log('  faucet    :', await faucetAlive(env));

  const w = await walletSync(env, BUDGET);
  if (w.ok) {
    console.log(`  ✅ wallet SYNCED in ${(w.ms / 1000).toFixed(1)}s`);
    console.log(`     address=${w.address}`);
    console.log(`     NIGHT utxos=${w.night} (dust-registered ${w.dustRegistered})  dust=${w.dust}`);
  } else {
    console.log(`  ❌ wallet did NOT sync in ${(w.ms / 1000).toFixed(1)}s - ${w.error}`);
  }
}
process.exit(0);
