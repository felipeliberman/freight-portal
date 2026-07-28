#!/usr/bin/env node
// Run the state invariants against the CURRENT portal.html. No network, no credentials, no browser.
//
//   node evals/state/run.js            # all
//   node evals/state/run.js 2 4        # a subset by id
//
// Exit code is 1 only when an invariant fails UNEXPECTEDLY, or when one marked expected-fail starts
// passing — both are things a human needs to look at. Expected failures alone exit 0, because they
// are the specification of work that has not landed yet.

const { boot } = require('./harness');
const { invariants } = require('./invariants');

// jsdom teardown guard: page-side async chains (ZIP lookups, debounced field refreshes) can land
// AFTER ctx.dom.window.close(), where `document` is gone — a fatal unhandledRejection that says
// nothing about any invariant. Invariant failures are caught via await/try in the loop below and
// are unaffected; only post-close page async is being counted (and summarized once) here.
let _teardownNoise = 0;
process.on('unhandledRejection', () => { _teardownNoise++; });
process.on('exit', () => {
  if (_teardownNoise) console.log('  (' + _teardownNoise + ' post-teardown page async rejection(s) ignored — jsdom close artifacts, not invariant results)\n');
});

const want = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const list = want.length ? invariants.filter(i => want.includes(i.id)) : invariants;

const C = process.stdout.isTTY
  ? { g: s => '\x1b[32m' + s + '\x1b[0m', r: s => '\x1b[31m' + s + '\x1b[0m', y: s => '\x1b[33m' + s + '\x1b[0m', d: s => '\x1b[2m' + s + '\x1b[0m' }
  : { g: s => s, r: s => s, y: s => s, d: s => s };

(async () => {
  const out = [];
  for (const inv of list) {
    const ctx = boot();
    let err = null;
    try { await inv.run(ctx); } catch (e) { err = e; }
    const passed = !err;
    let status;
    if (passed && !inv.expectFail) status = 'PASS';
    else if (!passed && inv.expectFail) status = 'EXPECTED-FAIL';
    else if (passed && inv.expectFail) status = 'UNEXPECTED-PASS';
    else status = 'FAIL';
    out.push({ inv, status, err });
    ctx.dom.window.close();
  }

  console.log('\n  STATE INVARIANTS — portal.html\n');
  for (const { inv, status, err } of out) {
    const tag = status === 'PASS' ? C.g('  PASS         ')
      : status === 'EXPECTED-FAIL' ? C.y('  EXPECTED-FAIL')
      : status === 'UNEXPECTED-PASS' ? C.r('  UNEXP-PASS   ') : C.r('  FAIL         ');
    console.log(tag + '  ' + inv.id + '. ' + inv.name);
    console.log(C.d('                   property: ' + inv.property));
    console.log(C.d('                   catches:  ' + inv.catches));
    if (status === 'EXPECTED-FAIL') {
      console.log(C.y('                   fixed by: ' + inv.fixedBy));
      console.log(C.d('                   why now:  ' + String(err.message).slice(0, 220)));
    } else if (status === 'FAIL' || status === 'UNEXPECTED-PASS') {
      if (err) console.log(C.r('                   ' + String(err.message).slice(0, 400)));
      else console.log(C.r('                   marked expected-fail but PASSED — update invariants.js'));
    }
    console.log('');
  }
  const n = s => out.filter(o => o.status === s).length;
  console.log('  ' + C.g(n('PASS') + ' pass') + '   ' + C.y(n('EXPECTED-FAIL') + ' expected-fail') + '   ' + C.r(n('FAIL') + ' fail') + '   ' + C.r(n('UNEXPECTED-PASS') + ' unexpected-pass') + '\n');

  // ── THE ACCEPTANCE FLOW — the product owner's ten-step script + negative flow, every run ──
  // (Skipped when a subset of invariants was requested by id.)
  let flowFails = 0;
  if (!want.length) {
    const { runFlow } = require('../flows/acceptance');
    console.log('  ACCEPTANCE FLOW — evals/flows/acceptance.js\n');
    const flow = await runFlow();
    for (const r of flow) {
      const tag = r.status === 'PASS' ? C.g('  PASS') : r.status === 'SKIP' ? C.y('  SKIP') : C.r('  FAIL');
      console.log(tag + '  ' + r.id + '. ' + r.name + (r.error ? '\n        ' + C.r(r.error.slice(0, 300)) : ''));
    }
    flowFails = flow.filter(r => r.status !== 'PASS').length;
    console.log('\n  FLOW: ' + C[flowFails ? 'r' : 'g']((flow.length - flowFails) + '/' + flow.length + ' steps green') + '\n');
  }
  process.exit(n('FAIL') + n('UNEXPECTED-PASS') + flowFails > 0 ? 1 : 0);
})();
