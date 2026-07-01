let token = localStorage.getItem("TOKEN") || "";
let me = null;
let limits = null;
let autoTimer = null;
let queueRunning = false;
let results = [];
let selected = null;
let locks = JSON.parse(localStorage.getItem("DEWA_V6_LOCKS") || "{}");
let DEWA_LAST_DIR = JSON.parse(localStorage.getItem("DEWA_LAST_DIR") || "{}");

const $ = id => document.getElementById(id);

const PRESETS = {
  crypto: ["BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "ADA/USD"],
  forex: ["EUR/USD", "GBP/USD", "USD/JPY", "AUD/USD", "USD/CAD"],
  gold: ["XAU/USD", "XAG/USD"],
  hybrid: ["BTC/USD", "ETH/USD", "XAU/USD", "EUR/USD"]
};

function fmt(x) {
  return Number.isFinite(x)
    ? Number(x).toLocaleString("en-US", { maximumFractionDigits: 6 })
    : "-";
}

function priceFmt(pair, x) {
  if (!Number.isFinite(x)) return "-";

  pair = String(pair || "");

  if (pair.includes("JPY")) {
    return Number(x).toLocaleString("en-US", { maximumFractionDigits: 3 });
  }

  if (pair.includes("/") && !pair.includes("XAU") && !pair.includes("XAG")) {
    return Number(x).toLocaleString("en-US", { maximumFractionDigits: 5 });
  }

  if (pair.includes("XAU") || pair.includes("XAG")) {
    return Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  if (Number(x) >= 1000) {
    return Number(x).toLocaleString("en-US", { maximumFractionDigits: 2 });
  }

  return Number(x).toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function authLog(x) {
  $("authLog").textContent =
    new Date().toLocaleTimeString() + " - " + x + "\n" + $("authLog").textContent;
}

function log(x) {
  $("log").textContent =
    new Date().toLocaleTimeString() + " - " + x + "\n" + $("log").textContent;
}

function headers() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + token
  };
}

async function api(p, o = {}) {
  const r = await fetch(p, {
    ...o,
    headers: {
      ...(o.headers || {}),
      ...headers()
    }
  });

  const d = await r.json().catch(() => ({}));

  if (!r.ok || d.error) {
    throw Error(d.error || "API error");
  }

  return d;
}

async function login() {
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: $("email").value,
        password: $("password").value
      })
    });

    const d = await r.json();

    if (!r.ok || d.error) {
      throw Error(d.error || "Login gagal");
    }

    token = d.token;
    localStorage.setItem("TOKEN", token);

    await loadMe();
  } catch (e) {
    authLog(e.message);
  }
}

async function requestAccess() {
  try {
    const r = await fetch("/api/auth/request-access", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email: $("email").value
      })
    });

    const d = await r.json();

    if (!r.ok || d.error) {
      throw Error(d.error || "Request gagal");
    }

    authLog("Request access berhasil. Tunggu approval admin.");
  } catch (e) {
    authLog(e.message);
  }
}

function logout() {
  localStorage.removeItem("TOKEN");
  location.reload();
}

async function loadMe() {
  try {
    const d = await api("/api/auth/me");

    me = d.user;
    limits = d.limits;

    $("authScreen").classList.add("hidden");
    $("appScreen").classList.remove("hidden");
    $("uEmail").textContent = me.email;
    $("uPlan").textContent = me.plan;
    $("uStatus").textContent = me.status;
    $("uExpired").textContent = (me.expiredAt || "-").slice(0, 10);
    $("uEaKey").textContent = me.eaApiKey || "-";
    $("adminPanel").style.display = me.role === "admin" ? "block" : "none";

    if (me.mustChangePassword) {
      showChangePassword();
    }

    applyMarket();
  } catch (e) {
    localStorage.removeItem("TOKEN");
    authLog(e.message);
  }
}

if (token) {
  loadMe();
}

function showChangePassword() {
  $("changePasswordCard").classList.remove("hidden");
}

async function changePassword() {
  try {
    await api("/api/auth/change-password", {
      method: "POST",
      body: JSON.stringify({
        password: $("newPassword").value
      })
    });

    $("changePasswordCard").classList.add("hidden");
    log("Password berhasil diganti.");

    await loadMe();
  } catch (e) {
    log(e.message);
  }
}

function saveLocks() {
  localStorage.setItem("DEWA_V6_LOCKS", JSON.stringify(locks));
}

function saveLastDir() {
  localStorage.setItem("DEWA_LAST_DIR", JSON.stringify(DEWA_LAST_DIR));
}

