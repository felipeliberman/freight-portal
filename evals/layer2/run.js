#!/usr/bin/env node
// Layer-2 flow simulations against the CURRENT portal.html. No network, no credentials, no browser.
//
//   node evals/layer2/run.js            # all cases
//   node evals/layer2/run.js 2 5        # a subset by id
//
// Exit code is 1 on any FAIL or UNEXPECTED-PASS. An expectFail case that PASSES is a FAILURE of the
// suite (Decision B): the documented bug is fixed, so the flag must be removed — the run says so.

const { boot2 } = require('./harness');
const { cases } = require('./cases');

// jsdom teardown guard (copied from evals/state/run.js): page-side async (ZIP lookups, debounced
// refreshes) can land after window.close(), a fatal unhandledRejection unrelated to any case.
let _teardownNoise = 0;
process.on('unhandledRejection', () => { _teardownNoise++; });
process.on('exit', () => {
  if (_teardownNoise) console.log('  (' + _teardownNoise + ' post-teardown page async rejection(s) ignored — jsdom close artifacts)\n');
});

const want = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const list = want.length ? cases.filter(c => want.includes(c.id)) : cases;

const C = process.stdout.isTTY
  ? { g: s => '\x1b[32m' + s + '\x1b[0m', r: s => '\x1b[31m' + s + '\x1b[0m', y: s => '\x1b[33m' + s + '\x1b[0m', d: s => '\x1b[2m' + s + '\x1b[0m' }
  : { g: s => s, r: s => s, y: s => s, d: s => s };

(async () => {
  const out = [];
  for (const c of list) {
    const h = boot2();
    let err = null;
    try { await c.run(h); } catch (e) { err = e; }
    const passed = !err;
    let status;
    if (passed && !c.expectFail) status = 'PASS';
    else if (!passed && c.expectFail) status = 'EXPECTED-FAIL';
    else if (passed && c.expectFail) status = 'UNEXPECTED-PASS';
    else status = 'FAIL';
    out.push({ c, status, err });
    try { h.close(); } catch (e) {}
  }

  console.log('\n  LAYER-2 FLOW SIMULATIONS — portal.html (chat + quoting)\n');
  for (const { c, status, err } of out) {
    const tag = status === 'PASS' ? C.g('  PASS         ')
      : status === 'EXPECTED-FAIL' ? C.y('  EXPECTED-FAIL')
      : status === 'UNEXPECTED-PASS' ? C.r('  UNEXP-PASS   ') : C.r('  FAIL         ');
    console.log(tag + '  ' + c.id + '. ' + c.name);
    console.log(C.d('                   catches:  ' + c.catches));
    if (status === 'EXPECTED-FAIL') {
      console.log(C.y('                   fixed by: ' + c.fixedBy));
      console.log(C.d('                   why now:  ' + String(err.message).slice(0, 240)));
    } else if (status === 'UNEXPECTED-PASS') {
      console.log(C.r('                   expected fail but PASSED — the documented bug is fixed. Remove the expectFail flag and confirm the fix.'));
    } else if (status === 'FAIL') {
      if (err) console.log(C.r('                   ' + String(err.message).slice(0, 500)));
    }
    console.log('');
  }
  const n = s => out.filter(o => o.status === s).length;
  console.log('  ' + C.g(n('PASS') + ' pass') + '   ' + C.y(n('EXPECTED-FAIL') + ' expected-fail') + '   ' + C.r(n('FAIL') + ' fail') + '   ' + C.r(n('UNEXPECTED-PASS') + ' unexpected-pass') + '\n');
  process.exit(n('FAIL') + n('UNEXPECTED-PASS') > 0 ? 1 : 0);
})();
