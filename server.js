const http=require('http');
const fs=require('fs');
const path=require('path');
const {Pool}=require('pg');

const PORT=Number(process.env.PORT||3000);
const ROOT=__dirname;
const DATA_DIR=path.join(ROOT,'data');
const PROFILES=path.join(DATA_DIR,'profiles');
const UPDATES=path.join(DATA_DIR,'updates');
fs.mkdirSync(PROFILES,{recursive:true});
fs.mkdirSync(UPDATES,{recursive:true});

const MAX_BODY=3000000;
const GAMEPLAY_MAX_BODY=26000000;
const ALLOW=new Set(['GET','POST','PUT','OPTIONS']);
const codeRe=/^#[A-Z0-9]{10}$/;
const legacyRe=/^#[A-Z0-9]{5}$/;
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
    refreshRate:'Up to 144 Hz',
    touchSampling:'Up to 3000 Hz instant touch / 360 Hz custom',
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
    'Access-Control-Allow-Headers':'Content-Type',
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
      if(done)return;
      done=true;
      try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}
    });
    req.on('error',e=>{if(!done){done=true;reject(e)}});
  });
}
function body(req){return readBody(req,MAX_BODY)}
function fileFor(dir,code){return path.join(dir,encodeURIComponent(code)+'.json')}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function writeJson(file,obj){
  const t=file+'.tmp';
  fs.writeFileSync(t,JSON.stringify(obj,null,2));
  fs.renameSync(t,file);
}
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
  const url=OFFICIAL_OB_URLS[ob];
  if(!url)return null;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),9000);
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
    dbReady=true;dbError='';
    console.log('VG MENT4L persistent database connected.');
  }catch(e){
    dbReady=false;dbError=String(e&&e.message||e);
    console.error('Database connection failed; local fallback remains available:',dbError);
    try{await pool?.end()}catch{}
    pool=null;
  }
}
async function dbGetProfile(code){
  if(!dbReady||!pool)return null;
  const r=await pool.query('SELECT profile FROM vg_profiles WHERE code=$1 LIMIT 1',[code]);
  return r.rows[0]?.profile||null;
}
async function dbSaveProfile(p){
  if(!dbReady||!pool)return false;
  await pool.query(
    'INSERT INTO vg_profiles(code,profile,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(code) DO UPDATE SET profile=EXCLUDED.profile,updated_at=NOW()',
    [p.code,JSON.stringify(p)]
  );
  return true;
}
async function dbSaveUpdate(i){
  if(!dbReady||!pool)return false;
  await pool.query('INSERT INTO vg_updates(code,item) VALUES($1,$2::jsonb)',[i.code||null,JSON.stringify(i)]);
  return true;
}
async function dbGetUpdates(c){
  if(!dbReady||!pool)return null;
  const r=await pool.query('SELECT item FROM vg_updates WHERE code=$1 ORDER BY created_at DESC LIMIT 100',[c]);
  return r.rows.map(x=>x.item);
}
function makeNewProfileCode(){
  const chars='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c='#';
  for(let i=0;i<10;i++)c+=chars[Math.floor(Math.random()*chars.length)];
  return c;
}
function normSens(s){
  s=s||{};
  return{
    general:clamp(s.general??s.General),
    red_dot:clamp(s.red_dot??s.RedDot??s.redDot),
    scope_2x:clamp(s.scope_2x??s['2x']??s.scope2x),
    scope_4x:clamp(s.scope_4x??s['4x']??s.scope4x),
    sniper:clamp(s.sniper??s.Sniper),
    free_look:clamp(s.free_look??s.FreeLook??s.freeLook)
  };
}

