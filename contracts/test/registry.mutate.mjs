// Mutation test for RelayerRegistry.
//
// Same discipline as ppt.mutate.mjs: break the contract the way a real change would, rebuild for
// real, rerun the suite, and demand that the test which should catch it reports `IT SUCCEEDED`.
//
// TWO entries below are marked `language_guarantee` and are expected NOT to land. They were written
// as ordinary mutations, did not land, and were then BUILT AND RUN to find out why - the answer was
// not "the test is weak" but "something underneath already refuses this". They pass on the opposite
// evidence: the mutant must still be rejected, and rejected by the named mechanism.
//
// That distinction is worth keeping rather than deleting the entries, because the two are not equal:
//
//   the stake ceiling   - Compact's `-` on Uint is CHECKED, so the underflow is refused by the
//                         LANGUAGE. The assert cannot be load-bearing for safety no matter how it is
//                         written; it exists so the caller reads "cannot unbond more than is staked"
//                         instead of "result of subtraction would be negative".
//
//   the member check    - refused by the RUNTIME, because `Map.lookup` of a missing key throws. Safe
//                         today, but that is behaviour of a component we do not own, and the error
//                         ("expected a cell, received null") tells a caller nothing. This assert is
//                         the one genuinely worth keeping: it makes the guarantee ours.


import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'src/RelayerRegistry.compact');
const BACKUP = join(root, 'src/.RelayerRegistry.compact.orig');
const COMPACT = process.env.COMPACT_BIN ?? 'compact';

const MUTATIONS = [
  {
    name: 'remove the NEAR edge of the unbonding delay',
    find: `  assert(kernel.blockTimeLessThan((disclose(unbondAt) - unbondingSeconds) as Uint<64>),
         "unbonding delay is too short");\n`,
    replace: '',
    expect: 'a release date sooner than the unbonding period is REJECTED',
    why: 'the operator picks their own release time - priority becomes rentable for a single burst',
  },
  {
    name: 'remove the FAR edge (the millisecond guard)',
    find: `  assert(kernel.blockTimeGreaterThan((disclose(unbondAt) - maxUnbondHorizonSeconds()) as Uint<64>),
         "unbond date is unreasonably far away - a millisecond timestamp looks exactly like this");\n`,
    replace: '',
    expect: 'a release date given in MILLISECONDS is REJECTED',
    why: 'one client-side Date.now() locks an operator\'s stake for ~55,000 years, silently',
  },
  {
    name: 'remove the wait from withdrawStake',
    find: '  assert(kernel.blockTimeGreaterThan(rec.unbondAt), "still unbonding");\n',
    replace: '',
    expect: 'withdrawing BEFORE the release time is REJECTED',
    why: 'request and withdraw in the same block - the unbonding period does not exist',
  },
  {
    name: 'remove the stake ceiling on an unbond request',
    find: '  assert(disclose(amount) <= rec.stake, "cannot unbond more than is staked");\n',
    replace: '',
    language_guarantee: /subtraction would be negative/,
    expect: 'unbonding more than is staked is REJECTED',
    why: 'on a language with wrapping arithmetic: an operator withdraws other operators\' stake',
  },
  {
    name: 'remove the registered-operator check',
    find: '  assert(operators.member(key), "not a registered operator");\n',
    replace: '',
    language_guarantee: /expected a cell, received null/,
    expect: 'topping up as an unregistered secret is REJECTED',
    why: 'if Map.lookup ever returned a default instead of throwing: anyone acts on any record',
  },
  {
    name: 'remove the governance proof',
    find: '  assert(disclose(governancePk(governanceSecret()) == governancePkCommit), "not governance");\n',
    replace: '',
    expect: 'setting the split without the governance secret is REJECTED',
    why: 'anyone sets the fee split to 100% to themselves',
  },
  {
    name: 'let the fee split total something other than 100%',
    find: `  assert(disclose(operatorBps) + disclose(burnBps) + disclose(teamBps) == 10000,
         "the fee split must total exactly 100%");\n`,
    replace: '',
    expect: 'a split that does not total 100% is REJECTED',
    why: 'fee revenue is silently created or destroyed, and nothing downstream reports an error',
  },
  {
    name: 'remove the unbonding floor from the constructor',
    find: `  assert(disclose(unbondSeconds) >= minUnbondingSeconds(),
         "unbonding period is below the floor - a delay of zero is not a delay");\n`,
    replace: '',
    expect: 'deploying with an unbonding period of ZERO is REJECTED',
    why: 'a registry deploys with a zero delay and "unbonding" is a word in a document',
  },
];

