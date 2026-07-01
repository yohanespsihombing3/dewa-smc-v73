
require('dotenv').config();
const express=require('express'),cors=require('cors'),fetch=require('node-fetch'),path=require('path'),fs=require('fs'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),webpush=require('web-push'),crypto=require('crypto'),{v4:uuid}=require('uuid');
const { createClient } = require('@supabase/supabase-js');
const app=express(),PORT=process.env.PORT||3000,SECRET=process.env.JWT_SECRET||'change-me',CACHE_MS=Number(process.env.CACHE_SECONDS||120)*1000;
const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';

const supabase = USE_SUPABASE
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    )
  : null;
const KEYS=[process.env.TWELVE_DATA_API_KEY_1,process.env.TWELVE_DATA_API_KEY_2,process.env.TWELVE_DATA_API_KEY_3].filter(Boolean);
let keyIndex=0;const cache=new Map(),DATA=path.join(__dirname,'data'),UF=path.join(DATA,'users.json'),SF=path.join(DATA,'signals.json'),EF=path.join(DATA,'ea-signals.json'),PF=path.join(DATA,'push-subscriptions.json'),KF=path.join(DATA,'push-keys.json');
app.use(cors());app.use(express.json({limit:'3mb'}));app.use(express.static(path.join(__dirname,'public')));
function ensure(){if(!fs.existsSync(DATA))fs.mkdirSync(DATA,{recursive:true});for(const [f,d] of [[UF,'{"users":[]}'],[SF,'{"signals":[]}'],[EF,'{"signals":[]}'],[PF,'{"subscriptions":[]}']])if(!fs.existsSync(f))fs.writeFileSync(f,d);if(!fs.existsSync(KF))fs.writeFileSync(KF,JSON.stringify(webpush.generateVAPIDKeys(),null,2))}
function read(f,x){ensure();try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return x}}function write(f,d){ensure();fs.writeFileSync(f,JSON.stringify(d,null,2))}
function db(){return read(UF,{users:[]})}
function saveDb(d){write(UF,d)}
function sigdb(){return read(SF,{signals:[]})}
function saveSig(d){write(SF,d)}
function eadb(){return read(EF,{signals:[]})}
function saveEa(d){write(EF,d)}

let PUSH_CACHE = {subscriptions:[]};

async function loadPushFromSupabase(){
  if(!USE_SUPABASE || !supabase) return read(PF,{subscriptions:[]});

  const { data, error } = await supabase
    .from('push_subscriptions_data')
    .select('id,data');

  if(error){
    console.error('Supabase load push error:', error.message);
    return read(PF,{subscriptions:[]});
  }

  return {
    subscriptions: (data || []).map(x => x.data)
  };
}

async function savePushToSupabase(d){
  if(!USE_SUPABASE || !supabase){
    write(PF,d);
    return;
  }

  for(const item of d.subscriptions || []){
    await supabase
      .from('push_subscriptions_data')
      .upsert({
        id: item.id || item.endpoint || uuid(),
        data: item
      });
  }
}

function pushdb(){
  return PUSH_CACHE;
}

function savePush(d){
  PUSH_CACHE = d;
  savePushToSupabase(d).catch(e=>console.error('Save push supabase error:',e.message));
}
function keys(){return read(KF,webpush.generateVAPIDKeys())}function setupPush(){let k=keys();webpush.setVapidDetails('mailto:admin@dewa.ai',k.publicKey,k.privateKey)}
function addDays(n){let d=new Date();d.setDate(d.getDate()+Number(n||0));return d.toISOString()}function newKey(){return 'DEWA-'+crypto.randomBytes(24).toString('hex').toUpperCase()}
function active(u){return u.role==='admin'||((u.status||'ACTIVE')==='ACTIVE'&&u.expiredAt&&new Date(u.expiredAt)>Date.now())}

