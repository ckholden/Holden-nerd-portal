/* HoldenDMR in-app Last Heard + Map (build hd2.3, 2026-11-03).
   index.html loads this file the first time the Heard tab shows Last Heard or Map, so the Talk screen never pays for it.
   Data: one GET of dmrfeed /snapshot every 15 s, only while one of those two views is on screen. Not the SSE stream:
   that re-sends every feed in full every 3-5 s (~55 MB an hour on a phone's data plan) and holds one of dmrfeed's 16
   viewer slots for as long as the app is open. A snapshot is ~55 KB and holds nothing.
   Read-only: no Firebase database reads or writes at all (the web board's catalog/net/watch writes are left out).
   Blocks marked "board" are copied unchanged from /svr/dmr/index.html, so the two screens agree on ages, merging and
   pin placement; the build script that copies them is in the session notes. Everything else is written for the phone.
   2026-11-10: a fourth feed, TGIF (dmrfeed's `tgif`, the bm envelope and rows). It has no Listen button: listenId()
   is BrandMeister only, because tuning a bridge to a talkgroup keys it up on the air. */
(function(){
var FEED='https://kj7dts-server.tail34c6a5.ts.net/dmrfeed', POLL_MS=15000, MAX_ROWS=60;
var feeds={hs:null,net:null,bm:null,tgif:null};
var src='net'; try{   // PNW first, as on the web board: it is the family's home network and frames the map on the Northwest
  var _s=localStorage.getItem('hd2_lhsrc'); if(_s==='all'||_s==='net'||_s==='bm'||_s==='tgif'||_s==='hs')src=_s; }catch(e){}
// one talkgroup (canonical key) picked from a "last 60 min" chip, or null. Kept in memory only: a filter saved across
// launches is what silently emptied the web board on 2026-08-09, and on a phone nobody would know it was still on.
var tgFilter=null, tgName='', query='';
var view=null;                       // 'lh' | 'map' while one is on screen, null otherwise
var pollT=null, inFlight=false, lastOk=0, lastErr=null, fails=0, n401=0, denied=false, skewMs=0;
var FETCH_MS=12000;                  // a stuck Funnel connection is given up on, so the screen can say so
// "Keep screen awake" means a phone left on this view never goes to the background: after 10 min with no touch the
// updates pause (a snapshot every 15 s is ~13 MB an hour) until the next tap. A touch or scroll also holds a poll
// redraw for 3 s (holdAt), so a row or chip doesn't move out from under a finger that is about to tap it.
var IDLE_MS=600000, HOLD_MS=3000, lastTouch=Date.now(), holdAt=0, paused=false, waking=false, wakeDraw=false, renderT=null, wakeT=null, lastRenderAt=0;
// a feed (hs/net/bm/tgif) or a redraw that tripped the code: said on screen, not hidden, and only on the networks it affects
var badFeeds={}, renderErr=false, lastNoBm=null;
var COARSE=false; try{ COARSE=matchMedia('(pointer: coarse)').matches; }catch(e){}   // a finger: 44 px tap boxes, pins kept apart
var placeMode='rep';                 // pin at the repeater site first (the board's default); the phone has no toggle
var mapObj=null, mapMk=[], tileLyr=null, userMoved=false, mapFocusPlace=null, mapOpen=false, leafletState=0, leafletFailAt=0;
var shownRows=[], lastC={all:[],hidden:0}, stripSrc=null;
function $id(i){ return document.getElementById(i); }
function el(tag,cls,txt){ var e=document.createElement(tag); if(cls)e.className=cls; if(txt!=null)e.textContent=txt; return e; }
// phone clock minus server clock, measured on every snapshot: row ages are read on the server's clock, so a phone whose
// clock is a minute off still shows "just now" for someone who just unkeyed.
function srvNow(){ return Date.now()-skewMs; }

/* ---------- board: helpers, normalising, merging, sorting ---------- */
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function arr(v){return Array.isArray(v)?v:(v?Object.values(v):[]);}
function normHS(d){d=d||{};return arr(d.lh).map(function(r){return {t:r.t||'',call:(r.call||'').toUpperCase(),name:r.name||'',loc:r.loc||'',tg:r.tgname||r.tg||'',tgid:r.tgid||'',rep:'',src:'hs',dmrid:r.dmrid||'',cnt:1,now:!!r.now};});}
function normNET(d){d=d||{};return arr(d.rows).map(function(r){return {t:r.t||'',call:(r.call||'').toUpperCase(),name:r.name||'',loc:r.qth||'',tg:r.tg||'',tgid:'',rep:r.rep||'',site:r.site||'',src:'net',dmrid:r.dmrid||'',cnt:r.cnt||1,now:!!r.now};});}
function normBM(d){d=d||{};return arr(d.rows).map(function(r){return {t:r.t||'',startEpoch:_epochOrNull(r.startEpoch),call:(r.call||'').toUpperCase(),name:r.name||'',loc:r.qth||'',tg:r.tg||'',tgid:r.tgid||'',rep:r.rep||'',site:r.site||'',src:'bm',dmrid:r.dmrid||'',cnt:r.cnt||1,now:!!r.now};});}   // startEpoch = the session start as a real unix time (seconds); rowAgeSec() prefers it over the `t` clock string
function normTGIF(d){d=d||{};return arr(d.rows).filter(function(r){return r&&typeof r==='object';}).map(function(r){return {t:r.t||'',startEpoch:_epochOrNull(r.startEpoch),call:String(r.call||'').toUpperCase(),name:r.name||'',loc:r.qth||'',tg:r.tg||'',tgid:r.tgid||'',rep:r.rep||'',site:r.site||'',src:'tgif',dmrid:r.dmrid||'',cnt:r.cnt||1,now:!!r.now};});}   // TGIF (dmrfeed only, no Firebase copy): the bm row shape, site "TGIF", or "TGIF-BRIDGE" for HOLDEN1 heard by our own bridge. A row that isn't an object is skipped, so the newest feed can't blank the other three
function tgCanon(r){if(r.tgid)return 'n'+r.tgid;var n=bmOf(r.tg);if(n)return 'n'+n;return 't'+String(r.tg||'').toLowerCase().trim();}
function stationCanon(r){if(r.dmrid)return 'id'+r.dmrid;if(r.call&&/^\d{4,9}$/.test(r.call))return 'id'+r.call;return r.call?'c'+r.call:'';}
function keyOf(r){return (stationCanon(r)||'?')+'|'+tgCanon(r);}
function sysOf(r){if(r.src==='tgif')return['TGIF','tgif','TGIF'];if(r.src==='hs')return['HS','hs','Hotspot'];var rep=r.rep||'',site=r.site||'';if(/bm/i.test(rep)&&/sourc/i.test(rep))return['BM','bm','BrandMeister'];if(/-bm-|^bm/i.test(site))return['BM','bm','BrandMeister'];if(/^pnw/i.test(site))return['PNW','pnw','PNWDigital'+(site!=='PNW'?' ('+site+')':'')];if(site)return[site.length>11?site.slice(0,11):site,'oth',site];return['PNW','pnw','PNWDigital'];}
function merged(){
  var hs=normHS(feeds.hs), net=normNET(feeds.net), tgif=normTGIF(feeds.tgif), bm=normBM(feeds.bm), list, nowMs=srvNow();   // app: the server clock, as every age shown
  if(src==='hs') list=hs;
  else if(src==='net') list=net;
  else if(src==='bm') list=bm;
  else if(src==='tgif') list=tgif;
  else { var seen={}; list=[]; net.concat(hs,bm,tgif).forEach(function(r){var k=keyOf(r); var ex=seen[k];
    if(ex){ ex.both=true; if(ex.srcs.indexOf(r.src)<0)ex.srcs.push(r.src);
      if((!ex.call||/^\d+$/.test(ex.call))&&r.call&&!/^\d+$/.test(r.call)){ex.call=r.call;if(r.name)ex.name=r.name;if(r.loc)ex.loc=r.loc;}   // a bare numeric "call" is really an unresolved ID that leaked through -- prefer whichever source actually named the station
      var _ae=rowAgeAt(ex,nowMs),_ar=rowAgeAt(r,nowMs);
      if(_ar!=null&&(_ae==null||_ar<_ae)){ex.t=r.t;ex.startEpoch=r.startEpoch;}   // the union row is as young as its youngest source: carry that source's time, so the Time shown, the sort and the recent/stale tint all agree
      return; }
    var r2=Object.assign({},r); r2.srcs=[r.src]; seen[k]=r2; list.push(r2);}); }   // 4-way union (PNW+Hotspot+BrandMeister+TGIF, TGIF last so a BM row keeps its BM fields) on canonical station+talkgroup identity; first source seen for a station keeps its richer fields, .srcs tracks every network it was actually heard on
  return sortByAge(list,nowMs);
}
// Newest first by real age, not by the text of `t`. A text sort put 00:05 below 23:58 after midnight and
// ranked BM by a clock string when BM carries a real epoch. One `now` for the whole sort keeps the order
// consistent; rows whose time can't be read sink to the bottom in feed order.
function sortByAge(list,nowMs){
  var k=list.map(function(r,i){return {r:r,a:rowAgeAt(r,nowMs),i:i};});
  k.sort(function(x,y){
    if(x.a==null||y.a==null)return (x.a==null)-(y.a==null)||x.i-y.i;
    return (x.a-y.a)||(x.i-y.i);
  });
  return k.map(function(e){return e.r;});
}
function activeOnline(){var h=feeds.hs,n=feeds.net,b=feeds.bm,g=feeds.tgif;if(src==='hs')return h?h.online!==false:null;if(src==='net')return n?n.online!==false:null;if(src==='bm')return b?b.online!==false:null;if(src==='tgif')return g?g.online!==false:null;return ((h&&h.online!==false)||(n&&n.online!==false));}

/* ---------- board: feed freshness (arrival vs content change vs bm true age) ---------- */
// The web board keeps its own copy under dmrFeedSeen; this app keeps a separate one (same origin, different page).
var SEEN_KEY='hd2_lhseen', _feedSeen={};
try{ var _fsRaw=JSON.parse(localStorage.getItem(SEEN_KEY)||'{}');
  Object.keys(_fsRaw).forEach(function(k){ _feedSeen[k]={at:0,sig:_fsRaw[k].sig,changedAt:_fsRaw[k].changedAt}; }); }catch(e){ _feedSeen={}; }
function _contentAgeSec(name, val){
  if(name !== 'bm' && name !== 'tgif') return null;
  var rows = (val && val.rows) || [], ts = val && val.ts;
  if(!rows.length || !ts) return null;
  // Use startEpoch -- a REAL unix timestamp present on every bm row (measured 2026-08-10).
  // This removes clock-string parsing entirely, which kills three bug classes at once:
  // timezone ambiguity, midnight wrap, and the start-vs-stop ordering trap below.
  //
  // ⚠ Why rows[0] must never be trusted here: bm rows ARE newest-first, but ordered by
  // when the row last CHANGED (Session-Stop), while `t` displays the session START. A
  // transmission that began 20 min ago and just ended sits at the top showing a 20-minute
  // -old start time. That is what told Christian "BrandMeister has stalled" on a feed
  // that was 28 s fresh. pnw never shows it because its keyups are short (start ~= end).
  var live = false, newest = null, i, se;
  for(i = 0; i < rows.length; i++){
    if(rows[i] && rows[i].now) live = true;              // authoritative Session-Start, still keyed
    se = rows[i] && rows[i].startEpoch;
    if(typeof se === 'number' && isFinite(se) && (newest === null || se > newest)) newest = se;
  }
  if(live) return 0;                                     // someone is on air right now
  if(newest !== null) return Math.max(0, ts - newest);

  // Fallback only if a future collector drops startEpoch: scan every row's clock string
  // and take the smallest age. Still order-independent. The row clocks are Pacific, so the
  // publish time is read on the Pacific clock too (pacSecOfDay, next to rowAgeSec()).
  var pubSec = pacSecOfDay(ts * 1000);
  var best = null;
  for(i = 0; i < rows.length; i++){
    var m = String(rows[i].t || '').match(/^(\d{1,2}):(\d{2}):(\d{2})/);
    if(!m) continue;
    var age = pubSec - ((+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]));
    if(age < -120) age += 86400;    // row heard before Pacific midnight, published after it
    if(age < 0) age = 0;
    if(best === null || age < best) best = age;
  }
  return best;
}

var STALL_MS = 15 * 60 * 1000;      // nothing arrived at all -> transport problem
var QUIET_MS = 30 * 60 * 1000;      // arriving but unchanged -> plausibly just a quiet band
var FROZEN_MS = 3 * 60 * 60 * 1000; // unchanged for hours -> almost certainly stalled upstream

function _feedSig(val){
  try{
    var rows = (val && (val.rows || val.lh)) || [];
    if(!rows.length) return 'empty';
    // ⚠ Order-INDEPENDENT on purpose. Keying on rows[0] meant that when a stable old row
    // sat at index 0 (which `bm` does -- its rows are not sorted newest-first), the
    // signature never changed even as new traffic arrived behind it. changedAt then froze
    // at first sighting and the banner escalated on a perfectly healthy feed. Hash every
    // row's identity, sorted, so ANY new or departed row moves the signature.
    var parts = [];
    for(var i = 0; i < rows.length; i++) parts.push((rows[i].t || '') + '~' + (rows[i].call || ''));
    parts.sort();
    var s = parts.join(','), h = 0;
    for(var j = 0; j < s.length; j++) h = (h * 31 + s.charCodeAt(j)) | 0;
    return rows.length + '|' + h;
  }catch(e){ return 'err'; }
}

function _relMin(ms){
  var m = Math.floor(ms / 60000);
  if(m < 60) return m + ' min';
  var h = Math.floor(m / 60);
  return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
}

/* ---------- board: map tables (state, city, PNW tower and country centroids) and placement ---------- */
var STCEN={AL:[32.8,-86.8],AK:[63.5,-152.0],AZ:[34.2,-111.7],AR:[34.9,-92.4],CA:[37.2,-119.3],CO:[39.0,-105.5],CT:[41.6,-72.7],DE:[39.0,-75.5],DC:[38.9,-77.0],FL:[28.6,-82.4],GA:[32.6,-83.4],HI:[20.5,-156.4],ID:[44.4,-114.6],IL:[40.0,-89.2],IN:[39.9,-86.3],IA:[42.0,-93.5],KS:[38.5,-98.4],KY:[37.5,-85.3],LA:[31.0,-92.0],ME:[45.4,-69.2],MD:[39.0,-76.8],MA:[42.3,-71.8],MI:[44.3,-85.4],MN:[46.3,-94.3],MS:[32.7,-89.7],MO:[38.4,-92.5],MT:[46.9,-110.0],NE:[41.5,-99.8],NV:[39.3,-116.6],NH:[43.7,-71.6],NJ:[40.2,-74.7],NM:[34.4,-106.1],NY:[42.9,-75.5],NC:[35.6,-79.4],ND:[47.5,-100.5],OH:[40.3,-82.8],OK:[35.6,-97.5],OR:[44.0,-120.5],PA:[40.9,-77.8],RI:[41.7,-71.5],SC:[33.9,-80.9],SD:[44.4,-100.2],TN:[35.9,-86.4],TX:[31.5,-99.3],UT:[39.3,-111.7],VT:[44.1,-72.7],VA:[37.5,-78.9],WA:[47.4,-120.4],WV:[38.6,-80.6],WI:[44.6,-90.0],WY:[43.0,-107.6],BC:[53.7,-125.0],AB:[54.0,-114.5],SK:[54.0,-106.0],MB:[55.0,-97.0],ON:[50.0,-85.0],QC:[52.0,-72.0],NB:[46.5,-66.0],NS:[45.0,-63.0],PE:[46.4,-63.2],NL:[53.1,-59.0],YT:[63.5,-135.0],NT:[64.0,-119.0],NU:[70.0,-90.0]};
var SYSCOL={hs:'#43d183',pnw:'#4aa3ff',pnwe:'#ab86f2',bm:'#f2ab3c',tgif:'#38c8c8',oth:'#8298ae'};
var ESRI='https://server.arcgisonline.com/ArcGIS/rest/services/';
var BASE_ATTR='Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>';
var BASEMAPS=[
  {k:'voyager',lbl:'🗺️',url:ESRI+'World_Street_Map/MapServer/tile/{z}/{y}/{x}',nz:18},
  {k:'positron',lbl:'◻️',url:ESRI+'Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',ref:ESRI+'Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}',nz:16},
  {k:'dark',lbl:'🌙',url:ESRI+'Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',ref:ESRI+'Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}',nz:16}
];
var CITYLL={
"PORTLAND OR":[45.5152,-122.6784],"GRESHAM OR":[45.5001,-122.4302],"TROUTDALE OR":[45.5393,-122.3873],"CORBETT OR":[45.5318,-122.2912],"SANDY OR":[45.3973,-122.2615],"ESTACADA OR":[45.2887,-122.3340],"BEAVERTON OR":[45.4871,-122.8037],"HILLSBORO OR":[45.5229,-122.9898],"TIGARD OR":[45.4312,-122.7715],"TUALATIN OR":[45.3843,-122.7637],"LAKE OSWEGO OR":[45.4207,-122.6706],"MILWAUKIE OR":[45.4462,-122.6398],"HAPPY VALLEY OR":[45.4468,-122.5645],"CLACKAMAS OR":[45.4090,-122.5701],"OREGON CITY OR":[45.3573,-122.6068],"WILSONVILLE OR":[45.3018,-122.7737],"CANBY OR":[45.2629,-122.6928],"BEAVERCREEK OR":[45.2984,-122.5470],"COLTON OR":[45.1462,-122.4370],"MULINO OR":[45.2170,-122.5820],"BORING OR":[45.4315,-122.3745],"DAMASCUS OR":[45.4165,-122.4520],"EAGLE CREEK OR":[45.3529,-122.3373],"GLADSTONE OR":[45.3801,-122.5943],"AURORA OR":[45.2307,-122.7540],"OTIS OR":[45.0293,-123.9540],"FOREST GROVE OR":[45.5198,-123.1107],"NEWBERG OR":[45.3001,-122.9734],"MCMINNVILLE OR":[45.2101,-123.1987],"WOODBURN OR":[45.1437,-122.8551],"MOLALLA OR":[45.1465,-122.5773],"SILVERTON OR":[45.0051,-122.7834],"MOUNT ANGEL OR":[45.0673,-122.7959],"STAYTON OR":[44.8007,-122.7962],
"SALEM OR":[44.9429,-123.0351],"KEIZER OR":[44.9901,-123.0262],"DALLAS OR":[44.9193,-123.3170],"ALBANY OR":[44.6365,-123.1059],"CORVALLIS OR":[44.5646,-123.2620],"LEBANON OR":[44.5365,-122.9070],"SWEET HOME OR":[44.3976,-122.7362],"EUGENE OR":[44.0521,-123.0868],"SPRINGFIELD OR":[44.0462,-123.0220],"MEDFORD OR":[42.3265,-122.8756],"ASHLAND OR":[42.1946,-122.7095],"GRANTS PASS OR":[42.4390,-123.3284],"ROSEBURG OR":[43.2165,-123.3417],"KLAMATH FALLS OR":[42.2249,-121.7817],"LAKEVIEW OR":[42.1888,-120.3453],
"BEND OR":[44.0582,-121.3153],"REDMOND OR":[44.2726,-121.1739],"PRINEVILLE OR":[44.2999,-120.8345],"POWELL BUTTE OR":[44.2476,-121.0175],"MADRAS OR":[44.6335,-121.1295],"SISTERS OR":[44.2909,-121.5492],"LA PINE OR":[43.6704,-121.5042],"TERREBONNE OR":[44.3529,-121.1778],"CULVER OR":[44.5257,-121.2131],"METOLIUS OR":[44.5846,-121.1781],
"HOOD RIVER OR":[45.7054,-121.5215],"THE DALLES OR":[45.5946,-121.1787],"CASCADE LOCKS OR":[45.6690,-121.8912],"GOVERNMENT CAMP OR":[45.3037,-121.7561],"MT HOOD OR":[45.3037,-121.7561],"BIGGS JUNCTION OR":[45.6698,-120.8328],"PINE HOLLOW OR":[45.2484,-121.2947],
"BOARDMAN OR":[45.8393,-119.7006],"HERMISTON OR":[45.8404,-119.2895],"PENDLETON OR":[45.6721,-118.7886],"LA GRANDE OR":[45.3246,-118.0877],"BAKER CITY OR":[44.7749,-117.8344],"ONTARIO OR":[44.0266,-116.9629],"JOHN DAY OR":[44.4165,-118.9530],"BURNS OR":[43.5865,-119.0541],
"NEWPORT OR":[44.6368,-124.0535],"ASTORIA OR":[46.1879,-123.8313],"SEASIDE OR":[45.9932,-123.9226],"CANNON BEACH OR":[45.8918,-123.9615],"MANZANITA OR":[45.7176,-123.9351],"TILLAMOOK OR":[45.4562,-123.8426],"LINCOLN CITY OR":[44.9582,-124.0179],"FLORENCE OR":[43.9826,-124.0998],"WALDPORT OR":[44.4265,-124.0687],"REEDSPORT OR":[43.7023,-124.0967],"COOS BAY OR":[43.3665,-124.2179],"BANDON OR":[43.1190,-124.4085],"GOLD BEACH OR":[42.4073,-124.4212],"BROOKINGS OR":[42.0526,-124.2840],
"RAINIER OR":[46.0899,-122.9426],"ST HELENS OR":[45.8646,-122.8115],"SCAPPOOSE OR":[45.7548,-122.8779],"COLUMBIA CITY OR":[45.8912,-122.8087],"CLATSKANIE OR":[46.1015,-123.2065],"VERNONIA OR":[45.8590,-123.1926],
"SEATTLE WA":[47.6062,-122.3321],"BELLEVUE WA":[47.6101,-122.2015],"REDMOND WA":[47.6740,-122.1215],"KIRKLAND WA":[47.6769,-122.2060],"RENTON WA":[47.4829,-122.2171],"KENT WA":[47.3809,-122.2348],"AUBURN WA":[47.3073,-122.2285],"FEDERAL WAY WA":[47.3223,-122.3126],"SHORELINE WA":[47.7557,-122.3415],"LYNNWOOD WA":[47.8279,-122.3054],"EVERETT WA":[47.9790,-122.2021],"MARYSVILLE WA":[48.0518,-122.1771],"TULALIP WA":[48.0623,-122.2884],"TACOMA WA":[47.2529,-122.4443],"PUYALLUP WA":[47.1854,-122.2929],"LAKEWOOD WA":[47.1718,-122.5185],"BREMERTON WA":[47.5673,-122.6329],
"OLYMPIA WA":[47.0379,-122.9007],"LACEY WA":[47.0343,-122.8232],"TUMWATER WA":[47.0073,-122.9093],"CENTRALIA WA":[46.7162,-122.9543],"CHEHALIS WA":[46.6621,-122.9640],"SHELTON WA":[47.2151,-123.1007],"OCEAN SHORES WA":[46.9737,-124.1563],"ABERDEEN WA":[46.9754,-123.8157],"HOQUIAM WA":[46.9809,-123.8893],"COSMOPOLIS WA":[46.9573,-123.7749],"CATHLAMET WA":[46.2054,-123.3826],"LONGVIEW WA":[46.1382,-122.9382],"KELSO WA":[46.1468,-122.9084],"ARIEL WA":[45.9568,-122.5709],"VANCOUVER WA":[45.6387,-122.6615],"CAMAS WA":[45.5871,-122.3945],"WASHOUGAL WA":[45.5826,-122.3534],"BATTLE GROUND WA":[45.7807,-122.5337],"BRUSH PRAIRIE WA":[45.7343,-122.5343],"TROUT LAKE WA":[46.0007,-121.5289],
"BELLINGHAM WA":[48.7519,-122.4787],"MOUNT VERNON WA":[48.4201,-122.3346],"ANACORTES WA":[48.5126,-122.6127],"OAK HARBOR WA":[48.2932,-122.6432],"PORT ANGELES WA":[48.1181,-123.4307],"PORT TOWNSEND WA":[48.1170,-122.7604],"SEQUIM WA":[48.0795,-123.1021],"SULTAN WA":[47.8615,-121.8154],
"LEAVENWORTH WA":[47.5962,-120.6615],"CLE ELUM WA":[47.1954,-120.9395],"ELLENSBURG WA":[46.9965,-120.5478],"NANEUM RIDGE WA":[47.2532,-120.3817],"RAVENS ROOST WA":[47.0242,-121.3347],"WENATCHEE WA":[47.4235,-120.3103],"CHELAN WA":[47.8410,-120.0165],"OMAK WA":[48.4110,-119.5276],"WINTHROP WA":[48.4763,-120.1836],"MOSES LAKE WA":[47.1301,-119.2781],"EPHRATA WA":[47.3179,-119.5533],
"YAKIMA WA":[46.6021,-120.5059],"SUNNYSIDE WA":[46.3237,-120.0087],"GRANDVIEW WA":[46.2543,-119.9017],"PROSSER WA":[46.2068,-119.7686],"TRI-CITIES WA":[46.2400,-119.2000],"KENNEWICK WA":[46.2112,-119.1372],"PASCO WA":[46.2396,-119.1006],"RICHLAND WA":[46.2857,-119.2845],"WALLA WALLA WA":[46.0646,-118.3430],
"SPOKANE WA":[47.6588,-117.4260],"SPOKANE VALLEY WA":[47.6733,-117.2394],"PULLMAN WA":[46.7313,-117.1796],"PALOUSE WA":[46.9098,-117.0788],"COLFAX WA":[46.8804,-117.3644],
"COEUR D'ALENE ID":[47.6777,-116.7805],"POST FALLS ID":[47.7180,-116.9516],"SAINT MARIES ID":[47.3088,-116.5690],"LEWISTON ID":[46.4165,-117.0177],"MOSCOW ID":[46.7324,-117.0002],"BOISE ID":[43.6150,-116.2023],"MERIDIAN ID":[43.6121,-116.3915],"NAMPA ID":[43.5407,-116.5635],"CALDWELL ID":[43.6629,-116.6874],"TWIN FALLS ID":[42.5558,-114.4701],"IDAHO FALLS ID":[43.4917,-112.0339],"POCATELLO ID":[42.8713,-112.4455],
"VANCOUVER BC":[49.2827,-123.1207],"NORTH VANCOUVER BC":[49.3200,-123.0724],"NEW WESTMINSTER BC":[49.2057,-122.9110],"MAPLE RIDGE BC":[49.2194,-122.5984],"SQUAMISH BC":[49.7017,-123.1558],"WHISTLER BC":[50.1163,-122.9574],"VICTORIA BC":[48.4284,-123.3656],"NANAIMO BC":[49.1659,-123.9401],"LADYSMITH BC":[48.9975,-123.8189],"KELOWNA BC":[49.8880,-119.4960],"KAMLOOPS BC":[50.6745,-120.3273],
"MISSOULA MT":[46.8721,-113.9940],"KALISPELL MT":[48.1958,-114.3129],"HELENA MT":[46.5891,-112.0391],"BOZEMAN MT":[45.6770,-111.0429],"BUTTE MT":[46.0038,-112.5348],"GREAT FALLS MT":[47.5052,-111.3008],"BILLINGS MT":[45.7833,-108.5007],"HAMILTON MT":[46.2470,-114.1601],
"SALT LAKE CITY UT":[40.7608,-111.8910],"WEST VALLEY CITY UT":[40.6916,-112.0011],"PROVO UT":[40.2338,-111.6585],"OREM UT":[40.2969,-111.6946],"OGDEN UT":[41.2230,-111.9738],"LAYTON UT":[41.0602,-111.9711],"SANDY UT":[40.5649,-111.8389],"LOGAN UT":[41.7370,-111.8338],"ST GEORGE UT":[37.0965,-113.5684],
"SACRAMENTO CA":[38.5816,-121.4944],"REDDING CA":[40.5865,-122.3917],"RED BLUFF CA":[40.1785,-122.2358],"CHICO CA":[39.7285,-121.8375],"EUREKA CA":[40.8021,-124.1637],"CRESCENT CITY CA":[41.7558,-124.2026],"YREKA CA":[41.7354,-122.6345],"MOUNT SHASTA CA":[41.3099,-122.3106],"SUSANVILLE CA":[40.4163,-120.6530],"WRIGHTWOOD CA":[34.3608,-117.6337],
"LOS ANGELES CA":[34.0522,-118.2437],"SAN FRANCISCO CA":[37.7749,-122.4194],"SAN JOSE CA":[37.3382,-121.8863],"SAN DIEGO CA":[32.7157,-117.1611],"FRESNO CA":[36.7378,-119.7871],"BAKERSFIELD CA":[35.3733,-119.0187],"LAS VEGAS NV":[36.1699,-115.1398],"RENO NV":[39.5296,-119.8138],"PHOENIX AZ":[33.4484,-112.0740],"MESA AZ":[33.4152,-111.8315],"TUCSON AZ":[32.2226,-110.9747],"DENVER CO":[39.7392,-104.9903],"COLORADO SPRINGS CO":[38.8339,-104.8214],"ALBUQUERQUE NM":[35.0844,-106.6504],"GRANTS NM":[35.1476,-107.8526],"EL PASO TX":[31.7619,-106.4850],"SAN ANTONIO TX":[29.4241,-98.4936],"AUSTIN TX":[30.2672,-97.7431],"HOUSTON TX":[29.7604,-95.3698],"DALLAS TX":[32.7767,-96.7970],"FORT WORTH TX":[32.7555,-97.3308],"OKLAHOMA CITY OK":[35.4676,-97.5164],"TULSA OK":[36.1540,-95.9928],"WICHITA KS":[37.6872,-97.3301],"KANSAS CITY MO":[39.0997,-94.5786],"ST LOUIS MO":[38.6270,-90.1994],"OMAHA NE":[41.2565,-95.9345],"MINNEAPOLIS MN":[44.9778,-93.2650],"CHICAGO IL":[41.8781,-87.6298],"MILWAUKEE WI":[43.0389,-87.9065],"INDIANAPOLIS IN":[39.7684,-86.1581],"FORT WAYNE IN":[41.0793,-85.1394],"COLUMBUS OH":[39.9612,-82.9988],"CLEVELAND OH":[41.4993,-81.6944],"CINCINNATI OH":[39.1031,-84.5120],"DETROIT MI":[42.3314,-83.0458],"LOUISVILLE KY":[38.2527,-85.7585],"NASHVILLE TN":[36.1627,-86.7816],"MEMPHIS TN":[35.1495,-90.0490],"ATLANTA GA":[33.7490,-84.3880],"CHARLOTTE NC":[35.2271,-80.8431],"RALEIGH NC":[35.7796,-78.6382],"JACKSONVILLE FL":[30.3322,-81.6557],"ORLANDO FL":[28.5383,-81.3792],"TAMPA FL":[27.9506,-82.4572],"MIAMI FL":[25.7617,-80.1918],"NEW ORLEANS LA":[29.9511,-90.0715],"WASHINGTON DC":[38.9072,-77.0369],"BALTIMORE MD":[39.2904,-76.6122],"PHILADELPHIA PA":[39.9526,-75.1652],"PITTSBURGH PA":[40.4406,-79.9959],"NEW YORK NY":[40.7128,-74.0060],"BUFFALO NY":[42.8864,-78.8784],"BOSTON MA":[42.3601,-71.0589],"RICHMOND VA":[37.5407,-77.4360],
"TORONTO ON":[43.6532,-79.3832],"OTTAWA ON":[45.4215,-75.6972],"HAMILTON ON":[43.2557,-79.8711],"MONTREAL QC":[45.5017,-73.5673],"QUEBEC CITY QC":[46.8139,-71.2080],"CALGARY AB":[51.0447,-114.0719],"EDMONTON AB":[53.5461,-113.4938],"WINNIPEG MB":[49.8951,-97.1384]
};
// PNWDigital repeater SITES with exact tower coords (from pnwdigital.net site pins, web-verified) — for snapping RF ops to the exact repeater.
var PNWREP=[
{c:"VE7XWX",city:"Whistler",st:"BC",site:"Blackcomb Mtn",ll:[50.07853,-122.89569]},{c:"VA7DXH",city:"Ladysmith",st:"BC",site:"Nanaimo",ll:[49.16608,-123.93867]},{c:"VE7NWR",city:"New Westminster",st:"BC",site:"",ll:[49.2057,-122.911]},{c:"VE7RAG",city:"North Vancouver",st:"BC",site:"Mt Seymour",ll:[49.3932,-122.9447]},{c:"VE7XWX",city:"Squamish",st:"BC",site:"",ll:[49.75711,-123.14828]},{c:"VE7RYS",city:"Vancouver",st:"BC",site:"UBC",ll:[49.2606,-123.246]},{c:"VE7BEL",city:"Victoria",st:"BC",site:"",ll:[48.4284,-123.3656]},{c:"VE7VIC",city:"Victoria",st:"BC",site:"",ll:[48.4284,-123.3656]},
{c:"N6GGS",city:"Blue Ridge",st:"CA",site:"Blue Ridge",ll:[34.3481,-117.6712]},{c:"KA6P",city:"Santiago Pk",st:"CA",site:"Santiago Pk",ll:[33.7103,-117.5342]},{c:"KA6P",city:"Wrightwood",st:"CA",site:"Wrightwood",ll:[34.35525,-117.63289]},
{c:"WA7DMR",city:"Coeur d'Alene",st:"ID",site:"Blossom Ridge",ll:[47.6591,-116.9638]},{c:"WA7DMR",city:"Coeur d'Alene",st:"ID",site:"Coeur d'Alene Metro",ll:[47.68036,-116.77606]},{c:"KB7SIJ",city:"Lewiston",st:"ID",site:"Craig Mtn",ll:[46.076,-116.8515]},{c:"KB7SIJ",city:"Saint Joe",st:"ID",site:"Saint Joe Baldy",ll:[47.22,-116.25]},
{c:"W7GXJ",city:"Bend",st:"OR",site:"Powell Butte",ll:[44.2476,-121.0175]},{c:"N7LF",city:"Biggs Junction",st:"OR",site:"Juniper Point",ll:[45.66408,-120.83756]},{c:"N7LF",city:"Boardman",st:"OR",site:"Golgotha Butte",ll:[45.83333,-119.77228]},{c:"N7LF",city:"Cascade Locks",st:"OR",site:"Cascade Locks",ll:[45.6773,-121.8934]},{c:"N7LF",city:"Corbett",st:"OR",site:"Lookout Point",ll:[45.55075,-122.29939]},{c:"N7MAQ",city:"Dallas",st:"OR",site:"City View",ll:[44.92647,-123.32014]},{c:"N7LF",city:"Gresham",st:"OR",site:"Hospital",ll:[45.50022,-122.46792]},{c:"K7RPT",city:"Hillsboro",st:"OR",site:"Saddle Mtn",ll:[45.5482,-123.3748]},{c:"N7LF",city:"Hood River",st:"OR",site:"Burdoin Mtn",ll:[45.74961,-121.52369]},{c:"N7LF",city:"Hood River",st:"OR",site:"Mt Defiance",ll:[45.65406,-121.71406]},{c:"N5GB",city:"Manzanita",st:"OR",site:"Manzanita",ll:[45.72128,-123.93031]},{c:"K7PN",city:"Mt Hood",st:"OR",site:"Government Camp",ll:[45.3035,-121.7508]},{c:"N7LF",city:"Pine Hollow",st:"OR",site:"Pine Hollow",ll:[45.2352,-121.2837]},{c:"KA7AGH",city:"Portland",st:"OR",site:"Mt Scott",ll:[45.48128,-122.58789]},{c:"WA7HAA",city:"Portland",st:"OR",site:"PPMC",ll:[45.5268,-122.6114]},{c:"K7RPT",city:"Portland",st:"OR",site:"Westhills",ll:[45.5106,-122.7649]},{c:"K7RPT",city:"Prineville",st:"OR",site:"Grizzly Mtn",ll:[44.43694,-120.95481]},{c:"N7CCO",city:"Prineville",st:"OR",site:"Town Center",ll:[44.2999,-120.8344]},{c:"K7LWV",city:"Salem",st:"OR",site:"Popcorn Hill",ll:[44.9525,-123.07339]},{c:"W7SRA",city:"Salem",st:"OR",site:"Prospect Hill",ll:[44.8546,-123.122]},{c:"N7LF",city:"The Dalles",st:"OR",site:"Stacker Butte",ll:[45.599,-121.16067]},{c:"N3EG",city:"Rainier",st:"OR",site:"Rainier Hill",ll:[46.14581,-122.91689]},
{c:"WA7DMR",city:"Ariel",st:"WA",site:"Ariel",ll:[45.96839,-122.59094]},{c:"N7ERP",city:"Bellevue",st:"WA",site:"Cougar Mtn",ll:[47.5404,-122.0993]},{c:"WA7DMR",city:"Bellevue",st:"WA",site:"Cougar Mtn",ll:[47.5404,-122.0993]},{c:"AF7PR",city:"Bellingham",st:"WA",site:"Lookout Mtn",ll:[48.7191,-122.3554]},{c:"K7SKW",city:"Bellingham",st:"WA",site:"Lookout Mtn",ll:[48.7191,-122.3554]},{c:"WA7HAA",city:"Brush Prairie",st:"WA",site:"Clark Range",ll:[45.72797,-122.41544]},{c:"W6UDF",city:"Cathlamet",st:"WA",site:"Wahkiakum HS",ll:[46.19653,-123.37542]},{c:"AF7PR",city:"Chehalis",st:"WA",site:"BawFaw Mtn",ll:[46.48797,-123.21506]},{c:"W7ZA",city:"Cosmopolis",st:"WA",site:"Cosmopolis",ll:[46.95069,-123.78286]},{c:"K7SKW",city:"Ellensburg",st:"WA",site:"SunEast",ll:[47.00936,-120.53747]},{c:"WA7DMR",city:"Ephrata",st:"WA",site:"Beasley Hill",ll:[47.34153,-119.58222]},{c:"WA7DMR",city:"Naneum Ridge",st:"WA",site:"Naneum Ridge",ll:[47.27417,-120.40675]},{c:"WA7DMR",city:"Ocean Shores",st:"WA",site:"Town Center",ll:[46.9735,-124.1563]},{c:"K7LL",city:"Palouse",st:"WA",site:"Kamiak Butte",ll:[46.86247,-117.16761]},{c:"WA7DMR",city:"Prosser",st:"WA",site:"Horse Haven",ll:[46.26596,-119.77176]},{c:"K7LL",city:"Pullman",st:"WA",site:"WSU",ll:[46.75375,-117.16286]},{c:"WA7DMR",city:"Ravens Roost",st:"WA",site:"Ravens Roost",ll:[47.0242,-121.3347]},{c:"W7WWI",city:"Seattle",st:"WA",site:"Capitol Hill",ll:[47.60833,-122.32222]},{c:"K7NWS",city:"Seattle",st:"WA",site:"Museum of Flight",ll:[47.52278,-122.30361]},{c:"K7NWS",city:"Seattle",st:"WA",site:"West Tiger Mtn 2",ll:[47.50875,-121.98506]},{c:"N9VW",city:"Shelton",st:"WA",site:"Spencer Lk",ll:[47.236,-123.031]},{c:"K7LFP",city:"Shoreline",st:"WA",site:"Shoreline",ll:[47.7557,-122.3415]},{c:"KC7AAD",city:"Spokane",st:"WA",site:"Lookout Point",ll:[47.77989,-117.50939]},{c:"K7TJ",city:"Spokane",st:"WA",site:"Krell Hill",ll:[47.57844,-117.40333]},{c:"WA7DMR",city:"Spokane",st:"WA",site:"Krell Hill",ll:[47.57844,-117.40333]},{c:"WA7DMR",city:"Spokane Valley",st:"WA",site:"Ridgecrest",ll:[47.82594,-117.23539]},{c:"KE7SFF",city:"Sultan",st:"WA",site:"Haystack Mtn",ll:[47.81069,-121.75136]},{c:"KG7KPH",city:"Tacoma",st:"WA",site:"Ruston",ll:[47.3043,-122.5115]},{c:"N7ER",city:"Tacoma",st:"WA",site:"Baldi Mtn",ll:[47.2212,-121.851]},{c:"WA7DMR",city:"Tacoma",st:"WA",site:"Baldi Mtn",ll:[47.2212,-121.851]},{c:"WA7DMR",city:"Tri-Cities",st:"WA",site:"Jump Off Joe",ll:[46.24247,-119.21711]},{c:"N7LF",city:"Trout Lake",st:"WA",site:"Flattop Mtn",ll:[46.02764,-121.61219]},{c:"KJ7ICL",city:"Tulalip",st:"WA",site:"Tulalip East",ll:[48.06953,-122.29311]},{c:"N7RHT",city:"Wenatchee",st:"WA",site:"Lower Badger",ll:[47.41436,-120.32314]},{c:"WA7MV",city:"Winthrop",st:"WA",site:"Rendezvous",ll:[48.50758,-120.22881]},{c:"WA7SAR",city:"Yakima",st:"WA",site:"Elephant Mtn",ll:[46.65408,-120.28203]}
];
var PNWLL={};PNWREP.forEach(function(r){var ci=(r.city||'').toUpperCase();if(r.site)PNWLL[r.site.toUpperCase()+'|'+ci]=r.ll;PNWLL[(r.c||'').toUpperCase()+'|'+ci]=r.ll;});
function _pk(s){return (s||'').toUpperCase().replace(/,/g,' ').replace(/\s+/g,' ').trim();}
// A "MM - Name" peer (or one with no 2-letter state) is an MMDVM hotspot, not a fixed repeater.
function isHotspotRep(rep){var s0=((rep||'').split(/\s+[-–—]\s+/)[0]||'').trim();var m=s0.toUpperCase().match(/\b([A-Z]{2})$/);return /^MM\b/i.test(s0)||!(m&&STCEN[m[1]]);}
function hsName(rep){return (rep||'').replace(/^MM\s*[-–—]\s*/i,'').replace(/\s+[a-z]$/i,'').trim();}
// Where they keyed IN (the repeater site). Wide-coverage repeaters mean this isn't exactly where the op is.
function repLL(r){
  if(r.rep&&!/bm.*sourc/i.test(r.rep)&&!isHotspotRep(r.rep)){
    var segs=r.rep.split(/\s+[-–—]\s+/);
    var city=(segs[0]||'').replace(/\s+[A-Z]{2}$/,'').trim().toUpperCase();
    var site=(segs.length>=3?segs[1]:'').trim().toUpperCase();
    var call=((segs[segs.length-1]||'').trim().split(/\s+/)[0]||'').toUpperCase();
    var ll=(site&&PNWLL[site+'|'+city])||PNWLL[call+'|'+city];   // exact tower via site|city or call|city
    if(ll)return {ll:ll,place:(segs[0]||'').trim(),exact:true,via:'rep'};
    var c=CITYLL[_pk(segs[0]||'')];                              // else the repeater's town center
    if(c)return {ll:c,place:(segs[0]||'').trim(),exact:true,via:'rep'};
  }
  return null;
}
// Their radioid.net registered QTH (from the CallWatch operator alias) — where they live, not necessarily where they are now.
function homeLL(r){if(r.loc){var c=CITYLL[_pk(r.loc)];if(c)return {ll:c,place:r.loc.trim(),exact:true,via:'home'};}return null;}
// aprs-dmr.py's resolve() appends the COUNTRY after the state/province code ("Airdrie, AB, Canada"), which
// broke the plain end-of-string match below for every non-US country (found live: every Canadian province
// code went unmatched because the string ends in "Canada", not "AB") -- strip a known trailing country name
// first, then look for the 2-letter code.
function stateLL(r){var loc=(r.loc||'').replace(/,\s*(Canada|United States|USA)\s*$/i,'');var mm=loc.toUpperCase().match(/\b([A-Z]{2})$/);if(mm&&STCEN[mm[1]])return {ll:STCEN[mm[1]],place:mm[1],exact:false,via:'state'};return null;}
// Worldwide fallback (anything stateLL couldn't resolve): match a trailing country name.
var CTRYCEN={
'united kingdom':[54.0,-2.0],'ireland':[53.4,-8.0],'france':[46.6,2.2],'germany':[51.2,10.4],'netherlands':[52.1,5.3],'belgium':[50.5,4.5],'switzerland':[46.8,8.2],'austria':[47.5,14.5],'italy':[42.8,12.8],'spain':[40.0,-4.0],'portugal':[39.5,-8.0],'sweden':[62.0,15.0],'norway':[62.0,10.0],'denmark':[56.0,10.0],'finland':[64.0,26.0],'poland':[52.0,19.5],'czech republic':[49.8,15.5],'czechia':[49.8,15.5],'slovakia':[48.7,19.5],'hungary':[47.2,19.5],'romania':[45.9,25.0],'bulgaria':[42.7,25.5],'greece':[39.0,22.0],'croatia':[45.1,15.5],'slovenia':[46.1,14.8],'serbia':[44.0,21.0],'bosnia and herzegovina':[43.9,17.7],'north macedonia':[41.6,21.7],'albania':[41.2,20.2],'montenegro':[42.7,19.4],'ukraine':[49.0,31.0],'belarus':[53.7,28.0],'moldova':[47.0,28.9],'russia':[61.5,105.0],'russian federation':[61.5,105.0],'estonia':[58.6,25.0],'latvia':[56.9,24.6],'lithuania':[55.2,23.9],'iceland':[65.0,-18.0],'luxembourg':[49.8,6.1],'malta':[35.9,14.5],'cyprus':[35.1,33.4],
'japan':[36.2,138.2],'south korea':[36.5,127.9],'korea, republic of':[36.5,127.9],'china':[35.0,103.0],'taiwan':[23.7,121.0],'philippines':[12.9,121.8],'thailand':[15.9,100.9],'vietnam':[16.0,108.0],'indonesia':[-2.5,118.0],'malaysia':[4.2,102.0],'singapore':[1.35,103.8],'india':[21.0,78.0],'pakistan':[30.4,69.3],'bangladesh':[23.7,90.4],'sri lanka':[7.9,80.8],'nepal':[28.4,84.1],'myanmar':[21.9,95.9],
'israel':[31.5,34.8],'turkey':[39.0,35.0],'saudi arabia':[24.0,45.0],'united arab emirates':[24.0,54.0],'kuwait':[29.3,47.5],'qatar':[25.3,51.2],'bahrain':[26.0,50.6],'oman':[21.5,55.9],'jordan':[31.2,36.5],'lebanon':[33.9,35.9],'iraq':[33.2,43.7],'iran':[32.4,53.7],'hong kong':[22.3,114.2],
'australia':[-25.0,133.0],'new zealand':[-41.0,174.0],'fiji':[-17.7,178.0],'papua new guinea':[-6.3,143.9],
'south africa':[-29.0,24.0],'egypt':[26.8,30.8],'nigeria':[9.1,8.7],'kenya':[0.0,37.9],'morocco':[31.8,-7.1],'algeria':[28.0,1.7],'tunisia':[33.9,9.5],'ghana':[7.9,-1.0],'ethiopia':[9.1,40.5],
'brazil':[-14.2,-51.9],'argentina':[-38.4,-63.6],'chile':[-35.7,-71.5],'colombia':[4.6,-74.3],'peru':[-9.2,-75.0],'venezuela':[6.4,-66.6],'ecuador':[-1.8,-78.2],'mexico':[23.6,-102.5],'costa rica':[9.7,-83.8],'panama':[8.5,-80.8],'uruguay':[-32.5,-55.8],'paraguay':[-23.4,-58.4],'bolivia':[-16.3,-63.6],'guatemala':[15.8,-90.2],'honduras':[15.2,-86.2],'el salvador':[13.8,-88.9],'nicaragua':[12.9,-85.2],
'puerto rico':[18.2,-66.6],'jamaica':[18.1,-77.3],'dominican republic':[18.7,-70.2],'bahamas':[24.3,-76.6],'trinidad and tobago':[10.7,-61.2],
'canada':[56.1,-106.3]   // belt-and-suspenders whole-country centroid, in case stateLL's province-code strip ever misses (a territory not in STCEN, an unexpected format, etc.)
};
function countryLL(r){var loc=(r.loc||'').toLowerCase().trim();if(!loc)return null;for(var k in CTRYCEN){if(loc.endsWith(k))return {ll:CTRYCEN[k],place:r.loc.trim(),exact:false,via:'country'};}return null;}
function resolveLL(r){
  if(placeMode==='home')return homeLL(r)||repLL(r)||stateLL(r)||countryLL(r);
  return repLL(r)||homeLL(r)||stateLL(r)||countryLL(r);
}
function sysColorKey(r){var s=sysOf(r);if(s[1]==='hs')return 'hs';if(s[1]==='bm')return 'bm';if(s[1]==='tgif')return 'tgif';if(s[1]==='pnw')return /^PNW-?E/.test((r.site||'').toUpperCase())?'pnwe':'pnw';return 'oth';}

/* ---------- board: row age on the Pacific clock ---------- */
var _pacFmt=null;
function pacSecOfDay(ms){   // seconds since Pacific midnight at instant ms
  try{
    if(!_pacFmt)_pacFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'America/Los_Angeles',hour12:false,hour:'2-digit',minute:'2-digit',second:'2-digit'});   // same options as the header clock's _hhmm()
    var p=_pacFmt.formatToParts(new Date(ms)),h=0,m=0,s=0;
    for(var i=0;i<p.length;i++){if(p[i].type==='hour')h=+p[i].value;else if(p[i].type==='minute')m=+p[i].value;else if(p[i].type==='second')s=+p[i].value;}
    return (h%24)*3600+m*60+s;   // %24: some engines print midnight as "24"
  }catch(e){var d=new Date(ms);return d.getHours()*3600+d.getMinutes()*60+d.getSeconds();}   // no Intl time zones: device clock, the old behaviour
}
var _pacNowAt=-1,_pacNowVal=0;
function _pacNow(ms){var k=Math.floor(ms/1000);if(k!==_pacNowAt){_pacNowAt=k;_pacNowVal=pacSecOfDay(k*1000);}return _pacNowVal;}   // once per second, not once per row
function _epochOrNull(v){var n=+v;return (v!=null&&v!==''&&isFinite(n)&&n>1e9&&n<1e11)?n:null;}   // unix SECONDS only; anything else falls back to the `t` clock
function rowAgeSec(r){ return rowAgeAt(r,srvNow()); }   // ONE argument on purpose (rows.map(rowAgeSec) passes an index second)
function rowAgeAt(r,ms){
  if(!r)return null;
  if(r.now)return 0;
  if(typeof r.startEpoch==='number'&&isFinite(r.startEpoch)){var e=Math.floor(ms/1000-r.startEpoch);return e<0?0:e;}
  var m=String(r.t||'').match(/^(\d{1,2}):(\d{2}):(\d{2})/);if(!m)return null;
  var a=_pacNow(ms)-((+m[1])*3600+(+m[2])*60+(+m[3]));
  if(a<-120)a+=86400;   // heard before Pacific midnight, read after it
  if(a<0)a=0;           // up to 2 min "ahead": clock skew, not tomorrow
  return a;
}
function ageOpacity(sec){if(sec==null)return .85;if(sec<=300)return 1;if(sec>=1800)return .4;return 1-(sec-300)/1500*.6;}