const ISSUE_DELTAS={
 'Aim head se upar ja raha hai':{general:-5,red_dot:-6,scope_2x:-5,scope_4x:-4,sniper:-3,free_look:0},
 'Aim chest pe lock ho raha hai':{general:6,red_dot:7,scope_2x:5,scope_4x:4,sniper:2,free_look:0},
 'Aim neck pe lock ho raha hai':{general:3,red_dot:4,scope_2x:3,scope_4x:2,sniper:1,free_look:0},
 'Drag slow lag raha hai':{general:7,red_dot:7,scope_2x:5,scope_4x:3,sniper:2,free_look:2},
 'Drag bahut fast / overshoot':{general:-7,red_dot:-7,scope_2x:-5,scope_4x:-3,sniper:-2,free_look:-2},
 'Recoil / spray shaky':{general:-4,red_dot:-5,scope_2x:-6,scope_4x:-7,sniper:-4,free_look:0},
 'Close-range tracking slow':{general:6,red_dot:5,scope_2x:2,scope_4x:0,sniper:0,free_look:1},
 'Long-range aim unstable':{general:-2,red_dot:-2,scope_2x:-4,scope_4x:-6,sniper:-6,free_look:0},
 'Aim target pe stick nahi kar raha':{general:2,red_dot:2,scope_2x:1,scope_4x:1,sniper:1,free_look:0},
 'Crosshair shaky':{general:-3,red_dot:-3,scope_2x:-3,scope_4x:-3,sniper:-2,free_look:0},
 'One-tap timing inconsistent':{general:-2,red_dot:-2,scope_2x:-1,scope_4x:0,sniper:0,free_look:0},
 'Flick target ke aage nikal raha hai':{general:-5,red_dot:-5,scope_2x:-4,scope_4x:-3,sniper:-2,free_look:0}
};
function inferCustomDeltas(t){
  t=String(t||'').toLowerCase();
  const d={general:0,red_dot:0,scope_2x:0,scope_4x:0,sniper:0,free_look:0};
  const add=x=>Object.keys(d).forEach(k=>d[k]+=x[k]||0);
  if(/upar|above|overshoot|zyada|fast|tez|high|head ke upar|aage nikal/.test(t))add({general:-4,red_dot:-4,scope_2x:-3,scope_4x:-2,sniper:-2});
  if(/chest|body|neeche|low|under|kam|slow|dheere|body pe/.test(t))add({general:4,red_dot:4,scope_2x:3,scope_4x:2,sniper:2});
  if(/neck/.test(t))add({general:2,red_dot:2,scope_2x:2,scope_4x:1,sniper:1});
  if(/recoil|spray|shake|shaky|hil|vibration/.test(t))add({general:-2,red_dot:-3,scope_2x:-4,scope_4x:-5,sniper:-3});
  if(/close|near|tracking|close range/.test(t))add({general:3,red_dot:3,scope_2x:1,free_look:1});
  if(/long|range|distance|door se/.test(t))add({general:-1,red_dot:-1,scope_2x:-2,scope_4x:-3,sniper:-4});
  return d;
}
function applyIssueList(base,issues=[],customText=''){
  const s=normSens(base);
  const list=Array.isArray(issues)?issues.map(x=>String(x||'').trim()).filter(Boolean):[];
  const t={general:0,red_dot:0,scope_2x:0,scope_4x:0,sniper:0,free_look:0};
  for(const i of list){
    const d=ISSUE_DELTAS[i];
    if(d)for(const k of Object.keys(t))t[k]+=Number(d[k]||0);
  }
  const c=inferCustomDeltas(customText);
  for(const k of Object.keys(t))t[k]+=c[k]||0;
  const fixed={};
  for(const k of Object.keys(s))fixed[k]=clamp(s[k]+Math.max(-15,Math.min(15,t[k])));
  return{sensitivity:fixed,issues:list,customText:String(customText||'').trim()};
}
function cleanIssueList(x){
  if(Array.isArray(x))return x.map(v=>String(v||'').trim()).filter(Boolean).slice(0,20);
  return x?[String(x).trim()]:[];
}
function extractResponseText(d){
  if(!d)return'';
  if(typeof d.output_text==='string')return d.output_text;
  let s='';
  for(const i of(d.output||[]))
    for(const c of(i.content||[]))
      if(typeof c.text==='string')s+=c.text;
  return s.trim();
}
function stripFences(s){
  return String(s||'').replace(/^```json\s*/i,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim();
}
function parseJsonLoose(s){
  const cleaned=stripFences(s);
  try{return JSON.parse(cleaned)}catch{}
  const a=cleaned.indexOf('{'),b=cleaned.lastIndexOf('}');
  if(a>=0&&b>a){try{return JSON.parse(cleaned.slice(a,b+1))}catch{}}
  throw new Error('AI returned invalid JSON');
}
async function openAIResponses({model,input,maxOutputTokens=1800,timeoutMs=45000}){
  const key=String(process.env.OPENAI_API_KEY||'').trim();
  if(!key)throw new Error('OPENAI_API_KEY is not configured on Render');
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},
      body:JSON.stringify({model,input,max_output_tokens:maxOutputTokens}),
      signal:ctl.signal
    });
    const raw=await r.text();
    if(!r.ok){
      let detail=raw.slice(0,900);
      try{const e=JSON.parse(raw);detail=e?.error?.message||detail}catch{}
      throw new Error(`OpenAI HTTP ${r.status}: ${detail}`);
    }
    let d;
    try{d=JSON.parse(raw)}catch{throw new Error('OpenAI returned invalid JSON envelope')}
    return parseJsonLoose(extractResponseText(d));
  }finally{clearTimeout(timer)}
}

function batchPrompt(context,batchNo,total){
  return `You are VG MENT4L's gameplay-vision analyst for Free Fire MAX.
This is evidence-based calibration, not a guarantee. Inspect ONLY what is visibly supported by the supplied gameplay screenshots.

TASK:
1) Identify visible sensitivity problems: overshoot/undershoot, head-overdrag, chest/neck lock, slow/fast drag, recoil/spray instability, crosshair shake, target tracking, flick control, close/mid/long-range behavior, and visible FPS/lag/recording artifacts.
2) Compare those observations with the CURRENT sensitivity in the profile context.
3) Do not invent hardware facts. Treat RAM as context, not a direct multiplier.
4) Recommend direction and magnitude of changes, but do not produce the final sensitivity in this batch.

