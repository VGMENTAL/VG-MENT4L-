
const http=require('http');
const fs=require('fs');
const path=require('path');
const os=require('os');
const crypto=require('crypto');
const {Pool}=require('pg');

const PORT=Number(process.env.PORT||3000);
const ROOT=__dirname;
const DATA_DIR=path.join(ROOT,'data');
const PROFILES=path.join(DATA_DIR,'profiles');
const UPDATES=path.join(DATA_DIR,'updates');
const TMP_DIR=path.join(os.tmpdir(),'vg-ment4l-video');
fs.mkdirSync(PROFILES,{recursive:true});
fs.mkdirSync(UPDATES,{recursive:true});
fs.mkdirSync(TMP_DIR,{recursive:true});

const MAX_BODY=3000000;
const GAMEPLAY_MAX_BODY=125*1024*1024;
const ALLOW=new Set(['GET','POST','PUT','OPTIONS']);
const codeRe=/^#[A-Z0-9]{10}$/,legacyRe=/^#[A-Z0-9]{5}$/;
const validCode=c=>codeRe.test(c)||legacyRe.test(c);
const safeCode=c=>String(c||'').toUpperCase().trim();
const clamp=n=>Math.max(0,Math.min(200,Math.round(Number(n)||0)));
const LATEST_OB=55;

const OFFICIAL_OB_URLS={
  OB55:'https://ff.garena.com/en/article/1712/',
  OB54:'https://ff.garena.com/en/news/',
  OB53:'https://ff.garena.com/en/article/1640/'
};

const VERIFIED_DEVICES={
 'iqoo neo 10':{
  canonical:'iQOO Neo 10',brand:'iQOO',platform:'Android',
  chipset:'Snapdragon 8s Gen 4',gpu:'Adreno-class GPU',
  ram:'8/12/16 GB LPDDR5X Ultra',display:'6.78-inch 1.5K AMOLED',
  refreshRate:'Up to 144 Hz',touchSampling:'Up to 3000 Hz instant touch / 360 Hz custom',
  os:'Funtouch OS 15 based on Android 15',
  gaming:'Supercomputing Chip Q1; 144 FPS gaming support; 7000 mm² VC cooling',
  source:'https://www.iqoo.com/in/products/neo10'
 }
};

function json(res,status,obj){
 res.writeHead(status,{
  'Content-Type':'application/json; charset=utf-8',
  'Cache-Control':'no-store',
  'Access-Control-Allow-Origin':'*',
  'Access-Control-Allow-Headers':'Content-Type,X-VG-Context',
  'Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'
 });
 res.end(JSON.stringify(obj));
}
function readBody(req,limit=MAX_BODY){
 return new Promise((resolve,reject)=>{
  let b='',done=false;
  req.on('data',x=>{
   if(done)return;
   b+=x;
   if(b.length>limit){done=true;req.destroy();reject(new Error('Payload too large'));}
  });
  req.on('end',()=>{
   if(done)return;done=true;
   try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}
  });
  req.on('error',e=>{if(!done){done=true;reject(e)}});
 });
}
function body(req){return readBody(req,MAX_BODY)}
function fileFor(dir,code){return path.join(dir,encodeURIComponent(code)+'.json')}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function writeJson(file,obj){const t=file+'.tmp';fs.writeFileSync(t,JSON.stringify(obj,null,2));fs.renameSync(t,file)}
function cleanProfile(p,code){
 if(!p||typeof p!=='object')return null;
 const o={...p,code:safeCode(code)};
 delete o.hudImageData;
 if(o.sensitivity&&typeof o.sensitivity==='object')
  for(const k of Object.keys(o.sensitivity))o.sensitivity[k]=clamp(o.sensitivity[k]);
 o.updatedAt=new Date().toISOString();
 return o;
}
function sendFile(res,file,type){
 if(!fs.existsSync(file)){res.writeHead(404);return res.end('Not found')}
 res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=300'});
 fs.createReadStream(file).pipe(res);
}
function normalizeDevice(s){return String(s||'').toLowerCase().replace(/[®™]/g,'').replace(/\s+/g,' ').trim()}
function lookupDevice(name){
 const n=normalizeDevice(name);
 for(const[k,v]of Object.entries(VERIFIED_DEVICES))
  if(n===k||n.includes(k)||k.includes(n))return {...v,match:'exact',query:name};
 return null;
}
async function fetchOfficial(ob){
 const url=OFFICIAL_OB_URLS[ob];if(!url)return null;
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
 try{
  const r=await fetch(url,{signal:ctl.signal,headers:{'User-Agent':'VG-MENT4L-Patch-Research/2.0'}});
  if(!r.ok)throw new Error('HTTP '+r.status);
  return{ob,url,text:(await r.text()).slice(0,220000),fetchedAt:new Date().toISOString()};
 }catch{return null}finally{clearTimeout(timer)}
}