function symbols() {
  return $("symbols").value
    .split(",")
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function applyMarket() {
  const m = $("market").value;

  if (m !== "custom") {
    $("symbols").value = PRESETS[m].join(",");
  }
}

function stop() {
  if (autoTimer) {
    clearInterval(autoTimer);
  }

  autoTimer = null;
  queueRunning = false;
  $("scanStatus").textContent = "Stopped";
  log("Stopped");
}

function resetSignals() {
  locks = {};
  saveLocks();
  render();
}

function start() {
  stop();
  scanQueue();
  autoTimer = setInterval(scanQueue, Number($("refresh").value) * 1000);
  $("scanStatus").textContent = "Auto ON";
}

function isCryptoSymbol(s) {
  return !s.includes("/") && !s.includes(":");
}

function tfLabel() {
  const v = $("tf").value;
  return v === "60" ? "1H" : v === "240" ? "4H" : v + "m";
}

function getHTFTf() {
  const tf = String($("tf").value);

  if (tf === "5") return "60";
  if (["15", "30", "60"].includes(tf)) return "240";
  if (tf === "240") return "D";

  return "60";
}

function intervalFromTf(src, tf) {
  if (tf === "5") return "5min";
  if (tf === "15") return "15min";
  if (tf === "30") return "30min";
  if (tf === "60") return "1h";
  if (tf === "240") return "4h";
  if (tf === "D") return "1day";

  return "5min";
}

async function fetchCandles(symbol, customTf=null){
  let tf=customTf||$("tf").value;
  let url="/api/twelvedata/candles"
    +"?symbol="+encodeURIComponent(symbol)
    +"&interval="+intervalFromTf("twelvedata",tf)
    +"&outputsize=180";

  let r=await fetch(url,{
    cache:"no-store",
    headers:{"Authorization":"Bearer "+token}
  });

  let d=await r.json();

  if(!r.ok||d.error)throw Error(d.error||"Twelve Data error");

  let candles=(d.values||[])
    .map(v=>({
      time:v.datetime,
      open:+v.open,
      high:+v.high,
      low:+v.low,
      close:+v.close,
      volume:+(v.volume||1)
    }))
    .filter(c=>Number.isFinite(c.close))
    .reverse();

  if(candles.length<40)throw Error("Candle < 40");

  return{candles,source:"Twelve Data"};
}
function lockExpired(sym){let L=locks[sym];if(!L)return true;let age=Date.now()-new Date(L.createdAt||0).getTime();return age>Number($("tf").value||5)*3*60*1000||["🔴 SL HIT","🏆 FULL TP"].includes(L.status)}async function scanQueue(){if(queueRunning)return;queueRunning=true;let list=symbols();if(limits&&list.length>limits.maxPairs){list=list.slice(0,limits.maxPairs)}results=[];render();for(let i=0;i<list.length;i++){let sym=list[i];try{let data=await fetchCandles(sym),htf=null;try{htf=await fetchCandles(sym,getHTFTf())}catch(e){}let sig=analyzeEngine(sym,data.candles,data.source,htf?htf.candles:null),live=sig.livePrice;if(locks[sym]){

  const reverseStatus = reverseAllowed(sym, locks[sym], sig);

  if(reverseStatus){

    sig.signal = reverseStatus === "REVERSE LONG"
      ? "OPEN LONG"
      : "OPEN SHORT";

    sig.status = reverseStatus;
    sig.color = "purple";
    sig.locked = true;

    locks[sym] = {
      signal:sig.signal,
      status:sig.status,
      color:sig.color,
      entry:sig.entry,
      tp1:sig.tp1,
      tp2:sig.tp2,
      tp3:sig.tp3,
      sl:sig.sl,
      createdAt:new Date().toISOString(),
      tf:tfLabel(),
      pair:sym,
      grade:sig.grade,
      engine:sig.engine,
      reverse:true
    };

    markReverse(sym);
    saveLocks();

    saveSignal(sym,sig);
    broadcastSignal(sym,sig);

  }else if(lockExpired(sym)){

    delete locks[sym];
    saveLocks();

  }else{

    let updated=updateLockedSignal(sym,live);

    sig={
      ...sig,
      ...updated,
      candles:sig.candles,
      locked:true,
      source:data.source
    };

  }
}if(!locks[sym]&&["SMC LONG","SMC SHORT","SNIPER LONG","SNIPER SHORT","HYBRID CONFIRM"].includes(sig.status)){locks[sym]={signal:sig.signal,status:"🔵 RUNNING",color:"blue",entry:sig.entry,tp1:sig.tp1,tp2:sig.tp2,tp3:sig.tp3,sl:sig.sl,createdAt:new Date().toISOString(),tf:tfLabel(),pair:sym,grade:sig.grade,engine:sig.engine};saveLocks();sig.status="🔵 RUNNING";sig.color="blue";sig.locked=true;saveSignal(sym,sig);broadcastSignal(sym,sig)}results.push(sig);log(sym+" OK")}catch(e){results.push({symbol:sym,source:"-",signal:"ERROR",status:e.message,color:"yellow",candles:[]});log(sym+" error: "+e.message)}render();if(results.length===1)pick(results[0].symbol);if(i<list.length-1)await sleep(Math.max(Number($("delay").value),limits?limits.delayMs:0))}$("scanStatus").textContent="Scan complete";queueRunning=false;loadAnalytics()}function updateLockedSignal(sym,price){let L=locks[sym];if(!L||!Number.isFinite(price))return L;if(L.signal==="OPEN LONG"){if(price>=L.tp3){L.status="🏆 FULL TP";L.color="green"}else if(price>=L.tp2){L.status="🟢 TP2 HIT";L.color="green"}else if(price>=L.tp1){L.status="🟢 TP1 HIT";L.color="green"}else if(price<=L.sl){L.status="🔴 SL HIT";L.color="red"}else{L.status="🔵 RUNNING";L.color="blue"}}if(L.signal==="OPEN SHORT"){if(price<=L.tp3){L.status="🏆 FULL TP";L.color="green"}else if(price<=L.tp2){L.status="🟢 TP2 HIT";L.color="green"}else if(price<=L.tp1){L.status="🟢 TP1 HIT";L.color="green"}else if(price>=L.sl){L.status="🔴 SL HIT";L.color="red"}else{L.status="🔵 RUNNING";L.color="blue"}}saveSignal(sym,L);return L}async function saveSignal(sym,r){try{if(!r.entry)return;await api("/api/signals/upsert",{method:"POST",body:JSON.stringify({key:`${sym}|${r.tf||tfLabel()}|${r.signal}|${r.entry}`,pair:sym,tf:r.tf||tfLabel(),signal:r.signal,entry:r.entry,tp1:r.tp1,tp2:r.tp2,tp3:r.tp3,sl:r.sl,status:r.status,createdAt:r.createdAt||new Date().toISOString(),grade:r.grade,engine:r.engine})})}catch(e){}}
function ema(a,p){if(!a.length)return NaN;let k=2/(p+1),e=a[0];for(let i=1;i<a.length;i++)e=a[i]*k+e*(1-k);return e}function atr(c,p=14){let t=[];for(let i=1;i<c.length;i++)t.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));let s=t.slice(-p);return s.length?s.reduce((a,b)=>a+b,0)/s.length:0}function sma(a,p){let s=a.slice(-p);return s.length?s.reduce((x,y)=>x+y,0)/s.length:0}function seriesEma(v,p){let out=Array(v.length).fill(null),k=2/(p+1),e=v[0];out[0]=e;for(let i=1;i<v.length;i++){e=v[i]*k+e*(1-k);out[i]=e}return out}function pineRsi(v,p=14){if(v.length<=p)return 50;let g=0,l=0;for(let i=1;i<=p;i++){let d=v[i]-v[i-1];if(d>=0)g+=d;else l-=d}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){let d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p}if(al===0)return 100;return 100-(100/(1+ag/al))}function pineMacd(v){let e12=seriesEma(v,12),e26=seriesEma(v,26),m=v.map((_,i)=>(e12[i]||0)-(e26[i]||0)),s=seriesEma(m,9),i=v.length-1;return{macdVal:m[i]||0,macdSig:s[i]||0,macdHist:(m[i]||0)-(s[i]||0)}}function getGrade(s){if(s>=8)return"A+";if(s>=6.5)return"A";if(s>=5)return"B";return"C"}function dmi(c,p=14){let trs=[],pd=[],md=[];for(let i=1;i<c.length;i++){let up=c[i].high-c[i-1].high,down=c[i-1].low-c[i].low;trs.push(Math.max(c[i].high-c[i].low,Math.abs(c[i].high-c[i-1].close),Math.abs(c[i].low-c[i-1].close)));pd.push(up>down&&up>0?up:0);md.push(down>up&&down>0?down:0)}let tr=sma(trs,p),diPlus=tr?100*sma(pd,p)/tr:0,diMinus=tr?100*sma(md,p)/tr:0,adx=(diPlus+diMinus)?100*Math.abs(diPlus-diMinus)/(diPlus+diMinus):0;return{adx,diPlus,diMinus}}function vwap(c){let pv=0,v=0;for(let k of c){let vol=k.volume||1,typ=(k.high+k.low+k.close)/3;pv+=typ*vol;v+=vol}return v?pv/v:c[c.length-1].close}
function pineParams(){let tf=Number($("tf").value||5);if(tf<=5)return{preset:"Scalping",emaFast:5,emaSlow:13,emaTrend:34,rsiLen:8,atrLen:10,effectiveScore:4,slMult:.8};if(tf<=60)return{preset:"Default",emaFast:9,emaSlow:21,emaTrend:55,rsiLen:13,atrLen:14,effectiveScore:5,slMult:1.5};return{preset:"Swing",emaFast:13,emaSlow:34,emaTrend:89,rsiLen:21,atrLen:20,effectiveScore:6,slMult:2.5}}
function analyzeSMCPine(symbol,candles,source,htfCandles){let c=candles.slice(0,-1),live=candles[candles.length-1];if(c.length<80)return{symbol,source,signal:"WAIT",status:"DATA LOW",color:"yellow",candles:c,engine:"SMC PINE",livePrice:live?.close};let last=c[c.length-1],close=c.map(x=>x.close),e9=ema(close.slice(-80),9),e20=ema(close.slice(-80),20),a=atr(c,14),s=c.slice(-20),structureHigh=Math.max(...s.map(x=>x.high)),structureLow=Math.min(...s.map(x=>x.low)),bosBull=last.close>structureHigh,bosBear=last.close<structureLow,emaLong=e9>e20&&last.close>e9,emaShort=e9<e20&&last.close<e9,htfBias=e9>e20?1:-1;if(htfCandles&&htfCandles.length>50){let hc=htfCandles.slice(0,-1).map(x=>x.close),hf=ema(hc.slice(-80),9),hs=ema(hc.slice(-80),20);htfBias=hf>hs?1:hf<hs?-1:0}let score=0;if(bosBull||bosBear)score+=2;if(emaLong||emaShort)score+=1.5;score+=1;if((bosBull&&htfBias===1)||(bosBear&&htfBias===-1))score+=1.5;let grade=getGrade(score),signal="WAIT",status="NO TRADE",color="yellow",entry,tp1,tp2,tp3,sl,target=a*2;if(bosBull&&emaLong&&htfBias!==-1&&score>=5){signal="OPEN LONG";status="SMC LONG";color="green";entry=structureHigh;tp1=entry+target*.8;tp2=entry+target*1.6;tp3=entry+target*2.8;sl=entry-target*1.2}else if(bosBear&&emaShort&&htfBias!==1&&score>=5){signal="OPEN SHORT";status="SMC SHORT";color="red";entry=structureLow;tp1=entry-target*.8;tp2=entry-target*1.6;tp3=entry-target*2.8;sl=entry+target*1.2}let aiAnalysis=`<b>⚡ DEWA SMC AI</b><br><b>Pair:</b> ${symbol}<br><b>Engine:</b> SMC PINE<br><b>HTF:</b> ${htfBias===1?"Bullish":"Bearish"}<br><b>Grade:</b> ${grade}<br><br><b>Entry:</b> ${priceFmt(symbol,entry)}<br><b>TP1:</b> ${priceFmt(symbol,tp1)}<br><b>TP2:</b> ${priceFmt(symbol,tp2)}<br><b>TP3:</b> ${priceFmt(symbol,tp3)}<br><b>SL:</b> ${priceFmt(symbol,sl)}`;return{symbol,source,signal,status,color,entry,tp1,tp2,tp3,sl,candles:c,structureHigh,structureLow,atr:a,volOk:true,locked:false,livePrice:live.close,engine:"SMC PINE",grade,score,aiAnalysis}}
function analyzeSniperFull(symbol,candles,source,htfCandles){let c=candles.slice(0,-1),live=candles[candles.length-1];if(c.length<80)return{symbol,source,signal:"WAIT",status:"DATA LOW",color:"yellow",candles:c,engine:"SNIPER PINE HTF",livePrice:live?.close};let p=pineParams(),last=c[c.length-1],close=c.map(x=>x.close),ef=seriesEma(close,p.emaFast),es=seriesEma(close,p.emaSlow),et=ema(close.slice(-140),p.emaTrend),emaFast=ef.at(-1),emaSlow=es.at(-1),prevFast=ef.at(-2),prevSlow=es.at(-2),rsi=pineRsi(close,p.rsiLen),mac=pineMacd(close),adx=dmi(c,14),vw=vwap(c),a=atr(c,p.atrLen),vol=c.map(x=>x.volume||1),volAbove=vol.at(-1)>sma(vol,20)*1.2,htfBias=emaFast>emaSlow?1:-1;if(htfCandles&&htfCandles.length>50){let hc=htfCandles.slice(0,-1).map(x=>x.close),hf=ema(hc.slice(-120),p.emaFast),hs=ema(hc.slice(-120),p.emaSlow),ht=ema(hc.slice(-140),p.emaTrend);htfBias=(hf>hs&&hc.at(-1)>ht)?1:(hf<hs&&hc.at(-1)<ht)?-1:0}let bull=0,bear=0;bull+=emaFast>emaSlow?1:0;bear+=emaFast<emaSlow?1:0;bull+=last.close>et?1:0;bear+=last.close<et?1:0;bull+=rsi>50&&rsi<75?1:0;bear+=rsi<50&&rsi>25?1:0;bull+=mac.macdHist>0?1:0;bear+=mac.macdHist<0?1:0;bull+=mac.macdVal>mac.macdSig?1:0;bear+=mac.macdVal<mac.macdSig?1:0;bull+=last.close>vw?1:0;bear+=last.close<vw?1:0;bull+=volAbove?1:0;bear+=volAbove?1:0;bull+=adx.adx>20&&adx.diPlus>adx.diMinus?1:0;bear+=adx.adx>20&&adx.diMinus>adx.diPlus?1:0;bull+=htfBias===1?1.5:0;bear+=htfBias===-1?1.5:0;let crossB=prevFast<=prevSlow&&emaFast>emaSlow,crossS=prevFast>=prevSlow&&emaFast<emaSlow,rawB=crossB&&last.close>emaFast&&last.close>emaSlow&&rsi<75&&bull>=p.effectiveScore&&bull>=6.5,rawS=crossS&&last.close<emaFast&&last.close<emaSlow&&rsi>25&&bear>=p.effectiveScore&&bear>=6.5,lastDir=DEWA_LAST_DIR[symbol]||0,signal="WAIT",status="NO TRADE",color="yellow",entry,tp1,tp2,tp3,sl,grade=getGrade(Math.max(bull,bear)),sh=Math.max(...c.slice(-10).map(x=>x.high)),lo=Math.min(...c.slice(-10).map(x=>x.low));if(rawB&&lastDir!==1){entry=last.close;sl=Math.max(entry-a*p.slMult,lo-a*.2);let risk=Math.abs(entry-sl);tp1=entry+risk;tp2=entry+risk*2;tp3=entry+risk*3;signal="OPEN LONG";status="SNIPER LONG";color="green";DEWA_LAST_DIR[symbol]=1;saveLastDir()}else if(rawS&&lastDir!==-1){entry=last.close;sl=Math.min(entry+a*p.slMult,sh+a*.2);let risk=Math.abs(entry-sl);tp1=entry-risk;tp2=entry-risk*2;tp3=entry-risk*3;signal="OPEN SHORT";status="SNIPER SHORT";color="red";DEWA_LAST_DIR[symbol]=-1;saveLastDir()}let aiAnalysis=`<b>⚡ DEWA SNIPER AI</b><br><b>Pair:</b> ${symbol}<br><b>Engine:</b> SNIPER PINE HTF<br><b>Bull:</b> ${bull} | <b>Bear:</b> ${bear} | <b>Grade:</b> ${grade}<br><b>HTF:</b> ${htfBias===1?"Bullish":"Bearish"}<br><br><b>Entry:</b> ${priceFmt(symbol,entry)}<br><b>TP1:</b> ${priceFmt(symbol,tp1)}<br><b>TP2:</b> ${priceFmt(symbol,tp2)}<br><b>TP3:</b> ${priceFmt(symbol,tp3)}<br><b>SL:</b> ${priceFmt(symbol,sl)}`;return{symbol,source,signal,status,color,entry,tp1,tp2,tp3,sl,candles:c,structureHigh:sh,structureLow:lo,atr:a,volOk:true,locked:false,livePrice:live.close,engine:"SNIPER PINE HTF",bullScore:bull,bearScore:bear,grade,aiAnalysis}}
function analyzeHybrid(symbol,candles,source,htf){let smc=analyzeSMCPine(symbol,candles,source,htf),sn=analyzeSniperFull(symbol,candles,source,htf);if(smc.signal===sn.signal&&smc.signal!=="WAIT"&&["A","A+"].includes(sn.grade))return{...sn,status:"HYBRID CONFIRM",engine:"HYBRID PINE HTF"};return{...sn,signal:"WAIT",status:"WAIT HYBRID",color:"yellow",engine:"HYBRID PINE HTF"}}function analyzeEngine(symbol,candles,source,htf){let mode=$("engine").value;if(mode==="sniper")return analyzeSniperFull(symbol,candles,source,htf);if(mode==="hybrid")return analyzeHybrid(symbol,candles,source,htf);return analyzeSMCPine(symbol,candles,source,htf)}
function render(){$("body").innerHTML=results.length?results.map((r,i)=>`<tr onclick="pick('${r.symbol}')"><td>${i+1}</td><td>${r.symbol}</td><td>${r.source||"-"}</td><td class="${r.color}"><b>${displaySignalName(r.signal,r.status)}</b></td><td class="${r.color}"><b>${r.status}</b></td><td>${priceFmt(r.symbol,r.entry)}</td><td>${priceFmt(r.symbol,r.tp1)}</td><td>${priceFmt(r.symbol,r.tp2)}</td><td>${priceFmt(r.symbol,r.tp3)}</td><td>${priceFmt(r.symbol,r.sl)}</td><td>${r.locked?"🔒 LOCKED":"-"}</td></tr>`).join(""):'<tr><td colspan="11" class="muted">Waiting scan...</td></tr>';$("stTotal").textContent=results.length;$("stLong").textContent=results.filter(r=>r.signal==="OPEN LONG").length;$("stShort").textContent=results.filter(r=>r.signal==="OPEN SHORT").length;$("stWait").textContent=results.filter(r=>["WAIT","🔵 RUNNING","WAIT HYBRID","NO TRADE"].includes(r.status)).length;$("stErr").textContent=results.filter(r=>r.signal==="ERROR").length}function pick(sym){let r=results.find(x=>x.symbol===sym);if(!r)return;selected=r;$("chartTitle").textContent=r.symbol+" - "+r.signal;$("mSignal").textContent=r.signal;$("mSignal").className=r.color;$("mStatus").textContent=r.status;$("mStatus").className=r.color;$("mSource").textContent=r.source||"-";$("mHigh").textContent=priceFmt(r.symbol,r.structureHigh);$("mLow").textContent=priceFmt(r.symbol,r.structureLow);$("dEntry").textContent=priceFmt(r.symbol,r.entry);$("dTP1").textContent=priceFmt(r.symbol,r.tp1);$("dTP2").textContent=priceFmt(r.symbol,r.tp2);$("dTP3").textContent=priceFmt(r.symbol,r.tp3);$("dSL").textContent=priceFmt(r.symbol,r.sl);$("dATR").textContent=priceFmt(r.symbol,r.atr);$("aiAnalysis").innerHTML=r.aiAnalysis||"Belum ada analisa";draw(r);calcLot()}
function contractSize(pair){if(pair.includes("XAU"))return 100;if(pair.includes("XAG"))return 5000;if(pair.includes("/"))return 100000;return 1}function pl(pair,signal,lot,entry,target){let move=signal==="OPEN LONG"?target-entry:entry-target;return move*lot*contractSize(pair)}function calcLot(){if(!selected||!selected.entry){$("calcResult").innerHTML="Pilih signal aktif yang memiliki entry.";return}let lot=Number($("lotInput").value||0),r=selected;$("calcResult").innerHTML=`<div class="row"><span>Pair</span><b>${r.symbol}</b></div><div class="row"><span>Lot</span><b>${lot}</b></div><div class="row"><span>TP1 Estimasi</span><b class="green">$${fmt(pl(r.symbol,r.signal,lot,r.entry,r.tp1))}</b></div><div class="row"><span>TP2 Estimasi</span><b class="green">$${fmt(pl(r.symbol,r.signal,lot,r.entry,r.tp2))}</b></div><div class="row"><span>TP3 Estimasi</span><b class="green">$${fmt(pl(r.symbol,r.signal,lot,r.entry,r.tp3))}</b></div><div class="row"><span>SL Estimasi</span><b class="red">$${fmt(pl(r.symbol,r.signal,lot,r.entry,r.sl))}</b></div>`}
async function loadAnalytics(){try{let d=await api("/api/signals/analytics");$("analyticsBox").innerHTML=`<div class="analytics"><div class="stat"><small>TODAY</small><b>${d.today.winrate}%</b><div class="sub">Signal ${d.today.total}</div></div><div class="stat"><small>ALL TIME</small><b>${d.allTime.winrate}%</b><div class="sub">Signal ${d.allTime.total}</div></div></div>`}catch(e){log(e.message)}}async function loadUsers(){try{let d=await api("/api/admin/users");$("adminUsers").innerHTML=d.users.map(u=>`<div class="usercard"><div class="row"><span><b>${u.email}</b><br><span class="muted">${u.plan} • ${String(u.expiredAt||"-").slice(0,10)}</span><br><span class="muted">EA: ${u.eaEnabled?"ON":"OFF"} • MT5: ${u.mt5Account||"-"}</span><br><span class="muted" style="word-break:break-all">KEY: ${u.eaApiKey||"-"}</span></span><span class="badge">${u.status||"-"} ${u.active?"✅":"❌"}</span></div>${u.status==="PENDING"?`<div class="mini"><select id="plan_${u.id}"><option>FREE</option><option>PRO</option><option>VIP</option></select><input id="days_${u.id}" type="number" value="30"><input id="pass_${u.id}" value="DEWA123456"></div><input id="mt5_${u.id}" placeholder="MT5 Account optional"><button class="btnok" onclick="approveUser('${u.id}')">APPROVE</button>`:`<div class="mini"><select id="status_${u.id}"><option ${u.status==="ACTIVE"?"selected":""}>ACTIVE</option><option ${u.status==="BLOCKED"?"selected":""}>BLOCKED</option></select><input id="mt5_${u.id}" value="${u.mt5Account||""}"><select id="ea_${u.id}"><option value="true" ${u.eaEnabled?"selected":""}>EA ON</option><option value="false" ${!u.eaEnabled?"selected":""}>EA OFF</option></select></div><button class="btn2" onclick="updateUser('${u.id}')">UPDATE</button> <button class="btn2" onclick="regenEaKey('${u.id}')">NEW EA KEY</button>`} <button class="btnred" onclick="deleteUser('${u.id}')">DELETE</button></div>`).join("")}catch(e){log(e.message)}}async function approveUser(id){let d=await api("/api/admin/approve-user",{method:"POST",body:JSON.stringify({userId:id,plan:$("plan_"+id).value,days:Number($("days_"+id).value||30),password:$("pass_"+id).value,mt5Account:$("mt5_"+id).value,eaEnabled:true})});log("Approved: "+d.user.email+" | EA Key: "+d.user.eaApiKey);loadUsers()}async function updateUser(id){await api("/api/admin/update-user",{method:"POST",body:JSON.stringify({userId:id,status:$("status_"+id).value,mt5Account:$("mt5_"+id).value,eaEnabled:$("ea_"+id).value==="true"})});loadUsers()}async function regenEaKey(id){await api("/api/admin/regenerate-ea-key",{method:"POST",body:JSON.stringify({userId:id})});loadUsers()}async function deleteUser(id){if(!confirm("Hapus member/request ini?"))return;let r=await fetch("/api/admin/delete-user/"+id,{method:"DELETE",headers:headers()}),d=await r.json();if(!r.ok||d.error)alert(d.error||"Delete gagal");loadUsers()}
function draw(r){let c=r.candles,cv=$("chart"),ctx=cv.getContext("2d");ctx.clearRect(0,0,cv.width,cv.height);ctx.fillStyle="#020617";ctx.fillRect(0,0,cv.width,cv.height);if(!c||c.length<2)return;let max=Math.max(...c.map(x=>x.high)),min=Math.min(...c.map(x=>x.low)),y=v=>cv.height-25-((v-min)/(max-min||1))*(cv.height-55),x=i=>30+i*((cv.width-55)/(c.length-1));c.forEach((k,i)=>{let xx=x(i),yo=y(k.open),yc=y(k.close),yh=y(k.high),yl=y(k.low);ctx.strokeStyle=k.close>=k.open?"#22c55e":"#ef4444";ctx.beginPath();ctx.moveTo(xx,yh);ctx.lineTo(xx,yl);ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.fillRect(xx-2,Math.min(yo,yc),4,Math.max(2,Math.abs(yc-yo)))})}function showPage(page){document.querySelectorAll('.nav div').forEach(x=>x.classList.remove('on'));if(page==="scanner"){$("navScanner").classList.add("on");$("scannerPanel").scrollIntoView({behavior:"smooth"})}if(page==="analytics"){$("navAnalytics").classList.add("on");$("analyticsPanel").scrollIntoView({behavior:"smooth"});loadAnalytics()}if(page==="member"){$("navMember").classList.add("on");document.querySelector(".userbox").scrollIntoView({behavior:"smooth"})}if(page==="admin"){$("navAdmin").classList.add("on");$("adminPanel").scrollIntoView({behavior:"smooth"});loadUsers()}}
function urlBase64ToUint8Array(b){const p="=".repeat((4-b.length%4)%4),base64=(b+p).replace(/-/g,"+").replace(/_/g,"/"),raw=atob(base64),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}async function enablePush(){let perm=await Notification.requestPermission();if(perm!=="granted")return alert("Izin notifikasi ditolak");let reg=await navigator.serviceWorker.ready,k=await api("/api/push/public-key"),sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(k.publicKey)});await api("/api/push/subscribe",{method:"POST",body:JSON.stringify({subscription:sub})});new Notification("⚡ DEWA SMC SIGNAL",{body:"Notifikasi aktif.",icon:"/icon-192.png"})}async function broadcastSignal(sym,r){try{await api("/api/push/broadcast",{method:"POST",body:JSON.stringify({pair:sym,signal:r.signal,entry:priceFmt(sym,r.entry),tp1:priceFmt(sym,r.tp1),tp2:priceFmt(sym,r.tp2),tp3:priceFmt(sym,r.tp3),sl:priceFmt(sym,r.sl)})})}catch(e){}}