Return ONLY valid JSON:
{"observations":[],"issues":[],"direction":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"evidenceQuality":"low|medium|high","confidence":"low|medium|high"}

Batch ${batchNo}/${total}
PROFILE CONTEXT:
${JSON.stringify(context||{})}`;
}

async function analyzeVisionBatch(frames,context,batchNo,total,model){
  const content=[{type:'input_text',text:batchPrompt(context,batchNo,total)}];
  for(const frame of frames)content.push({type:'input_image',image_url:String(frame)});
  return await openAIResponses({model,input:[{role:'user',content}],maxOutputTokens:1200,timeoutMs:45000});
}

async function synthesizeGameplay(context,observations,model){
  const prompt=`You are the final sensitivity calibration engine for VG MENT4L.
Use the multi-batch gameplay observations below plus the current profile. Produce a NEW sensitivity that directly addresses the strongest repeated visual evidence.

RULES:
- Free Fire MAX sensitivity fields are 0-200.
- Preserve the player's existing setup when evidence does not justify a change.
- Do not use RAM as a direct multiplier.
- Avoid huge changes unless evidence strongly supports them.
- Strong recoil control and headshot potential are optimization goals, not guarantees.
- Explain exactly what was wrong with the old sensitivity and why each changed value changed.
- If evidence is weak or contradictory, lower confidence and make conservative changes.
- Return ONLY valid JSON.

SCHEMA:
{"playerType":"","sensitivityType":"","dragStyle":"","rangePreference":"","focusGuns":[],"mainIssue":"","findings":[],"oldSensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"recommendedSensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"adjustmentReasons":[],"problemDiagnosis":[],"confidence":"low|medium|high","evidenceSummary":""}

PROFILE:
${JSON.stringify(context||{})}

