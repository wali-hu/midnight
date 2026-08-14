// Mutation test for DepositAttest.
//
// SESSION-LOG §7: "Never trust a green test you did not try to break." A green suite proves the
// tests run; it does not prove they would notice. This script deletes each load-bearing assert from
// the CONTRACT, recompiles for real, reruns the suite, and demands that the specific test which
// should catch it reports `IT SUCCEEDED` - i.e. the attack actually lands once the guard is gone.
//
// A mutation that leaves the suite green is a test that was never testing anything.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'src/DepositAttest.compact');
const BACKUP = join(root, 'src/.DepositAttest.compact.orig');

// The compact toolchain. Overridable so this runs on a machine where it lives elsewhere.
const COMPACT = process.env.COMPACT_BIN ?? 'compact';

const MUTATIONS = [
  {
    name: 'remove the double-mint guard (`minted`)',
    find: 'assert(disclose(!minted.member(disclose(depositId))), "deposit already minted");',
    expect: 'the SAME deposit cannot be minted twice',
    why: 'one BSC deposit could be minted into unlimited notes - a money printer',
  },
  {
    name: 'remove attester distinctness',
    find: `assert(disclose(a0 != a1), "attesters must be distinct");
  assert(disclose(a1 != a2), "attesters must be distinct");
  assert(disclose(a0 != a2), "attesters must be distinct");`,
    expect: '1 attestation cited 3× is NOT a quorum',
    why: '3-of-5 collapses to 1-of-5 - a single attester mints anything',
  },
  {
    name: 'remove enrolment check in attest()',
    find: 'assert(disclose(attesters.member(disclose(pk))), "not an enrolled attester");',
    expect: 'a NON-enrolled key cannot attest',
    why: 'anyone in the world becomes an attester; the quorum means nothing',
  },
  {
    name: 'remove the repeat-vote check in attest()',
    find: 'assert(disclose(!votes.member(disclose(vk))), "this attester already attested to this claim");',
    expect: 'the SAME attester cannot attest the same claim twice',
    why: 'one attester votes three times and reaches the threshold alone',
  },
  {
    name: 'remove the quorum lookup in mintFromDeposit()',
    find: `assert(disclose(votes.member(disclose(voteKey(ck, a0)))), "attester 1 has not attested this claim");
  assert(disclose(votes.member(disclose(voteKey(ck, a1)))), "attester 2 has not attested this claim");
  assert(disclose(votes.member(disclose(voteKey(ck, a2)))), "attester 3 has not attested this claim");`,
    // The FIRST test that touches the guard, not the most dramatic one. With the lookup gone, the
    // "2 of 5" mint lands and consumes DEPOSIT_ID, so every later attack fails on "already minted"
    // instead - a wrong-reason rejection that would read as a false green if this pointed there.
    expect: '2 of 5 is below the threshold',
    why: 'the relayer mints any amount to itself with no attestation at all',
  },
];

const build = () => execFileSync(COMPACT, ['compile', SRC, join(root, 'build-deposit')],
  { cwd: root, stdio: 'pipe' });

// The suite exits non-zero on failure, so capture output either way.
const runSuite = () => {
  try {
    return execFileSync(process.execPath, [join(here, 'deposit-attest.test.mjs')],
      { cwd: root, encoding: 'utf8' });
  } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};

copyFileSync(SRC, BACKUP);
const original = readFileSync(SRC, 'utf8');
let pass = 0, fail = 0;

console.log('\n════ DepositAttest - mutation test ════\n');
console.log('Each line: delete a guard from the contract, rebuild, and confirm the attack lands.\n');

try {
  // Sanity first. If the unmutated suite is not green, every result below is meaningless.
  build();
  if (!/ALL PASS/.test(runSuite())) {
    console.error('❌ baseline suite is not green - aborting, mutation results would be noise');
    process.exit(1);
  }
  console.log('  baseline: green\n');

  for (const m of MUTATIONS) {
    if (!original.includes(m.find)) {
      console.log(`  ❌ ${m.name}  - PATTERN NOT FOUND, the contract changed under this script`);
      fail++;
      continue;
    }
    writeFileSync(SRC, original.replace(m.find, ''));
    build();
    const out = runSuite();

    // The line for the expected test must now read "IT SUCCEEDED", not merely be absent or red.
    const line = out.split('\n').find((l) => l.includes(m.expect)) ?? '';
    const landed = /IT SUCCEEDED/.test(line);
    console.log(`  ${landed ? '🚨' : '❌'} ${m.name}`);
    console.log(`       caught by: "${m.expect}"`);
    console.log(`       ${landed ? 'attack lands as predicted' : 'NOTHING CHANGED - that test does not test this'}`);
    console.log(`       impact if shipped: ${m.why}\n`);
    landed ? pass++ : fail++;
  }
} finally {
  writeFileSync(SRC, original);
  build();
  // Only now: the backup is the last line of defence if this process is killed mid-run, so it is
  // removed after the restore has actually happened, never before.
  rmSync(BACKUP, { force: true });
  console.log('  contract restored and rebuilt from the original source');
}

const verdict = fail === 0;
console.log(`\n${verdict ? '✅ EVERY GUARD IS LOAD-BEARING' : '❌ SOME GUARDS ARE NOT TESTED'}` +
            `  -  ${pass}/${MUTATIONS.length} mutations caught\n`);
process.exit(verdict ? 0 : 1);