const DATABASE_URL=String(process.env.DATABASE_URL||'').trim();
let pool=null,dbReady=false,dbError='';
async function initDb(){
 if(!DATABASE_URL){dbError='DATABASE_URL is not configured; using local fallback.';return}
 try{
  pool=new Pool({connectionString:DATABASE_URL,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:10000,ssl:{rejectUnauthorized:false}});
  await pool.query('SELECT 1');
  await pool.query('CREATE TABLE IF NOT EXISTS vg_profiles (code TEXT PRIMARY KEY, profile JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE TABLE IF NOT EXISTS vg_updates (id BIGSERIAL PRIMARY KEY, code TEXT NULL, item JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pool.query('CREATE INDEX IF NOT EXISTS vg_updates_code_idx ON vg_updates(code)');
  dbReady=true;dbError='';console.log('VG MENT4L persistent database connected.');
 }catch(e){
  dbReady=false;dbError=String(e&&e.message||e);
  console.error('Database connection failed; local fallback remains available:',dbError);
  try{await pool?.end()}catch{} pool=null;
 }
}
async function dbGetProfile(code){if(!dbReady||!pool)return null;const r=await pool.query('SELECT profile FROM vg_profiles WHERE code=$1 LIMIT 1',[code]);return r.rows[0]?.profile||null}
async function dbSaveProfile(p){if(!dbReady||!pool)return false;await pool.query('INSERT INTO vg_profiles(code,profile,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(code) DO UPDATE SET profile=EXCLUDED.profile,updated_at=NOW()',[p.code,JSON.stringify(p)]);return true}
async function dbSaveUpdate(i){if(!dbReady||!pool)return false;await pool.query('INSERT INTO vg_updates(code,item) VALUES($1,$2::jsonb)',[i.code||null,JSON.stringify(i)]);return true}
async function dbGetUpdates(c){if(!dbReady||!pool)return null;const r=await pool.query('SELECT item FROM vg_updates WHERE code=$1 ORDER BY created_at DESC LIMIT 100',[c]);return r.rows.map(x=>x.item)}
function makeNewProfileCode(){const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';let c='#';for(let i=0;i<10;i++)c+=chars[Math.floor(Math.random()*chars.length)];return c}
function normSens(s){s=s||{};return{
 general:clamp(s.general??s.General),red_dot:clamp(s.red_dot??s.RedDot??s.redDot),
 scope_2x:clamp(s.scope_2x??s['2x']??s.scope2x),scope_4x:clamp(s.scope_4x??s['4x']??s.scope4x),
 sniper:clamp(s.sniper??s.Sniper),free_look:clamp(s.free_look??s.FreeLook??s.freeLook)
}}

const ISSUE_DELTAS={
 'Aim head se upar ja raha hai':{general:-5,red_dot:-6,scope_2x:-5,scope_4x:-4,sniper:-3,free_look:0},
 'Aim chest pe lock ho raha hai':{general:6,red_dot:7,scope_2x:5,scope_4x:4,sniper:2,free_look:0},
 'Aim neck pe lock ho raha hai':{general:3,red_dot:4,scope_2x:3,scope_4x:2,sniper:1,free_look:0},
 'Drag slow lag raha hai':{general:7,red_dot:7,scope_2x:5,scope_4x:3,sniper:2,free_look:2},
 'Drag bahut fast / overshoot':{general:-7,red_dot:-7,scope_2x:-5,scope_4x:-3,sniper:-2,free_look:-2},
 'Recoil / spray shaky':{general:-4,red_dot:-5,scope_2x:-6,scope_4x:-7,sniper:-4,free_look:0},
 'Close-range tracking slow':{general:6,red_dot:5,scope_2x:2,scope_4x:0,sniper:0,free_look:1},
 'Long-range aim unstable':{general:-2,red_dot:-2,scope_2x:-4,scope_4x:-6,sniper:-6,free_look:0},
 'Aim target pe stick nahi kar raha':{general:2,red_dot:2,scope_2x:1,scope_4x:1,sniper:1,free_look:0}
};
function inferCustomDeltas(t){
 t=String(t||'').toLowerCase();
 const d={general:0,red_dot:0,scope_2x:0,scope_4x:0,sniper:0,free_look:0},add=x=>Object.keys(d).forEach(k=>d[k]+=x[k]||0);
 if(/upar|above|overshoot|zyada|fast|tez|high/.test(t))add({general:-4,red_dot:-4,scope_2x:-3,scope_4x:-2,sniper:-2});
 if(/chest|body|neeche|low|under|kam|slow|dheere/.test(t))add({general:4,red_dot:4,scope_2x:3,scope_4x:2,sniper:2});
 if(/neck/.test(t))add({general:2,red_dot:2,scope_2x:2,scope_4x:1,sniper:1});
 if(/recoil|spray|shake|shaky|hil/.test(t))add({general:-2,red_dot:-3,scope_2x:-4,scope_4x:-5,sniper:-3});
 if(/close|near|tracking/.test(t))add({general:3,red_dot:3,scope_2x:1,free_look:1});
 if(/long|range|distance/.test(t))add({general:-1,red_dot:-1,scope_2x:-2,scope_4x:-3,sniper:-4});
 return d;
}
function applyIssueList(base,issues=[],customText=''){
 const s=normSens(base),list=Array.isArray(issues)?issues.map(x=>String(x||'').trim()).filter(Boolean):[];
 const t={general:0,red_dot:0,scope_2x:0,scope_4x:0,sniper:0,free_look:0};
 for(const i of list){const d=ISSUE_DELTAS[i];if(d)for(const k of Object.keys(t))t[k]+=Number(d[k]||0)}
 const c=inferCustomDeltas(customText);for(const k of Object.keys(t))t[k]+=c[k]||0;
 const fixed={};for(const k of Object.keys(s))fixed[k]=clamp(s[k]+Math.max(-15,Math.min(15,t[k])));
 return{sensitivity:fixed,issues:list,customText:String(customText||'').trim()};
}
function cleanIssueList(x){if(Array.isArray(x))return x.map(v=>String(v||'').trim()).filter(Boolean).slice(0,20);return x?[String(x).trim()]:[]}
function stripFences(s){return String(s||'').replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim()}
function extractText(d){
 if(!d)return '';
 if(typeof d.output_text==='string')return d.output_text;
 if(Array.isArray(d.steps)){
  let s='';for(const st of d.steps||[])for(const c of st.content||[])if(typeof c.text==='string')s+=c.text;
  if(s)return s.trim();
 }
 if(Array.isArray(d.output)){
  let s='';for(const i of d.output||[])for(const c of i.content||[])if(typeof c.text==='string')s+=c.text;
  if(s)return s.trim();
 }
 if(Array.isArray(d.candidates)){
  let s='';for(const c of d.candidates||[])for(const p of c.content?.parts||[])if(typeof p.text==='string')s+=p.text;
  if(s)return s.trim();
 }
 return '';
}
function parseJsonOutput(txt){
 let s=stripFences(txt);
 try{return JSON.parse(s)}catch{}
 const a=s.indexOf('{'),b=s.lastIndexOf('}');
 if(a>=0&&b>a){try{return JSON.parse(s.slice(a,b+1))}catch{}}
 throw new Error('AI returned non-JSON output');
}

async function fetchWithTimeout(url,options={},ms=900000){
 const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),ms);
 try{return await fetch(url,{...options,signal:ctl.signal})}
 finally{clearTimeout(timer)}
}

