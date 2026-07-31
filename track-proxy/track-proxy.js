var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// track-proxy.js
var track_proxy_default = {
  async fetch(request, env) {
    const ALLOW = "*";
    const cors = {
      "Access-Control-Allow-Origin": ALLOW,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    let num = "";
    try {
      const url = new URL(request.url);
      if (request.method === "GET") {
        num = (url.searchParams.get("q") || "").trim();
      } else {
        const ct = request.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const j = await request.json();
          num = String(j.q || j.trackingNumber || "").trim();
        } else {
          const f = await request.formData();
          num = String(f.get("q") || f.get("trackingNumber") || "").trim();
        }
      }
    } catch (e) {
    }
    if (!/^[A-Za-z0-9\-]{4,40}$/.test(num)) {
      return json({ ok: false, error: "Enter a valid BOL, PRO, or reference number." }, 400, cors);
    }
    if (env.RL) {
      const ip = request.headers.get("CF-Connecting-IP") || "anon";
      const key = "trk:" + ip;
      const hits = parseInt(await env.RL.get(key) || "0", 10);
      if (hits >= 60) return json({ ok: false, error: "Too many lookups. Try again shortly." }, 429, cors);
      await env.RL.put(key, String(hits + 1), { expirationTtl: 3600 });
    }
    let raw;
    try {
      const upstream = await fetch("https://portal.freightandlogistics.com/trackShipment.php", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": "https://portal.freightandlogistics.com/"
        },
        body: new URLSearchParams({
          trackingNumber: num,
          format: "json",
          fields: "BOL,shipperRefNumber,carrierRef"
        }).toString()
      });
      raw = await upstream.text();
    } catch (e) {
      return json({ ok: false, error: "Tracking is temporarily unavailable." }, 502, cors);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json({ ok: false, error: "No shipment found for that number." }, 404, cors);
    }
    const R = data && data.Result;
    if (!R || !R.BOL) {
      return json({ ok: false, error: "No shipment found for that number." }, 404, cors);
    }
    const timeline = (Array.isArray(R.TrackingInformation) ? R.TrackingInformation : []).map((t) => t && t.Item).filter(Boolean).filter((i) => String(i.Code || "").trim() !== "NOTE").map((i) => ({
      date: i.date || "",
      time: i.time || "",
      status: String(i.Status || "").trim(),
      remarks: String(i.Remarks || "").trim(),
      code: String(i.Code || "").trim()
    }));
    const current = (timeline[0] || {}).status || "In process";
    const safe = {
      ok: true,
      bol: R.BOL,
      currentStatus: current,
      carrier: R.Carrier && R.Carrier.CarrierName || "",
      scac: R.Carrier && R.Carrier.SCAC || "",
      service: R.Carrier && R.Carrier.ServiceLevel || "",
      origin: [R.Shipper && R.Shipper.City, R.Shipper && R.Shipper.State].filter(Boolean).join(", "),
      destination: [R.Consignee && R.Consignee.City, R.Consignee && R.Consignee.State].filter(Boolean).join(", "),
      pieces: (R.FreightInformation && R.FreightInformation.TotalPieces) ?? null,
      weight: (R.FreightInformation && R.FreightInformation.TotalWeight) ?? null,
      timeline
    };
    return json(safe, 200, cors);
  }
};
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}
__name(json, "json");
export {
  track_proxy_default as default
};
//# sourceMappingURL=track-proxy.js.map