/* =========================================================
   V7.0 PINE STATE FIX OVERRIDE
   Tujuan:
   - SNIPER mengikuti Pine lebih dekat:
     ema crossover/crossunder as trigger
     bullScore/bearScore with same weights
     HTF bias +1.5
     grade filter
     lastDirection memory
     trade state: ACTIVE LONG/SHORT
   - Jika signal sudah aktif, web tetap tampil ACTIVE seperti TradingView
   - Entry/TP/SL dikunci sampai TP/SL/reverse
   ========================================================= */

let DEWA_TV_STATE = JSON.parse(localStorage.getItem("DEWA_TV_STATE") || "{}");

function saveTvState(){
  localStorage.setItem("DEWA_TV_STATE", JSON.stringify(DEWA_TV_STATE));
}

function tvGradeMode(){
  // Default dibuat agar hanya A/A+ menjadi signal baru.
  // Active trade B tetap bisa tampil karena berasal dari state sebelumnya.
  return "A";
}

function passesGradeFilter(score){
  const mode = tvGradeMode();
  if(mode === "A+") return score >= 8;
  if(mode === "A") return score >= 6.5;
  if(mode === "B") return score >= 5;
  return score >= 0;
}

function getSniperStateKey(symbol){
  return symbol + "|" + tfLabel() + "|SNIPER";
}

