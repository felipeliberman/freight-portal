// Deterministic, parameter-VARYING rate fixture. The whole point of layer 3 is that a
// "price didn't move" bug is detectable — so the fixture must return different option counts
// and prices for different accessorial/dims/lane sets, deterministically (same params → same
// output). No network, no Primus. Parses the /applet/v1/rate/multiple query the app built.

// A small stable carrier pool. Restrictive accessorials shrink the eligible set (fewer carriers
// serve residential/liftgate/limited-access), and each accessorial adds a surcharge — so both the
// COUNT and the PRICE move with the parameter signature.
const CARRIERS = [
  { name: 'JTS Express',   scac: 'JTSX', svc: 'Standard LTL', base: 1.00, transit: 4, resOK: true,  liftOK: true,  laOK: true },
  { name: 'AAA Cooper',    scac: 'AACT', svc: 'Standard LTL', base: 1.06, transit: 3, resOK: true,  liftOK: true,  laOK: false },
  { name: 'Estes Express', scac: 'EXLA', svc: 'Standard LTL', base: 1.14, transit: 5, resOK: true,  liftOK: true,  laOK: true },
  { name: 'Forward Air',   scac: 'FWDA', svc: 'Standard LTL', base: 0.62, transit: 2, resOK: false, liftOK: false, laOK: false },
  { name: 'Saia',          scac: 'SAIA', svc: 'Standard LTL', base: 1.10, transit: 4, resOK: true,  liftOK: false, laOK: true },
  { name: 'R&L Carriers',  scac: 'RLCA', svc: 'Standard LTL', base: 1.02, transit: 4, resOK: true,  liftOK: true,  laOK: true },
  { name: 'XPO',           scac: 'XPOL', svc: 'Standard LTL', base: 1.18, transit: 3, resOK: true,  liftOK: true,  laOK: false },
];

// Per-code surcharge in dollars, applied to every eligible carrier. Values are illustrative but
// STABLE so a given parameter set always prices identically.
const SURCHARGE = { RSD: 55, RSO: 40, LFD: 45, LFO: 45, IND: 60, LAD: 70, LAO: 70, APD: 30, INS: 90, HZM: 120, OVL: 80, SOR: 35, TWO: 65, NBD: 15 };

function parseQuery(url) {
  const qs = (String(url).split('?')[1] || '');
  const out = { accessorials: [], freightInfo: [], originZip: '', destinationZip: '', insuranceAmount: 0 };
  qs.split('&').forEach(kv => {
    const i = kv.indexOf('='); if (i < 0) return;
    const k = kv.slice(0, i), v = decodeURIComponent(kv.slice(i + 1) || '');
    if (k === 'accessorialsList[]') out.accessorials = v.split('|').filter(Boolean);
    else if (k === 'freightInfo') { try { out.freightInfo = JSON.parse(v); } catch (e) {} }
    else if (k === 'originZipcode') out.originZip = v;
    else if (k === 'destinationZipcode') out.destinationZip = v;
    else if (k === 'insuranceAmount') out.insuranceAmount = Number(v) || 0;
  });
  return out;
}

// A cheap deterministic lane factor from the two ZIPs (no randomness).
function laneFactor(o, d) {
  let h = 0; const s = String(o) + '>' + String(d);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 1000;
  return 0.85 + (h / 1000) * 0.6; // 0.85 .. 1.45
}

// Build the rate list for a parsed request. Deterministic.
function ratesFor(q) {
  const codes = new Set(q.accessorials);
  const totalWeight = q.freightInfo.reduce((a, it) => a + (Number(it.weight) || 0) * (Number(it.qty) || 1), 0) || 100;
  const lane = laneFactor(q.originZip, q.destinationZip);
  const weightCost = Math.max(80, totalWeight * 0.9);      // heavier freight costs more
  const surcharge = [...codes].reduce((a, c) => a + (SURCHARGE[c] || 0), 0);

  const eligible = CARRIERS.filter(c =>
    (!codes.has('RSD') && !codes.has('RSO') || c.resOK) &&
    (!codes.has('LFD') && !codes.has('LFO') || c.liftOK) &&
    (!codes.has('LAD') && !codes.has('LAO') || c.laOK)
  );

  const rates = eligible.map(c => {
    const total = Math.round((weightCost * c.base * lane + surcharge) * 100) / 100;
    return { id: 'R-' + c.scac, rateId: 'R-' + c.scac, name: c.name, SCAC: c.scac,
      serviceLevel: c.svc, transitDays: c.transit, total, billTo: { total } };
  }).sort((a, b) => a.total - b.total);

  return rates;
}

// The /rate/multiple route reply used by the harness.
function rateRoute(url) {
  const q = parseQuery(url);
  const rates = ratesFor(q);
  return { status: 200, body: { data: { results: { rates } } } };
}

module.exports = { rateRoute, ratesFor, parseQuery, SURCHARGE };
