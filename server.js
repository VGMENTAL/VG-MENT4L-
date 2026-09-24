const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PROFILES = path.join(DATA_DIR, 'profiles');
const UPDATES = path.join(DATA_DIR, 'updates');
fs.mkdirSync(PROFILES, {recursive:true});
fs.mkdirSync(UPDATES, {recursive:true});

const ALLOW = new Set(['GET','POST','PUT','OPTIONS']);
const codeRe = /^#[A-Z0-9]{10}$/;
const legacyRe = /^#[A-Z0-9]{5}$/;
const validCode = c => codeRe.test(c) || legacyRe.test(c);
const safeCode = c => String(c||'').toUpperCase().trim();
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,PUT,OPTIONS'});res.end(JSON.stringify(obj));}
function body(req){return new Promise((resolve,reject)=>{let b='';req.on('data',x=>{b+=x;if(b.length>2_000_000) req.destroy();});req.on('end',()=>{try{resolve(b?JSON.parse(b):{})}catch(e){reject(e)}});req.on('error',reject)});}
function fileFor(dir,code){return path.join(dir,encodeURIComponent(code)+'.json');}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return null}}
function writeJson(file,obj){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(obj,null,2));fs.renameSync(tmp,file)}
function cleanProfile(p,code){
  if(!p || typeof p!=='object') return null;
  const out={...p,code};
  // Do not store uploaded HUD image bytes in the profile API.
  if(out.hudUploaded && out.hudImageData) delete out.hudImageData;
  out.updatedAt=new Date().toISOString();
  return out;
}
function sendFile(res,file,type){if(!fs.existsSync(file)){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':type,'Cache-Control':'public, max-age=300'});fs.createReadStream(file).pipe(res)}

const routes={
  '/': ['index.html','text/html; charset=utf-8'],
  '/website1.html': ['website1.html','text/html; charset=utf-8'],
  '/website2.html': ['website2.html','text/html; charset=utf-8'],
  '/robots.txt': ['robots.txt','text/plain; charset=utf-8'],
  '/sitemap.xml': ['sitemap.xml','application/xml; charset=utf-8']
};

const server=http.createServer(async(req,res)=>{
  if(!ALLOW.has(req.method)) return json(res,405,{error:'Method not allowed'});
  if(req.method==='OPTIONS') return json(res,204,{});
  const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
  try{
    if(req.method==='GET' && u.pathname.startsWith('/api/profiles/')){
      const code=safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if(!validCode(code)) return json(res,400,{error:'Invalid Profile ID'});
      const p=readJson(fileFor(PROFILES,code));
      if(!p) return json(res,404,{error:'Profile not found'});
      return json(res,200,{profile:p});
    }
    if((req.method==='POST'||req.method==='PUT') && u.pathname==='/api/profiles'){
      const b=await body(req); let code=safeCode(b.code);
      if(!validCode(code)) return json(res,400,{error:'Valid Profile ID required'});
      const p=cleanProfile(b,code); if(!p) return json(res,400,{error:'Invalid profile'});
      writeJson(fileFor(PROFILES,code),p);
      return json(res,200,{ok:true,code,updatedAt:p.updatedAt});
    }
    if(req.method==='POST' && u.pathname==='/api/updates'){
      const b=await body(req); const code=safeCode(b.code||'');
      if(code && !validCode(code)) return json(res,400,{error:'Invalid Profile ID'});
      const item={...b,time:b.time||new Date().toISOString()};
      const key=code||'manual'; const file=fileFor(UPDATES,key); const arr=readJson(file)||[]; arr.unshift(item); writeJson(file,arr.slice(0,100));
      return json(res,200,{ok:true});
    }
    if(req.method==='GET' && u.pathname==='/api/health') return json(res,200,{ok:true,service:'VG MENT4L API'});
    const r=routes[u.pathname]; if(req.method==='GET' && r) return sendFile(res,path.join(ROOT,r[0]),r[1]);
    if(req.method==='GET' && u.pathname.startsWith('/assets/')) return sendFile(res,path.join(ROOT,u.pathname), 'application/octet-stream');
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{error:'Server error'});}
});
server.listen(PORT,()=>console.log(`VG MENT4L running on http://localhost:${PORT}`));
