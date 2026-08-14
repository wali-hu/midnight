// Mutation test for PPT.
//
// The suite is green. That proves the tests RUN; it does not prove they would NOTICE. So each
// mutation below rewrites the contract into the broken version a careful engineer would plausibly
// have written, rebuilds for real, reruns the suite, and demands that the specific test which should
// catch it reports `IT SUCCEEDED` - the attack actually landing.
//
// Two of these are deletions and two are REWRITES, which is the more useful kind. A deleted assert
// is an obvious diff in review; `(a + b) as Uint<64>` instead of `a + b` is one pair of parentheses,
// reads as a tidy-up, and hands an attacker the entire supply.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'src/PPT.compact');
const BACKUP = join(root, 'src/.PPT.compact.orig');
const COMPACT = process.env.COMPACT_BIN ?? 'compact';

const MUTATIONS = [
  {
    name: 'remove the cap assert entirely',
    find: '  assert(next <= totalSupply(), "issue would exceed the fixed supply");\n',
    replace: '',
    expect: 'mint 1 base unit past the cap is REJECTED',
    why: 'the issuer mints without limit - "1,000,000,000 fixed" becomes a sentence in a document',
  },
  {
    name: 'narrow the sum BEFORE checking it (the parenthesis bug)',
    find: `  const next = issued + disclose(amount);
  assert(next <= totalSupply(), "issue would exceed the fixed supply");
  issued = next as Uint<64>;`,
    replace: `  const next = (issued + disclose(amount)) as Uint<64>;
  assert(next <= totalSupply(), "issue would exceed the fixed supply");
  issued = next;`,
    // ── THIS ONE IS EXPECTED NOT TO LAND, AND THAT IS THE RESULT ────────────────────────────────
    // It was written expecting a classic wraparound: at the cap, an amount of 2^64 - TOTAL_SUPPLY
    // sums to 2^64, narrows to 0, sails past a cap check reading the wrong number. On a C-like
    // language that is a supply-destroying bug hidden in one pair of parentheses.
    //
    // Built and run, it did not land. Compact's `as Uint<64>` is CHECKED: the runtime refuses the
    // cast rather than wrapping it. So this mutation cannot be caught by our tests, because there is
    // nothing left for them to catch - the language already caught it.
    //
    // Kept in the suite rather than deleted, because "we tried to break it this way and the platform
    // stopped us" is a durable finding about Compact that the next person should not have to
    // rediscover. The harness therefore demands a DIFFERENT proof for it: the mutant must still be
    // rejected, and the rejection must come from the cast.
    language_guarantee: /cast from Field or Uint value to smaller Uint/,
    expect: 'mint an amount that WRAPS Uint<64> past the cap is REJECTED',
    why: 'on a language that wraps: one call mints 17.4 quintillion units AND resets `issued` to zero',
  },
  {
    name: 'let burn decrement `issued` (accounting that looks correct)',
    find: '  burned = next as Uint<64>;',
    replace: `  burned = next as Uint<64>;
  issued = (issued - disclose(amount)) as Uint<64>;`,
    expect: 're-minting into the burned headroom is REJECTED',
    why: 'burn-then-remint forever; supply never reads above the cap at any instant and is unbounded',
  },
  {
    name: 'remove the burn ceiling',
    find: '  assert(next <= issued, "cannot burn more than was ever issued");\n',
    replace: '',
    expect: 'burning more than was ever issued is REJECTED',
    why: '`burned` climbs past `issued`, so `circulating()` underflows and the supply figure is fiction',
  },
  {
    name: 'remove the issuer proof',
    find: '  assert(disclose(issuerPk(issuerSecret()) == issuerPkCommit), "not the issuer");\n',
    replace: '',
    expect: 'issuing with the wrong secret is REJECTED',
    why: 'anyone mints the entire remaining supply to themselves',
  },
];

const build = () => execFileSync(COMPACT, ['compile', SRC, join(root, 'build-ppt')],
  { cwd: root, stdio: 'pipe' });

// The suite exits non-zero on failure, so capture output either way. Never swallow it - a mutation
// run that reports nothing is indistinguishable from a mutation that was not caught.
const runSuite = () => {
  try {
    return execFileSync(process.execPath, [join(here, 'ppt.test.mjs')], { cwd: root, encoding: 'utf8' });
  } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};

copyFileSync(SRC, BACKUP);
const original = readFileSync(SRC, 'utf8');
let pass = 0, fail = 0;

console.log('\n════ PPT - mutation test ════\n');
console.log('Each line: break the contract the way a real change would, rebuild, confirm the attack lands.\n');

try {
  build();
  if (!/PPT: \d+ passed, 0 failed/.test(runSuite())) {
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

    // A mutation that does not COMPILE has proven nothing about the tests. Report it as a failure of
    // this script rather than silently counting it, which would be a false green of the worst kind:
    // the mutation harness itself passing while testing nothing.
    let built = true, buildErr = '';
    try { build(); } catch (e) { built = false; buildErr = String(e.stderr ?? e.stdout ?? e).trim().split('\n').slice(0, 3).join(' '); }

    if (!built) {
      console.log(`  ⚠️  ${m.name}`);
      console.log(`       the mutated contract does not compile - the LANGUAGE rejects this, not our test`);
      console.log(`       compiler: ${buildErr}\n`);
      fail++;
      continue;
    }

    const out = runSuite();
    const line = out.split('\n').find((l) => l.includes(m.expect)) ?? '';
    const landed = /IT SUCCEEDED/.test(line);

    // A mutation flagged `language_guarantee` is one we EXPECT not to land. It passes on the
    // opposite evidence: the attack must still be refused, and refused by the mechanism named. It
    // must NOT be allowed to pass merely by being absent from the output - that would turn "the
    // platform protects us" into an untested slogan.
    if (m.language_guarantee) {
      const ok = !landed && m.language_guarantee.test(line);
      console.log(`  ${ok ? '🛡️ ' : '❌'} ${m.name}`);
      console.log(`       LANGUAGE GUARANTEE - expected NOT to land`);
      console.log(`       ${ok ? 'still rejected, by the platform rather than by our assert'
                              : 'the expected rejection did NOT appear - re-derive this claim'}`);
      console.log(`       observed: ${line.trim().replace(/^.*?-\s*/, '') || '(no such test line)'}`);
      console.log(`       would matter if Compact wrapped: ${m.why}\n`);
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
  // Removed only AFTER the restore actually happened - the backup is the last line of defence if
  // this process is killed mid-run.
  rmSync(BACKUP, { force: true });
  console.log('  contract restored and rebuilt from the original source');
}

const verdict = fail === 0;
console.log(`\n${verdict ? '✅ EVERY GUARD IS LOAD-BEARING' : '❌ SOME GUARDS ARE NOT TESTED'}` +
            `  -  ${pass}/${MUTATIONS.length} mutations caught\n`);
process.exit(verdict ? 0 : 1);
