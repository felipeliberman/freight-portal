/**
 * Wire-level regression test (commit 1: schemas + handlers): the AGENT booking path
 * carries hazmat (UN / packing group / emergency contact) into the Primus POST as
 * STRUCTURED fields — REAL CODE. Two scenarios:
 *
 *   A) PANEL PATH — _execUpdateBooking(hazmat fields) -> _applyBookingFields writes the
 *      #bk-haz-* panel fields -> _execBookShipment harvests them -> POST /applet/v1/book.
 *      Asserts the panel fields populate AND the wire body carries the structured fields.
 *
 *   B) DIRECT BOOK — _execBookShipment(hazmat fields) with NO prior update_booking and no
 *      open panel. Guards the `|| input.X` fallback in the hazmat normalization (a direct
 *      book_shipment call must still land structured). Wire assertions only (no panel).
 *
 * ASSERTIONS (intercepted POST body, both scenarios):
 *   lineItems[0].UN === '1993', lineItems[0].UNPKGGroup === 'III',
 *   emergencyContact === 'TEST CONTACT', emergencyPhone === '800-555-0100',
 *   UN absent from BOLInstructions, UN absent from specialInstructions.
 *   Scenario A additionally: #bk-haz-un.value/dataset.unPg + #bk-haz-contact/#bk-haz-phone populated.
 *
 * Against current commit (85a68b7): the booking tools have no hazmat schema fields,
 * _applyBookingFields never writes #bk-haz-*, and _execBookShipment never maps them ->
 * assertions fail. After the fix: pass.
 *
 * STUBS: fetch (login/geocodio/rate-save fixtures + /applet/v1/book capture), alert,
 * UI-chrome no-ops. openRightPanel runs for real so the panel mounts in the document.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const PORTAL_PATH = process.argv[2] || path.join(__dirname, 'portal.html');

function extractAppScript(html){
  const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/g) || [];
  let largest=''; for(const b of blocks){const i=b.replace(/<script\b[^>]*>/,'').replace(/<\/script>$/,''); if(i.length>largest.length)largest=i;}
  return largest;
}
function makeRes(b,ok=true,s=200){const t=typeof b==='string'?b:JSON.stringify(b);return{ok,status:s,json:async()=>JSON.parse(t),text:async()=>t};}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function buildWindow(scriptText){
  const vc=new VirtualConsole(); vc.on('jsdomError',()=>{});
  const dom=new JSDOM('<!DOCTYPE html><html><body><div id="main"></div></body></html>',
    { runScripts:'outside-only', pretendToBeVisual:true, url:'https://portal.test/', virtualConsole:vc });
  const win=dom.window; win.alert=()=>{};
  let book=null;
  win.fetch=async(url,opts)=>{
    const u=String(url); const m=(opts&&opts.method)||'GET';
    if(u.includes('/api/v1/login'))            return makeRes({data:{accessToken:'t'}});
    if(u.includes('api.zippopotam.us'))        return makeRes({places:[{'place name':'Dallas','state abbreviation':'TX'}]});
    if(u.includes('api.geocod.io'))            return makeRes({results:[{fields:{zip4:{residential:false}}}]});
    if(u.includes('/applet/v1/rate/save'))     return makeRes({data:{quoteNumber:'Q1'}});
    if(u.includes('/api/v1/database/untable')) return makeRes({data:{results:[{UNNumber:'1993',description:'Paint',HAZClass:'3',PKGGroup:'III'}]}});
    if(u.includes('/applet/v1/book')&&(m==='POST'||m==='PUT')){ if(book===null){ try{book=JSON.parse(opts.body);}catch(e){book={_raw:opts.body};} } return makeRes({data:{results:[{BOLId:'TEST-BOL',BOLNmbr:'BOL1',documents:[]}]}}); }
    return makeRes({},true,200);
  };
  win.eval(scriptText + '\n;currentCustomer={primusCustomerId:1123086640};primusToken="t";primusExpiry=Date.now()+3600000;');
  ['appendMessage','showTyping','removeTyping','showChatArea','addRecent','applyDefaultCommodity','applyDefaultAccessorials','showShipmentSavedModal','lookupZipCity','flashField'].forEach(fn=>win[fn]=()=>{});
  return { win, getBook:()=>book };
}

const SHIPMENT = { originZip:'90660', destinationZip:'75201', originCity:'Pico Rivera', originState:'CA',
  destinationCity:'Dallas', destinationState:'TX', originCountry:'US', destinationCountry:'US', accessorials:['RSD'],
  items:[{ pieces:1, weight:500, length:48, width:48, height:48, packageType:'PLT', freightClass:'85', description:'Paint, flammable', hazmat:true, stackAmount:1 }] };
const RATE = { id:'R1', rateId:'R1', name:'Estes Express', rateType:'LTL', billTo:{ total:441 } };
const SHIPPER = { name:'Acme Origin LLC', address:'7240 Crider Ave', city:'Pico Rivera', state:'CA', contact:'Joe Shipper', phone:'5625551000' };
const CONSIGNEE = { name:'Haynes Brothers Furniture', address:'1100 Commerce St', city:'Dallas', state:'TX', contact:'Jane Consignee', phone:'2145552000' };
const HAZ = { unNumber:'1993', packingGroup:'III', emergencyContactName:'TEST CONTACT', emergencyPhone:'800-555-0100' };

function seed(win){ win._lastRatesRaw=[RATE]; win._lastRatesShipment=SHIPMENT; win._bookingLock=null; win._lastBooked=null; win._bookingPanelOpen=false; win._resWarnShown=true; }

// Scenario A — agent opens panel via update_booking, then books.
async function runPanel(scriptText){
  const { win, getBook } = buildWindow(scriptText); seed(win);
  win._execUpdateBooking(Object.assign({ rank:1, shipper:SHIPPER, consignee:CONSIGNEE, pickupDate:'2026-07-06', pickupOpen:'09:00', pickupClose:'17:00' }, HAZ));
  await sleep(600); // _execUpdateBooking schedules _applyBookingFields at +400ms
  const g=id=>win.document.getElementById(id);
  const panel={ un:(g('bk-haz-un')||{}).value, pg:((g('bk-haz-un')||{dataset:{}}).dataset||{}).unPg, contact:(g('bk-haz-contact')||{}).value, phone:(g('bk-haz-phone')||{}).value };
  await win._execBookShipment({ rank:1 }); // panel open -> hazmat harvested
  await sleep(200);
  return { panel, body:getBook() };
}

// Scenario B — agent calls book_shipment directly with hazmat fields (no panel).
async function runDirect(scriptText){
  const { win, getBook } = buildWindow(scriptText); seed(win);
  await win._execBookShipment(Object.assign({ rank:1, shipper:SHIPPER, consignee:CONSIGNEE, pickupDate:'2026-07-06', pickupOpen:'09:00', pickupClose:'17:00' }, HAZ));
  await sleep(200);
  return { body:getBook() };
}

let pass=0, fail=0;
function eq(label,a,b){ const ok=a===b; console.log('   '+(ok?'✅ PASS':'❌ FAIL')+' — '+label); if(!ok)console.log('      expected '+JSON.stringify(b)+'  got '+JSON.stringify(a)); ok?pass++:fail++; }
function tru(label,c,d){ const ok=c===true; console.log('   '+(ok?'✅ PASS':'❌ FAIL')+' — '+label); if(!ok&&d)console.log('      '+d); ok?pass++:fail++; }
function wireAsserts(prefix, body){
  if(!body){ console.log('   ❌ FAIL — '+prefix+': no /applet/v1/book POST captured'); fail++; return; }
  const li=(body.lineItems&&body.lineItems[0])||{};
  console.log('   lineItems[0]:', JSON.stringify(li));
  console.log('   emergencyContact/Phone:', JSON.stringify(body.emergencyContact), JSON.stringify(body.emergencyPhone));
  console.log('   BOLInstructions:', JSON.stringify(body.BOLInstructions), '| specialInstructions:', JSON.stringify(body.specialInstructions));
  eq(prefix+' lineItems[0].UN', li.UN, '1993');
  eq(prefix+' lineItems[0].UNPKGGroup', li.UNPKGGroup, 'III');
  eq(prefix+' emergencyContact', body.emergencyContact, 'TEST CONTACT');
  eq(prefix+' emergencyPhone', body.emergencyPhone, '800-555-0100');
  const bol=typeof body.BOLInstructions==='string'?body.BOLInstructions:'';
  tru(prefix+' BOLInstructions HAS UN + class', bol.indexOf('UN1993')!==-1 && /class\s*3\b/i.test(bol), 'BOLInstructions: '+JSON.stringify(body.BOLInstructions));
  tru(prefix+' BOLInstructions has NO emergency contact (Primus renders the structured fields itself)', bol.indexOf('TEST CONTACT')===-1 && bol.indexOf('800-555-0100')===-1 && !/emergency/i.test(bol), 'BOLInstructions: '+JSON.stringify(body.BOLInstructions));
}

(async()=>{
  console.log('=== WIRE TEST (REAL CODE): agent booking path carries hazmat to Primus ===');
  console.log('Portal file:', PORTAL_PATH);
  const scriptText=extractAppScript(fs.readFileSync(PORTAL_PATH,'utf8'));
  console.log('App script extracted:', scriptText.length, 'chars\n');

  console.log('── Scenario A: panel path (update_booking -> book_shipment) ──');
  const A = await runPanel(scriptText);
  console.log('   panel hazmat fields:', JSON.stringify(A.panel));
  eq('A-P1: #bk-haz-un value', A.panel.un, '1993');
  eq('A-P2: #bk-haz-un dataset.unPg', A.panel.pg, 'III');
  eq('A-P3: #bk-haz-contact value', A.panel.contact, 'TEST CONTACT');
  eq('A-P4: #bk-haz-phone value', A.panel.phone, '800-555-0100');
  wireAsserts('A-W:', A.body);

  console.log('\n── Scenario B: direct book_shipment (no panel, || input.X fallback) ──');
  const B = await runDirect(scriptText);
  wireAsserts('B-W:', B.body);

  console.log('\n=== RESULTS ===');
  console.log('PASS:', pass, '  FAIL:', fail);
  process.exit(fail===0?0:1);
})().catch(e=>{ console.error('HARNESS ERROR:', e&&e.stack||e); process.exit(2); });