function isGradeAPlus(g){return String(g||'').toUpperCase()==='A'||String(g||'').toUpperCase()==='A+'}
function safe(u){return{id:u.id,email:u.email,role:u.role,plan:u.plan,status:u.status||'ACTIVE',expiredAt:u.expiredAt,active:active(u),mustChangePassword:!!u.mustChangePassword,eaApiKey:u.eaApiKey||'',eaEnabled:u.eaEnabled!==false,mt5Account:u.mt5Account||''}}
function makeToken(u){return jwt.sign({id:u.id,email:u.email,role:u.role},SECRET,{expiresIn:'7d'})}
function auth(req,res,next){try{let t=(req.headers.authorization||'').replace('Bearer ','');if(!t)throw Error('Unauthorized');let p=jwt.verify(t,SECRET),u=db().users.find(x=>x.id===p.id);if(!u)throw Error('User tidak ditemukan');if(!active(u))return res.status(403).json({error:'Akun expired / belum aktif'});req.user=u;next()}catch(e){res.status(401).json({error:e.message})}}
function eaAuth(req,res,next){try{let key=String(req.query.key||req.headers['x-ea-key']||''),email=String(req.query.email||'').toLowerCase(),mt5=String(req.query.mt5||'');let u=db().users.find(x=>x.eaApiKey===key&&(!email||x.email===email));if(!u)throw Error('EA key tidak valid');if(!active(u))throw Error('Member tidak aktif');if(u.eaEnabled===false)throw Error('EA disabled');if(u.mt5Account&&mt5&&String(u.mt5Account)!==mt5)throw Error('MT5 account tidak sesuai');req.eaUser=u;next()}catch(e){res.status(401).json({error:e.message})}}
async function ensureAdmin(){let d=db(),email=process.env.ADMIN_EMAIL||'admin@dewa.ai';if(!d.users.find(u=>u.email===email)){d.users.push({id:uuid(),email,passwordHash:await bcrypt.hash(process.env.ADMIN_PASSWORD||'admin12345',10),role:'admin',plan:'VIP',status:'ACTIVE',expiredAt:addDays(3650),createdAt:new Date().toISOString(),eaApiKey:newKey(),eaEnabled:true});saveDb(d);console.log('Admin created:',email)}}