function normalizeStatePrice(v){
  return Number.isFinite(Number(v)) ? Number(v) : NaN;
}

function isLongHit(price, level){ return Number.isFinite(price) && Number.isFinite(level) && price >= level; }
function isShortHit(price, level){ return Number.isFinite(price) && Number.isFinite(level) && price <= level; }

function updatePineTradeState(symbol, livePrice){
  const key = getSniperStateKey(symbol);
  const st = DEWA_TV_STATE[key];
  if(!st || !Number.isFinite(livePrice)) return null;

  if(st.dir === "LONG"){
    if(livePrice <= st.sl){
      st.tradeStatus = "SL HIT";
      st.active = false;
      st.color = "red";
    }else if(livePrice >= st.tp3){
      st.tradeStatus = "TP3 HIT";
      st.active = false;
      st.color = "green";
    }else if(livePrice >= st.tp2){
      st.tradeStatus = "TP2 HIT";
      st.active = true;
      st.color = "green";
    }else if(livePrice >= st.tp1){
      st.tradeStatus = "TP1 HIT";
      st.active = true;
      st.color = "green";
    }else{
      st.tradeStatus = "ACTIVE";
      st.active = true;
      st.color = "blue";
    }
  }

  if(st.dir === "SHORT"){
    if(livePrice >= st.sl){
      st.tradeStatus = "SL HIT";
      st.active = false;
      st.color = "red";
    }else if(livePrice <= st.tp3){
      st.tradeStatus = "TP3 HIT";
      st.active = false;
      st.color = "green";
    }else if(livePrice <= st.tp2){
      st.tradeStatus = "TP2 HIT";
      st.active = true;
      st.color = "green";
    }else if(livePrice <= st.tp1){
      st.tradeStatus = "TP1 HIT";
      st.active = true;
      st.color = "green";
    }else{
      st.tradeStatus = "ACTIVE";
      st.active = true;
      st.color = "blue";
    }
  }

  DEWA_TV_STATE[key] = st;
  saveTvState();
  return st;
}

function stateToResult(symbol, source, candles, live, st, extra={}){
  const signal = st.dir === "LONG" ? "OPEN LONG" : "OPEN SHORT";
  const isClosed = !st.active && (st.tradeStatus === "SL HIT" || st.tradeStatus === "TP3 HIT");
  const status = isClosed ? st.tradeStatus : "ACTIVE " + st.dir;
  const color = st.tradeStatus === "SL HIT" ? "red" : st.tradeStatus.includes("TP") ? "green" : "blue";
  const aiAnalysis = `
    <b>⚡ DEWA SNIPER AI - PINE STATE</b><br>
    <b>Pair:</b> ${symbol}<br>
    <b>Engine:</b> SNIPER PINE STATE<br>
    <b>Status:</b> ${status}<br>
    <b>Trend:</b> ${st.dir === "LONG" ? "BULLISH" : "BEARISH"}<br>
    <b>RSI:</b> ${extra.rsiText || "-"}<br>
    <b>ADX:</b> ${extra.adxText || "-"}<br>
    <b>HTF:</b> ${extra.htfText || st.htfText || "-"}<br>
    <b>Bull:</b> ${extra.bullScore ?? st.bullScore ?? "-"} |
    <b>Bear:</b> ${extra.bearScore ?? st.bearScore ?? "-"} |
    <b>Grade:</b> ${extra.grade || st.grade || "-"}<br><br>
    <b>Entry:</b> ${priceFmt(symbol, st.entry)}<br>
    <b>TP1:</b> ${priceFmt(symbol, st.tp1)}<br>
    <b>TP2:</b> ${priceFmt(symbol, st.tp2)}<br>
    <b>TP3:</b> ${priceFmt(symbol, st.tp3)}<br>
    <b>SL:</b> ${priceFmt(symbol, st.sl)}<br><br>
    <b>Catatan:</b> State ACTIVE mengikuti logic Pine: signal tidak reset tiap candle sampai TP/SL/reverse.
  `;
  return {
    symbol, source,
    signal,
    status,
    color,
    entry: st.entry, tp1: st.tp1, tp2: st.tp2, tp3: st.tp3, sl: st.sl,
    candles,
    structureHigh: extra.structureHigh,
    structureLow: extra.structureLow,
    atr: extra.atrVal,
    volOk: true,
    locked:false,
    livePrice: live ? live.close : undefined,
    engine:"SNIPER PINE STATE",
    grade: extra.grade || st.grade,
    bullScore: extra.bullScore ?? st.bullScore,
    bearScore: extra.bearScore ?? st.bearScore,
    aiAnalysis
  };
}

function analyzeSniperFull(symbol,candles,source,htfCandles){
  const c=candles.slice(0,-1);
  const live=candles[candles.length-1];

  if(c.length<80){
    return {symbol,source,signal:"WAIT",status:"DATA LOW",color:"yellow",candles:c,engine:"SNIPER PINE STATE",livePrice:live?.close};
  }

  const p=pineParams();
  const last=c[c.length-1];
  const close=c.map(x=>x.close);
  const ef=seriesEma(close,p.emaFast);
  const es=seriesEma(close,p.emaSlow);
  const emaFast=ef.at(-1);
  const emaSlow=es.at(-1);
  const prevFast=ef.at(-2);
  const prevSlow=es.at(-2);
  const emaTrend=ema(close.slice(-Math.max(140,p.emaTrend*2)),p.emaTrend);

  const rsi=pineRsi(close,p.rsiLen);
  const mac=pineMacd(close);
  const adx=dmi(c,14);
  const vw=vwap(c);
  const a=atr(c,p.atrLen);
  const vol=c.map(x=>x.volume||1);
  const volAbove=vol.at(-1)>sma(vol,20)*1.2;

  let htfBias=emaFast>emaSlow?1:emaFast<emaSlow?-1:0;
  let htfText="Fallback";
  if(htfCandles&&htfCandles.length>50){
    const hc=htfCandles.slice(0,-1).map(x=>x.close);
    const hf=ema(hc.slice(-120),p.emaFast);
    const hs=ema(hc.slice(-120),p.emaSlow);
    const ht=ema(hc.slice(-140),p.emaTrend);
    htfBias=(hf>hs&&hc.at(-1)>ht)?1:(hf<hs&&hc.at(-1)<ht)?-1:0;
    htfText=htfBias===1?"Bullish HTF":htfBias===-1?"Bearish HTF":"Neutral HTF";
  }

  let bull=0,bear=0;
  bull+=emaFast>emaSlow?1:0;
  bear+=emaFast<emaSlow?1:0;
  bull+=last.close>emaTrend?1:0;
  bear+=last.close<emaTrend?1:0;
  bull+=rsi>50&&rsi<75?1:0;
  bear+=rsi<50&&rsi>25?1:0;
  bull+=mac.macdHist>0?1:0;
  bear+=mac.macdHist<0?1:0;
  bull+=mac.macdVal>mac.macdSig?1:0;
  bear+=mac.macdVal<mac.macdSig?1:0;
  bull+=last.close>vw?1:0;
  bear+=last.close<vw?1:0;
  bull+=volAbove?1:0;
  bear+=volAbove?1:0;
  bull+=adx.adx>20&&adx.diPlus>adx.diMinus?1:0;
  bear+=adx.adx>20&&adx.diMinus>adx.diPlus?1:0;
  bull+=htfBias===1?1.5:0;
  bear+=htfBias===-1?1.5:0;
  bull+=last.close>emaFast?.5:0;
  bear+=last.close<emaFast?.5:0;

  const emaBullCross=prevFast<=prevSlow&&emaFast>emaSlow;
  const emaBearCross=prevFast>=prevSlow&&emaFast<emaSlow;
  const bullMomentum=last.close>emaFast&&last.close>emaSlow;
  const bearMomentum=last.close<emaFast&&last.close<emaSlow;
  const rsiNotOB=rsi<75;
  const rsiNotOS=rsi>25;

  const rawBuy=emaBullCross&&bullMomentum&&rsiNotOB&&bull>=p.effectiveScore&&passesGradeFilter(bull);
  const rawSell=emaBearCross&&bearMomentum&&rsiNotOS&&bear>=p.effectiveScore&&passesGradeFilter(bear);

  const key=getSniperStateKey(symbol);
  const livePrice=live?live.close:last.close;
  let st=updatePineTradeState(symbol,livePrice);

  // Jika ada state aktif seperti TradingView, tampilkan ACTIVE walau score sekarang turun ke B.
  // Invalidation utama: SL/TP3 atau opposite raw signal.
  if(st && st.active){
    if((st.dir==="LONG" && rawSell) || (st.dir==="SHORT" && rawBuy)){
      st.active=false;
      st.tradeStatus="REVERSE";
      DEWA_TV_STATE[key]=st;
      saveTvState();
    }else{
      return stateToResult(symbol,source,c,live,st,{
        rsiText:rsi.toFixed(1), adxText:adx.adx.toFixed(1), htfText,
        bullScore:bull, bearScore:bear, grade:getGrade(Math.max(bull,bear)),
        structureHigh:Math.max(...c.slice(-10).map(x=>x.high)),
        structureLow:Math.min(...c.slice(-10).map(x=>x.low)),
        atrVal:a
      });
    }
  }

  let signal="WAIT",status="NO TRADE",color="yellow",entry,tp1,tp2,tp3,sl;
  let grade=getGrade(Math.max(bull,bear));
  const structureHigh=Math.max(...c.slice(-10).map(x=>x.high));
  const structureLow=Math.min(...c.slice(-10).map(x=>x.low));

  const lastDir = DEWA_LAST_DIR[symbol] || 0;

  if(rawBuy && lastDir!==1){
    entry=last.close;
    sl=Math.max(entry-a*p.slMult,structureLow-a*.2);
    const risk=Math.abs(entry-sl);
    tp1=entry+risk;
    tp2=entry+risk*2;
    tp3=entry+risk*3;
    signal="OPEN LONG";
    status="SNIPER LONG";
    color="green";
    grade=getGrade(bull);
    DEWA_LAST_DIR[symbol]=1; saveLastDir();
    DEWA_TV_STATE[key]={active:true,dir:"LONG",entry,tp1,tp2,tp3,sl,tradeStatus:"ACTIVE",grade,bullScore:bull,bearScore:bear,createdAt:new Date().toISOString(),htfText};
    saveTvState();
  }else if(rawSell && lastDir!==-1){
    entry=last.close;
    sl=Math.min(entry+a*p.slMult,structureHigh+a*.2);
    const risk=Math.abs(entry-sl);
    tp1=entry-risk;
    tp2=entry-risk*2;
    tp3=entry-risk*3;
    signal="OPEN SHORT";
    status="SNIPER SHORT";
    color="red";
    grade=getGrade(bear);
    DEWA_LAST_DIR[symbol]=-1; saveLastDir();
    DEWA_TV_STATE[key]={active:true,dir:"SHORT",entry,tp1,tp2,tp3,sl,tradeStatus:"ACTIVE",grade,bullScore:bull,bearScore:bear,createdAt:new Date().toISOString(),htfText};
    saveTvState();
  }

  const aiAnalysis=`
    <b>⚡ DEWA SNIPER AI - PINE STATE</b><br>
    <b>Pair:</b> ${symbol}<br>
    <b>Engine:</b> SNIPER PINE STATE<br>
    <b>Status:</b> ${status}<br>
    <b>Trend:</b> ${emaFast>emaSlow?"BULLISH":"BEARISH"}<br>
    <b>RSI:</b> ${rsi.toFixed(1)}<br>
    <b>ADX:</b> ${adx.adx.toFixed(1)}<br>
    <b>HTF:</b> ${htfText}<br>
    <b>EMA Cross:</b> ${emaBullCross?"Bull Cross":emaBearCross?"Bear Cross":"No Cross"}<br>
    <b>Bull:</b> ${bull} | <b>Bear:</b> ${bear} | <b>Grade:</b> ${grade}<br>
    <b>Grade Filter:</b> ${passesGradeFilter(Math.max(bull,bear))?"PASS":"WAIT"}<br><br>
    <b>Entry:</b> ${priceFmt(symbol,entry)}<br>
    <b>TP1:</b> ${priceFmt(symbol,tp1)}<br>
    <b>TP2:</b> ${priceFmt(symbol,tp2)}<br>
    <b>TP3:</b> ${priceFmt(symbol,tp3)}<br>
    <b>SL:</b> ${priceFmt(symbol,sl)}<br><br>
    <b>Catatan:</b> Signal baru tetap butuh EMA Cross seperti Pine. Jika sudah muncul, state akan tetap ACTIVE sampai TP/SL/reverse.
  `;

  return {
    symbol,source,signal,status,color,entry,tp1,tp2,tp3,sl,
    candles:c,structureHigh,structureLow,atr:a,volOk:true,locked:false,livePrice:live.close,
    engine:"SNIPER PINE STATE",bullScore:bull,bearScore:bear,grade,aiAnalysis
  };
}

