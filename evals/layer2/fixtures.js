// Layer-2 fixtures. Haynes Brothers (1123086640) shapes only — never Simply Nursery. All canned;
// nothing here reaches Primus or the model. Rate/geo/book responses live in the harness routes;
// this file holds only data a case reads directly.

// The canonical money regex every customer-facing quote price must satisfy: "$1,234.56".
const MONEY_RE = /^\$\d{1,3}(,\d{3})*\.\d{2}$/;

// Rates chosen to exercise fmtMoney's two hard cases: a 4-digit value (needs a thousands separator)
// and a half-dollar value (needs a trailing zero). 388.10 covers the plain case.
const MONEY_RATES = [
  { id: 'RATE-M1', rateId: 'RATE-M1', name: 'JTS Express',   SCAC: 'JTSX', serviceLevel: 'Standard LTL', transitDays: 4, total: 1145.5, billTo: { total: 1145.5 } },
  { id: 'RATE-M2', rateId: 'RATE-M2', name: 'AAA Cooper',    SCAC: 'AACT', serviceLevel: 'Standard LTL', transitDays: 3, total: 287.5,  billTo: { total: 287.5 } },
  { id: 'RATE-M3', rateId: 'RATE-M3', name: 'Estes Express', SCAC: 'EXLA', serviceLevel: 'Standard LTL', transitDays: 5, total: 388.1,  billTo: { total: 388.1 } },
];

// A ready-to-rate line item (weight + full dims) so _gateRateReadiness().ok is true.
const READY_ITEM = { pieces: 1, weight: 450, length: 48, width: 40, height: 48, commodity: 'furniture', type: 'PLT' };

// Booking-panel party fill used by the re-quote-preservation case (Haynes shapes).
const PARTY_FILL = {
  'bk-pu-name': 'Michaels Furniture', 'bk-pu-street': '7240 Crider Ave', 'bk-pu-city': 'Pico Rivera', 'bk-pu-state': 'CA',
  'bk-pu-contact': 'Juan Ortiz', 'bk-pu-phone': '5625551234', 'bk-pu-ref': 'PO-44821',
  'bk-dl-name': 'Haynes Brothers Furniture', 'bk-dl-street': '1250 Main St', 'bk-dl-city': 'Brandon', 'bk-dl-state': 'FL',
  'bk-dl-contact': 'Rick Haynes', 'bk-dl-phone': '8135559876',
  'bk-special-instructions': 'Call 30 minutes before delivery.',
};

module.exports = { MONEY_RE, MONEY_RATES, READY_ITEM, PARTY_FILL };