app.post('/api/auth/request-access',async(req,res)=>{try{let email=String(req.body.email||'').toLowerCase().trim();if(!email.includes('@'))return res.status(400).json({error:'Email tidak valid'});let d=db();if(d.users.find(u=>u.email===email))return res.status(400).json({error:'Email sudah terdaftar'});d.users.push({id:uuid(),email,passwordHash:'',role:'member',plan:'FREE',status:'PENDING',expiredAt:addDays(7),mustChangePassword:true,eaApiKey:'',eaEnabled:false,mt5Account:'',createdAt:new Date().toISOString()});saveDb(d);res.json({success:true})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/auth/register',async(req,res)=>{
  try{
    let email=String(req.body.email||'').toLowerCase().trim();
    if(!email.includes('@'))return res.status(400).json({error:'Email tidak valid'});
    let d=db();
    if(d.users.find(u=>u.email===email))return res.status(400).json({error:'Email sudah terdaftar'});
    d.users.push({id:uuid(),email,passwordHash:'',role:'member',plan:'FREE',status:'PENDING',expiredAt:addDays(7),mustChangePassword:true,eaApiKey:'',eaEnabled:false,mt5Account:'',createdAt:new Date().toISOString()});
    saveDb(d);
    res.json({success:true});
  }catch(e){res.status(500).json({error:e.message})}
});
app.post('/api/auth/login',async(req,res)=>{try{let email=String(req.body.email||'').toLowerCase().trim(),pw=String(req.body.password||''),u=db().users.find(x=>x.email===email);if(!u||!u.passwordHash||!await bcrypt.compare(pw,u.passwordHash))return res.status(401).json({error:'Login gagal'});if(!active(u))return res.status(403).json({error:'Belum approve / expired'});res.json({token:makeToken(u),user:safe(u)})}catch(e){res.status(500).json({error:e.message})}});
app.post('/api/auth/change-password',auth,async(req,res)=>{let d=db(),u=d.users.find(x=>x.id===req.user.id),p=String(req.body.password||'');if(p.length<6)return res.status(400).json({error:'Password minimal 6'});u.passwordHash=await bcrypt.hash(p,10);u.mustChangePassword=false;saveDb(d);res.json({success:true})});
app.get('/api/auth/me',auth,(req,res)=>res.json({user:safe(req.user),limits:{maxPairs:req.user.plan==='VIP'?30:req.user.plan==='PRO'?15:3,delayMs:req.user.plan==='VIP'?2000:req.user.plan==='PRO'?5000:10000}}));

app.get('/api/admin/users',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});res.json({users:db().users.map(safe)})});
app.post('/api/admin/approve-user',auth,async(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);if(!u)return res.status(404).json({error:'User tidak ditemukan'});let tmp=req.body.password||'DEWA123456';u.passwordHash=await bcrypt.hash(tmp,10);u.status='ACTIVE';u.plan=req.body.plan||'FREE';u.expiredAt=addDays(req.body.days||30);u.mustChangePassword=true;u.eaApiKey=u.eaApiKey||newKey();u.eaEnabled=req.body.eaEnabled!==false;u.mt5Account=String(req.body.mt5Account||'');saveDb(d);res.json({success:true,tempPassword:tmp,user:safe(u)})});
app.post('/api/admin/update-user',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);if(!u)return res.status(404).json({error:'User tidak ditemukan'});['plan','status','mt5Account'].forEach(k=>{if(req.body[k]!==undefined)u[k]=req.body[k]});if(req.body.days)u.expiredAt=addDays(req.body.days);if(req.body.eaEnabled!==undefined)u.eaEnabled=!!req.body.eaEnabled;saveDb(d);res.json({user:safe(u)})});
app.post('/api/admin/regenerate-ea-key',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);u.eaApiKey=newKey();u.eaEnabled=true;saveDb(d);res.json({user:safe(u)})});
app.delete('/api/admin/delete-user/:id',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),i=d.users.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Tidak ditemukan'});if(d.users[i].role==='admin')return res.status(400).json({error:'Admin tidak boleh dihapus'});let del=d.users.splice(i,1)[0];saveDb(d);res.json({success:true,deleted:del.email})});