/* ---------- board: map fit and clustering ---------- */
function fitPins(){
  if(!mapObj||!mapMk.length)return;
  // Bias the fit toward precisely-placed pins (repeater site / registered home city) so a single
  // worldwide/BrandMeister caller resolved only to a country centroid (found live: Kuwait, Indonesia,
  // Czech Republic) doesn't zoom the whole map out to a world view just to include one distant dot --
  // that pin is still there and clickable, it just doesn't drive the DEFAULT view. Falls back to every
  // pin if nothing precise is currently up (never leaves the map with nothing framed).
  var exactMk=mapMk.filter(function(m){return m._exact;});
  var useMk=exactMk.length?exactMk:mapMk;
  var pts=fitPts(), b=pts.length?L.latLngBounds(pts):L.featureGroup(useMk).getBounds(), one=pts.length?b.getNorthEast().equals(b.getSouthWest()):useMk.length===1;mapObj._prog=true;mapObj._fitted=true;   // app: fitPts
  if(one)mapObj.setView(b.getCenter(),8,{animate:false});   // app: one place, not one dot
  else mapObj.fitBounds(b,Object.assign(fitPad(),{maxZoom:10,animate:false}));   // app: clear the map buttons (fitPad)
  mapObj._fitted=true;userMoved=false;
  setTimeout(function(){mapObj._prog=false;
    if(mapOpen&&window.L)try{plotPins();}catch(e){}   // found live: clusterGroups() is zoom-dependent (latLngToLayerPoint), and this fit can land on the SAME zoom level as before -- a pure pan with no discrete zoom change, which never fires Leaflet's zoomend, so the corrective re-cluster that listener normally provides silently doesn't happen and the legend/grouping goes stale relative to where the map actually settled. Re-plotting here doesn't depend on that event firing at all. _fitted is already true by this point so this can't loop back into fitPins() again.
  },60);
}
// Merge groups whose markers would overlap at the current zoom, so nearby towns don't stack
// into an unclickable pile — they split apart as you zoom in.
function clusterGroups(list){
  if(!mapObj||list.length<2)return list.map(function(g){g.places={};g.places[g.place]=1;g.nplaces=1;return g;});
  var THRESH=COARSE?44:24;   // app: a finger's 44 px tap circles kept apart (see plotPins)
  list.sort(function(a,b){return b.rows.length-a.rows.length;});
  var cl=[];
  list.forEach(function(grp){
    var pt=mapObj.latLngToLayerPoint(L.latLng(grp.ll[0],grp.ll[1])),best=null,bd=THRESH;
    for(var i=0;i<cl.length;i++){var dx=cl[i].pt.x-pt.x,dy=cl[i].pt.y-pt.y,dd=Math.sqrt(dx*dx+dy*dy);if(dd<bd){bd=dd;best=cl[i];}}
    if(best){best.rows=best.rows.concat(grp.rows);best.places[grp.place]=1;}
    else{var o={};o[grp.place]=1;cl.push({ll:grp.ll,pt:pt,place:grp.place,exact:grp.exact,rows:grp.rows.slice(),places:o});}
  });
  cl.forEach(function(c){c.nplaces=Object.keys(c.places).length;});
  return cl;
}