async function uploadToGemini(filePath,mime,displayName,key){
 const stat=fs.statSync(filePath),size=stat.size;
 const start=await fetchWithTimeout('https://generativelanguage.googleapis.com/upload/v1beta/files',{
  method:'POST',
  headers:{
   'x-goog-api-key':key,
   'X-Goog-Upload-Protocol':'resumable',
   'X-Goog-Upload-Command':'start',
   'X-Goog-Upload-Header-Content-Length':String(size),
   'X-Goog-Upload-Header-Content-Type':mime,
   'Content-Type':'application/json'
  },
  body:JSON.stringify({file:{display_name:displayName}})
 },60000);
 const startText=await start.text();
 if(!start.ok)throw new Error(`Gemini upload-start HTTP ${start.status}: ${startText.slice(0,800)}`);
 const uploadUrl=start.headers.get('x-goog-upload-url');
 if(!uploadUrl)throw new Error('Gemini upload URL missing');
 const stream=fs.createReadStream(filePath);
 const up=await fetchWithTimeout(uploadUrl,{
  method:'POST',
  headers:{
   'Content-Length':String(size),
   'X-Goog-Upload-Offset':'0',
   'X-Goog-Upload-Command':'upload, finalize'
  },
  body:stream,
  duplex:'half'
 },15*60*1000);
 const upText=await up.text();
 if(!up.ok)throw new Error(`Gemini video upload HTTP ${up.status}: ${upText.slice(0,800)}`);
 const info=JSON.parse(upText);
 if(!info.file?.name||!info.file?.uri)throw new Error('Gemini did not return a usable file reference');
 return info.file;
}
async function waitGeminiFile(name,key){
 for(let i=0;i<90;i++){
  const r=await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${name}`,{headers:{'x-goog-api-key':key}},30000);
  const raw=await r.text();
  if(!r.ok)throw new Error(`Gemini file-status HTTP ${r.status}: ${raw.slice(0,800)}`);
  const d=JSON.parse(raw);
  const state=String(d.state||'').toUpperCase();
  if(state==='ACTIVE')return d;
  if(state==='FAILED')throw new Error('Gemini video processing failed');
  await new Promise(r=>setTimeout(r,2000));
 }
 throw new Error('Gemini video processing timed out');
}
async function deleteGeminiFile(name,key){
 try{await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${name}`,{method:'DELETE',headers:{'x-goog-api-key':key}},30000)}catch{}
}

