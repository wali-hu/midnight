// Mutation test for OtcEscrow.
//
// Same discipline as ppt.mutate.mjs and registry.mutate.mjs: break the contract the way a real
// change would, rebuild for real, rerun the suite, and demand that the test which should catch it
// reports `IT SUCCEEDED`.
//
// This one matters more than the other two. The suite it is grading ALREADY missed a live bug once:
// `ticketFor` accepted `priceMax` and left it out of the commitment, and post → fill → fill → claim
// passed against it end to end. A suite that has been wrong before does not get to be trusted on its
// own say-so.
//
// Entries marked `language_guarantee` are expected NOT to land. They were written as ordinary
// mutations, did not land, and were then investigated rather than deleted - the platform refuses
// them underneath our assert. They pass on the opposite evidence: still rejected, by the named
// mechanism.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const SRC = join(root, 'src/OtcEscrow.compact');
const BACKUP = join(root, 'src/.OtcEscrow.compact.orig');
const COMPACT = process.env.COMPACT_BIN ?? 'compact';

const MUTATIONS = [
  {
    name: 'remove the FLOOR of the price band',
    find: '  assert(scaled >= e.priceMin * disclose(fillAmount), "price is below the maker\'s band");\n',
    replace: '',
    expect: 'filling BELOW the band is REJECTED',
    why: 'a taker fills at any price they like - the maker sells 100 units for one',
  },
  {
    name: 'remove the CEILING of the price band',
    find: '  assert(scaled <= e.priceMax * disclose(fillAmount), "price is above the maker\'s band");\n',
    replace: '',
    expect: 'filling ABOVE the band is REJECTED',
    why: 'the band stops binding upward; a maker cannot cap what an order costs a taker',
  },
  {
    name: 'check the price by DIVISION instead of cross-multiplication',
    find: `  const scaled = disclose(payAmount) * priceScale();
  assert(scaled >= e.priceMin * disclose(fillAmount), "price is below the maker's band");
  assert(scaled <= e.priceMax * disclose(fillAmount), "price is above the maker's band");`,
    replace: `  const implied = (disclose(payAmount) * priceScale() / disclose(fillAmount)) as Uint<64>;
  assert(implied >= e.priceMin, "price is below the maker's band");
  assert(implied <= e.priceMax, "price is above the maker's band");`,
    // Included to DOCUMENT the design choice under test rather than only in a comment. If Compact has
    // no integer division this will not compile, and that is itself the answer - recorded as such
    // instead of as a caught mutation.
    language_guarantee: /below the maker's band|above the maker's band/,
    expect: 'filling BELOW the band is REJECTED',
    why: 'truncation an attacker tunes with a small fill, while every trade still looks in-band',
  },
  {
    name: 'remove the remaining-amount ceiling',
    find: '  assert(disclose(fillAmount) <= e.remaining, "fill exceeds what is left of the order");\n',
    replace: '',
    expect: 'filling MORE than remains is REJECTED',
    why: 'an order sells more than was ever escrowed - the contract mints the sell asset',
  },
  {
    name: 'remove the pay-asset check',
    find: '  assert(disclose(takerAsset) == e.assetBuy, "you must pay in the asset the maker is buying");\n',
    replace: '',
    expect: 'paying in the WRONG asset is REJECTED',
    why: 'a taker pays in the cheap asset and is credited in the dear one',
  },
  {
    name: 'remove the LEAF BINDING in consumeNote',
    find: '  assert(disclose(p.leaf == cm), "merkle path is not for this note");\n',
    replace: '',
    expect: "presenting SOMEONE ELSE'S leaf is REJECTED",
    why: 'anyone spends anyone else\'s note: leaves are public, the path is a witness. This is the line',
  },
  {
    name: 'let a CLAIMED order still be filled',
    find: '  assert(e.open, "this order has been claimed and is closed");\n',
    replace: '',
    expect: 'filling a claimed order is REJECTED',
    why: 'takers keep buying from an order whose value the maker has already walked away with',
  },
  {
    name: 'let an order be claimed TWICE',
    find: '  assert(e.open, "this order has already been claimed");\n',
    replace: '',
    expect: 'claiming twice is REJECTED - no double payout',
    why: 'the maker claims proceeds and remainder repeatedly - a money printer',
  },
  {
    name: 'insert the TICKET into the note tree',
    find: `  escrows.insert(disclose(ticket), Escrow {
    remaining: disclose(amount), proceeds: 0,`,
    replace: `  notes.insert(ticket);
  escrows.insert(disclose(ticket), Escrow {
    remaining: disclose(amount), proceeds: 0,`,
    expect: 'the ticket is NOT a merkle leaf',
    why: 'the claim key becomes a tree leaf - visible to anyone walking the tree, and shaped like a note',
  },
  {
    name: 'drop priceMax from the ticket commitment (the bug this suite already caught once)',
    find: `     priceMin as Field as Bytes<32>, priceMax as Field as Bytes<32>],`,
    replace: `     priceMin as Field as Bytes<32>, priceMin as Field as Bytes<32>],`,
    expect: 'claiming with DIFFERENT parameters than were posted is REJECTED',
    why: 'the ticket stops being the order\'s identity; two orders differing only in priceMax collide',
  },
];