BATCH OBSERVATIONS:
${JSON.stringify(observations)}`;
  return await openAIResponses({model,input:[{role:'user',content:[{type:'input_text',text:prompt}]}],maxOutputTokens:1800,timeoutMs:45000});
}

async function runGameplayAI(p){
  const key=String(process.env.OPENAI_API_KEY||'').trim();
  const model=String(process.env.GAMEPLAY_AI_MODEL||'gpt-5.6-luna').trim();
  if(!key)return{configured:false,message:'Real gameplay AI is not configured. Add OPENAI_API_KEY in Render Environment Variables to enable vision analysis.'};

  const frames=Array.isArray(p.frames)?p.frames.slice(0,16):[];
  if(!frames.length)throw new Error('No gameplay frames were supplied');

  const maxPerBatch=4;
  const batches=[];
  for(let i=0;i<frames.length;i+=maxPerBatch)batches.push(frames.slice(i,i+maxPerBatch));

  const settled=await Promise.allSettled(
    batches.map((b,i)=>analyzeVisionBatch(b,p.context||{},i+1,batches.length,model))
  );
  const observations=[];
  const errors=[];
  settled.forEach((x,i)=>{
    if(x.status==='fulfilled')observations.push({...x.value,batch:i+1});
    else errors.push(`Batch ${i+1}: ${x.reason?.message||x.reason}`);
  });
  if(!observations.length)throw new Error('All vision batches failed. '+errors.join(' | '));

  let final;
  try{
    final=await synthesizeGameplay(p.context||{},observations,model);
  }catch(e){
    // Conservative local fallback if synthesis fails after successful vision batches.
    const base=normSens(p.context?.sensitivity);
    const dirs=observations.map(x=>x.direction||{});
    const avg={general:0,red_dot:0,scope_2x:0,scope_4x:0,sniper:0,free_look:0};
    for(const d of dirs)for(const k of Object.keys(avg))avg[k]+=Number(d[k]||0);
    for(const k of Object.keys(avg))avg[k]=Math.max(-12,Math.min(12,Math.round(avg[k]/Math.max(1,dirs.length))));
    final={
      playerType:'Gameplay-derived profile',
      sensitivityType:p.context?.gameSensitivity||'Default',
      dragStyle:'Evidence-derived',
      rangePreference:'Mixed',
      focusGuns:p.context?.guns||[],
      mainIssue:'Multi-batch vision completed; final synthesis fallback used',
      findings:observations.flatMap(x=>Array.isArray(x.observations)?x.observations:[]).slice(0,20),
      oldSensitivity:base,
      recommendedSensitivity:Object.fromEntries(Object.keys(base).map(k=>[k,clamp(base[k]+avg[k])])),
      adjustmentReasons:['Final synthesis fallback combined the successful vision batches conservatively.'],
      problemDiagnosis:observations.flatMap(x=>Array.isArray(x.issues)?x.issues:[]).slice(0,20),
      confidence:'medium',
      evidenceSummary:'Vision batches completed, but final synthesis failed: '+e.message
    };
    errors.push('Final synthesis: '+e.message);
  }
  final.oldSensitivity=normSens(final.oldSensitivity||p.context?.sensitivity);
  final.recommendedSensitivity=normSens(final.recommendedSensitivity);
  final.findings=Array.isArray(final.findings)?final.findings.slice(0,20):[];
  final.adjustmentReasons=Array.isArray(final.adjustmentReasons)?final.adjustmentReasons.slice(0,20):[];
  final.problemDiagnosis=Array.isArray(final.problemDiagnosis)?final.problemDiagnosis.slice(0,20):[];
  final.focusGuns=Array.isArray(final.focusGuns)?final.focusGuns.slice(0,10):[];
  final.configured=true;
  final.model=model;
  final.framesAnalyzed=frames.length;
  final.batchesAnalyzed=observations.length;
  final.partialErrors=errors;
  return final;
}

async function aiProblemFix(base,issues,customText,context){
  const key=String(process.env.OPENAI_API_KEY||'').trim();
  const model=String(process.env.GAMEPLAY_AI_MODEL||'gpt-5.6-luna').trim();
  if(!key)return null;
  const prompt=`You are VG MENT4L's sensitivity refinement engine.