async function runGeminiVideo(filePath,mime,context){
 const key=String(process.env.GEMINI_API_KEY||'').trim();
 const model=String(process.env.GEMINI_MODEL||'gemini-3.6-flash').trim();
 if(!key)return{configured:false,message:'GEMINI_API_KEY is not configured. Render Environment Variables mein Gemini API key add karo.'};

 const fileInfo=await uploadToGemini(filePath,mime,'VG-MENT4L-gameplay-'+Date.now(),key);
 try{
  await waitGeminiFile(fileInfo.name,key);
  const prompt=`You are the full-video gameplay calibration analyst for VG MENT4L Free Fire MAX.
IMPORTANT: Analyze the ENTIRE supplied gameplay video, not a small set of screenshots. Dynamically inspect different timestamps and fast-action moments. Track repeated behavior across the whole recording before making a sensitivity recommendation.

Goal: diagnose the CURRENT sensitivity from actual gameplay behavior and then create a NEW sensitivity tailored to this player.

Study:
- the player's natural drag speed and drag length
- direction and consistency of upward drag
- one-tap/flick timing
- whether crosshair stops at chest, neck or head
- overshoot above head and under-drag
- recoil/spray control and crosshair shake
- close, mid and long range tracking
- target switching and aim correction
- movement while firing
- different guns visible in the recording
- repeated patterns versus one-off mistakes
- visible FPS/frame pacing/lag/recording artifacts when observable
- differences between fights and ranges
- whether the CURRENT sensitivity is too high, too low, or imbalanced between scopes

Do NOT assume that every miss is caused by sensitivity. Separate player-input mistakes, ping/FPS/recording issues and sensitivity-related patterns.

Use the profile context below as baseline. RAM is context only and must NOT directly multiply sensitivity.

PROFILE CONTEXT:
${JSON.stringify(context)}

Return ONLY valid JSON with this exact shape:
{
 "playerType":"",
 "dragStyle":"",
 "rangePreference":"",
 "mainIssue":"",
 "problemDiagnosis":["specific evidence-based statements about the CURRENT sensitivity"],
 "findings":["specific observations from different parts/timestamps of the ENTIRE video"],
 "recommendedSensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},
 "adjustmentReasons":["why each important change was made"],
 "evidenceSummary":"",
 "confidence":"low|medium|high",
 "videoDuration":"",
 "timestampEvidence":["timestamp + observation"]
}

Sensitivity must be integers from 0 to 200. Do not promise zero recoil or guaranteed headshots. Prefer a measured change over extreme values unless the video strongly supports it.`;

  const body={
   model,
   input:[
    {type:'video',uri:fileInfo.uri,mime_type:mime,processing:'agentic'},
    {type:'text',text:prompt}
   ]
  };
  const r=await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/interactions',{
   method:'POST',
   headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
   body:JSON.stringify(body)
  },15*60*1000);
  const raw=await r.text();
  if(!r.ok)throw new Error(`Gemini vision HTTP ${r.status}: ${raw.slice(0,1200)}`);
  const d=JSON.parse(raw),txt=extractText(d),out=parseJsonOutput(txt);
  out.recommendedSensitivity=normSens(out.recommendedSensitivity);
  out.findings=Array.isArray(out.findings)?out.findings.slice(0,30):[];
  out.problemDiagnosis=Array.isArray(out.problemDiagnosis)?out.problemDiagnosis.slice(0,20):[];
  out.adjustmentReasons=Array.isArray(out.adjustmentReasons)?out.adjustmentReasons.slice(0,20):[];
  out.timestampEvidence=Array.isArray(out.timestampEvidence)?out.timestampEvidence.slice(0,30):[];
  out.model=model;out.configured=true;out.fullVideo=true;
  return out;
 }finally{await deleteGeminiFile(fileInfo.name,key)}
}

