// Canned data for the state harness. NOTHING here touches Primus — the harness must be runnable
// offline, in CI, with no credentials. Shapes mirror what /applet/v1/rate/multiple and
// /applet/v1/book actually return, trimmed to the fields the portal reads.

const RATES = [
  { id: 'RATE-JTS-1',   rateId: 'RATE-JTS-1',   name: 'JTS Express',      SCAC: 'JTSX', serviceLevel: 'Standard LTL',   transitDays: 4, total: 388.10, billTo: { total: 388.10 } },
  { id: 'RATE-AAA-1',   rateId: 'RATE-AAA-1',   name: 'AAA Cooper',       SCAC: 'AACT', serviceLevel: 'Standard LTL',   transitDays: 3, total: 412.35, billTo: { total: 412.35 } },
  { id: 'RATE-ESTES-1', rateId: 'RATE-ESTES-1', name: 'Estes Express',    SCAC: 'EXLA', serviceLevel: 'Standard LTL',   transitDays: 5, total: 441.00, billTo: { total: 441.00 } },
  { id: 'RATE-ESTES-2', rateId: 'RATE-ESTES-2', name: 'Estes Express',    SCAC: 'EXLA', serviceLevel: 'Guaranteed',     transitDays: 3, total: 612.75, billTo: { total: 612.75 } },
];

// A second list for the re-quote/re-key path — same carriers, new ids and prices.
const RATES_REPULL = RATES.map((r, i) => Object.assign({}, r, {
  id: r.id + '-B', rateId: r.rateId + '-B',
  total: r.total + 25, billTo: { total: r.total + 25 },
}));

const SHIPMENT = {
  originZip: '90660', destinationZip: '33511',
  originCity: 'Pico Rivera', originState: 'CA',
  destinationCity: 'Brandon', destinationState: 'FL',
  originCountry: 'US', destinationCountry: 'US',
  accessorials: ['Residential Delivery', 'Liftgate Delivery', 'Limited Access Delivery', 'Appointment Delivery', 'Cargo Insurance'],
  pickupDate: '2026-07-23',
  items: [{ pieces: 1, weight: 450, length: 48, width: 40, height: 48, packageType: 'PLT', freightClass: '70', description: 'Furniture' }],
};

// A saved BOL as /applet/v1/book returns it — BOLId and BOLNumber deliberately DIFFERENT, which is
// the whole point of resolveBOLId (a Number used as an Id is the 404).
const SAVED_SHIPMENT = {
  BOLId: 'BOLID-778899', BOLNumber: '160135280',
  shipper:   { name: 'Michaels Furniture', address1: '7240 Crider Ave', city: 'Pico Rivera', state: 'CA', zipCode: '90660' },
  consignee: { name: 'Haynes Brothers',    address1: '1250 Main St',    city: 'Brandon',     state: 'FL', zipCode: '33511' },
  freightInfo: [{ qty: 1, weight: 450, length: 48, width: 40, height: 48, dimType: 'PLT', class: '70', commodity: 'Furniture' }],
  accessorials: ['Residential Delivery', 'Liftgate Delivery'],
  pickupInformation: { date: '2026-07-23' },
  accountingInformation: { invoiceAmount: 388.10 },
  vendor: { name: 'JTS Express', cost: 388.10 },
};

module.exports = { RATES, RATES_REPULL, SHIPMENT, SAVED_SHIPMENT };
