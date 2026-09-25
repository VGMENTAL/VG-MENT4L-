const http = require('http');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROFILES = path.join(DATA_DIR, 'profiles');
const UPDATES = path.join(DATA_DIR, 'updates');
fs.mkdirSync(PROFILES, {recursive:true});
fs.mkdirSync(UPDATES, {recursive:true});

const MAX_BODY = 3_000_000;
const ALLOW = new Set(['GET','POST','PUT','OPTIONS']);
const codeRe = /^#[A-Z0-9]{10}$/;
const legacyRe = /^#[A-Z0-9]{5}$/;
const validCode = c => codeRe.test(c) || legacyRe.test(c);
const safeCode = c => String(c||'').toUpperCase().trim();
const clamp = n => Math.max(0, Math.min(200, Math.round(Number(n)||0)));

// Latest official patch verified from Garena at build time. Do not advance this
// number until the next official Garena patch has actually been released and reviewed.
const LATEST_OB = 55;
const OFFICIAL_OB_URLS = {
  OB55:'https://ff.garena.com/en/article/1712/',
  OB54:'https://ff.garena.com/en/news/',
  OB53:'https://ff.garena.com/en/article/1640/'
};

const VERIFIED_DEVICES = {
  'iqoo neo 10': {
    canonical:'iQOO Neo 10', brand:'iQOO', platform:'Android',
    chipset:'Snapdragon 8s Gen 4', gpu:'Adreno-class GPU',
    ram:'8/12/16 GB LPDDR5X Ultra', display:'6.78-inch 1.5K AMOLED',
    refreshRate:'Up to 144 Hz', touchSampling:'Up to 3000 Hz instant touch / 360 Hz custom',
    os:'Funtouch OS 15 based on Android 15', gaming:'Supercomputing Chip Q1; 144 FPS gaming support; 7000 mm² VC cooling',
    source:'https://www.iqoo.com/in/products/neo10'
  }
};

function json(res,status,obj){
  res.writeHead(status,{
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'no-store',
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Headers':'Content-Type',
    'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}
function body(req){return new Promise((resolve,reject)=>{
  let b='';
  req.on('data',x=>{b+=x;if(b.length>MAX_BODY){req.destroy();reject(new Error('Payload too large'));}});
  req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});
  req.on('error',reject);
});}
function fileFor(dir,code){return path.join(dir,encodeURIComponent(code)+'.json');}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function writeJson(file,obj){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(obj,null,2));fs.renameSync(tmp,file)}
function cleanProfile(p,code){
  if(!p || typeof p!=='object') return null;
  const out={...p,code:safeCode(code)};
  // Never store raw HUD screenshot bytes in the profile JSON.
  delete out.hudImageData;
  if(out.sensitivity && typeof out.sensitivity==='object'){
    for(const k of Object.keys(out.sensitivity)) out.sensitivity[k]=clamp(out.sensitivity[k]);
  }
  out.updatedAt=new Date().toISOString();
  return out;
}
function sendFile(res,file,type){
  if(!fs.existsSync(file)){res.writeHead(404);return res.end('Not found');}
  res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=300'});
  fs.createReadStream(file).pipe(res);
}
function normalizeDevice(s){return String(s||'').toLowerCase().replace(/[®™]/g,'').replace(/\s+/g,' ').trim();}
function lookupDevice(name){
  const n=normalizeDevice(name);
  for(const [key,val] of Object.entries(VERIFIED_DEVICES)) if(n===key || n.includes(key) || key.includes(n)) return {...val,match:'exact',query:name};
  return null;
}

async function fetchOfficial(ob){
  const url=OFFICIAL_OB_URLS[ob];
  if(!url) return null;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),9000);
  try{
    const r=await fetch(url,{signal:ctl.signal,headers:{'User-Agent':'VG-MENT4L-Patch-Research/1.0'}});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const text=await r.text();
    return {ob,url,text:text.slice(0,220000),fetchedAt:new Date().toISOString()};
  }catch(e){return null;}finally{clearTimeout(timer);}
}

// Supabase/PostgreSQL is the persistent cross-device store. If DATABASE_URL is
// missing, the server keeps a local JSON fallback so the site can still boot.
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
let pool = null;
let dbReady = false;
let dbError = '';

async function initDb(){
  if(!DATABASE_URL){
    dbError = 'DATABASE_URL is not configured; using local fallback.';
    return;
  }
  try{
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized:false }
    });
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vg_profiles (
        code TEXT PRIMARY KEY,
        profile JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS vg_updates (
        id BIGSERIAL PRIMARY KEY,
        code TEXT NULL,
        item JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS vg_updates_code_idx ON vg_updates(code)');
    dbReady = true;
    dbError = '';
    console.log('VG MENT4L persistent database connected.');
  }catch(e){
    dbReady = false;
    dbError = String(e && e.message || e);
    console.error('Database connection failed; local fallback remains available:', dbError);
    try{ await pool?.end(); }catch{}
    pool = null;
  }
}