async function runGeminiTextFix(payload){
 const key=String(process.env.GEMINI_API_KEY||'').trim();
 const model=String(process.env.GEMINI_MODEL||'gemini-3.6-flash').trim();
 if(!key)return null;
 const prompt=`You are the final sensitivity refinement analyst for VG MENT4L Free Fire MAX.
A previous gameplay analysis produced a recommended sensitivity. The player now reports one or more problems.
Analyze ALL selected problems and the player's custom sentence together. Do not ignore the custom sentence and do not blindly apply fixed deltas.

BASE SENSITIVITY:
${JSON.stringify(payload.sensitivity)}

SELECTED PROBLEMS:
${JSON.stringify(payload.issues||[])}

PLAYER CUSTOM PROBLEM:
${JSON.stringify(payload.customText||'')}

PROFILE/GAME CONTEXT:
${JSON.stringify(payload.context||{})}

Return ONLY JSON:
{
 "sensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},
 "diagnosis":"",
 "changes":["specific changes and reasons"],
 "confidence":"low|medium|high"
}
Keep all values 0-200. Make the smallest useful changes supported by the problem. RAM is context only. Do not promise zero recoil or guaranteed headshots.`;
 const r=await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/interactions',{
  method:'POST',headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
  body:JSON.stringify({model,input:[{type:'text',text:prompt}]})
 },120000);
 const raw=await r.text();
 if(!r.ok)throw new Error(`Gemini refinement HTTP ${r.status}: ${raw.slice(0,1000)}`);
 const out=parseJsonOutput(extractText(JSON.parse(raw)));
 out.sensitivity=normSens(out.sensitivity);
 out.changes=Array.isArray(out.changes)?out.changes.slice(0,20):[];
 out.model=model;
 return out;
}