/* ---------- board: talkgroup names -> BrandMeister numbers ---------- */
var TGMAP={'oregon':3141,'oregon 1':3141,'oregon central':31411,'or central':31411,'pnw regional':31771,'pnwr':31771,'pnw rgnl':31771,'bridge':3100,
  'tac 310':310,'tac 311':311,'tac 312':312,'tac 313':313,'tac 314':314,'tac 315':315,'tac 316':316,'tac 317':317,'tac 318':318,'tac 319':319,
  'washington':3153,'washington 1':3153,'idaho':3116,'idaho 1':3116,'montana':3130,'montana 2':3130,'utah':3149,'california':3106,'california 1':3106,
  'north am':93,'north america':93,'na bm':93,          // same TG (93), three names seen across the codeplug/BM feed
  'worldwide':91,'ww bm':91,                              // same TG (91) -- the mismatch that caused the original duplicate-row bug
  'worldwide english':913,'worldwide englsh':913,          // "englsh" = a literal typo in Christian's own codeplug, kept so it still resolves
  'europe':92,'asia':94,'australia / nz':95,'australia/nz':95,'aus nz':95};
function bmOf(tg){if(!tg)return 0;return TGMAP[String(tg).toLowerCase().trim()]||0;}

/* ---------- data: /snapshot poll ---------- */
// The board's normalisers read all four feeds on every redraw, whichever network is picked, so one row they can't read
// (a null, a number where a name belongs) would freeze every network. Rows are cleaned once as they arrive, and run
// through their normaliser here: a feed that still trips it keeps its last good copy while the others update.
var ROWKEY={hs:'lh',net:'rows',bm:'rows',tgif:'rows'}, NORM={hs:normHS,net:normNET,bm:normBM,tgif:normTGIF};
var TXT=['t','call','name','qth','loc','tg','tgname','tgid','rep','site','dmrid'];
function cleanFeed(k,val){ var out=Object.assign({},val), rk=ROWKEY[k];
  out[rk]=arr(val[rk]).filter(function(r){ return r&&typeof r==='object'; }).map(function(r){ var c=Object.assign({},r);
    TXT.forEach(function(x){ if(c[x]!=null&&typeof c[x]!=='string')c[x]=String(c[x]); });
    if(c.cnt!=null&&typeof c.cnt!=='number')c.cnt=+c.cnt||1;
    return c; });
  NORM[k](out); return out; }