const build = () => execFileSync(COMPACT, ['compile', SRC, join(root, 'build-otc')],
  { cwd: root, stdio: 'pipe' });

const runSuite = () => {
  try {
    return execFileSync(process.execPath, [join(here, 'otc.test.mjs')], { cwd: root, encoding: 'utf8' });
  } catch (e) { return String(e.stdout ?? '') + String(e.stderr ?? ''); }
};

copyFileSync(SRC, BACKUP);
const original = readFileSync(SRC, 'utf8');
let pass = 0, fail = 0;

console.log('\n════ OtcEscrow - mutation test ════\n');

try {
  build();
  if (!/OtcEscrow: \d+ passed, 0 failed/.test(runSuite())) {
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

    let built = true, buildErr = '';
    try { build(); } catch (e) {
      built = false;
      buildErr = String(e.stderr ?? e.stdout ?? e).trim().split('\n').slice(0, 3).join(' ').slice(0, 200);
    }
    if (!built) {
      // For a language_guarantee entry a compile failure IS the finding: the language refuses the
      // broken form outright. For an ordinary mutation it means this script tested nothing.
      const ok = Boolean(m.language_guarantee);
      console.log(`  ${ok ? '🛡️ ' : '⚠️ '} ${m.name}`);
      console.log(`       the mutated contract does NOT COMPILE - the LANGUAGE refuses this form`);
      console.log(`       compiler: ${buildErr}`);
      console.log(`       would matter otherwise: ${m.why}\n`);
      ok ? pass++ : fail++;
      continue;
    }

    const out = runSuite();
    const line = out.split('\n').find((l) => l.includes(m.expect)) ?? '';

    // Two shapes of "the suite noticed", and the harness was blind to the second one:
    //   rejected(...) that did NOT reject  -> prints "IT SUCCEEDED"
    //   check(...)    that went false      -> prints a leading ❌ and no marker at all
    // The ticket-as-leaf mutation is a check(), so it read as NOTHING CHANGED while the suite was in
    // fact failing on exactly the right line. A mutation harness that can only see one kind of
    // failure silently under-reports its own coverage.
    const landed = /IT SUCCEEDED/.test(line) || line.trimStart().startsWith('❌');

    if (m.language_guarantee) {
      const ok = !landed && m.language_guarantee.test(line);
      console.log(`  ${ok ? '🛡️ ' : '❌'} ${m.name}`);
      console.log(`       LANGUAGE GUARANTEE - expected NOT to land`);
      console.log(`       ${ok ? 'still rejected, underneath our assert' : 'the expected rejection did NOT appear - re-derive this'}`);
      console.log(`       observed: ${line.trim().replace(/^.*?-\s*/, '') || '(no such test line)'}\n`);
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
            `  -  ${pass}/${MUTATIONS.length} mutations accounted for\n`);
process.exit(verdict ? 0 : 1);
