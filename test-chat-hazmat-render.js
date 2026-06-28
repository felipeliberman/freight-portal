/**
 * Render-state regression test: the booking form's Hazardous Material section
 * renders when a hazmat quote is booked via the TWO non-form openers — REAL CODE.
 *
 * RULE-4 ADAPTATION (approved): opening the booking panel emits NO outbound API
 * request — the defect is pure client-side rendering. So this test asserts on real
 * runtime state + the rendered DOM instead of an intercepted wire body:
 *   after the opener runs, lastQuotedShipment.items[0].hazmat === true AND
 *   document.getElementById('bk-haz-un') exists.
 *
 * Two openers, both of which built shipData.lineItems WITHOUT hazmat (the bug):
 *   S1  _execUpdateBooking         (agent / chat "update_booking" path, portal.html:9682)
 *   S2  Rate-Saved modal "Book"    (#qt-conf-book onclick, portal.html:14918)
 *
 * Each drives REAL portal functions:
 *   S1: real _publishRatesForAI (upstream sync) -> real _execUpdateBooking -> showBookingPanel
 *   S2: real showQuoteForm -> fill + check .li-haz -> real _doGetRates (renders the rate
 *       rows) -> click the real .qt-save-rate-btn -> click the real #qt-conf-book -> showBookingPanel
 *
 * Against broken d9bebda: both fail (hazmat=false, #bk-haz-un null).
 * Against fixed:          both pass.
 *
 * STUBS (external boundaries / UI chrome only — no logic under test is replaced):
 * fetch (login/zip/geocodio/rate-multiple/rate-save fixtures), alert, UI-chrome no-ops,
 * openRightPanel shimmed to attach the real container to document. Auth + rpState +
 * a lastQuotedShipment accessor are appended into the script's eval as test scaffolding.
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
function makeRes(body, ok=true, status=200){ const t=typeof body==='string'?body:JSON.stringify(body); return { ok, status, json:async()=>JSON.parse(t), text:async()=>t }; }
const sleep = ms => new Promise(r=>setTimeout(r,ms));

function buildWindow(scriptText){
  const vc=new VirtualConsole(); vc.on('jsdomError',()=>{});
  const dom=new JSDOM('<!DOCTYPE html><html><body><div id="main"></div><div id="welcome"></div><div id="chat-area"></div></body></html>',
    { runScripts:'outside-only', pretendToBeVisual:true, url:'https://portal.test/', virtualConsole:vc });
  const win=dom.window; win.alert=()=>{};
  win.fetch = async (url)=>{
    const u=String(url);
    if(u.includes('/api/v1/login'))            return makeRes({ data:{ accessToken:'t' } });
    if(u.includes('api.zippopotam.us'))        return makeRes({ places:[{ 'place name':'Los Angeles','state abbreviation':'CA' }] });
    if(u.includes('api.geocod.io'))            return makeRes({ results:[] });
    if(u.includes('/applet/v1/rate/save'))     return makeRes({ data:{ quoteNumber:'Q1' } });
    if(u.includes('/applet/v1/rate/multiple')) return makeRes({ data:{ results:{ rates:[ { id:'R1', rateId:'R1', name:'Estes Express', SCAC:'EXLA', rateType:'LTL', transitDays:3, serviceLevel:'LTL', billTo:{ total:441 }, total:441 } ] } } });
    return makeRes({}, true, 200);
  };
  const seed = '\n;currentCustomer={primusCustomerId:1123086640};primusToken="t";primusExpiry=Date.now()+3600000;'
             + 'window.__rpState=(typeof rpState!=="undefined")?rpState:null;'
             + 'window.__lqs=function(){return (typeof lastQuotedShipment!=="undefined")?lastQuotedShipment:null;};';
  win.eval(scriptText + seed);
  ['appendMessage','showTyping','removeTyping','showChatArea','addRecent','applyDefaultCommodity','applyDefaultAccessorials','showShipmentSavedModal','lookupZipCity','flashField'].forEach(fn=>{ win[fn]=()=>{}; });
  // openRightPanel is NOT stubbed — it runs for real so the quote tab lands in
  // rpState.tabs and the active panel (quote, then booking) mounts under #rp-body in
  // the document, where getElementById('bk-haz-un') resolves.
  return win;
}
function getQuoteContainer(win){
  const st=win.__rpState; const tab=st&&st.tabs&&st.tabs.find(t=>t.title==='Get a Quote');
  return tab&&tab.el;
}

// ── S1: chat path (_execUpdateBooking) ─────────────────────────────────────────
async function scenarioChat(scriptText){
  const win=buildWindow(scriptText);
  const shipment={ originZip:'90660', destinationZip:'90035', originCity:'Pico Rivera', originState:'CA',
    destinationCity:'Los Angeles', destinationState:'CA', accessorials:[],
    items:[{ pieces:1, weight:100, length:48, width:48, height:48, packageType:'PLT', freightClass:'70', description:'Plastic articles', hazmat:true, unNumber:'3480', stackAmount:1 }] };
  const rate={ id:'R1', rateId:'R1', name:'Estes Express', rateType:'LTL', billTo:{ total:441 } };
  win._publishRatesForAI([rate], shipment);
  win._lastRatesRaw=[rate]; win._lastRatesShipment=shipment; win._bookingLock=null; win._bookingPanelOpen=false;
  win._execUpdateBooking({ rank:1 });
  await sleep(120);
  const lqs=win.__lqs();
  return { haz: !!(lqs&&lqs.items&&lqs.items[0]&&lqs.items[0].hazmat===true), el: !!win.document.getElementById('bk-haz-un') };
}

// ── S2: Rate-Saved modal "Book Shipment" (#qt-conf-book) ───────────────────────
async function scenarioModal(scriptText){
  const win=buildWindow(scriptText);
  win.showQuoteForm();
  await sleep(60);
  const c=getQuoteContainer(win);
  if(!c) throw new Error('quote container not found');
  const set=(sel,v)=>{ const e=c.querySelector(sel); if(e){ e.value=String(v); } };
  set('#qt-origin','90660'); set('#qt-dest','90035');
  const row=c.querySelector('.qt-line');
  if(row){ const si=(s,v)=>{const e=row.querySelector(s); if(e)e.value=String(v);};
    si('.li-qty','1'); si('.li-weight','100'); si('.li-len','48'); si('.li-wid','48'); si('.li-hgt','48');
    si('.li-commodity','Plastic articles');
    const haz=row.querySelector('.li-haz'); if(haz){ haz.checked=true; haz.dispatchEvent(new win.Event('change',{bubbles:true})); }
  }
  await win._doGetRates();
  await sleep(250);
  const saveBtn=c.querySelector('.qt-save-rate-btn');
  if(!saveBtn) throw new Error('rate row save button not rendered');
  await saveBtn.onclick();
  await sleep(150);
  const bookBtn=win.document.getElementById('qt-conf-book');
  if(!bookBtn) throw new Error('Rate-Saved modal Book button not present');
  bookBtn.onclick();
  await sleep(150);
  const lqs=win.__lqs();
  return { haz: !!(lqs&&lqs.items&&lqs.items[0]&&lqs.items[0].hazmat===true), el: !!win.document.getElementById('bk-haz-un') };
}

let pass=0, fail=0;
function check(label, cond){ const ok=cond===true; console.log('   '+(ok?'✅ PASS':'❌ FAIL')+' — '+label); ok?pass++:fail++; }

(async()=>{
  console.log('=== RENDER-STATE TEST (REAL CODE): hazmat section on chat/modal booking openers ===');
  console.log('Portal file:', PORTAL_PATH);
  const html=fs.readFileSync(PORTAL_PATH,'utf8');
  const scriptText=extractAppScript(html);
  console.log('App script extracted:', scriptText.length, 'chars\n');

  const s1=await scenarioChat(scriptText);
  console.log('── S1 _execUpdateBooking (chat path) ──');
  console.log('   lastQuotedShipment.items[0].hazmat:', s1.haz, '| #bk-haz-un present:', s1.el);
  check('S1a: hazmat===true after chat book-open', s1.haz);
  check('S1b: #bk-haz-un rendered', s1.el);

  const s2=await scenarioModal(scriptText);
  console.log('\n── S2 Rate-Saved modal "Book Shipment" ──');
  console.log('   lastQuotedShipment.items[0].hazmat:', s2.haz, '| #bk-haz-un present:', s2.el);
  check('S2a: hazmat===true after modal book-open', s2.haz);
  check('S2b: #bk-haz-un rendered', s2.el);

  console.log('\n=== RESULTS ===');
  console.log('PASS:', pass, '  FAIL:', fail);
  process.exit(fail===0?0:1);
})().catch(e=>{ console.error('HARNESS ERROR:', e&&e.stack||e); process.exit(2); });