async function dbGetProfile(code){
  if(!dbReady || !pool) return null;
  const r=await pool.query('SELECT profile FROM vg_profiles WHERE code=$1 LIMIT 1',[code]);
  return r.rows[0]?.profile || null;
}
async function dbSaveProfile(profile){
  if(!dbReady || !pool) return false;
  await pool.query(
    `INSERT INTO vg_profiles(code,profile,updated_at) VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(code) DO UPDATE SET profile=EXCLUDED.profile, updated_at=NOW()`,
    [profile.code, JSON.stringify(profile)]
  );
  return true;
}
async function dbSaveUpdate(item){
  if(!dbReady || !pool) return false;
  await pool.query('INSERT INTO vg_updates(code,item) VALUES($1,$2::jsonb)',[item.code||null,JSON.stringify(item)]);
  return true;
}
async function dbGetUpdates(code){
  if(!dbReady || !pool) return null;
  const r=await pool.query('SELECT item FROM vg_updates WHERE code=$1 ORDER BY created_at DESC LIMIT 100',[code]);
  return r.rows.map(x=>x.item);
}

const routes={
  '/':['index.html','text/html; charset=utf-8'],
  '/website1.html':['website1.html','text/html; charset=utf-8'],
  '/website2.html':['website2.html','text/html; charset=utf-8'],
  '/website3.html':['website3.html','text/html; charset=utf-8'],
  '/robots.txt':['robots.txt','text/plain; charset=utf-8'],
  '/sitemap.xml':['sitemap.xml','application/xml; charset=utf-8']
};

const server=http.createServer(async(req,res)=>{
  if(!ALLOW.has(req.method)) return json(res,405,{error:'Method not allowed'});
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='GET' && u.pathname==='/api/config'){
      return json(res,200,{ok:true,latestOb:`OB${LATEST_OB}`,latestObNumber:LATEST_OB,officialSource:OFFICIAL_OB_URLS[`OB${LATEST_OB}`],backend:dbReady,storage:dbReady?'supabase-postgres':'local-fallback',version:'4.0'});
    }
    if(req.method==='GET' && u.pathname==='/api/health') return json(res,200,{ok:true,service:'VG MENT4L API',version:'4.0',latestOb:`OB${LATEST_OB}`,database:dbReady?'connected':'fallback',databaseError:dbReady?'':dbError});

    if(req.method==='GET' && u.pathname==='/api/device-research'){
      const q=u.searchParams.get('device')||'';
      const hit=lookupDevice(q);
      return json(res,200,{ok:true,device:hit,verified:!!hit,query:q,notice:hit?'Exact/known device profile found.':'Exact device not in the verified catalog; do not invent hardware specs.'});
    }

    if(req.method==='GET' && u.pathname==='/api/patch-research'){
      const ob=safeCode(u.searchParams.get('ob')||'');
      if(!/^OB\d+$/.test(ob)) return json(res,400,{error:'Valid OB required'});
      if(Number(ob.slice(2))>LATEST_OB) return json(res,409,{error:`${ob} is not officially supported yet`,latestOb:`OB${LATEST_OB}`});
      const result=await fetchOfficial(ob);
      if(!result) return json(res,503,{error:'Official Garena patch could not be fetched right now',ob});
      return json(res,200,{ok:true,...result});
    }

    if(req.method==='GET' && u.pathname.startsWith('/api/profiles/')){
      const code=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if(!validCode(code)) return json(res,400,{error:'Invalid Profile ID'});
      if(dbReady){
        const p=await dbGetProfile(code);
        if(p) return json(res,200,{profile:p,source:'backend'});
      }
      const p=readJson(fileFor(PROFILES,code));
      if(!p) return json(res,404,{error:'Profile not found'});
      return json(res,200,{profile:p,source:'local-fallback'});
    }

    if((req.method==='POST'||req.method==='PUT') && u.pathname==='/api/profiles'){
      const b=await body(req); const code=safeCode(b.code);
      if(!validCode(code)) return json(res,400,{error:'Valid Profile ID required'});
      const p=cleanProfile(b,code); if(!p) return json(res,400,{error:'Invalid profile'});
      if(dbReady){
        await dbSaveProfile(p);
        return json(res,200,{ok:true,code,updatedAt:p.updatedAt,source:'backend'});
      }
      writeJson(fileFor(PROFILES,code),p);
      return json(res,200,{ok:true,code,updatedAt:p.updatedAt,source:'local-fallback',warning:'Persistent database unavailable'});
    }

    if(req.method==='POST' && u.pathname==='/api/updates'){
      const b=await body(req); const code=safeCode(b.code||'');
      if(code && !validCode(code)) return json(res,400,{error:'Invalid Profile ID'});
      const item={...b,code:code||null,time:b.time||new Date().toISOString()};
      if(dbReady){
        await dbSaveUpdate(item);
        return json(res,200,{ok:true,source:'backend'});
      }
      const key=code||'manual'; const file=fileFor(UPDATES,key); const arr=readJson(file)||[];
      arr.unshift(item); writeJson(file,arr.slice(0,100));
      return json(res,200,{ok:true,source:'local-fallback'});
    }

    if(req.method==='GET' && u.pathname.startsWith('/api/updates/')){
      const code=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if(!validCode(code)) return json(res,400,{error:'Invalid Profile ID'});
      if(dbReady) return json(res,200,{updates:await dbGetUpdates(code),source:'backend'});
      return json(res,200,{updates:readJson(fileFor(UPDATES,code))||[],source:'local-fallback'});
    }

    const r=routes[u.pathname];
    if(req.method==='GET' && r) return sendFile(res,path.join(ROOT,r[0]),r[1]);
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{error:'Server error'});}
});

server.listen(PORT,async()=>{
  console.log(`VG MENT4L running on http://localhost:${PORT}`);
  await initDb();
});