async function saveNewProfile(clone){
 const c=makeNewProfileCode();const p=cleanProfile({...clone,code:c},c);
 if(dbReady)await dbSaveProfile(p);else writeJson(fileFor(PROFILES,c),p);
 return p;
}
async function loadProfile(c){let p=null;if(dbReady)p=await dbGetProfile(c);return p||readJson(fileFor(PROFILES,c))}

async function saveIncomingVideo(req,filePath,maxBytes){
 return new Promise((resolve,reject)=>{
  let total=0,done=false;
  const out=fs.createWriteStream(filePath,{flags:'wx'});
  const fail=e=>{if(done)return;done=true;try{out.destroy()}catch{};try{fs.unlinkSync(filePath)}catch{};reject(e)};
  req.on('data',chunk=>{
   if(done)return;
   total+=chunk.length;
   if(total>maxBytes){req.destroy();fail(new Error(`Gameplay video too large. Maximum is ${Math.round(maxBytes/1048576)} MB.`));return}
   if(!out.write(chunk))req.pause();
  });
  out.on('drain',()=>req.resume());
  out.on('error',fail);
  out.on('finish',()=>{if(done)return;done=true;resolve(total)});
  req.on('end',()=>out.end());
  req.on('error',fail);
 });
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
 if(!ALLOW.has(req.method))return json(res,405,{error:'Method not allowed'});
 if(req.method==='OPTIONS')return json(res,204,{});
 const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
 try{
  if(req.method==='GET'&&u.pathname==='/api/config')
   return json(res,200,{ok:true,latestOb:`OB${LATEST_OB}`,latestObNumber:LATEST_OB,officialSource:OFFICIAL_OB_URLS[`OB${LATEST_OB}`],backend:dbReady,storage:dbReady?'supabase-postgres':'local-fallback',gameplayAI:!!String(process.env.GEMINI_API_KEY||'').trim(),aiProvider:'gemini',gameplayModel:String(process.env.GEMINI_MODEL||'gemini-3.6-flash'),videoMode:'full-video-agentic',version:'6.0'});
  if(req.method==='GET'&&u.pathname==='/api/health')
   return json(res,200,{ok:true,service:'VG MENT4L API',version:'6.0',latestOb:`OB${LATEST_OB}`,database:dbReady?'connected':'fallback',databaseError:dbReady?'':dbError,gameplayAI:!!String(process.env.GEMINI_API_KEY||'').trim(),aiProvider:'gemini'});
  if(req.method==='GET'&&u.pathname==='/api/device-research'){
   const q=u.searchParams.get('device')||'',hit=lookupDevice(q);
   return json(res,200,{ok:true,device:hit,verified:!!hit,query:q,notice:hit?'Exact/known device profile found.':'Exact device not in the verified catalog; do not invent hardware specs.'});
  }
  if(req.method==='GET'&&u.pathname==='/api/patch-research'){
   const ob=safeCode(u.searchParams.get('ob')||'');
   if(!/^OB\d+$/.test(ob))return json(res,400,{error:'Valid OB required'});
   if(Number(ob.slice(2))>LATEST_OB)return json(res,409,{error:`${ob} is not officially supported yet`,latestOb:`OB${LATEST_OB}`});
   const r=await fetchOfficial(ob);if(!r)return json(res,503,{error:'Official Garena patch could not be fetched right now',ob});
   return json(res,200,{ok:true,...r});
  }
  if(req.method==='GET'&&u.pathname.startsWith('/api/profiles/')){
   const c=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
   if(!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
   if(dbReady){const p=await dbGetProfile(c);if(p)return json(res,200,{profile:p,source:'backend'})}
   const p=readJson(fileFor(PROFILES,c));if(!p)return json(res,404,{error:'Profile not found'});
   return json(res,200,{profile:p,source:'local-fallback'});
  }
  if((req.method==='POST'||req.method==='PUT')&&u.pathname==='/api/profiles'){
   const b=await body(req),c=safeCode(b.code);if(!validCode(c))return json(res,400,{error:'Valid Profile ID required'});
   const p=cleanProfile(b,c);if(!p)return json(res,400,{error:'Invalid profile'});
   if(dbReady){await dbSaveProfile(p);return json(res,200,{ok:true,code:c,updatedAt:p.updatedAt,source:'backend'})}
   writeJson(fileFor(PROFILES,c),p);return json(res,200,{ok:true,code:c,updatedAt:p.updatedAt,source:'local-fallback',warning:'Persistent database unavailable'});
  }
  if(req.method==='POST'&&u.pathname==='/api/profile-fix'){
   const b=await body(req),oldCode=safeCode(b.code);
   if(!validCode(oldCode))return json(res,400,{error:'Valid existing Profile ID required'});
   const old=await loadProfile(oldCode);if(!old)return json(res,404,{error:'Existing profile not found'});
   const issues=cleanIssueList(b.issues??b.issue),custom=String(b.customText||b.custom||'').trim();
   if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
   const fixed=applyIssueList(old.sensitivity,issues,custom),clone=JSON.parse(JSON.stringify(old));
   clone.sensitivity=fixed.sensitivity;clone.recalibration={...(clone.recalibration||{}),sourceProfileId:oldCode,issues,customText:custom,createdAt:new Date().toISOString()};
   const p=await saveNewProfile(clone);
   return json(res,200,{ok:true,oldProfileId:oldCode,newProfileId:p.code,sensitivity:p.sensitivity,issues,customText:custom,oldProfileUnchanged:true,source:dbReady?'backend':'local-fallback'});
  }
  if(req.method==='POST'&&u.pathname==='/api/manual-fix'){
   const b=await body(req),issues=cleanIssueList(b.issues??b.issue),custom=String(b.customText||b.custom||'').trim();
   if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
   const ai=await runGeminiTextFix({sensitivity:b.sensitivity,issues,customText:custom,context:b.context||{}});
   if(ai)return json(res,200,{ok:true,sensitivity:ai.sensitivity,issues,customText:custom,diagnosis:ai.diagnosis,changes:ai.changes,model:ai.model});
   return json(res,200,{ok:true,...applyIssueList(b.sensitivity,issues,custom),warning:'Gemini AI not configured; conservative local fallback used.'});
  }

  /* NEW: raw full-video endpoint. Context arrives in X-VG-Context; video bytes stream to a temporary file. */
  if(req.method==='POST'&&u.pathname==='/api/gameplay-analyze'){
   const ct=String(req.headers['content-type']||'').toLowerCase();
   if(!ct.startsWith('video/'))return json(res,415,{error:'Send the complete gameplay video as video/* body. Representative frames are no longer used.'});
   const rawContext=String(req.headers['x-vg-context']||'');
   let context={};
   try{context=JSON.parse(decodeURIComponent(Buffer.from(rawContext,'base64').toString('utf8')))}catch{
    try{context=JSON.parse(Buffer.from(rawContext,'base64').toString('utf8'))}catch{}
   }
   const filePath=path.join(TMP_DIR,`gameplay-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.mp4`);
   try{
    const bytes=await saveIncomingVideo(req,filePath,GAMEPLAY_MAX_BODY);
    const result=await runGeminiVideo(filePath,ct,context);
    return json(res,200,{ok:true,temporary:true,videoStored:false,fullVideo:true,bytesReceived:bytes,result});
   }finally{try{fs.unlinkSync(filePath)}catch{}}
  }

  if(req.method==='POST'&&u.pathname==='/api/gameplay-fix'){
   const b=await body(req),issues=cleanIssueList(b.issues??b.issue),custom=String(b.customText||b.custom||'').trim();
   if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
   let ai=null;
   try{ai=await runGeminiTextFix({sensitivity:b.sensitivity,issues,customText:custom,context:b.context||{}})}catch(e){
    console.error('Gemini refinement failed:',e.message);
    return json(res,502,{error:'AI refinement failed',detail:e.message});
   }
   const fixed=ai?{sensitivity:ai.sensitivity,diagnosis:ai.diagnosis,changes:ai.changes,model:ai.model}:{...applyIssueList(b.sensitivity,issues,custom)};
   const oldCode=safeCode(b.code||'');
   if(validCode(oldCode)){
    const old=await loadProfile(oldCode);
    if(old){
     const clone=JSON.parse(JSON.stringify(old));
     clone.sensitivity=fixed.sensitivity;
     clone.recalibration={...(clone.recalibration||{}),sourceProfileId:oldCode,issues,customText:custom,source:'full-video-ai-refinement',createdAt:new Date().toISOString(),aiModel:fixed.model||null};
     const p=await saveNewProfile(clone);
     return json(res,200,{ok:true,oldProfileId:oldCode,newProfileId:p.code,sensitivity:p.sensitivity,issues,customText:custom,oldProfileUnchanged:true,diagnosis:fixed.diagnosis||'',changes:fixed.changes||[],model:fixed.model||null});
    }
   }
   return json(res,200,{ok:true,newProfileId:null,sensitivity:fixed.sensitivity,issues,customText:custom,oldProfileUnchanged:true,diagnosis:fixed.diagnosis||'',changes:fixed.changes||[],model:fixed.model||null});
  }

  if(req.method==='POST'&&u.pathname==='/api/updates'){
   const b=await body(req),c=safeCode(b.code||'');if(c&&!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
   const item={...b,code:c||null,time:b.time||new Date().toISOString()};
   if(dbReady){await dbSaveUpdate(item);return json(res,200,{ok:true,source:'backend'})}
   const f=fileFor(UPDATES,c||'manual'),a=readJson(f)||[];a.unshift(item);writeJson(f,a.slice(0,100));
   return json(res,200,{ok:true,source:'local-fallback'});
  }
  if(req.method==='GET'&&u.pathname.startsWith('/api/updates/')){
   const c=safeCode(decodeURIComponent(u.pathname.split('/').pop()));if(!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
   if(dbReady)return json(res,200,{updates:await dbGetUpdates(c),source:'backend'});
   return json(res,200,{updates:readJson(fileFor(UPDATES,c))||[],source:'local-fallback'});
  }

  const r=routes[u.pathname];if(req.method==='GET'&&r)return sendFile(res,path.join(ROOT,r[0]),r[1]);
  return json(res,404,{error:'Not found'});
 }catch(e){
  console.error(e);
  return json(res,500,{error:'Server error',detail:String(e&&e.message||e)});
 }
});
server.listen(PORT,async()=>{console.log(`VG MENT4L running on http://localhost:${PORT}`);await initDb()});
