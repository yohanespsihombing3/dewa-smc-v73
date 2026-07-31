require('dotenv').config();
const express=require('express'),cors=require('cors'),fetch=require('node-fetch'),path=require('path'),fs=require('fs'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),webpush=require('web-push'),crypto=require('crypto'),{v4:uuid}=require('uuid');
const { createClient } = require('@supabase/supabase-js');
const { createEaV9Store } = require('./lib/ea-v9-store');
const { registerV10Admin } = require('./lib/v10-admin');
const app=express(),PORT=process.env.PORT||3000,SECRET=process.env.JWT_SECRET||'change-me',CACHE_MS=Number(process.env.CACHE_SECONDS||120)*1000;
const USE_SUPABASE = String(process.env.USE_SUPABASE || '').toLowerCase() === 'true';
const EA_SIGNAL_MAX_AGE_MINUTES = Math.max(
  1,
  Number(process.env.EA_SIGNAL_MAX_AGE_MINUTES || 20)
);
const EA_SIGNAL_MAX_AGE_MS = EA_SIGNAL_MAX_AGE_MINUTES * 60 * 1000;

const supabase = USE_SUPABASE
  ? createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SECRET_KEY
    )
  : null;
const KEYS=[process.env.TWELVE_DATA_API_KEY_1,process.env.TWELVE_DATA_API_KEY_2,process.env.TWELVE_DATA_API_KEY_3].filter(Boolean);
let keyIndex=0;const cache=new Map(),DATA=path.join(__dirname,'data'),UF=path.join(DATA,'users.json'),SF=path.join(DATA,'signals.json'),EF=path.join(DATA,'ea-signals.json'),PF=path.join(DATA,'push-subscriptions.json'),KF=path.join(DATA,'push-keys.json');
const eaV9Store=createEaV9Store({dataDir:DATA,retentionDays:Number(process.env.EA_QUEUE_RETENTION_DAYS||14),maxEvents:Number(process.env.EA_QUEUE_MAX_EVENTS||10000)});
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

function normalizeEmail(value=''){
  return String(value).toLowerCase().trim();
}

function normalizeMt5Account(value=''){
  return String(value).replace(/\D/g,'');
}

function normalizeEaTimeframe(value=''){
  const tf=String(value).toLowerCase().trim();
  if(tf==='5m'||tf==='m5'||tf==='5min')return '5m';
  if(tf==='15m'||tf==='m15'||tf==='15min')return '15m';
  return '';
}

function normalizeEaSymbol(value=''){
  const raw=String(value).toUpperCase().trim();
  const compact=raw.replace(/[^A-Z0-9]/g,'');

  const supported=[
    ['XAUUSD','XAU/USD'],
    ['XAGUSD','XAG/USD'],
    ['BTCUSD','BTC/USD'],
    ['ETHUSD','ETH/USD'],
    ['EURUSD','EUR/USD'],
    ['GBPUSD','GBP/USD'],
    ['USDJPY','USD/JPY'],
    ['AUDUSD','AUD/USD'],
    ['USDCAD','USD/CAD'],
    ['USDCHF','USD/CHF'],
    ['NZDUSD','NZD/USD']
  ];

  for(const [brokerCode,serverPair] of supported){
    if(compact.includes(brokerCode))return serverPair;
  }

  return '';
}

function isFreshEaSignal(signal){
  const created=new Date(signal.createdAt||signal.updatedAt||0).getTime();
  return Number.isFinite(created)&&created>0&&(Date.now()-created)<=EA_SIGNAL_MAX_AGE_MS;
}

function isGradeAPlus(g){return String(g||'').toUpperCase()==='A'||String(g||'').toUpperCase()==='A+'}
function safe(u){return{id:u.id,email:u.email,role:u.role,plan:u.plan,status:u.status||'ACTIVE',expiredAt:u.expiredAt,active:active(u),mustChangePassword:!!u.mustChangePassword,eaApiKey:u.eaApiKey||'',eaEnabled:u.eaEnabled!==false,mt5Account:u.mt5Account||''}}
function makeToken(u){return jwt.sign({id:u.id,email:u.email,role:u.role},SECRET,{expiresIn:'7d'})}
function auth(req,res,next){try{let t=(req.headers.authorization||'').replace('Bearer ','');if(!t)throw Error('Unauthorized');let p=jwt.verify(t,SECRET),u=db().users.find(x=>x.id===p.id);if(!u)throw Error('User tidak ditemukan');if(!active(u))return res.status(403).json({error:'Akun expired / belum aktif'});req.user=u;next()}catch(e){res.status(401).json({error:e.message})}}