function applySnap(j){
  var nowS=srvNow(), f=(j&&j.feeds)||{}, sts=+(j&&j.ts), bad={};
  if(sts>1e9&&sts<1e11){ skewMs=Date.now()-sts*1000; nowS=sts*1000; }
  [['dmr','hs'],['pnw','net'],['bm','bm'],['tgif','tgif']].forEach(function(p){   // tgif: absent on an older dmrfeed, which is null here
    var name=p[0], val=f[name];
    if(!val){ feeds[p[1]]=null; return; }          // that collector hasn't published since dmrfeed last restarted
    try{   // one feed the code can't read doesn't stop the others from updating
      val=cleanFeed(p[1],val);
      var sig=_feedSig(val), prev=_feedSeen[name];
      var changedAt=(prev&&prev.sig===sig&&prev.changedAt)?prev.changedAt:nowS;
      var trueAge=_contentAgeSec(name,val); if(trueAge!=null)changedAt=Math.min(changedAt,nowS-trueAge*1000);
      // Arrival = when the COLLECTOR last published (its own ts, server clock), not when this phone fetched it: /snapshot
      // keeps handing back the last state for ever, so a dead collector would otherwise look fresh every 15 s.
      var vts=+val.ts, at=(vts>1e9&&vts<1e11)?Math.min(nowS,vts*1000):nowS;
      _feedSeen[name]={at:at,sig:sig,changedAt:changedAt};
      feeds[p[1]]=val;
    }catch(e){ bad[p[1]]=true; try{ console.error('lastheard snapshot',name,e); }catch(e2){} }
  });
  badFeeds=bad;
  try{ localStorage.setItem(SEEN_KEY,JSON.stringify(_feedSeen)); }catch(e){}
}
function schedule(ms){ if(pollT)clearTimeout(pollT); pollT=null; if(view)pollT=setTimeout(poll,ms); }
function poll(){
  if(pollT){ clearTimeout(pollT); pollT=null; }   // called early, its own timer must not fire too: that is a second chain
  if(!view||inFlight||paused)return;              // paused, only wake() or a fresh show() starts it again (not 'online')
  // the next touch starts it again (noteTouch). Not while refused: a 401 is tiny, and asking once a minute is what lets
  // "ask Christian" clear by itself once .151 is back up, with nobody touching the phone.
  if(!denied&&Date.now()-lastTouch>IDLE_MS){ paused=true; safeRender(); return; }
  var u=firebase.auth().currentUser;
  if(!u){ lastErr='signin'; waking=wakeDraw=false; safeRender(); return; }
  inFlight=true;
  var ac=(typeof AbortController==='function')?new AbortController():null, to=setTimeout(function(){ if(ac)ac.abort(); },FETCH_MS);
  u.getIdToken(n401===1).then(function(tok){                       // after the first 401, ask once with a fresh token
    return fetch(FEED+'/snapshot?token='+encodeURIComponent(tok),{cache:'no-store',signal:ac?ac.signal:undefined});
  }).then(function(r){
    if(r.status===401||r.status===403){ var e=new Error('denied'); e.code=401; throw e; }
    if(!r.ok){ var e2=new Error('http '+r.status); e2.code=r.status; throw e2; }
    return r.json();
  }).then(function(j){
    clearTimeout(to); inFlight=false; waking=false; fails=0; n401=0; denied=false; lastErr=null; lastOk=Date.now();
    schedule(POLL_MS);                 // first, so a snapshot that trips the drawing code can't stop the updates
    applySnap(j); if(wakeDraw)drawNow(); else renderSoon();
  }).catch(function(e){
    clearTimeout(to); inFlight=false; waking=false; fails++; lastErr=(e&&e.code)||'net'; n401=(lastErr===401)?n401+1:0;
    // Refused twice in a row, the second time with a fresh token. dmrfeed answers 401 for "not on the list" AND for its
    // own sign-in checks not being ready (after a .151 restart), so the words allow for both and it keeps asking once a minute.
    if(n401>=2)denied=true;
    schedule(denied?60000:lastErr===401?500:Math.min(60000,POLL_MS*fails));
    if(wakeDraw)drawNow(); else renderSoon();   // held like any poll redraw: on weak signal the status line grows on every failed try
  });
}
// fromPoll: a poll's (or a repaint's) redraw, which leaves an open map popup alone; anything the user did passes nothing
function safeRender(fromPoll){ var was=renderErr;
  try{ render(fromPoll); renderErr=false; if(was)renderStat(); }
  catch(e){ renderErr=true; try{ console.error('lastheard',e); }catch(e2){} try{ renderStat(); }catch(e3){} } }