app.get('/api/ea/verify',eaAuth,(req,res)=>res.json({ok:true,user:safe(req.eaUser)}));
app.get('/api/ea/latest-signal',eaAuth,(req,res)=>{
  try{
    let symbol=String(req.query.symbol||'').toUpperCase();
    let tf=String(req.query.tf||'');
    let all=eadb().signals.filter(s=>{
      const engine=String(s.engine||'').toUpperCase();
      const isEntry=['OPEN LONG','OPEN SHORT','REVERSE LONG','REVERSE SHORT'].includes(s.signal);
      const isSmc=engine.includes('SMC')&&!engine.includes('HYBRID');
      const isSniper=engine.includes('SNIPER')&&!engine.includes('HYBRID');
      return isEntry && isGradeAPlus(s.grade) && (isSmc || isSniper);
    });
    if(symbol)all=all.filter(s=>String(s.pair||'').toUpperCase()===symbol);
    if(tf)all=all.filter(s=>String(s.tf||'')===tf);

    const rank=s=>{
      const e=String(s.engine||'').toUpperCase();
      if(e.includes('SMC')&&!e.includes('HYBRID'))return 1;
      if(e.includes('SNIPER')&&!e.includes('HYBRID'))return 2;
      return 9;
    };

    all.sort((a,b)=>{
      const pa=rank(a),pb=rank(b);
      if(pa!==pb)return pa-pb;
      return new Date(b.createdAt||0)-new Date(a.createdAt||0);
    });

    res.json({ok:true,priority:'SMC > SNIPER A/A+ | HYBRID ignored',signal:all[0]||null});
  }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/signals/upsert',auth,(req,res)=>{let s=req.body||{};if(!s.pair||!s.signal||!s.entry)return res.status(400).json({error:'Data signal kurang'});let d=sigdb(),key=s.key||`${s.pair}|${s.tf}|${s.signal}|${s.entry}`,old=d.signals.find(x=>x.key===key);let item={id:old?old.id:uuid(),key,...s,createdAt:s.createdAt||new Date().toISOString(),updatedAt:new Date().toISOString(),result:String(s.status||'').includes('SL HIT')?'LOSS':String(s.status||'').includes('TP')?'WIN':'RUNNING'};if(old)Object.assign(old,item);else d.signals.push(item);saveSig(d);if((String(s.engine||'').toUpperCase().includes('SMC')||String(s.engine||'').toUpperCase().includes('SNIPER'))&&!String(s.engine||'').toUpperCase().includes('HYBRID')&&['OPEN LONG','OPEN SHORT','REVERSE LONG','REVERSE SHORT'].includes(s.signal)&&isGradeAPlus(s.grade)){let ed=eadb(),eo=ed.signals.find(x=>x.key===key),ei={id:eo?eo.id:uuid(),key,pair:s.pair,tf:s.tf,signal:s.signal,engine:s.engine,grade:s.grade,entry:s.entry,tp1:s.tp1,tp2:s.tp2,tp3:s.tp3,sl:s.sl,createdAt:s.createdAt||new Date().toISOString()};if(eo)Object.assign(eo,ei);else ed.signals.push(ei);saveEa(ed)}res.json({success:true})});
app.get('/api/signals/analytics',auth,(req,res)=>{let all=sigdb().signals,win=all.filter(x=>x.result==='WIN').length,loss=all.filter(x=>x.result==='LOSS').length;res.json({today:{total:all.length,win,loss,running:all.length-win-loss,winrate:win+loss?+(win/(win+loss)*100).toFixed(2):0},allTime:{total:all.length,win,loss,running:all.length-win-loss,winrate:win+loss?+(win/(win+loss)*100).toFixed(2):0},pairs:[],latest:all.slice(-30).reverse()})});

app.get('/api/push/public-key',auth,(req,res)=>{setupPush();res.json({publicKey:keys().publicKey})});
app.post('/api/push/subscribe',auth,(req,res)=>{let sub=req.body.subscription;if(!sub||!sub.endpoint)return res.status(400).json({error:'Invalid'});let d=pushdb(),old=d.subscriptions.find(x=>x.endpoint===sub.endpoint);if(old)old.subscription=sub;else d.subscriptions.push({id:uuid(),userId:req.user.id,email:req.user.email,endpoint:sub.endpoint,subscription:sub});savePush(d);res.json({success:true})});
app.post('/api/push/broadcast',auth,async(req,res)=>{
  setupPush();

  let s=req.body||{};
  let title='⚡ DEWA SIGNAL';

  if(s.signal==='OPEN LONG') title='🟢 NEW LONG';
  else if(s.signal==='OPEN SHORT') title='🔴 NEW SHORT';
  else if(s.signal==='REVERSE LONG') title='🔄 REVERSE LONG';
  else if(s.signal==='REVERSE SHORT') title='🔄 REVERSE SHORT';

  let action='';
  if(s.signal==='REVERSE LONG') action='Close SELL → Open BUY\n';
  if(s.signal==='REVERSE SHORT') action='Close BUY → Open SELL\n';

  let body=`${s.pair} • ${s.signal}\n${action}Entry: ${s.entry} | TP1: ${s.tp1} | SL: ${s.sl}`;

  let payload=JSON.stringify({
    title,
    body,
    url:'/'
  });

  let d=pushdb();

  for(let it of d.subscriptions){
    try{
      await webpush.sendNotification(it.subscription,payload);
    }catch(e){}
  }

  res.json({success:true});
});
function getC(k){let o=cache.get(k);return o&&Date.now()-o.t<CACHE_MS?o.d:null}function setC(k,d){cache.set(k,{t:Date.now(),d})}
app.get('/api/binance/candles',auth,async(req,res)=>{let symbol=String(req.query.symbol||'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g,''),interval=req.query.interval||'5m',n=Math.min(Number(req.query.outputsize||180),500),ck=`B|${symbol}|${interval}|${n}`,c=getC(ck);if(c)return res.json({...c,cached:true});let r=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${n}`),d=await r.json();if(!r.ok||!Array.isArray(d))return res.status(502).json({error:'Binance error'});let values=d.map(k=>({datetime:new Date(k[0]).toISOString(),open:k[1],high:k[2],low:k[3],close:k[4],volume:k[5]})).reverse(),out={symbol,interval,source:'Binance',values,cached:false};setC(ck,out);res.json(out)});
app.get('/api/twelvedata/candles',auth,async(req,res)=>{if(!KEYS.length)return res.status(500).json({error:'Belum ada Twelve Data key'});let symbol=String(req.query.symbol||'XAU/USD').toUpperCase(),interval=req.query.interval||'5min',n=Math.min(Number(req.query.outputsize||180),500),ck=`T|${symbol}|${interval}|${n}`,c=getC(ck);if(c)return res.json({...c,cached:true});let key=KEYS[keyIndex++%KEYS.length],url=new URL('https://api.twelvedata.com/time_series');url.searchParams.set('symbol',symbol);url.searchParams.set('interval',interval);url.searchParams.set('outputsize',String(n));url.searchParams.set('format','JSON');url.searchParams.set('apikey',key);let r=await fetch(url),d=await r.json();if(!r.ok||d.status==='error')return res.status(502).json({error:d.message||'Twelve Data error'});let out={symbol,interval,source:'Twelve Data',values:d.values,cached:false};setC(ck,out);res.json(out)});
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: 'V7.5 EA PENDING CHAIN',
    time: new Date().toISOString()
  });
});
app.get('/api/subscriptions', (req, res) => {
  try {
    const data = pushdb();
    res.json({
      total: data.subscriptions.length,
      subscriptions: data.subscriptions
    });
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});
app.get('/test-notification', async (req, res) => {
  try {
    setupPush();

    const data = pushdb();

    const payload = JSON.stringify({
      title: '🧪 TEST DEWA SMC',
      body: 'Push notification berhasil dikirim',
      icon: '/icon-192.png',
      url: '/'
    });

    let sent = 0;

    for (const item of data.subscriptions) {
      try {
        const sub = item.subscription || item;

        await webpush.sendNotification(sub, payload);

        sent++;
      } catch (err) {
        console.error(err.message);
      }
    }

    res.json({
      success: true,
      sent,
      total: data.subscriptions.length
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});
app.get('/debug/users', (req,res)=>{
  res.json(db().users.map(u=>({
    email:u.email,
    role:u.role,
    status:u.status,
    active:active(u),
    hasPassword:!!u.passwordHash
  })));
});

app.get('*',(req,res)=>{
  res.sendFile(path.join(__dirname,'public','index.html'));
});

ensureAdmin().then(async()=>{
  setupPush();
  PUSH_CACHE = await loadPushFromSupabase();

  app.listen(PORT,'0.0.0.0',()=>{
    console.log('DEWA SMC V7.5 EA PENDING CHAIN running at http://0.0.0.0:'+PORT);
    console.log('Push subscriptions loaded:', PUSH_CACHE.subscriptions.length);
    console.log('Supabase:', USE_SUPABASE ? 'ON' : 'OFF');
  });
});