const build = () => execFileSync(COMPACT, ['compile', SRC, join(root, 'build-registry')],
  { cwd: root, stdio: 'pipe' });

const runSuite = () => {
  try {
    return execFileSync(process.execPath, [join(here, 'registry.test.mjs')],
      { cwd: root, encoding: 'utf8' });
  } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};

copyFileSync(SRC, BACKUP);
const original = readFileSync(SRC, 'utf8');
let pass = 0, fail = 0;

console.log('\n════ RelayerRegistry - mutation test ════\n');

try {
  build();
  if (!/RelayerRegistry: \d+ passed, 0 failed/.test(runSuite())) {
    console.error('❌ baseline suite is not green - aborting, every result below would be noise');
    process.exit(1);
  }
  console.log('  baseline: green\n');

  for (const m of MUTATIONS) {
    if (!original.includes(m.find)) {
      console.log(`  ❌ ${m.name}  - PATTERN NOT FOUND, the contract changed under this script\n`);
      fail++;
      continue;
    }
    writeFileSync(SRC, original.replace(m.find, m.replace));

    // A mutant that does not compile has proven nothing about the tests. Counting it as a pass would
    // be the mutation harness itself going green while testing nothing.
    let built = true, buildErr = '';
    try { build(); } catch (e) {
      built = false;
      buildErr = String(e.stderr ?? e.stdout ?? e).trim().split('\n').slice(0, 3).join(' ');
    }
    if (!built) {
      console.log(`  ⚠️  ${m.name}`);
      console.log(`       the mutated contract does not compile - the LANGUAGE rejects this`);
      console.log(`       compiler: ${buildErr}\n`);
      fail++;
      continue;
    }

    const out = runSuite();
    const line = out.split('\n').find((l) => l.includes(m.expect)) ?? '';
    const landed = /IT SUCCEEDED/.test(line);

    // Expected NOT to land. It passes only on the opposite evidence - still refused, and refused by
    // the mechanism named. Absence from the output is NOT enough: that would let "the platform
    // protects us" pass as an untested slogan.
    if (m.language_guarantee) {
      const ok = !landed && m.language_guarantee.test(line);
      console.log(`  ${ok ? '🛡️ ' : '❌'} ${m.name}`);
      console.log(`       LANGUAGE GUARANTEE - expected NOT to land`);
      console.log(`       ${ok ? 'still rejected, by the platform rather than by our assert'
                              : 'the expected rejection did NOT appear - re-derive this claim'}`);
      console.log(`       observed: ${line.trim().replace(/^.*?-\s*/, '') || '(no such test line)'}`);
      console.log(`       would matter otherwise: ${m.why}\n`);
      ok ? pass++ : fail++;
      continue;
    }

    console.log(`  ${landed ? '🚨' : '❌'} ${m.name}`);
    console.log(`       caught by: "${m.expect}"`);
    console.log(`       ${landed ? 'attack lands as predicted' : 'NOTHING CHANGED - that test does not test this'}`);
    console.log(`       impact if shipped: ${m.why}\n`);
    landed ? pass++ : fail++;
  }
} finally {
  writeFileSync(SRC, original);
  build();
  rmSync(BACKUP, { force: true });
  console.log('  contract restored and rebuilt from the original source');
}

const verdict = fail === 0;
console.log(`\n${verdict ? '✅ EVERY GUARD IS LOAD-BEARING' : '❌ SOME GUARDS ARE NOT TESTED'}` +
            `  -  ${pass}/${MUTATIONS.length} mutations caught\n`);
process.exit(verdict ? 0 : 1);