// A poll redraw waits HOLD_MS after the last touch while anything tappable is on screen (rows, or the chips and Show all
// over a search that matches nobody). Nothing to move yet means nothing to hold, and the tap that opened the view doesn't
// count (show() clears holdAt): the first data is drawn the moment it arrives.
function renderSoon(){ if(renderT){ clearTimeout(renderT); renderT=null; }
  var w=HOLD_MS-(Date.now()-holdAt); if(w>0&&(shownRows.length||lastC.all.length)){ renderT=setTimeout(renderSoon,w); return; }
  safeRender(true); }
// the first draw after a wake is the one that tap asked for: more taps while it is on its way don't hold it back
function drawNow(){ wakeDraw=false; if(renderT){ clearTimeout(renderT); renderT=null; } safeRender(true); }
function noteTouch(e){
  if(e&&e.type==='scroll'&&Date.now()-lastRenderAt<300)return;   // the browser's own scroll when a redraw shortened the page
  lastTouch=holdAt=Date.now();
  if(paused&&view&&!wakeT&&!(e&&e.type==='pointerdown'))wakeT=setTimeout(wake,120); }
// Woken after the tap has landed (pointerup + 120 ms, past its click): the paused banner answers "Updating…" in place,
// held at its height so nothing under the finger moves, until the fresh data replaces it (waking: a repaint meanwhile
// keeps it). A tap that was leaving for another tab (hide) fetches nothing.
function wake(){ wakeT=null; if(!paused||!view)return; paused=false; waking=wakeDraw=true; holdAt=0;
  var s=$id('lhstat'); if(s){ if(s.offsetHeight>0)s.style.minHeight=s.offsetHeight+'px'; s.textContent='Updating…'; }
  if(!inFlight)poll(); }
// "talking now" only from fresh data: someone keyed when the updates paused, or when the connection dropped, would
// otherwise stay red and pulsing for as long as that lasts
function liveOk(){ return !paused&&!waking&&!lastErr&&Date.now()-lastOk<45000; }
function isNow(r){ return !!r.now&&liveOk(); }

/* ---------- what's on screen ---------- */
var SRCS=[['all','All'],['net','PNW'],['bm','BM'],['tgif','TGIF'],['hs','Hotspot']];
var SRCNAME={net:'PNW',bm:'BM',tgif:'TGIF',hs:'Hotspot'};
var FEEDNAME={hs:'The hotspot feed',net:'The PNW feed',bm:'The BrandMeister feed',tgif:'The TGIF feed'};
function compute(){
  var all=merged(), q=query.trim().toLowerCase(), hidden=0;
  shownRows=all.filter(function(r){
    if(tgFilter&&tgCanon(r)!==tgFilter){ hidden++; return false; }
    if(q&&((r.call+' '+r.name+' '+r.loc+' '+r.tg+' '+r.rep).toLowerCase().indexOf(q)<0))return false;
    return true; });
  return (lastC={all:all,hidden:hidden});
}
function dur(sec){ var m=Math.max(1,Math.round(sec/60)); if(m<60)return m+' min';   // whole minutes first: no "60 min"
  var h=Math.floor(m/60); m%=60; if(h<48)return h+' h'+(m?' '+m+' min':''); return Math.round(h/24)+' days'; }
function ago(sec){ if(sec==null)return ''; if(sec<45)return 'just now'; return dur(sec)+' ago'; }
function times(n){ return n>1?' · '+n+' times':''; }
// the feed(s) behind the selected network have never published since dmrfeed last restarted (null in the snapshot)
function noFeedData(){ var k=src==='all'?['hs','net','bm','tgif']:[src]; return k.every(function(x){ return !feeds[x]; }); }
// The board's activeOnline() leaves BrandMeister and TGIF out of All, so PNW and the hotspot down would hide live BM/TGIF rows.
// Here All is offline only when every feed that has reported says so.
function offlineNow(){ if(src!=='all')return activeOnline()===false;
  var ks=['hs','net','bm','tgif'].filter(function(k){ return feeds[k]; });
  return ks.length>0&&ks.every(function(k){ return feeds[k].online===false; }); }
// Named once, used by the footnote and Help's wording: the BM collector watches these talkgroups, not all of BrandMeister
var BM_WHICH='a handful of BrandMeister talkgroups (Oregon, PNW Regional, Worldwide and a few more)';
// the tgif collector watches the TGIF talkgroups this app can tune, and our own bridge reports HOLDEN1 as it hears it
var TGIF_WHICH='the TGIF talkgroups in this app';
var NOTE_SRC={all:'Everyone heard on PNWDigital, on '+BM_WHICH+', on '+TGIF_WHICH+' and on the KJ7DTS hotspot.',
  net:'Showing PNWDigital. Tap All to see every network.', bm:'Showing '+BM_WHICH+'.',
  tgif:'Showing '+TGIF_WHICH+', with HOLDEN1 as our own bridge hears it.',
  hs:'Showing the KJ7DTS hotspot. Tap All to see every network.'};
function pacTime(t){ var m=String(t||'').match(/^(\d{1,2}):(\d{2})/); if(!m)return ''; var h=+m[1]%24;
  return ((h%12)||12)+':'+m[2]+(h<12?' AM':' PM')+' PT'; }   // every feed's `t` is Pacific; say so, for Dad on Central time
// Listen only where it is exactly right: the station was heard on BrandMeister, and the app's BM bridge tunes that TG.
// Not offered once the app knows (from hello) that this account has no BrandMeister; before hello it can't know, and the
// Talk tab's own Listen card explains "BrandMeister needed" in that case.
function noBm(){ try{ return !!(typeof myCall!=='undefined'&&myCall&&typeof myNets!=='undefined'&&myNets.indexOf('bm')<0); }catch(e){ return false; } }
function listenId(r){ var onBm=r.src==='bm'||(r.srcs&&r.srcs.indexOf('bm')>=0); if(!onBm||noBm())return 0;
  var n=/^\d+$/.test(String(r.tgid||''))?+r.tgid:bmOf(r.tg); return n>0?n:0; }
function listen(r){ var n=listenId(r); if(!n)return;
  var h='#answer=bm:'+n+':'+encodeURIComponent(r.tg||('TG '+n));   // the app's own deep-link: Talk tab, Listen card, one tap
  // the same link still pending on Talk is still in the URL, and setting an identical hash fires no hashchange
  if(location.hash===h){ try{ history.replaceState(null,'',location.pathname+location.search); }catch(e){} }
  location.hash=h; }
// BrandMeister's own rep field only says "Repeater" or "Network", and a PNW row from BM says "BM 3102 Sourced-..": skip both
function repText(r){ if(!r.rep||/bm.*sourc/i.test(r.rep)||r.src==='bm'||/^BM-/i.test(r.site||''))return '';
  if(isHotspotRep(r.rep)){ var hn=hsName(r.rep); return 'via a hotspot'+(hn?' ('+hn+')':''); }
  var s=r.rep.split(/\s+[-–—]\s+/); return 'via '+s.slice(0,Math.max(1,s.length-1)).join(' – ')+(s.length>1?' ('+(s[s.length-1]||'').trim().split(/\s+/)[0]+')':''); }
function sysTags(r){ if(r.srcs&&r.srcs.length>1)return r.srcs.map(function(s){ return [SRCNAME[s]||s, s==='net'?'pnw':s]; });
  var s=sysOf(r); return [[s[0]==='HS'?'Hotspot':s[0],sysColorKey(r)]]; }
function tagEl(t){ var b=el('span','lhsys',t[0]); b.style.setProperty('--sc',SYSCOL[t[1]]||SYSCOL.oth); return b; }
function ageCls(r){ if(isNow(r))return ' now'; var a=rowAgeSec(r); if(a!=null&&a<300)return ' recent'; if(a!=null&&a>=1800)return ' old'; return ''; }

function render(fromPoll){
  if(!view)return; lastRenderAt=Date.now();
  renderSrc(); renderStat(); renderStale();   // first, so data that trips compute() can't freeze the status line
  var c=compute();
  renderFilter(c);
  if(view==='lh')renderList(c);
  else{ if(sizeMap()&&mapObj)mapObj.invalidateSize(); plotPins(fromPoll===true); }   // a banner above the map that came or went moves its top
}
// The talkgroup filter and the search are never invisible, in either view: say what they hide, with the way out right
// there (the map has no search box of its own, so without this a filter set on the list would silently thin the map).
function renderFilter(c){
  ['lhfilt','lhmfilt'].forEach(function(id){ var x=$id(id); if(x)x.textContent=''; });
  var f=$id(view==='map'?'lhmfilt':'lhfilt'), q=query.trim(); if(!f||(!tgFilter&&!q))return;
  var g=tgFilter?c.all.filter(function(r){ return tgCanon(r)===tgFilter; })[0]:null, what=[], n=c.all.length-shownRows.length;
  if(tgFilter)what.push(g?g.tg:(tgName||'one talkgroup'));
  if(q)what.push('matches for “'+q+'”');
  var b=el('div','ban lhfilt');
  b.appendChild(el('span',null,'Showing only '+what.join(' and ')+(n?(' · '+n+' other '+(n===1?'entry':'entries')+' hidden'):'')+'. '));
  var x=el('button','lhlink','Show all'); x.type='button'; x.dataset.act='clear'; b.appendChild(x); f.appendChild(b); }
function renderSrc(){ var b=$id('lhsrc'); if(!b)return;
  [].forEach.call(b.children,function(x){ x.setAttribute('aria-pressed',String(x.dataset.src===src)); }); }
// "Checked", not "Updated": this line is about the phone asking, and must not read as the opposite of a red
// "Feed not updating" (the collector) right under it
// the last snapshot is older than a few polls with no error to explain it: the screen was just reopened (or woken) and
// the fetch is on its way. Neither "Checked 2 h ago" nor a red "not updating" banner is true of that moment.
function catchingUp(){ return !!lastOk&&!lastErr&&Date.now()-lastOk>45000; }
function renderStat(){ var s=$id('lhstat'); if(!s)return; s.className='lhstat';
  if(!waking)s.style.minHeight='';   // the box a wake tap was answered in keeps its height until the fresh data is drawn
  if(denied){ s.className='ban warn'; s.textContent='Last Heard and Map aren’t available for your account right now. If this doesn’t clear up in a few minutes, ask Christian to add you.'; return; }
  if(lastErr==='signin'){ s.textContent='Sign in to see Last Heard.'; return; }
  if(paused){ s.className='ban'; s.textContent='Updates paused to save data (no taps or clicks for 10 minutes). What you see is from when they paused. Tap or click anywhere to update.'; return; }
  if(waking){ s.className='ban'; s.textContent='Updating…'; return; }
  if(!lastOk){ s.textContent=lastErr?'Can’t reach the Last Heard feed. Trying again…':'Loading…'; return; }
  var a=Math.round((Date.now()-lastOk)/1000);
  // an outage first: it is what is happening now, and the bad-data line would hide it for as long as it lasts
  if(lastErr){ s.textContent='Can’t reach the feed right now. Trying again. What you see is from '+(a<60?'less than a minute ago':ago(a))+'.'; return; }
  if(catchingUp()){ s.textContent='Updating…'; return; }
  if(renderErr||(src==='all'?Object.keys(badFeeds).length>0:badFeeds[src])){ s.className='ban warn'; s.textContent='Some of the latest data couldn’t be shown, so part of what you see may be old. It tries again with every update.'; return; }
  s.textContent='Checked '+(a<10?'just now':ago(a))+' · every 15 seconds'; }   // one line at 320 px: every line above the map is taken from it
// board logic (updateStaleBanner), drawn as an app banner: red = nothing published in 15 min, amber = no change in 3 h,
// grey = no change in 30 min. Nothing at all until a feed has been seen.
function renderStale(){ var e=$id('lhstale'); if(!e)return;
  var names=src==='hs'?['dmr']:src==='net'?['pnw']:src==='bm'?['bm']:src==='tgif'?['tgif']:['dmr','pnw','bm','tgif'];
  var now=srvNow(), arrival=null, change=null, anySeen=false;
  names.forEach(function(n){ var s=_feedSeen[n]; if(!s)return;
    if(s.at){ anySeen=true; var a=now-s.at; if(arrival===null||a<arrival)arrival=a; }
    if(s.changedAt){ var c=now-s.changedAt; if(change===null||c<change)change=c; } });
  e.hidden=true; if(!anySeen||denied||catchingUp())return;
  var many=src==='all';   // All: the freshest of the three decides, so these speak of the feeds together
  if(arrival>STALL_MS){ e.className='ban warn lhred'; e.textContent=(many?'Feeds not updating: nothing new from them in ':'Feed not updating: nothing new from it in ')+dur(arrival/1000)+'. What you see is old, not current.'; }
  else if(change>FROZEN_MS){ e.className='ban warn'; e.textContent='No new activity in '+dur(change/1000)+'. Either nobody is talking or '+(many?'the feeds are':'the feed is')+' stuck. Treat what you see as old.'; }
  else if(change>QUIET_MS){ e.className='lhstat'; e.textContent='No new activity in '+dur(change/1000)+'. '+(many?'At least one feed is':'The feed is')+' connected and updating.'; }
  else return;
  e.hidden=false; }

