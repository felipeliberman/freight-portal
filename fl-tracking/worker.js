/**
 * Freight and Logistics, Inc. — Shipment Tracking Worker
 *
 * Calls ShipPrimus's public tracking endpoint server-side.
 * Returns ONLY status data — shipper, consignee, addresses, contacts, PII are NEVER included.
 * The customer code lives here on the server, never in the browser.
 */

const CUSTOMER = 'Shippi'; // your ShipPrimus customer code — update if changed

export default {
  async fetch(request) {

    // Reflect requesting origin so file://, localhost, and the live site all work
    const origin = request.headers.get('Origin') || '*';
    const CORS = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Content-Type': 'application/json; charset=utf-8',
      'Vary': 'Origin',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: CORS });

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Input validation: digits only, sane length
    const url = new URL(request.url);
    const bol = (url.searchParams.get('bol') || '').replace(/\D/g, '');
    if (!bol || bol.length < 4 || bol.length > 20) {
      return json({ found: false, error: 'invalid_number' }, 400);
    }

    // Call ShipPrimus tracking server-side — never exposed to browser
    const trackUrl =
      'https://shipprimus.com/tracking.php?format=json' +
      '&customer=' + encodeURIComponent(CUSTOMER) +
      '&trackingNumber=' + encodeURIComponent(bol);

    let data;
    try {
      const res = await fetch(trackUrl);
      if (!res.ok) throw new Error('upstream');
      data = await res.json();
    } catch {
      return json({ found: false, error: 'upstream_error' });
    }

    const r = data?.Result;
    if (!r || !r.TrackingInformation?.length) {
      return json({ found: false });
    }

    // PII-free response — Shipper/Consignee/ThirdParty/FreightInformation intentionally excluded
    const events = r.TrackingInformation.map(row => ({
      status:  row.Item?.Status  || '',
      remarks: row.Item?.Remarks || '',
      date:    row.Item?.date    || '',
      time:    row.Item?.time    || '',
      code:    row.Item?.Code    || '',
    }));

    const latest    = events[0] || {};
    const delivered = latest.code === 'DLV' || /deliver/i.test(latest.status || '');

    return json({
      found:     true,
      bol:       r.BOL                   || bol,
      carrier:   r.Carrier?.CarrierName  || '',
      service:   r.Carrier?.ServiceLevel || '',
      status:    latest.status           || 'Status unavailable',
      delivered,
      events,
    });
  },
};