// Override hybrid agar memakai state sniper baru
function analyzeHybrid(symbol,candles,source,htf){
  const smc=analyzeSMCPine(symbol,candles,source,htf);
  const sn=analyzeSniperFull(symbol,candles,source,htf);
  if(smc.signal===sn.signal && smc.signal!=="WAIT" && ["A","A+"].includes(sn.grade)){
    return {...sn,status:"HYBRID CONFIRM",engine:"HYBRID PINE STATE",aiAnalysis:(sn.aiAnalysis||"")+"<br><br><b>HYBRID:</b> SMC dan SNIPER searah."};
  }
  // Jika sniper masih ACTIVE, tetap tampilkan agar sama dengan TV
  if((sn.status||"").startsWith("ACTIVE")){
    return {...sn,engine:"HYBRID PINE STATE"};
  }
  return {...sn,signal:"WAIT",status:"WAIT HYBRID",color:"yellow",engine:"HYBRID PINE STATE"};
}

// RESET SIGNAL juga bersihkan state Pine
const _oldResetSignals = resetSignals;
resetSignals = function(){
  locks={};
  DEWA_TV_STATE={};
  DEWA_LAST_DIR={};
  saveLocks();
  saveTvState();
  saveLastDir();
  log("Locked signals + Pine state reset");
  render();
};


/* =========================================================
   V7.1 A/A+ ONLY NOTIFICATION + EA EXECUTION
   - Signal baru Grade A/A+ saja yang:
     1) kirim push notification
     2) disimpan ke EA endpoint
     3) dieksekusi EA
   - Grade B hanya tampil sebagai ACTIVE continuation jika berasal dari state lama.
   ========================================================= */

function isGradeAPlusWeb(g){
  g = String(g || "").toUpperCase();
  return g === "A" || g === "A+";
}

// Override saveSignal: EA server hanya menerima SNIPER A/A+.
// Signal B continuation tetap bisa tampil di dashboard, tapi tidak dikirim sebagai entry EA.
saveSignal = async function(sym,r){
  try{
    if(!r.entry)return;

    const payload = {
      key:`${sym}|${r.tf||tfLabel()}|${r.signal}|${r.entry}`,
      pair:sym,
      tf:r.tf||tfLabel(),
      signal:r.signal,
      entry:r.entry,
      tp1:r.tp1,
      tp2:r.tp2,
      tp3:r.tp3,
      sl:r.sl,
      status:r.status,
      createdAt:r.createdAt||new Date().toISOString(),
      grade:r.grade,
      engine:r.engine
    };

    // /api/signals/upsert tetap menyimpan history dashboard.
    // Server sudah dipatch agar EA storage hanya menerima SNIPER A/A+.
    await api("/api/signals/upsert",{method:"POST",body:JSON.stringify(payload)});
  }catch(e){}
};

// Override broadcastSignal: push notification hanya untuk signal baru SNIPER A/A+.
broadcastSignal = async function(sym,r){
  try{
    const engine = String(r.engine || "").toUpperCase();
    const isSniper = engine.includes("SNIPER");
    const isEntry = ["OPEN LONG","OPEN SHORT"].includes(r.signal);
    const isA = isGradeAPlusWeb(r.grade);

    if(!isSniper || !isEntry || !isA){
      log("Notif/EA skip: hanya SNIPER Grade A/A+ yang dikirim. "+sym+" grade="+(r.grade||"-"));
      return;
    }

    await api("/api/push/broadcast",{
      method:"POST",
      body:JSON.stringify({
        pair:sym,
        signal:r.signal,
        grade:r.grade,
        engine:r.engine,
        entry:priceFmt(sym,r.entry),
        tp1:priceFmt(sym,r.tp1),
        tp2:priceFmt(sym,r.tp2),
        tp3:priceFmt(sym,r.tp3),
        sl:priceFmt(sym,r.sl)
      })
    });
    log("Notif dikirim: "+sym+" "+r.signal+" Grade "+r.grade);
  }catch(e){
    log("Broadcast notif gagal: "+e.message);
  }
};


/* =========================================================
   V7.2 SMC STATE + SNIPER STATE 95 FINAL
   SMC dibuat lebih mirip Pine/TradingView:
   - Pivot swing high/low
   - BOS body/close validation
   - CHoCH trend shift
   - BOS/CHoCH window 10 candle
   - EMA 9/20 confirmation
   - ATR volatility filter
   - HTF bias
   - Active state memory seperti TradingView
   - Entry/TP/SL terkunci sampai TP/SL/reverse
   ========================================================= */

let DEWA_SMC_STATE = JSON.parse(localStorage.getItem("DEWA_SMC_STATE") || "{}");

function saveSmcState(){
  localStorage.setItem("DEWA_SMC_STATE", JSON.stringify(DEWA_SMC_STATE));
}

function getSmcStateKey(symbol){
  return symbol + "|" + tfLabel() + "|SMC";
}

function smcPivotSwings(c,left=3,right=3){
  const highs=[], lows=[];
  for(let i=left;i<c.length-right;i++){
    let isH=true,isL=true;
    for(let j=i-left;j<=i+right;j++){
      if(j===i)continue;
      if(c[j].high>=c[i].high)isH=false;
      if(c[j].low<=c[i].low)isL=false;
    }
    if(isH)highs.push({i,price:c[i].high,time:c[i].time});
    if(isL)lows.push({i,price:c[i].low,time:c[i].time});
  }
  return {highs,lows};
}

function smcFindRecentEvent(c,structureHigh,structureLow,lookback=10){
  let lastBull=null,lastBear=null;
  for(let n=Math.max(1,c.length-lookback);n<c.length;n++){
    const k=c[n];
    const bodyHigh=Math.max(k.open,k.close);
    const bodyLow=Math.min(k.open,k.close);
    if(k.close>structureHigh && bodyHigh>structureHigh)lastBull={i:n,candle:k};
    if(k.close<structureLow && bodyLow<structureLow)lastBear={i:n,candle:k};
  }
  return {lastBull,lastBear};
}

function updateSmcTradeState(symbol, livePrice){
  const key=getSmcStateKey(symbol);
  const st=DEWA_SMC_STATE[key];
  if(!st||!Number.isFinite(livePrice))return null;

  if(st.dir==="LONG"){
    if(livePrice<=st.sl){st.tradeStatus="SL HIT";st.active=false;st.color="red";}
    else if(livePrice>=st.tp3){st.tradeStatus="TP3 HIT";st.active=false;st.color="green";}
    else if(livePrice>=st.tp2){st.tradeStatus="TP2 HIT";st.active=true;st.color="green";}
    else if(livePrice>=st.tp1){st.tradeStatus="TP1 HIT";st.active=true;st.color="green";}
    else{st.tradeStatus="ACTIVE";st.active=true;st.color="blue";}
  }

  if(st.dir==="SHORT"){
    if(livePrice>=st.sl){st.tradeStatus="SL HIT";st.active=false;st.color="red";}
    else if(livePrice<=st.tp3){st.tradeStatus="TP3 HIT";st.active=false;st.color="green";}
    else if(livePrice<=st.tp2){st.tradeStatus="TP2 HIT";st.active=true;st.color="green";}
    else if(livePrice<=st.tp1){st.tradeStatus="TP1 HIT";st.active=true;st.color="green";}
    else{st.tradeStatus="ACTIVE";st.active=true;st.color="blue";}
  }

  DEWA_SMC_STATE[key]=st;
  saveSmcState();
  return st;
}