The player already received a recommended sensitivity. They now report a new problem using preset issues and/or free text.
Analyze ALL selected issues together. The custom text is important and must not be ignored or replaced by presets.
Make a conservative 0-200 adjustment. Explain the diagnosis and each change.
Do not promise zero recoil or guaranteed headshots.
Return ONLY valid JSON:
{"diagnosis":"","changes":[],"sensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"confidence":"low|medium|high"}
CURRENT SENSITIVITY: ${JSON.stringify(normSens(base))}
SELECTED ISSUES: ${JSON.stringify(issues)}
CUSTOM PROBLEM: ${JSON.stringify(String(customText||''))}
PROFILE CONTEXT: ${JSON.stringify(context||{})}`;
  try{
    const out=await openAIResponses({model,input:[{role:'user',content:[{type:'input_text',text:prompt}]}],maxOutputTokens:900,timeoutMs:30000});
    out.sensitivity=normSens(out.sensitivity);
    out.changes=Array.isArray(out.changes)?out.changes.slice(0,12):[];
    out.model=model;out.ai=true;
    return out;
  }catch(e){return{ai:false,error:e.message}}
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
      return json(res,200,{ok:true,latestOb:`OB${LATEST_OB}`,latestObNumber:LATEST_OB,officialSource:OFFICIAL_OB_URLS[`OB${LATEST_OB}`],backend:dbReady,storage:dbReady?'supabase-postgres':'local-fallback',gameplayAI:!!String(process.env.OPENAI_API_KEY||'').trim(),version:'6.0-ultra'});
    if(req.method==='GET'&&u.pathname==='/api/health')
      return json(res,200,{ok:true,service:'VG MENT4L API',version:'6.0-ultra',latestOb:`OB${LATEST_OB}`,database:dbReady?'connected':'fallback',databaseError:dbReady?'':dbError,gameplayAI:!!String(process.env.OPENAI_API_KEY||'').trim()});
    if(req.method==='GET'&&u.pathname==='/api/device-research'){
      const q=u.searchParams.get('device')||'',hit=lookupDevice(q);
      return json(res,200,{ok:true,device:hit,verified:!!hit,query:q,notice:hit?'Exact/known device profile found.':'Exact device not in the verified catalog; do not invent hardware specs.'});
    }
    if(req.method==='GET'&&u.pathname==='/api/patch-research'){
      const ob=safeCode(u.searchParams.get('ob')||'');
      if(!/^OB\d+$/.test(ob))return json(res,400,{error:'Valid OB required'});
      if(Number(ob.slice(2))>LATEST_OB)return json(res,409,{error:`${ob} is not officially supported yet`,latestOb:`OB${LATEST_OB}`});
      const r=await fetchOfficial(ob);
      if(!r)return json(res,503,{error:'Official Garena patch could not be fetched right now',ob});
      return json(res,200,{ok:true,...r});
    }
    if(req.method==='GET'&&u.pathname.startsWith('/api/profiles/')){
      const c=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if(!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
      if(dbReady){const p=await dbGetProfile(c);if(p)return json(res,200,{profile:p,source:'backend'})}
      const p=readJson(fileFor(PROFILES,c));
      if(!p)return json(res,404,{error:'Profile not found'});
      return json(res,200,{profile:p,source:'local-fallback'});
    }
    if((req.method==='POST'||req.method==='PUT')&&u.pathname==='/api/profiles'){
      const b=await body(req),c=safeCode(b.code);
      if(!validCode(c))return json(res,400,{error:'Valid Profile ID required'});
      const p=cleanProfile(b,c);
      if(!p)return json(res,400,{error:'Invalid profile'});
      if(dbReady){await dbSaveProfile(p);return json(res,200,{ok:true,code:c,updatedAt:p.updatedAt,source:'backend'})}
      writeJson(fileFor(PROFILES,c),p);
      return json(res,200,{ok:true,code:c,updatedAt:p.updatedAt,source:'local-fallback',warning:'Persistent database unavailable'});
    }
    async function loadProfile(c){let p=null;if(dbReady)p=await dbGetProfile(c);return p||readJson(fileFor(PROFILES,c))}
    async function saveProfile(p){
      let c=makeNewProfileCode();
      for(let i=0;i<8;i++){
        if(!(await loadProfile(c)))break;
        c=makeNewProfileCode();
      }
      p=cleanProfile({...p,code:c},c);
      if(dbReady)await dbSaveProfile(p);else writeJson(fileFor(PROFILES,c),p);
      return p;
    }
    if(req.method==='POST'&&u.pathname==='/api/profile-fix'){
      const b=await body(req),oldCode=safeCode(b.code);
      if(!validCode(oldCode))return json(res,400,{error:'Valid existing Profile ID required'});
      const old=await loadProfile(oldCode);
      if(!old)return json(res,404,{error:'Existing profile not found'});
      const issues=cleanIssueList(b.issues??b.issue),custom=String(b.customText||b.custom||'').trim();
      if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
      const fixed=applyIssueList(old.sensitivity,issues,custom);
      const clone=JSON.parse(JSON.stringify(old));
      clone.sensitivity=fixed.sensitivity;
      clone.recalibration={...(clone.recalibration||{}),sourceProfileId:oldCode,issues,customText:custom,createdAt:new Date().toISOString()};
      const p=await saveProfile(clone);
      return json(res,200,{ok:true,oldProfileId:oldCode,newProfileId:p.code,sensitivity:p.sensitivity,issues,customText:custom,oldProfileUnchanged:true,source:dbReady?'backend':'local-fallback'});
    }
    if(req.method==='POST'&&u.pathname==='/api/manual-fix'){
      const b=await body(req),issues=cleanIssueList(b.issues??b.issue),custom=String(b.customText||b.custom||'').trim();
      if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
      return json(res,200,{ok:true,...applyIssueList(b.sensitivity,issues,custom)});
    }
    if(req.method==='POST'&&u.pathname==='/api/gameplay-analyze'){
      const b=await readBody(req,GAMEPLAY_MAX_BODY);
      if(!Array.isArray(b.frames)||!b.frames.length)return json(res,400,{error:'Gameplay frames required'});
      b.frames=b.frames.slice(0,16);
      for(const f of b.frames){
        if(typeof f!=='string'||!f.startsWith('data:image/'))return json(res,400,{error:'Invalid gameplay frame'});
        if(f.length>2500000)return json(res,413,{error:'One gameplay frame is too large'});
      }
      const result=await runGameplayAI(b);
      return json(res,200,{ok:true,temporary:true,videoStored:false,framesReceived:b.frames.length,result});
    }
    if(req.method==='POST'&&u.pathname==='/api/gameplay-fix'){
      const b=await body(req);
      const issues=cleanIssueList(b.issues??b.issue);
      const custom=String(b.customText||b.custom||'').trim();
      if(!issues.length&&!custom)return json(res,400,{error:'Select at least one problem or enter a custom problem'});
      const base=normSens(b.sensitivity);
      const ai=await aiProblemFix(base,issues,custom,b.context||{});
      let fixedSens=ai?.sensitivity;
      let mode='ai';
      if(!fixedSens){fixedSens=applyIssueList(base,issues,custom).sensitivity;mode='safe-fallback'}
      const oldCode=safeCode(b.code||'');
      if(validCode(oldCode)){
        const old=await loadProfile(oldCode);
        if(old){
          const clone=JSON.parse(JSON.stringify(old));
          clone.sensitivity=fixedSens;
          clone.recalibration={...(clone.recalibration||{}),sourceProfileId:oldCode,issues,customText:custom,source:'gameplay-check-ultra',diagnosis:ai?.diagnosis||'',createdAt:new Date().toISOString()};
          const p=await saveProfile(clone);
          return json(res,200,{ok:true,oldProfileId:oldCode,newProfileId:p.code,sensitivity:p.sensitivity,issues,customText:custom,oldProfileUnchanged:true,diagnosis:ai?.diagnosis||'',changes:ai?.changes||[],confidence:ai?.confidence||'medium',mode,warning:ai?.error||''});
        }
      }
      return json(res,200,{ok:true,newProfileId:null,sensitivity:fixedSens,issues,customText:custom,oldProfileUnchanged:true,diagnosis:ai?.diagnosis||'',changes:ai?.changes||[],confidence:ai?.confidence||'medium',mode,warning:ai?.error||''});
    }
    if(req.method==='POST'&&u.pathname==='/api/updates'){
      const b=await body(req),c=safeCode(b.code||'');
      if(c&&!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
      const item={...b,code:c||null,time:b.time||new Date().toISOString()};
      if(dbReady){await dbSaveUpdate(item);return json(res,200,{ok:true,source:'backend'})}
      const f=fileFor(UPDATES,c||'manual'),a=readJson(f)||[];
      a.unshift(item);writeJson(f,a.slice(0,100));
      return json(res,200,{ok:true,source:'local-fallback'});
    }
    if(req.method==='GET'&&u.pathname.startsWith('/api/updates/')){
      const c=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if(!validCode(c))return json(res,400,{error:'Invalid Profile ID'});
      if(dbReady)return json(res,200,{updates:await dbGetUpdates(c),source:'backend'});
      return json(res,200,{updates:readJson(fileFor(UPDATES,c))||[],source:'local-fallback'});
    }
    const r=routes[u.pathname];
    if(req.method==='GET'&&r)return sendFile(res,path.join(ROOT,r[0]),r[1]);
    return json(res,404,{error:'Not found'});
  }catch(e){
    console.error(e);
    return json(res,500,{error:'Server error',detail:String(e&&e.message||e)});
  }
});
server.listen(PORT,async()=>{console.log(`VG MENT4L running on http://localhost:${PORT}`);await initDb()});