/* Last Heard list */
function emptyText(c){
  if(offlineNow())return (FEEDNAME[src]||'The feeds')+(src==='all'?' are':' is')+' offline right now.';
  if(!lastOk)return '';
  if(noFeedData())return src==='all'?'Nothing from the feeds yet. People show up here as soon as they report.':'Nothing from this feed yet. People show up here as soon as it reports.';
  if(!shownRows.length)return c.all.length?'Nothing matches. Tap Show all.':(src==='all'?'Nobody heard yet.':'Nobody heard yet on this network.');
  return ''; }
function renderList(c){
  var list=$id('lhlist'); if(!list)return;
  renderLive(c);   // whoever is keyed now sorts to the top of the list itself (age 0), marked red, so there is no separate card
  list.textContent='';
  // the footnote says what this list is, and explains Listen only when a Listen button is actually on screen
  var msg=emptyText(c), nt=$id('lhnote'), lis=!msg&&shownRows.slice(0,MAX_ROWS).some(function(r){ return listenId(r)>0; });
  if(nt)nt.textContent=NOTE_SRC[src]+' Times are Pacific.'+(lis?' Listen moves this app to the BrandMeister talkgroup that person was heard on, and your talk button then talks there too. To go back, tap HOLDEN or TGIF at the top of Talk, then your channel.':'');
  if(msg||!shownRows.length){ if(msg)list.appendChild(el('div','empty',msg)); return; }
  // All with one network down still has rows from the others, so without this the outage would read as a quiet network
  if(src==='all'){ var off=['net','hs','bm','tgif'].filter(function(k){ return feeds[k]&&feeds[k].online===false; });
    if(off.length)list.appendChild(el('div','ban',off.map(function(k,i){ return i?FEEDNAME[k].replace(/^The/,'the'):FEEDNAME[k]; }).join(' and ')+(off.length>1?' are':' is')+' offline right now. Showing the others.')); }
  shownRows.slice(0,MAX_ROWS).forEach(function(r,i){
    var d=el('div','hl lhr'+ageCls(r));
    var top=el('div','lhtop'); top.appendChild(el('span','w',r.call+(r.name?' · '+r.name:''))); top.appendChild(el('span','lhage',isNow(r)?'talking now':ago(rowAgeSec(r)))); d.appendChild(top);
    if(r.loc)d.appendChild(el('div','q',r.loc));
    var t=el('div','t'); sysTags(r).forEach(function(x){ t.appendChild(tagEl(x)); });
    t.appendChild(document.createTextNode((r.tg||'?')+times(r.cnt)+(pacTime(r.t)?' · '+pacTime(r.t):''))); d.appendChild(t);
    var rp=repText(r); if(rp)d.appendChild(el('div','q lhrep',rp));
    d.dataset.i=i; actions(d,r); list.appendChild(d); });
  if(shownRows.length>MAX_ROWS)list.appendChild(el('p','note','Showing the newest '+MAX_ROWS+' of '+shownRows.length+'. Search to find someone older.'));
}
function actions(d,r){ var lid=listenId(r), p=resolveLL(r); if(!lid&&!p)return;
  var a=el('div','lhact'), i=shownRows.indexOf(r);
  if(lid){ var b=el('button','lhbtn','Listen'); b.type='button'; b.dataset.act='listen'; b.dataset.i=i; b.setAttribute('aria-label','Listen to '+(r.tg||'this talkgroup')+' on BrandMeister'); a.appendChild(b); }
  if(p){ var m=el('button','lhbtn','Show on map'); m.type='button'; m.dataset.act='map'; m.dataset.i=i; m.setAttribute('aria-label','Show '+r.call+' on the map'); a.appendChild(m); }
  d.appendChild(a); }
// board buildLiveNow, but over the network picked above (the board's chips read every feed; here a chip for a talkgroup
// the list isn't showing would filter it down to nothing). Last 60 min, grouped by talkgroup, newest 12. Tap = only that TG.
function renderLive(c){
  var box=$id('lhlive'); if(!box)return;
  var byTg={};
  c.all.forEach(function(r){ var age=rowAgeSec(r); if(age==null||age>3600)return;
    var key=tgCanon(r), g=byTg[key]; if(!g)g=byTg[key]={tg:r.tg,canon:key,age:age,live:false,calls:{},tally:{}};
    if(age<g.age)g.age=age; if(isNow(r))g.live=true; g.calls[r.call||'?']=1;
    var ck=sysColorKey(r); g.tally[ck]=(g.tally[ck]||0)+1; });
  var groups=Object.keys(byTg).map(function(k){ return byTg[k]; }).sort(function(a,b){ return a.age-b.age; }).slice(0,12);
  // a redraw keeps the strip where the finger left it; another network's strip starts at its newest chip
  var strip=$id('lhchips'), sl=(stripSrc===src)?strip.scrollLeft:0; stripSrc=src; strip.textContent=''; box.hidden=!groups.length;
  groups.forEach(function(g){ var n=Object.keys(g.calls).length, ck=Object.keys(g.tally).sort(function(a,b){ return g.tally[b]-g.tally[a]; })[0]||'oth';
    var b=el('button','lhchip'); b.type='button'; b.dataset.act='tg'; b.dataset.tg=g.canon; b.dataset.tgn=g.tg||''; b.setAttribute('aria-pressed',String(tgFilter===g.canon));
    if(!g.live)b.style.opacity=Math.max(.8,ageOpacity(g.age)).toFixed(2);   // not below .8: dimmer fails contrast
    var dot=el('i','lhdot'+(g.live?' live':'')); dot.style.background=SYSCOL[ck]||SYSCOL.oth; b.appendChild(dot);
    var w=el('span','lhcw'); w.appendChild(el('span','lhct',g.tg||'?')); w.appendChild(el('span','lhcm',(g.live?'talking now':ago(g.age))+(n>1?' · '+n+' people':''))); b.appendChild(w);
    strip.appendChild(b); });
  strip.scrollLeft=sl;
}

/* ---------- map ---------- */
var BASE_KEY='hd2_mapbase', BASE_LBL={voyager:'Streets',positron:'Light',dark:'Dark'};
var baseIdx=(function(){ var s='dark'; try{ s=localStorage.getItem(BASE_KEY)||'dark'; }catch(e){} for(var i=0;i<BASEMAPS.length;i++)if(BASEMAPS[i].k===s)return i; return 2; })();
// One stylesheet link at a time. One that failed removes itself and is asked for again 10 s later while the map is on
// screen: kept in <head>, it would block every retry, and a map built without leaflet.css is a jumble of tiles.
// One retry timer each for the stylesheet and the script: every failure starting its own would multiply them for as long
// as the map sits open with no connection.
var cssT=null, leafT=null;
function ensureCss(){ if($id('lhleafcss'))return;
  var c=document.createElement('link'); c.id='lhleafcss'; c.rel='stylesheet'; c.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
  c.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY='; c.crossOrigin='';
  c.onload=function(){ if(mapObj)mapObj.invalidateSize(); };
  c.onerror=function(){ c.remove(); if(!cssT)cssT=setTimeout(function(){ cssT=null; if(view==='map')ensureCss(); },10000); };
  document.head.appendChild(c); }
function ensureLeaflet(cb){
  ensureCss();
  if(window.L&&window.L.map){ cb(); return; }
  if(leafletState===1)return; leafletState=1;
  var s=document.createElement('script'); s.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
  s.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo='; s.crossOrigin='';
  var done=false, stall=setTimeout(fail,20000);   // a download that hangs counts as a failure, so the map is never blank and silent
  function fail(){ if(done)return; done=true; clearTimeout(stall); leafletState=0; leafletFailAt=Date.now(); s.remove();
    var m=$id('lhmapmsg'); if(m){ m.hidden=false; m.textContent='The map couldn’t load. Trying again in a few seconds.'; sizeMap(); }
    if(!leafT)leafT=setTimeout(function(){ leafT=null; if(view==='map'&&!mapObj)showMap(); },10500); }
  s.onload=function(){ if(done)return; done=true; clearTimeout(stall); leafletState=0; cb(); };
  s.onerror=fail;
  document.head.appendChild(s); }
function applyBase(){ if(!mapObj)return; if(tileLyr){ mapObj.removeLayer(tileLyr); tileLyr=null; }
  var bm=BASEMAPS[baseIdx]||BASEMAPS[2], ls=[L.tileLayer(bm.url,{maxZoom:18,maxNativeZoom:bm.nz,zIndex:1,attribution:BASE_ATTR})];
  if(bm.ref)ls.push(L.tileLayer(bm.ref,{maxZoom:18,maxNativeZoom:bm.nz,zIndex:2}));
  tileLyr=L.layerGroup(ls).addTo(mapObj);
  var b=$id('lhbase'); if(b){ b.textContent=BASE_LBL[bm.k]||'Style'; b.setAttribute('aria-label','Map style: '+(BASE_LBL[bm.k]||bm.k)+'. Tap to change.'); } }
function cycleBase(){ baseIdx=(baseIdx+1)%BASEMAPS.length; try{ localStorage.setItem(BASE_KEY,BASEMAPS[baseIdx].k); }catch(e){} applyBase(); }
function fitReset(){ userMoved=false; if(mapObj)mapObj._fitted=false; plotPins(); }
// The map fills the space between its top edge and the tab bar, so the page never has to scroll: Leaflet takes every
// swipe that lands on the map, so a map taller than the screen would trap the finger.
// Measured from the map's place on the page, not on the screen, so a page that has scrolled doesn't grow it. It is never
// under 180 px: when that runs past the tab bar (a small phone with banners above the map) the tab bar paints over it
// (#lhmap is its own stacking layer) and .lhshort moves Style, Fit and the key to the map's top edge, still in reach.
// While a popup is open those buttons are hidden (.lhpopopen), so on a short map they never sit over its close button.
// True when the height changed.
function sizeMap(){ var m=$id('lhmap'); if(!m||m.offsetParent===null)return false;
  var tb=$id('tabbar'), tr=(tb&&!tb.hidden)?tb.getBoundingClientRect():null, bottom=(tr&&tr.height)?tr.top:window.innerHeight;
  var top=m.getBoundingClientRect().top+(window.pageYOffset||0), room=Math.round(bottom-top-12), h=Math.max(180,room);
  shortMap=h-room-12>4; m.classList.toggle('lhshort',shortMap);   // px of map under the tab bar: past ~4, the bottom row (10 px up) gets covered
  m.style.setProperty('--lhh',h+'px');   // the open key's panel stays inside the map
  if(m.style.height===h+'px')return false; m.style.height=h+'px'; return true; }