function smcStateToResult(symbol,source,c,live,st,extra={}){
  const signal=st.dir==="LONG"?"OPEN LONG":"OPEN SHORT";
  const status=(!st.active&&(st.tradeStatus==="SL HIT"||st.tradeStatus==="TP3 HIT"))?st.tradeStatus:"ACTIVE "+st.dir;
  const color=st.tradeStatus==="SL HIT"?"red":st.tradeStatus.includes("TP")?"green":"blue";
  const aiAnalysis=`
    <b>⚡ DEWA SMC AI - PINE STATE</b><br>
    <b>Pair:</b> ${symbol}<br>
    <b>Engine:</b> SMC PINE STATE<br>
    <b>Status:</b> ${status}<br>
    <b>Market Structure:</b> ${st.mainSignal || "-"}<br>
    <b>Momentum:</b> ${st.dir==="LONG"?"Bullish":"Bearish"}<br>
    <b>EMA Confirm:</b> ${extra.emaText || st.emaText || "-"}<br>
    <b>HTF Bias:</b> ${extra.htfText || st.htfText || "-"}<br>
    <b>Volatility:</b> ${extra.volText || st.volText || "-"}<br>
    <b>Score:</b> ${extra.score ?? st.score ?? "-"} |
    <b>Grade:</b> ${extra.grade || st.grade || "-"}<br>
    <b>Structure High:</b> ${priceFmt(symbol,extra.structureHigh ?? st.structureHigh)}<br>
    <b>Structure Low:</b> ${priceFmt(symbol,extra.structureLow ?? st.structureLow)}<br><br>
    <b>Entry:</b> ${priceFmt(symbol,st.entry)}<br>
    <b>TP1:</b> ${priceFmt(symbol,st.tp1)}<br>
    <b>TP2:</b> ${priceFmt(symbol,st.tp2)}<br>
    <b>TP3:</b> ${priceFmt(symbol,st.tp3)}<br>
    <b>SL:</b> ${priceFmt(symbol,st.sl)}<br><br>
    <b>Catatan:</b> State SMC mengikuti gaya TradingView: signal tetap ACTIVE sampai TP/SL/reverse.
  `;
  return {
    symbol,source,signal,status,color,
    entry:st.entry,tp1:st.tp1,tp2:st.tp2,tp3:st.tp3,sl:st.sl,
    candles:c,structureHigh:extra.structureHigh ?? st.structureHigh,
    structureLow:extra.structureLow ?? st.structureLow,
    atr:extra.atrVal ?? st.atr,
    volOk:true,locked:false,livePrice:live?live.close:undefined,
    engine:"SMC PINE STATE",
    grade:extra.grade || st.grade,
    score:extra.score ?? st.score,
    aiAnalysis
  };
}

function analyzeSMCPine(symbol,candles,source,htfCandles){
  const c=candles.slice(0,-1);
  const live=candles[candles.length-1];

  if(c.length<80){
    return {symbol,source,signal:"WAIT",status:"DATA LOW",color:"yellow",candles:c,engine:"SMC PINE STATE",livePrice:live?.close};
  }

  const last=c[c.length-1];
  const close=c.map(x=>x.close);
  const e9=ema(close.slice(-100),9);
  const e20=ema(close.slice(-120),20);
  const e50=ema(close.slice(-140),50);
  const atrVal=atr(c,14);

  let atrVals=[];
  for(let i=34;i<c.length;i++)atrVals.push(atr(c.slice(0,i+1),14));
  const atrAvg=sma(atrVals,20)||atrVal;
  const volOk=atrVal>=atrAvg*0.85;

  const sw=smcPivotSwings(c,3,3);
  const lastSwingHigh=sw.highs.at(-1);
  const lastSwingLow=sw.lows.at(-1);
  const structureHigh=lastSwingHigh?lastSwingHigh.price:Math.max(...c.slice(-20).map(x=>x.high));
  const structureLow=lastSwingLow?lastSwingLow.price:Math.min(...c.slice(-20).map(x=>x.low));

  const event=smcFindRecentEvent(c,structureHigh,structureLow,10);
  const bosBull=!!event.lastBull;
  const bosBear=!!event.lastBear;

  const prevTrend=e9>e20?"BULLISH":e9<e20?"BEARISH":"NEUTRAL";
  const chochBull=prevTrend==="BEARISH"&&bosBull;
  const chochBear=prevTrend==="BULLISH"&&bosBear;

  const emaLong=e9>e20&&last.close>e9;
  const emaShort=e9<e20&&last.close<e9;

  let htfBias=e9>e20?1:e9<e20?-1:0;
  let htfText=htfBias===1?"Bullish HTF":htfBias===-1?"Bearish HTF":"Neutral HTF";
  if(htfCandles&&htfCandles.length>50){
    const hc=htfCandles.slice(0,-1).map(x=>x.close);
    const hf=ema(hc.slice(-100),9);
    const hs=ema(hc.slice(-120),20);
    const ht=ema(hc.slice(-140),50);
    htfBias=(hf>hs&&hc.at(-1)>ht)?1:(hf<hs&&hc.at(-1)<ht)?-1:0;
    htfText=htfBias===1?"Bullish HTF":htfBias===-1?"Bearish HTF":"Neutral HTF";
  }

  const key=getSmcStateKey(symbol);
  const livePrice=live?live.close:last.close;
  let st=updateSmcTradeState(symbol,livePrice);

  // Jika state aktif, tetap tampil ACTIVE seperti TradingView, kecuali reverse SMC muncul.
  if(st&&st.active){
    const reverse=(st.dir==="LONG"&&bosBear&&emaShort)||(st.dir==="SHORT"&&bosBull&&emaLong);
    if(reverse){
      st.active=false;
      st.tradeStatus="REVERSE";
      DEWA_SMC_STATE[key]=st;
      saveSmcState();
    }else{
      return smcStateToResult(symbol,source,c,live,st,{
        emaText:emaLong?"Bullish":emaShort?"Bearish":"Neutral",
        htfText,
        volText:volOk?"OK":"LOW",
        structureHigh,structureLow,atrVal,
        score:st.score,
        grade:st.grade
      });
    }
  }

  const distHigh=Math.abs(structureHigh-last.close)/last.close*100;
  const distLow=Math.abs(last.close-structureLow)/last.close*100;
  const prepareLong=last.close<structureHigh&&distHigh<=0.25&&emaLong;
  const prepareShort=last.close>structureLow&&distLow<=0.25&&emaShort;

  let score=0;
  if(bosBull||bosBear)score+=2;
  if(chochBull||chochBear)score+=1;
  if(emaLong||emaShort)score+=1.5;
  if(volOk)score+=1;
  if((bosBull&&htfBias===1)||(bosBear&&htfBias===-1))score+=1.5;
  if(last.close>e50&&bosBull)score+=0.5;
  if(last.close<e50&&bosBear)score+=0.5;

  let grade=getGrade(score);
  let signal="WAIT",status="NO TRADE",color="yellow",entry,tp1,tp2,tp3,sl,mainSignal="Tidak ada";

  const target=atrVal*2;

  if((bosBull||chochBull)&&emaLong&&volOk&&htfBias!==-1&&score>=5){
    signal="OPEN LONG";
    status="SMC LONG";
    color="green";
    entry=structureHigh;
    tp1=entry+target*.8;
    tp2=entry+target*1.6;
    tp3=entry+target*2.8;
    sl=entry-target*1.2;
    mainSignal=chochBull?"CHoCH BULLISH":"BOS BULLISH";
    DEWA_SMC_STATE[key]={active:true,dir:"LONG",entry,tp1,tp2,tp3,sl,tradeStatus:"ACTIVE",grade,score,structureHigh,structureLow,atr:atrVal,mainSignal,htfText,volText:volOk?"OK":"LOW",emaText:"Bullish",createdAt:new Date().toISOString()};
    saveSmcState();
  }else if((bosBear||chochBear)&&emaShort&&volOk&&htfBias!==1&&score>=5){
    signal="OPEN SHORT";
    status="SMC SHORT";
    color="red";
    entry=structureLow;
    tp1=entry-target*.8;
    tp2=entry-target*1.6;
    tp3=entry-target*2.8;
    sl=entry+target*1.2;
    mainSignal=chochBear?"CHoCH BEARISH":"BOS BEARISH";
    DEWA_SMC_STATE[key]={active:true,dir:"SHORT",entry,tp1,tp2,tp3,sl,tradeStatus:"ACTIVE",grade,score,structureHigh,structureLow,atr:atrVal,mainSignal,htfText,volText:volOk?"OK":"LOW",emaText:"Bearish",createdAt:new Date().toISOString()};
    saveSmcState();
  }else if(prepareLong){
    status="WAIT LONG";
    color="yellow";
    mainSignal="PREPARE LONG";
  }else if(prepareShort){
    status="WAIT SHORT";
    color="yellow";
    mainSignal="PREPARE SHORT";
  }

  const aiAnalysis=`
    <b>⚡ DEWA SMC AI - PINE STATE</b><br>
    <b>Pair:</b> ${symbol}<br>
    <b>Engine:</b> SMC PINE STATE<br>
    <b>Sinyal Utama:</b> ${mainSignal}<br>
    <b>BOS Bull/Bear:</b> ${bosBull?"YES":"NO"} / ${bosBear?"YES":"NO"}<br>
    <b>CHoCH Bull/Bear:</b> ${chochBull?"YES":"NO"} / ${chochBear?"YES":"NO"}<br>
    <b>EMA 9/20:</b> ${emaLong?"Bullish":emaShort?"Bearish":"Neutral"}<br>
    <b>HTF Bias:</b> ${htfText}<br>
    <b>Volatility:</b> ${volOk?"OK":"LOW"}<br>
    <b>Score:</b> ${score} |
    <b>Grade:</b> ${grade}<br>
    <b>Structure High:</b> ${priceFmt(symbol,structureHigh)}<br>
    <b>Structure Low:</b> ${priceFmt(symbol,structureLow)}<br><br>
    <b>Signal:</b> ${signal}<br>
    <b>Status:</b> ${status}<br>
    <b>Entry:</b> ${priceFmt(symbol,entry)}<br>
    <b>TP1:</b> ${priceFmt(symbol,tp1)}<br>
    <b>TP2:</b> ${priceFmt(symbol,tp2)}<br>
    <b>TP3:</b> ${priceFmt(symbol,tp3)}<br>
    <b>SL:</b> ${priceFmt(symbol,sl)}<br><br>
    <b>Catatan:</b> SMC memakai BOS/CHoCH window + active state agar lebih mirip TradingView.
  `;

  return {symbol,source,signal,status,color,entry,tp1,tp2,tp3,sl,candles:c,structureHigh,structureLow,atr:atrVal,volOk,locked:false,livePrice:live.close,engine:"SMC PINE STATE",grade,score,aiAnalysis};
}