function eaAuth(req,res,next){
  try{
    const email=normalizeEmail(req.query.email);
    const mt5=normalizeMt5Account(req.query.mt5);

    if(!email||!email.includes('@')){
      return res.status(400).json({error:'Email EA tidak valid'});
    }

    if(!mt5){
      return res.status(400).json({error:'Nomor akun MT5 wajib dikirim'});
    }

    const u=db().users.find(x=>normalizeEmail(x.email)===email);

    if(!u){
      return res.status(401).json({error:'Email tidak terdaftar'});
    }

    if(!active(u)){
      return res.status(403).json({error:'Member tidak aktif / expired'});
    }

    if(u.eaEnabled===false){
      return res.status(403).json({error:'EA disabled'});
    }

    const registeredMt5=normalizeMt5Account(u.mt5Account);

    if(!registeredMt5){
      return res.status(403).json({error:'Nomor akun MT5 belum didaftarkan'});
    }

    if(registeredMt5!==mt5){
      return res.status(401).json({error:'Nomor akun MT5 tidak sesuai'});
    }

    req.eaUser=u;
    req.eaMt5=mt5;
    next();
  }catch(e){
    res.status(500).json({error:e.message});
  }
}
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

app.post('/api/member/mt5-account',auth,(req,res)=>{
  try{
    const mt5Account=normalizeMt5Account(req.body.mt5Account);

    if(!mt5Account){
      return res.status(400).json({error:'Nomor akun MT5 wajib diisi'});
    }

    if(mt5Account.length<5||mt5Account.length>20){
      return res.status(400).json({error:'Nomor akun MT5 tidak valid'});
    }

    const d=db();
    const u=d.users.find(x=>x.id===req.user.id);

    if(!u){
      return res.status(404).json({error:'User tidak ditemukan'});
    }

    const duplicate=d.users.find(x=>
      x.id!==u.id &&
      normalizeMt5Account(x.mt5Account)===mt5Account
    );

    if(duplicate){
      return res.status(409).json({
        error:'Nomor akun MT5 sudah terdaftar pada member lain'
      });
    }

    u.mt5Account=mt5Account;
    u.eaEnabled=true;
    u.mt5UpdatedAt=new Date().toISOString();
    saveDb(d);

    res.json({
      success:true,
      message:'Nomor akun MT5 berhasil disimpan',
      user:safe(u)
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});

app.delete('/api/member/mt5-account',auth,(req,res)=>{
  try{
    const d=db();
    const u=d.users.find(x=>x.id===req.user.id);

    if(!u){
      return res.status(404).json({error:'User tidak ditemukan'});
    }

    u.mt5Account='';
    u.mt5UpdatedAt=new Date().toISOString();
    saveDb(d);

    res.json({
      success:true,
      message:'Nomor akun MT5 berhasil dihapus',
      user:safe(u)
    });
  }catch(e){
    res.status(500).json({error:e.message});
  }
});



registerV10Admin({
  app,
  auth,
  dataDir: DATA,
  db,
  saveDb,
  safe,
  addDays,
  newKey,
  bcrypt,
  uuid
});

app.get('/api/admin/users',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});res.json({users:db().users.map(safe)})});
app.post('/api/admin/approve-user',auth,async(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);if(!u)return res.status(404).json({error:'User tidak ditemukan'});let tmp=req.body.password||'DEWA123456';u.passwordHash=await bcrypt.hash(tmp,10);u.status='ACTIVE';u.plan=req.body.plan||'FREE';u.expiredAt=addDays(req.body.days||30);u.mustChangePassword=true;u.eaApiKey=u.eaApiKey||newKey();u.eaEnabled=req.body.eaEnabled!==false;u.mt5Account=String(req.body.mt5Account||'');saveDb(d);res.json({success:true,tempPassword:tmp,user:safe(u)})});
app.post('/api/admin/update-user',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);if(!u)return res.status(404).json({error:'User tidak ditemukan'});['plan','status','mt5Account'].forEach(k=>{if(req.body[k]!==undefined)u[k]=req.body[k]});if(req.body.days)u.expiredAt=addDays(req.body.days);if(req.body.eaEnabled!==undefined)u.eaEnabled=!!req.body.eaEnabled;saveDb(d);res.json({user:safe(u)})});
app.post('/api/admin/regenerate-ea-key',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),u=d.users.find(x=>x.id===req.body.userId);u.eaApiKey=newKey();u.eaEnabled=true;saveDb(d);res.json({user:safe(u)})});
app.delete('/api/admin/delete-user/:id',auth,(req,res)=>{if(req.user.role!=='admin')return res.status(403).json({error:'Admin only'});let d=db(),i=d.users.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Tidak ditemukan'});if(d.users[i].role==='admin')return res.status(400).json({error:'Admin tidak boleh dihapus'});let del=d.users.splice(i,1)[0];saveDb(d);res.json({success:true,deleted:del.email})});

app.get('/api/ea/verify',eaAuth,(req,res)=>{
  res.json({
    ok:true,
    email:req.eaUser.email,
    mt5Account:req.eaMt5,
    eaEnabled:req.eaUser.eaEnabled!==false,
    active:active(req.eaUser)
  });
});


app.get('/api/ea/latest-signal',eaAuth,(req,res)=>{
  try{
    const symbol=normalizeEaSymbol(req.query.symbol);
    const tf=normalizeEaTimeframe(req.query.tf);

    if(!symbol){
      return res.status(400).json({
        error:'Symbol broker tidak didukung',
        received:String(req.query.symbol||'')
      });
    }

    if(!tf){
      return res.status(400).json({
        error:'Timeframe EA hanya boleh 5m atau 15m',
        received:String(req.query.tf||'')
      });
    }

    const all=eadb().signals.filter(s=>{
      const engine=String(s.engine||'').toUpperCase();
      const signalName=String(s.signal||'').toUpperCase();
      const pair=normalizeEaSymbol(s.pair);
      const signalTf=normalizeEaTimeframe(s.tf);
      const isEntry=['OPEN LONG','OPEN SHORT','REVERSE LONG','REVERSE SHORT'].includes(signalName);
      const isSmc=engine.includes('SMC')&&!engine.includes('HYBRID');
      const isSniper=engine.includes('SNIPER')&&!engine.includes('HYBRID');

      return (
        isEntry &&
        isGradeAPlus(s.grade) &&
        (isSmc||isSniper) &&
        pair===symbol &&
        signalTf===tf &&
        isFreshEaSignal(s)
      );
    });

    const rank=s=>{
      const e=String(s.engine||'').toUpperCase();
      if(e.includes('SMC')&&!e.includes('HYBRID'))return 1;
      if(e.includes('SNIPER')&&!e.includes('HYBRID'))return 2;
      return 9;
    };

    all.sort((a,b)=>{
      const pa=rank(a),pb=rank(b);
      if(pa!==pb)return pa-pb;
      return new Date(b.createdAt||b.updatedAt||0)-new Date(a.createdAt||a.updatedAt||0);
    });

    const latest=all[0]||null;

    if(!latest){
      return res.json({
        ok:true,
        authenticatedBy:'email+mt5',
        symbol,
        tf,
        maxSignalAgeMinutes:EA_SIGNAL_MAX_AGE_MINUTES,
        priority:'SMC > SNIPER A/A+ | HYBRID ignored',
        id:null,
        signalId:null,
        signal:null,
        status:'NO_SIGNAL',
        direction:null
      });
    }

    const rawSignal=String(latest.signal||'').trim().toUpperCase();
    const map={
      'OPEN LONG':['OPEN_LONG','LONG'],
      'OPEN SHORT':['OPEN_SHORT','SHORT'],
      'REVERSE LONG':['REVERSE_LONG','LONG'],
      'REVERSE SHORT':['REVERSE_SHORT','SHORT'],
      'WAIT LONG':['PREPARE_LONG','LONG'],
      'PREPARE LONG':['PREPARE_LONG','LONG'],
      'WAIT SHORT':['PREPARE_SHORT','SHORT'],
      'PREPARE SHORT':['PREPARE_SHORT','SHORT'],
      'TP1':['TP1_HIT',null],
      'TP1 HIT':['TP1_HIT',null],
      'TP2':['TP2_HIT',null],
      'TP2 HIT':['TP2_HIT',null],
      'TP3':['TP3_HIT',null],
      'TP3 HIT':['TP3_HIT',null],
      'SL':['STOP_LOSS',null],
      'STOP LOSS':['STOP_LOSS',null],
      'STOP_LOSS':['STOP_LOSS',null],
      'CANCELLED':['CANCELLED',null],
      'CLOSED':['CLOSED',null],
      'NO TRADE':['NO_TRADE',null],
      'NO_TRADE':['NO_TRADE',null]
    };
    const [status,direction]=map[rawSignal]||['UNKNOWN',latest.direction||null];

    return res.json({
      ok:true,
      authenticatedBy:'email+mt5',
      symbol,
      tf,
      maxSignalAgeMinutes:EA_SIGNAL_MAX_AGE_MINUTES,
      priority:'SMC > SNIPER A/A+ | HYBRID ignored',
      id:String(latest.id||''),
      signalId:String(latest.id||''),
      key:latest.key||'',
      signal:rawSignal,
      status,
      direction,
      engine:String(latest.engine||''),
      grade:String(latest.grade||''),
      entry:Number(latest.entry||0),
      tp1:Number(latest.tp1||0),
      tp2:Number(latest.tp2||0),
      tp3:Number(latest.tp3||0),
      sl:Number(latest.sl||0),
      createdAt:latest.createdAt||latest.updatedAt||null
    });
  }catch(err){
    console.error('latest-signal error:',err);
    return res.status(500).json({
      ok:false,
      error:err.message||'Gagal mengambil signal'
    });
  }
});

app.get('/api/ea/signals',eaAuth,(req,res)=>{
  try{
    const afterSequence=Math.max(0,Number(req.query.afterSequence||0));
    const limit=Math.min(200,Math.max(1,Number(req.query.limit||50)));
    const result=eaV9Store.getEvents(afterSequence,limit);

    return res.json({
      ok:true,
      authenticatedBy:'email+mt5',
      account:req.eaMt5,
      afterSequence,
      lastSequence:result.lastSequence,
      events:result.events
    });
  }catch(err){
    console.error('ea signals queue error:',err);
    return res.status(500).json({
      ok:false,
      error:err.message||'Gagal mengambil queue'
    });
  }
});

app.post('/api/ea/signal-ack',eaAuth,(req,res)=>{
  try{
    const ack=eaV9Store.upsertAck(req.eaMt5,req.body||{});
    return res.json({ok:true,ack});
  }catch(err){
    return res.status(err.statusCode||500).json({
      ok:false,
      error:err.message||'Gagal menyimpan ACK'
    });
  }
});

app.post('/api/ea/update-execution',eaAuth,(req,res)=>{
  try{
    const body=req.body||{};
    const signalId=String(body.signalId||'').trim();
    const nextStatus=String(
      body.execution_status||
      body.executionStatus||
      body.status||
      ''
    ).trim().toUpperCase();

    if(!signalId){
      return res.status(400).json({
        ok:false,
        error:'signalId wajib diisi'
      });
    }

    const allowedStatuses=[
      'NEW',
      'EXECUTED',
      'TP1',
      'TP2',
      'TP3',
      'BREAKEVEN',
      'PARTIAL_CLOSE',
      'STOP_LOSS',
      'CLOSED',
      'CANCELLED',
      'ERROR'
    ];

    if(!allowedStatuses.includes(nextStatus)){
      return res.status(400).json({
        ok:false,
        error:'execution status tidak valid'
      });
    }

    const ed=eadb();

    const item=ed.signals.find(
      x=>String(x.id)===signalId
    );

    if(!item){
      return res.status(404).json({
        ok:false,
        error:'Signal tidak ditemukan'
      });
    }

    const now=new Date().toISOString();

    item.execution={
      ...(item.execution||{}),
      status:nextStatus,
      updatedAt:now
    };

    if(body.ticket!==undefined)
      item.execution.ticket=body.ticket;

    if(body.volume!==undefined)
      item.execution.volume=Number(body.volume);

    if(body.fill_price!==undefined)
      item.execution.fillPrice=Number(body.fill_price);

    if(body.fillPrice!==undefined)
      item.execution.fillPrice=Number(body.fillPrice);

    if(body.close_price!==undefined)
      item.execution.closePrice=Number(body.close_price);

    if(body.closePrice!==undefined)
      item.execution.closePrice=Number(body.closePrice);

    if(body.profit!==undefined)
      item.execution.profit=Number(body.profit);

    if(nextStatus==='EXECUTED'){
      item.execution.executedAt=
        item.execution.executedAt||now;
    }

    if([
      'TP3',
      'STOP_LOSS',
      'CLOSED',
      'CANCELLED'
    ].includes(nextStatus)){
      item.execution.closedAt=now;
    }

    item.updatedAt=now;

    saveEa(ed);

    return res.json({
      ok:true,
      signalId:item.id,
      execution:item.execution
    });

  }catch(err){
    console.error('Update execution error:',err);

    return res.status(500).json({
      ok:false,
      error:err.message||'Gagal update execution'
    });
  }
});  

app.post('/api/signals/upsert',auth,(req,res)=>{
  try{
    const s=req.body||{};

    if(!s.pair||!s.signal||!s.entry){
      return res.status(400).json({error:'Data signal kurang'});
    }

    const d=sigdb();
    const key=s.key||`${s.pair}|${s.tf}|${s.signal}|${s.entry}`;
    const old=d.signals.find(x=>x.key===key);
    const now=new Date().toISOString();

    const item={
      id:old?old.id:uuid(),
      key,
      ...s,
      createdAt:s.createdAt||(old&&old.createdAt)||now,
      updatedAt:now,
      result:String(s.status||'').includes('SL HIT')
        ?'LOSS'
        :String(s.status||'').includes('TP')
          ?'WIN'
          :'RUNNING'
    };

    if(old){
      Object.assign(old,item);
    }else{
      d.signals.push(item);
    }

    saveSig(d);

    const engine=String(s.engine||'').toUpperCase();
    const signalName=String(s.signal||'').toUpperCase();
    const eligibleEngine=
      (engine.includes('SMC')||engine.includes('SNIPER')) &&
      !engine.includes('HYBRID');
    const eligibleSignal=[
      'OPEN LONG',
      'OPEN SHORT',
      'REVERSE LONG',
      'REVERSE SHORT'
    ].includes(signalName);

    let queueEvent=null;

    if(eligibleEngine&&eligibleSignal&&isGradeAPlus(s.grade)){
      const ed=eadb();
      const eo=ed.signals.find(x=>x.key===key);

      const previousSignal=eo
        ?String(eo.signal||'').toUpperCase()
        :null;

      const previousUpdatedAt=eo
        ?String(eo.updatedAt||'')
        :null;

      const ei={
        id:eo?eo.id:item.id,
        key,
        pair:s.pair,
        tf:s.tf,
        signal:signalName,
        status:s.status||null,
        direction:
          s.direction||
          (signalName.includes('LONG')?'LONG':'SHORT'),
        engine:s.engine,
        grade:s.grade,
        entry:Number(s.entry||0),
        tp1:Number(s.tp1||0),
        tp2:Number(s.tp2||0),
        tp3:Number(s.tp3||0),
        sl:Number(s.sl||0),
        createdAt:s.createdAt||(eo&&eo.createdAt)||now,
        updatedAt:now,
        execution:(eo&&eo.execution)||{
          status:'NEW',
          ticket:null,
          volume:null,
          fillPrice:null,
          executedAt:null,
          closePrice:null,
          closedAt:null,
          profit:null,
          updatedAt:now
        }
      };

      const shouldQueue=
        !eo ||
        previousSignal!==signalName ||
        previousUpdatedAt!==String(ei.updatedAt||'');

      if(eo){
        Object.assign(eo,ei);
      }else{
        ed.signals.push(ei);
      }

      saveEa(ed);

      if(shouldQueue){
        queueEvent=eaV9Store.pushEvent(ei);
      }
    }

    return res.json({
      success:true,
      signalId:item.id,
      queued:!!queueEvent,
      queueEvent
    });
  }catch(err){
    console.error('signals upsert error:',err);
    return res.status(500).json({
      error:err.message||'Gagal menyimpan signal'
    });
  }
});

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
    version: 'V8 EMAIL+MT5 AUTH | M5/M15 | SYMBOL NORMALIZATION',
    version: 'V9 QUEUE+ACK | V8 COMPATIBLE | EMAIL+MT5 AUTH',
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
    console.log('DEWA SMC V8 EMAIL+MT5 AUTH running at http://0.0.0.0:'+PORT);
    console.log('DEWA SMC V9 QUEUE+ACK running at http://0.0.0.0:'+PORT);
    console.log('Push subscriptions loaded:', PUSH_CACHE.subscriptions.length);
    console.log('Supabase:', USE_SUPABASE ? 'ON' : 'OFF');
  });
});