// Fit (board fitReset, patched in build_lh.js) keeps pins out from under the row of map buttons (44 px + 10 px margin),
// which is at the bottom edge, or at the top on a short map
var shortMap=false;
// what Fit frames (board fitPins, patched): the places of the precisely-placed stations, or of everyone when nobody is
// precise, as plotPins last saw them before merging into dots. Merging depends on the zoom; these don't.
var fitLL=[];
function fitPts(){ return fitLL; }
function fitPad(){ return shortMap?{paddingTopLeft:[30,64],paddingBottomRight:[30,30]}:{paddingTopLeft:[30,30],paddingBottomRight:[30,64]}; }
function mapCtl(pos,build){ var C=L.Control.extend({options:{position:pos},onAdd:function(){ var d=L.DomUtil.create('div','lhctl'); build(d); L.DomEvent.disableClickPropagation(d); L.DomEvent.disableScrollPropagation(d); return d; }}); return new C(); }
function initMap(){
  if(mapObj)return;
  // zoom buttons only with a mouse: a phone pinches, and on a 343 px map the buttons sit on top of every popup
  var coarse=false, still=false; try{ coarse=matchMedia('(pointer: coarse)').matches; still=matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
  // trackResize off: Leaflet's own resize handler also runs while the map is hidden and then remembers a 0×0 map;
  // the app's resize handler (in build) and showMap re-measure it only while it is on screen
  mapObj=L.map('lhmap',{zoomControl:!coarse,zoomAnimation:!still,fadeAnimation:!still,markerZoomAnimation:!still,trackResize:false}).setView([44.0,-120.5],6);
  mapObj.attributionControl.setPrefix('');
  mapCtl('bottomright',function(d){   // bottom row, next to the key: the top stays clear for popups
    var b=L.DomUtil.create('button','lhmbtn',d); b.type='button'; b.id='lhbase'; b.onclick=cycleBase;
    var f=L.DomUtil.create('button','lhmbtn',d); f.type='button'; f.textContent='Fit'; f.setAttribute('aria-label','Fit the map to everyone heard'); f.onclick=fitReset; }).addTo(mapObj);
  mapCtl('bottomleft',function(d){ d.id='lhkey'; }).addTo(mapObj);
  applyBase();
  mapObj.on('dragstart',function(){ userMoved=true; });
  mapObj.on('zoomstart',function(){ if(!mapObj._prog)userMoved=true; });
  mapObj.on('zoomend',function(){ plotPins(); });
  mapObj.on('popupopen',function(){ popOpen=true; $id('lhmap').classList.add('lhpopopen'); });
  mapObj.on('popupclose',function(){ popOpen=false; $id('lhmap').classList.remove('lhpopopen'); setTimeout(function(){ plotPins(true); },0); });
  renderKey();
}
var keyOpen=false; try{ keyOpen=localStorage.getItem('hd2_mapkey')==='1'; }catch(e){}
var lastCount=null;
// counts people, as every dot, title and popup does (a station heard on two talkgroups is one station, not two)
function renderKey(){ var k=$id('lhkey'); if(!k)return;
  var ae=document.activeElement, hadF=!!(ae&&k.contains&&k.contains(ae)); k.textContent='';   // rebuilt on every redraw: keep its focus
  var mp=$id('lhmap'); if(mp)mp.classList.toggle('lhkeyopen',keyOpen);
  // the count is hidden on a narrow map (.lhkn), where it would run under Style; it stays in the button's name
  var cnt=lastCount?(lastCount.people+(lastCount.people===1?' station':' stations')):'';
  var t=el('button','lhkeyb','Key'); if(cnt)t.appendChild(el('span','lhkn',' · '+cnt)); t.appendChild(document.createTextNode(keyOpen?' ▾':' ▸'));
  t.type='button'; t.setAttribute('aria-label',cnt?'Key, '+cnt:'Key'); t.setAttribute('aria-expanded',String(keyOpen));
  t.onclick=function(){ keyOpen=!keyOpen; try{ localStorage.setItem('hd2_mapkey',keyOpen?'1':'0'); }catch(e){} renderKey(); }; k.appendChild(t);
  if(hadF){ try{ t.focus({preventScroll:true}); }catch(e){} }
  if(!keyOpen)return;
  // one panel beside the button (above it, or below it on a short map), no taller than the map: it scrolls if it must
  var p=el('div','lhkrows'); k.appendChild(p);
  [['#ff5b52','Talking now'],[SYSCOL.pnw,'PNW'],[SYSCOL.pnwe,'PNW-E'],[SYSCOL.bm,'BrandMeister'],[SYSCOL.tgif,'TGIF'],[SYSCOL.hs,'Hotspot']].forEach(function(x){
    var r=el('div','lhki'); var i=el('i'); i.style.background=x[0]; r.appendChild(i); r.appendChild(document.createTextNode(x[1])); p.appendChild(r); });
  var ap=el('div','lhki'); ap.appendChild(el('i','ap')); ap.appendChild(document.createTextNode('Dashed = only the state or country is known')); p.appendChild(ap);
  p.appendChild(el('div','lhki','Bigger = more people · brighter = more recent')); }
function showMap(){
  var msg=$id('lhmapmsg'); if(msg)msg.hidden=true;
  // re-measure now, not in 90 ms: show() draws (and may Fit) the pins straight after this, and a Fit against the size
  // Leaflet last saw (the phone turned, or the toolbar moved, while the map was hidden) zooms in on the wrong box
  sizeMap(); if(mapObj)mapObj.invalidateSize();
  ensureLeaflet(function(){
    if(view!=='map')return;
    if(msg&&!mapObj)msg.hidden=true;
    initMap(); mapOpen=true;
    setTimeout(function(){ if(!mapObj||view!=='map')return; sizeMap(); mapObj.invalidateSize(); plotPins(); },90); });
  // a slow first download would otherwise be an empty box under "Checked just now"
  if(msg&&!mapObj&&leafletState===1){ msg.hidden=false; msg.textContent='Loading the map…'; sizeMap(); } }
// board plotPins, with the popup built as DOM (no feed text ever parsed as HTML) and Listen as an in-app button.
// A 15 s poll leaves the pins alone when nothing changed, or while a popup is open (a redraw would blink it shut and
// open again under the reader's finger); closing the popup catches up. Every other caller (zoom, fit, focus, and the
// user's own Show all, network and talkgroup taps) redraws, popup or not: the popup reopens on its place.
var plotSig='', popOpen=false;
function focusPopup(mk){ var pe=mk.getPopup()&&mk.getPopup().getElement(); if(!pe)return;
  pe.setAttribute('tabindex','-1'); try{ pe.focus({preventScroll:true}); }catch(e){} }
function plotPins(fromPoll){
  if(!mapObj||!window.L||view!=='map')return;
  // the 2-minute clock in the signature lets pins fade with age on a quiet network, where nothing else changes; the map
  // message is in it so a feed going offline (same rows) says so at the next poll, not at the next 2-minute bucket; the
  // map's width is in it because each popup's width is set from it (a phone turned sideways and back)
  var sig=src+'|'+tgFilter+'|'+query+'|'+mapObj.getZoom()+'|'+mapObj.getSize().x+'|'+Math.floor(srvNow()/120000)+'|'+(liveOk()?'':'s')+'|'+emptyText(lastC)+'|'+shownRows.map(function(r){ return r.call+r.t+r.tg+(r.now?1:0); }).join(',');
  if(fromPoll===true&&!mapFocusPlace&&(sig===plotSig||popOpen))return;
  plotSig=sig;
  // placed and grouped before the old pins come off: a row that trips placement leaves the last good map, not a blank one
  var base={}, mapped=0, who={};
  shownRows.forEach(function(r){ var p=resolveLL(r); if(!p)return; mapped++; who[r.call||'?']=1; r._pl=p.place;
    var gk=p.ll[0].toFixed(3)+','+p.ll[1].toFixed(3);
    if(!base[gk])base[gk]={ll:p.ll,place:p.place,exact:p.exact,rows:[]};
    base[gk].rows.push(r); });
  var ex=[], all=[]; Object.keys(base).forEach(function(k){ all.push(base[k].ll); if(base[k].exact)ex.push(base[k].ll); });
  fitLL=ex.length?ex:all;
  var groups=clusterGroups(Object.keys(base).map(function(k){ return base[k]; }));
  // above the map (below it would sit behind the tab bar); its coming and going moves the map's top, so re-measure, and
  // before the pins and the Fit: a Fit made first would be framed for the taller map and slide under the map buttons.
  // lastC is the compute() that made these shownRows, so the message and the pins always agree.
  var msg=$id('lhmapmsg');
  if(msg&&lastOk){ var et=emptyText(lastC); msg.hidden=!!mapped&&!et; if(!msg.hidden)msg.textContent=et||'Nobody shown here has a known location.';
    if(sizeMap())mapObj.invalidateSize(); }
  // Removing a marker drops keyboard focus on the page: note where it was (a pin, or inside its open popup) so the
  // rebuilt pin holding the same place gets it back. Otherwise a keyboard user loses their place every 2 minutes.
  var openPlace=null, ae=document.activeElement, focusPop=false, focusPl=null;
  mapMk.forEach(function(m){
    if(m._pl&&m.isPopupOpen&&m.isPopupOpen()){ openPlace=m._pl; var pe=m.getPopup().getElement(); if(pe&&ae&&pe.contains(ae))focusPop=true; }
    if(ae&&m._icon===ae)focusPl=m._pl;
    mapObj.removeLayer(m); });
  mapMk=[];
  groups.forEach(function(grp){
    var _ca={}; grp.rows.forEach(function(r){ _ca[r.call||'?']=1; }); var n=Object.keys(_ca).length, tally={};
    grp.rows.forEach(function(r){ var k=sysColorKey(r); tally[k]=(tally[k]||0)+1; });
    var key=Object.keys(tally).sort(function(a,b){ return tally[b]-tally[a]; })[0]||'oth';
    var ages=grp.rows.map(rowAgeSec).filter(function(a){ return a!=null; });
    grp.fresh=ages.length?Math.min.apply(null,ages):null;
    var live=grp.rows.some(isNow);
    var col=live?'#ff5b52':(SYSCOL[key]||SYSCOL.oth), op=live?1:ageOpacity(grp.fresh);
    var d=Math.round(24+Math.min(28,Math.sqrt(Math.max(0,n-1))*10));   // board 20 + ...: a little bigger for a finger
    // For a finger, what takes the tap is a 44 px circle centred on the dot; clusterGroups keeps separate pins 44 px
    // apart there (THRESH), so a tap on a dot opens that dot. Only a dot of 5 or more people is wider than 44 px, and its
    // edge can reach a few px into a neighbour's circle. A mouse taps the dot.
    var D=COARSE?Math.max(44,d):d;
    var icon=L.divIcon({className:'lhhit',iconSize:[D,D],iconAnchor:[D/2,D/2],html:'<div class="mpin'+(live?' live':'')+(grp.exact?'':' approx')+'" style="--pc:'+col+';width:'+d+'px;height:'+d+'px;line-height:'+(d-4)+'px;font-size:'+(n>9?12:13)+'px;opacity:'+op.toFixed(2)+'">'+n+'</div>'});
    var mk=L.marker([grp.ll[0],grp.ll[1]],{icon:icon,zIndexOffset:live?1000:0,keyboard:true,title:grp.place+', '+n+(n===1?' station':' stations')});
    // fits a 180 px map (content + its frame and tip) and a 320 px phone (its frame adds 32 px; 10 px pan room each side);
    // the map's buttons hide while it is open (.lhpopopen)
    mk.bindPopup(function(){ return pinPopup(grp); },{maxWidth:Math.max(160,Math.min(280,mapObj.getSize().x-52)),maxHeight:Math.max(120,mapObj.getSize().y-80),className:'lhpop',autoPanPaddingTopLeft:[10,10],autoPanPaddingBottomRight:[10,10]});
    mk._pl=grp.place; mk._places=grp.places; mk._exact=grp.exact;
    if(n===1&&mapObj.getZoom()>=7){   // name labels only once zoomed in: at state level on a phone they pile on top of each other
      var soleCall=Object.keys(_ca)[0], soleTg=(grp.rows[0]&&grp.rows[0].tg)||'';
      mk.bindTooltip(esc(soleCall)+(soleTg?' <span class="lbltg">· '+esc(soleTg)+'</span>':''),{permanent:true,direction:'top',offset:[0,-(d/2)-2],className:'mpin-label'}); }
    mk.addTo(mapObj); mapMk.push(mk);
    // by any town the pin holds: new rows can move a merged pin's anchor from Gresham to Portland
    var holds=function(pl){ return !!pl&&(grp.place===pl||!!(grp.places&&grp.places[pl])); };
    if(holds(openPlace)){ mk.openPopup(); if(focusPop)focusPopup(mk); }
    if(holds(focusPl)&&mk._icon){ try{ mk._icon.focus({preventScroll:true}); }catch(e){} } });
  if(mapFocusPlace){
    var fmk=mapMk.filter(function(m){ return m._places&&m._places[mapFocusPlace]; })[0];
    if(fmk){ mapObj._prog=true; mapObj.setView(fmk.getLatLng(),Math.max(mapObj.getZoom(),8),{animate:false}); fmk.openPopup(); userMoved=true; mapObj._fitted=true; setTimeout(function(){ mapObj._prog=false; },60);
      focusPopup(fmk); }   // the "Show on map" button that had focus is gone with the list: hand focus to the popup that answers it
    mapFocusPlace=null; }
  if(mapMk.length&&!userMoved&&!mapObj._fitted)fitPins();
  // plain "Key" until there is data to count: "0 stations" under Loading… or a refusal reads as "nobody on the air"
  lastCount=(lastOk&&!denied)?{places:groups.length,people:Object.keys(who).length}:null; renderKey();
}
function pinPopup(g){
  // per station: its newest row, and how often it talked on each talkgroup here. PNW and BM give one row per run of keyups
  // (or per session), so a QSO on one talkgroup is many rows: rows are not talkgroups.
  var seen={}, uniq=[];
  g.rows.forEach(function(r){ var k=(r.call||'?'), a=rowAgeSec(r), tk=tgCanon(r), s=seen[k];
    if(!s){ s=seen[k]={r:r,age:a,tgs:{}}; uniq.push(s); }
    else if(a!=null&&(s.age==null||a<s.age)){ s.r=r; s.age=a; }
    s.tgs[tk]=(s.tgs[tk]||0)+(r.cnt||1); });
  var box=el('div','lhpc');
  var np=(g.nplaces||1)-1, h=el('div','lhph',g.place+(np?' and '+np+' nearby '+(np===1?'place':'places'):'')); box.appendChild(h);
  box.appendChild(el('div','lhpm',uniq.length+(uniq.length===1?' station':' stations')+(g.fresh!=null?' · '+ago(g.fresh):'')+(g.exact?'':' · only the state or country is known')));
  uniq.slice(0,10).forEach(function(u){ var r=u.r, d=el('div','lhpr'), ntg=Object.keys(u.tgs).length;
    d.appendChild(el('div','lhpn',r.call+(r.name?' · '+r.name:'')+(ntg>1?' · on '+ntg+' talkgroups':'')+(isNow(r)?' · talking now':'')));
    d.appendChild(el('div','lhpt',(r.tg||'?')+times(u.tgs[tgCanon(r)])+(pacTime(r.t)?' · '+pacTime(r.t):'')));
    var rp=repText(r); if(rp)d.appendChild(el('div','lhpt',rp));
    if(r.loc&&g.nplaces>1&&r._pl!==r.loc)d.appendChild(el('div','lhpt','Home: '+r.loc));
    var lid=listenId(r); if(lid){ var b=el('button','lhbtn','Listen'); b.type='button'; b.setAttribute('aria-label','Listen to '+(r.tg||'this talkgroup')+' on BrandMeister'); b.onclick=function(){ listen(r); }; d.appendChild(b); }
    box.appendChild(d); });
  if(uniq.length>10)box.appendChild(el('div','lhpt','+'+(uniq.length-10)+' more'));
  return box; }

/* ---------- skeleton, events, lifecycle ---------- */
var CSS=[
/* wraps: "Hotspot" gets the room it needs at 320 px, and at page zoom the row goes to two lines instead of off the edge */
'.lhsrc{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}',
'.lhsrc>button{flex:1 1 auto;min-height:48px;padding:0 8px;border:1px solid var(--bd);border-radius:12px;background:var(--panel);color:var(--mut);font-weight:700;font-size:16px;line-height:1.15}',
'.lhsrc>button[aria-pressed="true"]{border-color:var(--sky);color:var(--sky);background:rgba(133,183,235,.12)}',
// five buttons since TGIF (2026-11-10): on a 320 px phone they wrapped, leaving Hotspot alone on a second row. Less side
// padding keeps them on one row there (they still wrap if a wider font needs it); never under 44 px wide, for a finger
'@media (max-width:359px){.lhsrc{gap:6px}.lhsrc>button{padding:0 4px;min-width:44px}}',
'.lhstat{font-size:15px;color:var(--mut);margin:0 0 10px}.lhstat:empty{display:none}',
'.ban.lhred{border-color:var(--red);color:#ffb3b5;background:rgba(229,72,77,.12)}',
'#lhlive{margin:0 0 12px}.lhlh{font-size:14px;font-weight:700;letter-spacing:.4px;color:var(--mut);margin:0 0 6px}',
'#lhchips{display:flex;gap:8px;overflow-x:auto;padding:0 0 4px;-webkit-overflow-scrolling:touch}',
/* a finger swipes the strip; a mouse needs its scrollbar to reach the chips past the edge */
'@media (pointer:coarse){#lhchips{scrollbar-width:none}#lhchips::-webkit-scrollbar{display:none}}',
'.lhchip{flex:none;display:flex;align-items:center;gap:8px;min-height:52px;max-width:220px;padding:6px 12px;border:1px solid var(--bd);border-radius:12px;background:var(--panel);text-align:left}',
'.lhchip[aria-pressed="true"]{border-color:var(--sky);background:rgba(133,183,235,.12)}',
'.lhcw{display:flex;flex-direction:column;min-width:0}.lhct{font-weight:700;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.lhcm{font-size:13px;color:var(--mut);white-space:nowrap}',
'.lhdot{flex:none;width:10px;height:10px;border-radius:50%}.lhdot.live{box-shadow:0 0 0 0 rgba(255,91,82,.7);animation:lhp 1.4s ease-out infinite}',
'@keyframes lhp{70%{box-shadow:0 0 0 8px rgba(255,91,82,0)}100%{box-shadow:0 0 0 0 rgba(255,91,82,0)}}',
'#lhqf{margin:0 0 12px}#lhq{width:100%;min-height:52px;padding:0 14px;border:1px solid var(--bd);border-radius:12px;background:var(--panel);color:var(--tx);font-size:17px;margin:0}',
'#lhmfilt .lhfilt{margin:0 0 10px}',
'.lhfilt{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:0 0 12px}',
'.lhlink{min-height:44px;padding:0 6px;border:none;background:none;color:var(--sky);font-weight:700;text-decoration:underline}',
/* old rows: the name goes grey; the row keeps full opacity so the 12 px network tags stay readable (4.5:1) */
'.lhr.now{border-color:var(--red);box-shadow:inset 4px 0 0 var(--red)}.lhr.recent{border-color:var(--sky)}.lhr.old .w{color:var(--mut)}',
'.lhtop{display:flex;align-items:baseline;gap:10px}.lhtop .w{flex:1;min-width:0}.lhage{flex:none;font-size:14px;color:var(--mut);white-space:nowrap}.lhr.now .lhage{color:#ff9a9d;font-weight:700}',
'.lhsys{display:inline-block;font-size:12px;font-weight:800;letter-spacing:.4px;padding:1px 6px;margin-right:6px;border:1px solid var(--sc);color:var(--sc);border-radius:6px;vertical-align:1px}',
'.lhrep{font-size:14px}',
'.lhact{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}',
'.lhbtn{min-height:44px;padding:0 14px;border:1px solid var(--bd2);border-radius:10px;background:var(--panel2);color:var(--tx);font-weight:700;font-size:15px}',
/* its own stacking layer: Leaflet's panes (z-index 400-1000) then stay under the fixed tab bar (30) and the tour (60) */
'#lhmap{position:relative;z-index:0;isolation:isolate;height:360px;border:1px solid var(--bd);border-radius:14px;overflow:hidden;background:var(--panel)}',
'#lhmapmsg{margin:0 0 10px}',
/* a map at its 180 px floor runs under the tab bar: its bottom row of buttons moves to the top edge */
'#lhmap.lhshort .leaflet-bottom{top:0;bottom:auto}#lhmap.lhshort .leaflet-bottom .leaflet-control{margin-top:10px;margin-bottom:0}',
/* short map on a PC: the key now sits where the zoom buttons are, so they step down below it */
'#lhmap.lhshort .leaflet-top.leaflet-left{top:54px}',
/* a popup has the map to itself: Style, Fit, the key and the tile credit sit above popups (Leaflet's control layer), so
   on a small map they would cover its text, its close button or its Listen button. They come back when it closes. */
'#lhmap.lhpopopen .lhctl,#lhmap.lhpopopen .leaflet-control-attribution{visibility:hidden}',
/* leaflet.css is added to <head> after this block, so anything that must beat it is prefixed with #lhmap */
'#lhmap.leaflet-container{background:#1b1f24;font:15px/1.4 var(--sans)}',
'#lhmap .leaflet-control-zoom a{width:44px;height:44px;line-height:44px;font-size:22px;background:var(--panel2);color:var(--tx);border-color:var(--bd)}',
'#lhmap .leaflet-bar{border:1px solid var(--bd)}',
'#lhmap .leaflet-control-attribution{background:rgba(11,22,34,.8);color:var(--mut);font-size:11px}#lhmap .leaflet-control-attribution a{color:var(--sky)}',
'#lhmap .lhctl{display:flex;gap:6px}',
'#lhmap .lhmbtn{min-width:64px;min-height:44px;padding:0 10px;border:1px solid var(--bd);border-radius:10px;background:rgba(19,36,58,.94);color:var(--tx);font:700 15px var(--sans)}',
'#lhmap .lhkeyb{min-height:44px;padding:0 10px;border:1px solid var(--bd);border-radius:10px;background:rgba(19,36,58,.94);color:var(--tx);font:700 14px var(--sans)}',
/* the open key: a column (a row would run off the map's edge), the button staying on the map's edge and the panel on
   the map side of it; --lhh is the map's height (sizeMap), less the button, its margins and the gaps */
'#lhmap #lhkey{flex-direction:column-reverse;align-items:flex-start}#lhmap.lhshort #lhkey{flex-direction:column}',
/* Style and Fit sit a line higher than the key (the tile credit is under them): the panel starts above their top */
'#lhmap:not(.lhshort) #lhkey .lhkrows{margin-bottom:20px}',
/* on a short map the tile credit moves up under Style and Fit, where the open key's panel would cover it; the key stays
   open from one visit to the next, so the credit goes back down to the map's bottom edge rather than out of sight
   (the tile licences want it shown). The panel ends 30 px above that edge (max-height above). */
'#lhmap.lhshort.lhkeyopen .leaflet-control-attribution{position:absolute;top:calc(var(--lhh,180px) - 18px);right:0;margin:0;white-space:nowrap}',
'#lhmap #lhkey .lhkrows{max-width:min(240px,calc(100vw - 72px));max-height:calc(var(--lhh,360px) - 90px);overflow-y:auto;background:rgba(11,22,34,.94);border:1px solid var(--bd);border-radius:10px;padding:6px 0}',
'#lhmap #lhkey .lhki{color:var(--tx);font-size:13px;padding:2px 10px}#lhmap #lhkey .lhki:last-child{color:var(--mut)}',
'@media (max-width:359px){#lhmap .lhkn{display:none}}',
'#lhmap .lhki i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}#lhmap .lhki i.ap{border:1.5px dashed var(--mut)}',
/* round: the tap area is the 44 px circle, which is what clusterGroups keeps apart (a square's corners would overlap) */
'#lhmap .lhhit{display:flex;align-items:center;justify-content:center;border-radius:50%}#lhmap .lhhit:focus-visible{outline:3px solid var(--sky);outline-offset:-2px}',
'#lhmap .mpin{flex:none;border-radius:50%;text-align:center;font-weight:800;color:#08131f;background:var(--pc);border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 2px rgba(0,0,0,.35),0 0 12px var(--pc);box-sizing:border-box}',
'#lhmap .mpin.approx{background:rgba(11,22,34,.55);color:var(--pc);border-style:dashed;border-color:var(--pc)}',
'#lhmap .mpin.live{animation:lhmp 1.4s ease-out infinite}',
'@keyframes lhmp{0%{box-shadow:0 0 0 2px rgba(0,0,0,.3),0 0 0 0 rgba(240,80,80,.65)}70%{box-shadow:0 0 0 2px rgba(0,0,0,.3),0 0 0 15px rgba(240,80,80,0)}100%{box-shadow:0 0 0 2px rgba(0,0,0,.3),0 0 0 0 rgba(240,80,80,0)}}',
'#lhmap .leaflet-tooltip.mpin-label{background:rgba(11,22,34,.9);border:1px solid var(--bd);color:var(--tx);font:700 12px var(--sans);padding:2px 6px;border-radius:6px;box-shadow:none}',
'#lhmap .leaflet-tooltip.mpin-label::before{display:none}#lhmap .mpin-label .lbltg{color:var(--mut);font-weight:400}',
'#lhmap .lhpop .leaflet-popup-content-wrapper,#lhmap .lhpop .leaflet-popup-tip{background:var(--panel);color:var(--tx);border:1px solid var(--bd2)}',
'#lhmap .lhpop .leaflet-popup-content{margin:12px 14px;font:15px/1.4 var(--sans)}',
'#lhmap .lhpop a.leaflet-popup-close-button{width:44px;height:44px;font:26px/44px var(--sans);color:var(--mut)}',
'#lhmap .lhph{font-weight:800;font-size:16px;padding-right:30px}#lhmap .lhpm{color:var(--mut);font-size:14px;margin-bottom:4px}',
'#lhmap .lhpr{border-top:1px solid var(--bd);padding:8px 0 6px}#lhmap .lhpn{font-weight:700}#lhmap .lhpt{color:var(--mut);font-size:14px}#lhmap .lhpr .lhbtn{margin-top:6px}',
'@media (prefers-reduced-motion:reduce){.lhdot.live,#lhmap .mpin.live{animation:none}}'
].join('\n');
function build(){
  var host=$id('hv-net'); if(!host||$id('lhsrc'))return;
  var st=document.createElement('style'); st.id='lhcss'; st.textContent=CSS; document.head.appendChild(st);
  host.textContent='';
  // captioned on screen: the same short labels as Talk's network switch, but these only pick what to show
  var sh=el('div','lhlh','SHOW WHO WAS HEARD ON'); sh.id='lhsrch'; host.appendChild(sh);
  var s=el('div','lhsrc'); s.id='lhsrc'; s.setAttribute('role','group'); s.setAttribute('aria-labelledby','lhsrch');
  SRCS.forEach(function(x){ var b=el('button',null,x[1]); b.type='button'; b.dataset.src=x[0]; if(x[0]==='bm')b.setAttribute('aria-label','BM (BrandMeister)'); s.appendChild(b); });
  host.appendChild(s);
  var stat=el('div','lhstat'); stat.id='lhstat'; host.appendChild(stat);
  var stale=el('div','lhstat'); stale.id='lhstale'; stale.hidden=true; host.appendChild(stale);
  var lh=el('div'); lh.id='hv-lh'; lh.hidden=true;
  var live=el('div'); live.id='lhlive'; live.hidden=true; live.appendChild(el('div','lhlh','TALKGROUPS · LAST 60 MIN'));
  var ch=el('div'); ch.id='lhchips'; ch.setAttribute('role','group'); ch.setAttribute('aria-label','Talkgroups heard in the last 60 minutes'); live.appendChild(ch); lh.appendChild(live);
  // in a form, so the keyboard's Search key closes the keyboard (and brings the tab bar back) on iOS
  var qf=el('form'); qf.id='lhqf'; qf.setAttribute('role','search'); qf.action='#';
  var q=el('input'); q.id='lhq'; q.type='search'; q.placeholder='Search calls, names, places'; q.setAttribute('aria-label','Search Last Heard');
  q.autocomplete='off'; q.setAttribute('autocapitalize','off'); q.setAttribute('enterkeyhint','search'); q.spellcheck=false; qf.appendChild(q); lh.appendChild(qf);
  qf.addEventListener('submit',function(e){ e.preventDefault(); q.blur(); });
  var f=el('div'); f.id='lhfilt'; lh.appendChild(f);
  var list=el('div'); list.id='lhlist'; lh.appendChild(list);
  var nt=el('p','note'); nt.id='lhnote'; lh.appendChild(nt);   // filled by renderList: it depends on the network picked
  host.appendChild(lh);
  var mp=el('div'); mp.id='hv-map'; mp.hidden=true;
  var mf=el('div'); mf.id='lhmfilt'; mp.appendChild(mf);
  var mm=el('div','empty'); mm.id='lhmapmsg'; mm.hidden=true; mp.appendChild(mm);   // above the map: below, the tab bar covers it
  var mapd=el('div'); mapd.id='lhmap'; mapd.setAttribute('role','region'); mapd.setAttribute('aria-label','Map of stations heard'); mp.appendChild(mapd);
  host.appendChild(mp);
  s.addEventListener('click',function(e){ var b=e.target.closest('button'); if(!b||!b.dataset.src)return;
    src=b.dataset.src; try{ localStorage.setItem('hd2_lhsrc',src); }catch(e2){}
    // a talkgroup picked on one network that the next one hasn't heard would leave an empty list with nothing pressed
    try{ if(tgFilter&&!merged().some(function(r){ return tgCanon(r)===tgFilter; })){ tgFilter=null; tgName=''; } }catch(e3){}
    if(mapObj){ mapObj._fitted=false; userMoved=false; } safeRender(); });
  q.addEventListener('input',function(){ query=q.value||''; if(view)safeRender(); });
  host.addEventListener('click',function(e){ var b=e.target.closest('button[data-act]'); if(!b||!host.contains(b))return;
    var act=b.dataset.act, r=shownRows[+b.dataset.i];
    if(act==='tg'){ var off=(tgFilter===b.dataset.tg); tgFilter=off?null:b.dataset.tg; tgName=off?'':(b.dataset.tgn||''); safeRender(); }
    else if(act==='clear'){ tgFilter=null; tgName=''; query=''; q.value=''; safeRender(); }
    else if(act==='listen'&&r)listen(r);
    else if(act==='map'&&r){ var p=resolveLL(r); if(p){ mapFocusPlace=p.place; if(typeof setHeardView==='function')setHeardView('map'); } } });
  // re-plot only when the width changed (popup width); iOS resizes the height whenever its toolbar slides away
  window.addEventListener('resize',function(){ if(view==='map'&&mapObj){ var w=mapObj.getSize().x; sizeMap(); mapObj.invalidateSize(); if(mapObj.getSize().x!==w)plotPins(); } });
  // any touch, key or scroll counts as someone looking (the idle pause) and holds a poll redraw for HOLD_MS. Scroll is
  // caught on the way down, so a swipe along the talkgroup strip (an element, not the page) counts too.
  // pointercancel: a press-and-hold or a pan that scrolled nothing ends there, never in pointerup, and should still wake
  ['pointerdown','pointerup','pointercancel','keydown','wheel','scroll'].forEach(function(t){ document.addEventListener(t,noteTouch,{capture:true,passive:true}); });
  // back online while a retry is waiting out its back-off: try now
  window.addEventListener('online',function(){ if(view&&!inFlight&&lastErr&&lastErr!=='signin')schedule(0); });
}
function show(v){
  build();
  var changed=(view!==v); view=v;
  $id('hv-lh').hidden=(v!=='lh'); $id('hv-map').hidden=(v!=='map');
  // opening a view is someone looking at it; the tap that opened it doesn't hold the first redraw (holdAt)
  if(changed){ lastTouch=Date.now(); holdAt=0; paused=false; waking=wakeDraw=false; if(wakeT){ clearTimeout(wakeT); wakeT=null; } }
  if(denied&&changed){ denied=false; fails=0; n401=0; lastErr=null; }        // they may have been added since: ask again
  // index.html calls show() on every chrome repaint, so the map is only (re)opened when this view just came on screen,
  // or when Leaflet failed to load and a few seconds have passed (it is retried rather than left blank). A repaint can
  // also have shown or hidden a banner above the map ("Reconnecting…"), so the map is re-measured every time.
  if(v!=='map')mapOpen=false;
  else if(changed||(!mapObj&&leafletState===0&&!leafT&&Date.now()-leafletFailAt>10000))showMap();
  else if(mapObj&&sizeMap())mapObj.invalidateSize();
  // hello just told us this account has no BrandMeister (or now has it): Listen buttons go or come without waiting for a poll
  var nb=noBm(), nbChanged=(lastNoBm!==null&&nb!==lastNoBm); lastNoBm=nb;
  if(paused){ if(nbChanged)renderSoon(); return; }
  if(changed)safeRender(); else if(nbChanged||!pollT)renderSoon();   // a repaint is held like a poll redraw
  // schedule, never poll() here: a timer already pending is replaced, not left running beside a new chain
  if((changed||!pollT)&&!inFlight)schedule(lastOk?Math.max(0,POLL_MS-(Date.now()-lastOk)):0);
}
function hide(){ view=null; mapOpen=false; waking=wakeDraw=false; if(pollT){ clearTimeout(pollT); pollT=null; } if(renderT){ clearTimeout(renderT); renderT=null; } if(wakeT){ clearTimeout(wakeT); wakeT=null; } }
window.LH={show:show,hide:hide};
})();