// Hybrid tetap memakai SMC state + Sniper state
function analyzeHybrid(symbol,candles,source,htf){
  const smc=analyzeSMCPine(symbol,candles,source,htf);
  const sn=analyzeSniperFull(symbol,candles,source,htf);

  if(smc.signal===sn.signal && smc.signal!=="WAIT" && ["A","A+"].includes(sn.grade)){
    return {...sn,status:"HYBRID CONFIRM",engine:"HYBRID PINE STATE",aiAnalysis:(sn.aiAnalysis||"")+"<br><br><b>HYBRID:</b> SMC dan SNIPER searah."};
  }

  // Jika salah satu state ACTIVE, tetap tampilkan yang aktif sesuai mode hybrid.
  if((sn.status||"").startsWith("ACTIVE")) return {...sn,engine:"HYBRID PINE STATE"};
  if((smc.status||"").startsWith("ACTIVE")) return {...smc,engine:"HYBRID PINE STATE"};

  return {...sn,signal:"WAIT",status:"WAIT HYBRID",color:"yellow",engine:"HYBRID PINE STATE"};
}

// Extend reset: hapus state SMC juga
const _oldResetSignalsV72 = resetSignals;
resetSignals = function(){
  locks={};
  DEWA_TV_STATE={};
  DEWA_SMC_STATE={};
  DEWA_LAST_DIR={};
  saveLocks();
  if(typeof saveTvState==="function")saveTvState();
  saveSmcState();
  saveLastDir();
  log("Reset: locked signal + Sniper state + SMC state");
  render();
};


/* =========================================================
   V7.3 EXACT SMC PINE OVERRIDE
   Berdasarkan Pine Script DewaSMC ELITE:
   - structurePeriod = 20
   - confirmationType = Body
   - ta.pivothigh/ta.pivotlow dengan left/right = structurePeriod
   - highBreakPending / lowBreakPending
   - trendDirection + CHoCH
   - entry/TP/SL formula sama:
     targetRange = ATR14 * 2.0
     TP1 0.8, TP2 1.6, TP3 2.8, SL 1.2
   - prepare zone = 0.25%
   - EMA confirm = EMA9/20 + close di sisi EMA
   - volatilityOK = ATR14 > SMA(ATR14, 20)
   - trade state dihitung ulang dari histori candle seperti Pine
   ========================================================= */

function pineAtrSeries(c, period=14){
  const out = Array(c.length).fill(null);
  const tr = Array(c.length).fill(null);
  for(let i=1;i<c.length;i++){
    tr[i]=Math.max(
      c[i].high-c[i].low,
      Math.abs(c[i].high-c[i-1].close),
      Math.abs(c[i].low-c[i-1].close)
    );
  }
  let vals=[];
  for(let i=1;i<c.length;i++){
    vals.push(tr[i]);
    if(vals.length>=period){
      out[i]=vals.slice(-period).reduce((a,b)=>a+b,0)/period;
    }
  }
  return out;
}

function pinePivotHighAt(c, pivotIndex, left, right){
  if(pivotIndex-left<0 || pivotIndex+right>=c.length) return null;
  const v=c[pivotIndex].high;
  for(let j=pivotIndex-left;j<=pivotIndex+right;j++){
    if(j===pivotIndex) continue;
    if(c[j].high>=v) return null;
  }
  return v;
}

function pinePivotLowAt(c, pivotIndex, left, right){
  if(pivotIndex-left<0 || pivotIndex+right>=c.length) return null;
  const v=c[pivotIndex].low;
  for(let j=pivotIndex-left;j<=pivotIndex+right;j++){
    if(j===pivotIndex) continue;
    if(c[j].low<=v) return null;
  }
  return v;
}

function emulateDewaSMC(c, opts={}){
  const structurePeriod = opts.structurePeriod || 20;
  const confirmationType = opts.confirmationType || "Body";
  const volatilityMultiplier = 2.0;

  const atrArr = pineAtrSeries(c,14);
  const closes = c.map(x=>x.close);
  const ema9Arr = seriesEma(closes,9);
  const ema20Arr = seriesEma(closes,20);

  let lastHigh = NaN, lastLow = NaN;
  let lastHighBar = null, lastLowBar = null;
  let trendDirection = 0;
  let highBreakPending = false;
  let lowBreakPending = false;

  let entryLevel=NaN,tp1Level=NaN,tp2Level=NaN,tp3Level=NaN,stopLevel=NaN;
  let tradeDirection=0,tp1Hit=false,tp2Hit=false,tp3Hit=false,lastTradeBar=null;
  let lastEvent=null;
  let lastAlertPrice=NaN;

  for(let i=0;i<c.length;i++){
    const k=c[i];

    // ta.pivothigh/low confirms on current bar i for pivot at i-structurePeriod
    const pivotIndex = i - structurePeriod;
    if(pivotIndex>=0){
      const ph = pinePivotHighAt(c, pivotIndex, structurePeriod, structurePeriod);
      const pl = pinePivotLowAt(c, pivotIndex, structurePeriod, structurePeriod);

      if(ph!==null){
        lastHigh=ph;
        lastHighBar=pivotIndex;
        highBreakPending=true;
      }
      if(pl!==null){
        lastLow=pl;
        lastLowBar=pivotIndex;
        lowBreakPending=true;
      }
    }

    let highBroken=false, lowBroken=false;

    if(highBreakPending && Number.isFinite(lastHigh)){
      if((confirmationType==="Body" && k.close>lastHigh) || (confirmationType==="Wick" && k.high>lastHigh)){
        highBroken=true;
        highBreakPending=false;
      }
    }

    if(lowBreakPending && Number.isFinite(lastLow)){
      if((confirmationType==="Body" && k.close<lastLow) || (confirmationType==="Wick" && k.low<lastLow)){
        lowBroken=true;
        lowBreakPending=false;
      }
    }

    const prevTrend=trendDirection;
    if(highBroken) trendDirection=1;
    else if(lowBroken) trendDirection=-1;

    const chochSignal=(prevTrend===-1 && trendDirection===1) || (prevTrend===1 && trendDirection===-1);

    const atrVal=atrArr[i] || atr(c.slice(0,i+1),14);
    const targetRange=atrVal*volatilityMultiplier;

    if(highBroken && Number.isFinite(lastHigh)){
      entryLevel=lastHigh;
      tp1Level=entryLevel+targetRange*0.8;
      tp2Level=entryLevel+targetRange*1.6;
      tp3Level=entryLevel+targetRange*2.8;
      stopLevel=entryLevel-targetRange*1.2;
      tradeDirection=1;
      tp1Hit=false;tp2Hit=false;tp3Hit=false;lastTradeBar=i;
      lastEvent={i,dir:"LONG",type:chochSignal?"CHoCH BULLISH":"BOS BULLISH",entry:entryLevel,tp1:tp1Level,tp2:tp2Level,tp3:tp3Level,sl:stopLevel,trend:trendDirection,choch:chochSignal,atr:atrVal,structHigh:lastHigh,structLow:lastLow,highBar:lastHighBar,lowBar:lastLowBar};
    }

    if(lowBroken && Number.isFinite(lastLow)){
      entryLevel=lastLow;
      tp1Level=entryLevel-targetRange*0.8;
      tp2Level=entryLevel-targetRange*1.6;
      tp3Level=entryLevel-targetRange*2.8;
      stopLevel=entryLevel+targetRange*1.2;
      tradeDirection=-1;
      tp1Hit=false;tp2Hit=false;tp3Hit=false;lastTradeBar=i;
      lastEvent={i,dir:"SHORT",type:chochSignal?"CHoCH BEARISH":"BOS BEARISH",entry:entryLevel,tp1:tp1Level,tp2:tp2Level,tp3:tp3Level,sl:stopLevel,trend:trendDirection,choch:chochSignal,atr:atrVal,structHigh:lastHigh,structLow:lastLow,highBar:lastHighBar,lowBar:lastLowBar};
    }

    // TP hit logic persis Pine
    if(tradeDirection===1){
      if(!tp1Hit && k.high>=tp1Level) tp1Hit=true;
      if(!tp2Hit && k.high>=tp2Level) tp2Hit=true;
      if(!tp3Hit && k.high>=tp3Level) tp3Hit=true;
    }
    if(tradeDirection===-1){
      if(!tp1Hit && k.low<=tp1Level) tp1Hit=true;
      if(!tp2Hit && k.low<=tp2Level) tp2Hit=true;
      if(!tp3Hit && k.low<=tp3Level) tp3Hit=true;
    }
  }

  const i=c.length-1;
  const last=c[i];
  const atrVal=atrArr[i] || atr(c,14);
  const atrSma20=sma(atrArr.filter(x=>Number.isFinite(x)),20);
  const volatilityOK=Number.isFinite(atrSma20)?atrVal>atrSma20:true;

  const ema9=ema9Arr[i], ema20=ema20Arr[i];
  const emaAlignedLong=ema9>ema20 && last.close>ema9;
  const emaAlignedShort=ema9<ema20 && last.close<ema9;

  const prepThresholdLong=Number.isFinite(lastHigh)?lastHigh*(0.25/100):NaN;
  const prepThresholdShort=Number.isFinite(lastLow)?lastLow*(0.25/100):NaN;
  const prepLong=Number.isFinite(lastHigh) && !(lastEvent&&lastEvent.i===i&&lastEvent.dir==="LONG") && Math.abs(last.close-lastHigh)<=prepThresholdLong && last.close<lastHigh && emaAlignedLong;
  const prepShort=Number.isFinite(lastLow) && !(lastEvent&&lastEvent.i===i&&lastEvent.dir==="SHORT") && Math.abs(last.close-lastLow)<=prepThresholdShort && last.close>lastLow && emaAlignedShort;

  return {
    lastHigh,lastLow,lastHighBar,lastLowBar,trendDirection,
    entryLevel,tp1Level,tp2Level,tp3Level,stopLevel,
    tradeDirection,tp1Hit,tp2Hit,tp3Hit,lastTradeBar,
    lastEvent,atrVal,volatilityOK,ema9,ema20,emaAlignedLong,emaAlignedShort,
    prepLong,prepShort
  };
}

function analyzeSMCPine(symbol,candles,source,htfCandles){
  const c=candles.slice(0,-1);
  const live=candles[candles.length-1];

  if(c.length<70){
    return {symbol,source,signal:"WAIT",status:"DATA LOW",color:"yellow",candles:c,engine:"SMC PINE EXACT",livePrice:live?.close};
  }

  const smc=emulateDewaSMC(c,{structurePeriod:20,confirmationType:"Body"});
  const last=c[c.length-1];
  const event=smc.lastEvent;
  const isFresh=event && event.i===c.length-1;

  let signal="WAIT",status="NO TRADE",color="yellow";
  let entry=smc.entryLevel,tp1=smc.tp1Level,tp2=smc.tp2Level,tp3=smc.tp3Level,sl=smc.stopLevel;
  let mainSignal="Tidak ada";

  if(isFresh && event.dir==="LONG"){
    signal="OPEN LONG";
    status="SMC LONG";
    color="green";
    mainSignal=event.type;
  }else if(isFresh && event.dir==="SHORT"){
    signal="OPEN SHORT";
    status="SMC SHORT";
    color="red";
    mainSignal=event.type;
  }else if(smc.tradeDirection===1 && Number.isFinite(entry)){
    signal="OPEN LONG";
    status=smc.tp3Hit?"TP3 HIT":smc.tp2Hit?"TP2 HIT":smc.tp1Hit?"TP1 HIT":"ACTIVE LONG";
    color=smc.tp3Hit||smc.tp2Hit||smc.tp1Hit?"green":"blue";
    mainSignal=event?event.type:"ACTIVE LONG";
  }else if(smc.tradeDirection===-1 && Number.isFinite(entry)){
    signal="OPEN SHORT";
    status=smc.tp3Hit?"TP3 HIT":smc.tp2Hit?"TP2 HIT":smc.tp1Hit?"TP1 HIT":"ACTIVE SHORT";
    color=smc.tp3Hit||smc.tp2Hit||smc.tp1Hit?"green":"blue";
    mainSignal=event?event.type:"ACTIVE SHORT";
  }else if(smc.prepLong){
    status="WAIT LONG";
    color="yellow";
    mainSignal="PREPARE LONG";
  }else if(smc.prepShort){
    status="WAIT SHORT";
    color="yellow";
    mainSignal="PREPARE SHORT";
  }

  const confidence =
    ((smc.emaAlignedLong||smc.emaAlignedShort) && event && event.choch && smc.volatilityOK) ? "HIGH" :
    ((smc.emaAlignedLong||smc.emaAlignedShort) && event && smc.volatilityOK) ? "MEDIUM" : "LOW";

  const aiAnalysis=`
    <b>⚡ DEWA SMC AI - EXACT PINE CORE</b><br>
    <b>Pair:</b> ${symbol}<br>
    <b>Engine:</b> SMC PINE EXACT<br>
    <b>Structure Period:</b> 20<br>
    <b>Confirmation:</b> Body close<br>
    <b>Sinyal Utama:</b> ${mainSignal}<br>
    <b>Trend:</b> ${smc.trendDirection===1?"Bullish":smc.trendDirection===-1?"Bearish":"Neutral"}<br>
    <b>EMA 9/20:</b> ${smc.emaAlignedLong?"LONG YES":smc.emaAlignedShort?"SHORT YES":"NO"}<br>
    <b>Volatility:</b> ${smc.volatilityOK?"OK":"LOW"}<br>
    <b>Confidence:</b> ${confidence}<br>
    <b>Structure High:</b> ${priceFmt(symbol,smc.lastHigh)}<br>
    <b>Structure Low:</b> ${priceFmt(symbol,smc.lastLow)}<br>
    <b>TP Status:</b> TP1 ${smc.tp1Hit?"✓":"-"} | TP2 ${smc.tp2Hit?"✓":"-"} | TP3 ${smc.tp3Hit?"✓":"-"}<br><br>
    <b>Signal:</b> ${signal}<br>
    <b>Status:</b> ${status}<br>
    <b>Entry:</b> ${priceFmt(symbol,entry)}<br>
    <b>TP1:</b> ${priceFmt(symbol,tp1)}<br>
    <b>TP2:</b> ${priceFmt(symbol,tp2)}<br>
    <b>TP3:</b> ${priceFmt(symbol,tp3)}<br>
    <b>SL:</b> ${priceFmt(symbol,sl)}<br><br>
    <b>Catatan:</b> Logic ini meniru Pine Script SMC yang Anda kirim: pivot 20/20, pending break, BOS/CHoCH, EMA 9/20, ATR target.
  `;

  return {
    symbol,source,signal,status,color,
    entry,tp1,tp2,tp3,sl,
    candles:c,
    structureHigh:smc.lastHigh,
    structureLow:smc.lastLow,
    atr:smc.atrVal,
    volOk:smc.volatilityOK,
    locked:false,
    livePrice:live?live.close:undefined,
    engine:"SMC PINE EXACT",
    grade:confidence==="HIGH"?"A+":confidence==="MEDIUM"?"A":"B",
    score:confidence==="HIGH"?8:confidence==="MEDIUM"?6.5:5,
    aiAnalysis
  };
}


/* =========================================================
   V7.4 EA PRIORITY UPDATE
   Rule:
   - EA execute: SMC Grade A/A+ prioritas pertama.
   - Jika tidak ada SMC A/A+, EA boleh execute SNIPER Grade A/A+.
   - HYBRID tidak dipakai EA.
   - Notifikasi dikirim untuk SMC A/A+ dan SNIPER A/A+.
   ========================================================= */
function isGradeAPlusV74(g){
  g=String(g||"").toUpperCase();
  return g==="A" || g==="A+";
}
function isEaAllowedEngineV74(engine){
  engine=String(engine||"").toUpperCase();
  if(engine.includes("HYBRID")) return false;
  return engine.includes("SMC") || engine.includes("SNIPER");
}
saveSignal = async function(sym,r){
  try{
    if(!r.entry)return;
    const payload={
      key:`${sym}|${r.tf||tfLabel()}|${r.signal}|${r.entry}`,
      pair:sym,
      tf:r.tf||tfLabel(),
      signal:r.signal,
      entry:r.entry,
      tp1:r.tp1,
      tp2:r.tp2,
      tp3:r.tp3,
      sl:r.sl,
      status:r.status,
      createdAt:r.createdAt||new Date().toISOString(),
      grade:r.grade,
      engine:r.engine
    };
    await api("/api/signals/upsert",{method:"POST",body:JSON.stringify(payload)});
  }catch(e){}
};
broadcastSignal = async function(sym,r){
  try{
    const isEntry=["OPEN LONG","OPEN SHORT"].includes(r.signal);
    const isA=isGradeAPlusV74(r.grade);
    const allowed=isEaAllowedEngineV74(r.engine);
    if(!isEntry || !isA || !allowed){
      log("Notif/EA skip: hanya SMC/SNIPER Grade A/A+. "+sym+" engine="+(r.engine||"-")+" grade="+(r.grade||"-"));
      return;
    }
    await api("/api/push/broadcast",{
      method:"POST",
      body:JSON.stringify({
        pair:sym,
        signal:r.signal,
        grade:r.grade,
        engine:r.engine,
        priority:String(r.engine||"").toUpperCase().includes("SMC")?"SMC PRIORITY":"SNIPER BACKUP",
        entry:priceFmt(sym,r.entry),
        tp1:priceFmt(sym,r.tp1),
        tp2:priceFmt(sym,r.tp2),
        tp3:priceFmt(sym,r.tp3),
        sl:priceFmt(sym,r.sl)
      })
    });
    log("Notif dikirim: "+sym+" "+r.signal+" "+(r.engine||"-")+" Grade "+r.grade);
  }catch(e){
    log("Broadcast notif gagal: "+e.message);
  }
};
/* ================================
   DEWA V7.6 REVERSE STATE PATCH
================================ */

let DEWA_REVERSE_STATE = JSON.parse(localStorage.getItem("DEWA_REVERSE_STATE") || "{}");

function saveReverseState(){
  localStorage.setItem("DEWA_REVERSE_STATE", JSON.stringify(DEWA_REVERSE_STATE));
}

function isReverseCooldownOk(symbol){
  const tf = Number($("tf").value || 5);
  const last = DEWA_REVERSE_STATE[symbol];
  if(!last) return true;
  return Date.now() - last.ts > tf * 3 * 60 * 1000;
}

function markReverse(symbol){
  DEWA_REVERSE_STATE[symbol] = { ts: Date.now() };
  saveReverseState();
}

function normalizeSignalName(signal){
  if(signal === "OPEN LONG") return "NEW LONG";
  if(signal === "OPEN SHORT") return "NEW SHORT";
  return signal;
}

function oppositeSignal(activeSignal, newSignal){
  const a = String(activeSignal || "");
  const n = String(newSignal || "");
  if(a.includes("LONG") && n.includes("SHORT")) return "REVERSE SHORT";
  if(a.includes("SHORT") && n.includes("LONG")) return "REVERSE LONG";
  return null;
}

function reverseAllowed(symbol, activeLock, newSig){
  if(!activeLock || !newSig) return false;

  const rev = oppositeSignal(activeLock.signal, newSig.signal);
  if(!rev) return false;

  const grade = String(newSig.grade || "").toUpperCase();
  if(!(grade === "A" || grade === "A+")) return false;

  const atrVal = Number(newSig.atr || 0);
  const entryOld = Number(activeLock.entry);
  const entryNew = Number(newSig.entry);

  if(!Number.isFinite(atrVal) || atrVal <= 0) return false;
  if(!Number.isFinite(entryOld) || !Number.isFinite(entryNew)) return false;

  const distanceOk = Math.abs(entryNew - entryOld) >= atrVal * 0.5;
  if(!distanceOk) return false;

  if(!isReverseCooldownOk(symbol)) return false;

  return rev;
}

function displaySignalName(signal, status){
  if(status === "REVERSE LONG") return "REVERSE LONG";
  if(status === "REVERSE SHORT") return "REVERSE SHORT";
  if(signal === "OPEN LONG") return "NEW LONG";
  if(signal === "OPEN SHORT") return "NEW SHORT";
  return signal || "-";
}

window.login = login;
window.requestAccess = requestAccess;
window.logout = logout;
window.changePassword = changePassword;
window.start = start;
window.stop = stop;
window.resetSignals = resetSignals;
window.enablePush = enablePush;
