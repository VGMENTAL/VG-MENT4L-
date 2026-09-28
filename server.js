const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const PROFILES = path.join(DATA, 'profiles');
const UPDATES = path.join(DATA, 'updates');
fs.mkdirSync(PROFILES, { recursive: true });
fs.mkdirSync(UPDATES, { recursive: true });

const MAX_BODY = 3 * 1024 * 1024;
const GAMEPLAY_MAX_BODY = 2 * 1024 * 1024 * 1024; // 2 GB
const GAMEPLAY_TIMEOUT_MS = 30 * 60 * 1000;
const OPENAI_FRAME_BODY = 18 * 1024 * 1024;
const OPENAI_GAMEPLAY_MODEL = String(process.env.OPENAI_GAMEPLAY_MODEL || 'gpt-5.6-luna').trim();
const ALLOW = new Set(['GET', 'POST', 'PUT', 'OPTIONS']);
const codeRe = /^#[A-Z0-9]{10}$/;
const legacyRe = /^#[A-Z0-9]{5}$/;
const validCode = c => codeRe.test(c) || legacyRe.test(c);
const safeCode = c => String(c || '').toUpperCase().trim();
const clamp = n => Math.max(0, Math.min(200, Math.round(Number(n) || 0)));
const LATEST_OB = 55;

const OFFICIAL_OB_URLS = {
  // Keep every supported historical OB available so OB52 → OB55
  // researches each intermediate official patch instead of behaving
  // like a hard-coded OB54 → OB55 conversion.
  OB49: 'https://www.freefiremobile.com/en/article/1473/',
  OB50: 'https://www.freefiremobile.com/en/article/1511/',
  OB51: 'https://www.freefiremobile.com/en/news/20/',
  OB52: 'https://www.freefiremobile.com/en/article/1595/',
  OB53: 'https://ff.garena.com/en/article/1640/',
  OB54: 'https://ff.garena.com/en/article/1673/',
  OB55: 'https://ff.garena.com/en/article/1712/'
};

const VERIFIED_DEVICES = {
  'iqoo neo 10': {
    canonical: 'iQOO Neo 10', brand: 'iQOO', platform: 'Android',
    chipset: 'Snapdragon 8s Gen 4', gpu: 'Adreno-class GPU',
    ram: '8/12/16 GB LPDDR5X Ultra', display: '6.78-inch 1.5K AMOLED',
    refreshRate: 'Up to 144 Hz', touchSampling: 'Up to 3000 Hz instant touch / 360 Hz custom',
    os: 'Funtouch OS 15 based on Android 15',
    gaming: 'Supercomputing Chip Q1; 144 FPS gaming support; 7000 mm² VC cooling',
    source: 'https://www.iqoo.com/in/products/neo10'
  }
};

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-VG-Context, Content-Length',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let body = '';
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      body += chunk.toString();
      if (Buffer.byteLength(body) > limit) {
        done = true;
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', e => { if (!done) { done = true; reject(e); } });
  });
}

function fileFor(dir, code) { return path.join(dir, encodeURIComponent(code) + '.json'); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function cleanProfile(profile, code) {
  if (!profile || typeof profile !== 'object') return null;
  const out = { ...profile, code: safeCode(code) };
  delete out.hudImageData;
  if (out.sensitivity && typeof out.sensitivity === 'object') {
    for (const k of Object.keys(out.sensitivity)) out.sensitivity[k] = clamp(out.sensitivity[k]);
  }
  out.updatedAt = new Date().toISOString();
  return out;
}
function sendFile(res, file, type) {
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' });
  fs.createReadStream(file).pipe(res);
}
function normalizeDevice(s) { return String(s || '').toLowerCase().replace(/[®™]/g, '').replace(/\s+/g, ' ').trim(); }
function lookupDevice(name) {
  const n = normalizeDevice(name);
  for (const [k, v] of Object.entries(VERIFIED_DEVICES)) {
    if (n === k || n.includes(k) || k.includes(n)) return { ...v, match: 'exact', query: name };
  }
  return null;
}

async function fetchOfficial(ob) {
  const url = OFFICIAL_OB_URLS[ob];
  if (!url) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'VG-MENT4L-Patch-Research/3.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { ob, url, text: (await r.text()).slice(0, 220000), fetchedAt: new Date().toISOString() };
  } catch { return null; }
  finally { clearTimeout(timer); }
}

const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
let pool = null;
let dbReady = false;
let dbError = '';

async function initDb() {
  if (!DATABASE_URL) { dbError = 'DATABASE_URL is not configured; using local fallback.'; return; }
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: false }
    });
    await pool.query('SELECT 1');
    await pool.query('CREATE TABLE IF NOT EXISTS vg_profiles (code TEXT PRIMARY KEY, profile JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('CREATE TABLE IF NOT EXISTS vg_updates (id BIGSERIAL PRIMARY KEY, code TEXT NULL, item JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query('CREATE INDEX IF NOT EXISTS vg_updates_code_idx ON vg_updates(code)');
    dbReady = true;
    dbError = '';
    console.log('VG MENT4L persistent database connected.');
  } catch (e) {
    dbReady = false;
    dbError = String(e?.message || e);
    console.error('Database connection failed; local fallback remains available:', dbError);
    try { await pool?.end(); } catch {}
    pool = null;
  }
}
async function dbGetProfile(code) {
  if (!dbReady || !pool) return null;
  const r = await pool.query('SELECT profile FROM vg_profiles WHERE code=$1 LIMIT 1', [code]);
  return r.rows[0]?.profile || null;
}
async function dbSaveProfile(profile) {
  if (!dbReady || !pool) return false;
  await pool.query(
    'INSERT INTO vg_profiles(code,profile,updated_at) VALUES($1,$2::jsonb,NOW()) ON CONFLICT(code) DO UPDATE SET profile=EXCLUDED.profile,updated_at=NOW()',
    [profile.code, JSON.stringify(profile)]
  );
  return true;
}
async function dbSaveUpdate(item) {
  if (!dbReady || !pool) return false;
  await pool.query('INSERT INTO vg_updates(code,item) VALUES($1,$2::jsonb)', [item.code || null, JSON.stringify(item)]);
  return true;
}
async function dbGetUpdates(code) {
  if (!dbReady || !pool) return null;
  const r = await pool.query('SELECT item FROM vg_updates WHERE code=$1 ORDER BY created_at DESC LIMIT 100', [code]);
  return r.rows.map(x => x.item);
}

function makeNewProfileCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let c = '#';
  for (let i = 0; i < 10; i++) c += chars[crypto.randomInt(chars.length)];
  return c;
}
function normSens(s = {}) {
  return {
    general: clamp(s.general ?? s.General),
    red_dot: clamp(s.red_dot ?? s.RedDot ?? s.redDot),
    scope_2x: clamp(s.scope_2x ?? s['2x'] ?? s.scope2x),
    scope_4x: clamp(s.scope_4x ?? s['4x'] ?? s.scope4x),
    sniper: clamp(s.sniper ?? s.Sniper),
    free_look: clamp(s.free_look ?? s.FreeLook ?? s.freeLook)
  };
}

const ISSUE_DELTAS = {
  'Aim head se upar ja raha hai': { general: -5, red_dot: -6, scope_2x: -5, scope_4x: -4, sniper: -3, free_look: 0 },
  'Aim chest pe lock ho raha hai': { general: 6, red_dot: 7, scope_2x: 5, scope_4x: 4, sniper: 2, free_look: 0 },
  'Aim neck pe lock ho raha hai': { general: 3, red_dot: 4, scope_2x: 3, scope_4x: 2, sniper: 1, free_look: 0 },
  'Drag slow lag raha hai': { general: 7, red_dot: 7, scope_2x: 5, scope_4x: 3, sniper: 2, free_look: 2 },
  'Drag bahut fast / overshoot': { general: -7, red_dot: -7, scope_2x: -5, scope_4x: -3, sniper: -2, free_look: -2 },
  'Recoil / spray shaky': { general: -4, red_dot: -5, scope_2x: -6, scope_4x: -7, sniper: -4, free_look: 0 },
  'Close-range tracking slow': { general: 6, red_dot: 5, scope_2x: 2, scope_4x: 0, sniper: 0, free_look: 1 },
  'Long-range aim unstable': { general: -2, red_dot: -2, scope_2x: -4, scope_4x: -6, sniper: -6, free_look: 0 },
  'Aim target pe stick nahi kar raha': { general: 2, red_dot: 2, scope_2x: 1, scope_4x: 1, sniper: 1, free_look: 0 }
};
function inferCustomDeltas(text) {
  const t = String(text || '').toLowerCase();
  const d = { general: 0, red_dot: 0, scope_2x: 0, scope_4x: 0, sniper: 0, free_look: 0 };
  const add = x => Object.keys(d).forEach(k => d[k] += x[k] || 0);
  if (/upar|above|overshoot|zyada|fast|tez|high/.test(t)) add({ general: -4, red_dot: -4, scope_2x: -3, scope_4x: -2, sniper: -2 });
  if (/chest|body|neeche|low|under|kam|slow|dheere/.test(t)) add({ general: 4, red_dot: 4, scope_2x: 3, scope_4x: 2, sniper: 2 });
  if (/neck/.test(t)) add({ general: 2, red_dot: 2, scope_2x: 2, scope_4x: 1, sniper: 1 });
  if (/recoil|spray|shake|shaky|hil/.test(t)) add({ general: -2, red_dot: -3, scope_2x: -4, scope_4x: -5, sniper: -3 });
  if (/close|near|tracking/.test(t)) add({ general: 3, red_dot: 3, scope_2x: 1, free_look: 1 });
  if (/long|range|distance/.test(t)) add({ general: -1, red_dot: -1, scope_2x: -2, scope_4x: -3, sniper: -4 });
  return d;
}
function applyIssueList(base, issues = [], customText = '') {
  const s = normSens(base);
  const list = Array.isArray(issues) ? issues.map(x => String(x || '').trim()).filter(Boolean).slice(0, 20) : [];
  const delta = { general: 0, red_dot: 0, scope_2x: 0, scope_4x: 0, sniper: 0, free_look: 0 };
  for (const issue of list) {
    const d = ISSUE_DELTAS[issue];
    if (d) for (const k of Object.keys(delta)) delta[k] += Number(d[k] || 0);
  }
  const custom = inferCustomDeltas(customText);
  for (const k of Object.keys(delta)) delta[k] += custom[k] || 0;
  const out = {};
  for (const k of Object.keys(s)) out[k] = clamp(s[k] + Math.max(-15, Math.min(15, delta[k])));
  return { sensitivity: out, issues: list, customText: String(customText || '').trim() };
}
function cleanIssueList(x) {
  if (Array.isArray(x)) return x.map(v => String(v || '').trim()).filter(Boolean).slice(0, 20);
  return x ? [String(x).trim()] : [];
}
function stripFences(s) {
  return String(s || '').replace(/^```json\s*/i, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
}
function extractText(d) {
  if (!d) return '';
  if (typeof d.output_text === 'string') return d.output_text;
  if (Array.isArray(d.output)) {
    let s = '';
    for (const item of d.output) {
      if (typeof item?.text === 'string') s += item.text;
      for (const c of item.content || []) if (typeof c.text === 'string') s += c.text;
    }
    if (s) return s.trim();
  }
  if (Array.isArray(d.outputs)) {
    let s = '';
    for (const item of d.outputs) {
      if (typeof item?.text === 'string') s += item.text;
      for (const c of item.content || []) if (typeof c.text === 'string') s += c.text;
    }
    if (s) return s.trim();
  }
  if (Array.isArray(d.steps)) {
    let s = '';
    for (const step of d.steps) for (const c of step.content || []) if (typeof c.text === 'string') s += c.text;
    if (s) return s.trim();
  }
  if (Array.isArray(d.candidates)) {
    let s = '';
    for (const c of d.candidates) for (const p of c.content?.parts || []) if (typeof p.text === 'string') s += p.text;
    if (s) return s.trim();
  }
  return '';
}
function parseJsonOutput(text) {
  const s = stripFences(text);
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(s.slice(a, b + 1)); } catch {}
  }
  throw new Error('AI returned non-JSON output');
}
async function fetchWithTimeout(url, options = {}, ms = 900000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...options, signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}

async function startGeminiUpload(mime, size, displayName, key) {
  // Gemini Files API REST flow: authenticate with x-goog-api-key
  // and use the resumable upload headers documented by Google.
  const uploadEndpoint = 'https://generativelanguage.googleapis.com/upload/v1beta/files';
  const r = await fetchWithTimeout(uploadEndpoint, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: displayName } })
  }, 60000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Gemini upload-start HTTP ${r.status}: ${text.slice(0, 1000)}`);
  const uploadUrl = r.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini upload URL missing');
  return uploadUrl;
}

async function uploadGeminiStream(stream, mime, size, displayName, key) {
  const uploadUrl = await startGeminiUpload(mime, size, displayName, key);
  const r = await fetchWithTimeout(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: stream,
    duplex: 'half'
  }, GAMEPLAY_TIMEOUT_MS);
  const text = await r.text();
  if (!r.ok) throw new Error(`Gemini video upload HTTP ${r.status}: ${text.slice(0, 1200)}`);
  let info;
  try { info = JSON.parse(text); } catch { throw new Error('Gemini returned invalid upload JSON'); }
  if (!info.file?.name || !info.file?.uri) throw new Error('Gemini did not return a usable file reference');
  return info.file;
}

async function waitGeminiFile(name, key) {
  for (let i = 0; i < 120; i++) {
    const r = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      headers: { 'x-goog-api-key': key }
    }, 30000);
    const text = await r.text();
    if (!r.ok) throw new Error(`Gemini file-status HTTP ${r.status}: ${text.slice(0, 1000)}`);
    const d = JSON.parse(text);
    const state = String(d.state || d.file?.state || '').toUpperCase();
    if (state === 'ACTIVE') return d.file || d;
    if (state === 'FAILED') throw new Error('Gemini video processing failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Gemini video processing timed out');
}
async function deleteGeminiFile(name, key) {
  try {
    await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/${name}`, {
      method: 'DELETE', headers: { 'x-goog-api-key': key }
    }, 30000);
  } catch {}
}

async function runGeminiVideo(stream, mime, size, context) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const configuredModel = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  if (!key) return { configured: false, message: 'GEMINI_API_KEY is not configured. Render Environment Variables mein Gemini API key add karo.' };

  // FAST MODE: short gameplay clips use static processing because it avoids the
  // extra agentic navigation/tool round-trips that can increase latency.
  const models = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.7-flash', configuredModel]
    .filter((m, i, arr) => m && arr.indexOf(m) === i);

  // Keep the complete-video upload path, but analyze the uploaded video directly
  // with generateContent. The browser does not create representative screenshots.
  const fileInfo = await uploadGeminiStream(stream, mime, size, 'VG-MENT4L-gameplay-' + Date.now(), key);

  try {
    const prompt = `Analyze this COMPLETE Free Fire MAX gameplay video for sensitivity calibration.
Use repeated evidence across the whole clip. Check drag speed, overshoot/under-drag, head/neck/chest stopping point, recoil control, range, target switching and movement while firing. Separate player mistakes/FPS/ping/recording artifacts from sensitivity problems.

Rules:
- Anchor to CURRENT sensitivity in PROFILE CONTEXT.
- Change a value only when repeated evidence supports that direction.
- Prefer the smallest useful change.
- Do not assume every miss is sensitivity-related.
- Return concise JSON only.

PROFILE CONTEXT:
${JSON.stringify(context)}

JSON:
{"playerType":"","dragStyle":"","rangePreference":"","mainIssue":"","problemDiagnosis":[""],"findings":[""],"recommendedSensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"adjustmentReasons":[""],"evidenceSummary":"","confidence":"low|medium|high","videoDuration":"","timestampEvidence":["MM:SS observation"]}
Values 0-200 integers. No guaranteed headshots/recoil.`;

    let last503 = null;

    for (const candidate of models) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const started = Date.now();
        const r = await fetchWithTimeout(
          'https://generativelanguage.googleapis.com/v1beta/models/' +
          encodeURIComponent(candidate) + ':generateContent',
          {
            method: 'POST',
            headers: {
              ['x-goog-' + 'api-key']: key,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              contents: [{
                role: 'user',
                parts: [
                  {
                    file_data: {
                      file_uri: fileInfo.uri,
                      mime_type: mime
                    },
                    media_resolution: {
                      level: 'MEDIA_RESOLUTION_LOW'
                    },
                    media_processing: 'STATIC'
                  },
                  { text: prompt }
                ]
              }],
              generationConfig: {
                temperature: 0,
                seed: 42,
                thinkingConfig: { thinkingLevel: 'minimal' },
                maxOutputTokens: 1200,
                responseMimeType: 'application/json',
                mediaResolution: 'MEDIA_RESOLUTION_LOW'
              }
            })
          },
          GAMEPLAY_TIMEOUT_MS
        );

        const responseText = await r.text();
        const elapsedMs = Date.now() - started;

        if (r.ok) {
          const data = JSON.parse(responseText);
          const out = parseJsonOutput(extractText(data));
          out.recommendedSensitivity = normSens(out.recommendedSensitivity);
          out.findings = Array.isArray(out.findings) ? out.findings.slice(0, 24) : [];
          out.problemDiagnosis = Array.isArray(out.problemDiagnosis) ? out.problemDiagnosis.slice(0, 16) : [];
          out.adjustmentReasons = Array.isArray(out.adjustmentReasons) ? out.adjustmentReasons.slice(0, 16) : [];
          out.timestampEvidence = Array.isArray(out.timestampEvidence) ? out.timestampEvidence.slice(0, 12) : [];
          out.model = candidate;
          out.configured = true;
          out.fullVideo = true;
          out.processingMode = 'static-fast-minimal';
          out.mediaResolution = 'low';
          out.aiAnalysisMs = elapsedMs;
          return out;
        }

        if (r.status === 503) {
          last503 = new Error(`Gemini video analysis HTTP 503: ${responseText.slice(0, 1200)}`);
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700));
          continue;
        }

        throw new Error(`Gemini video analysis HTTP ${r.status}: ${responseText.slice(0, 1800)}`);
      }
    }

    if (last503) throw last503;
    throw new Error('Gemini video analysis failed');
  } finally {
    await deleteGeminiFile(fileInfo.name, key);
  }
}

async function runOpenAIGameplayFrames(frames, context) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) return { configured: false, message: 'OPENAI_API_KEY is not configured. Render Environment Variables mein OpenAI API key add karo.' };
  if (!Array.isArray(frames) || !frames.length) throw new Error('No gameplay frames received.');
  if (frames.length > 40) frames = frames.slice(0, 40);
  const prompt = `You are the gameplay sensitivity calibration vision analyst inside VG MENT4L.
These images are chronological frames sampled uniformly across the ENTIRE uploaded gameplay video. Treat them as one continuous recording, not unrelated screenshots. Use the timestamp attached to each frame and compare early/middle/late gameplay.

Analyze observable gameplay: drag speed and length, upward drag consistency, one-tap/flick behavior, chest/neck/head stopping point, overshoot/under-drag, recoil/spray control, close/mid/long tracking, target switching, movement while firing, visible weapon/scope behavior, repeated sensitivity patterns, and any visible FPS/frame-pacing clues. Separate player-input mistakes and network/recording artifacts from sensitivity-related patterns. RAM is context only and must NOT multiply sensitivity.

PROFILE CONTEXT:
${JSON.stringify(context)}

Return ONLY JSON in this exact shape:
{
  "playerType":"",
  "dragStyle":"",
  "rangePreference":"",
  "mainIssue":"",
  "problemDiagnosis":[""],
  "findings":[""],
  "recommendedSensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},
  "adjustmentReasons":[""],
  "evidenceSummary":"",
  "confidence":"low|medium|high",
  "videoDuration":"",
  "timestampEvidence":["timestamp + observation"]
}
Sensitivity values are integers 0-200. Do not promise zero recoil or guaranteed headshots. Prefer measured changes over extreme values.`;
  const content = [{ type: 'input_text', text: prompt }];
  for (const f of frames) {
    if (!f || typeof f.data !== 'string' || !f.data.startsWith('data:image/')) continue;
    content.push({ type: 'input_text', text: `Timestamp: ${String(f.t || 'unknown')}` });
    content.push({ type: 'input_image', image_url: f.data, detail: 'high' });
  }
  const r = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_GAMEPLAY_MODEL, reasoning: { effort: 'none' }, input: [{ role: 'user', content }], max_output_tokens: 5000 })
  }, GAMEPLAY_TIMEOUT_MS);
  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI vision HTTP ${r.status}: ${raw.slice(0, 1600)}`);
  const data = JSON.parse(raw);
  const out = parseLooseJson(extractOpenAIOutput(data));
  out.recommendedSensitivity = normSens(out.recommendedSensitivity);
  out.findings = Array.isArray(out.findings) ? out.findings.slice(0, 30) : [];
  out.problemDiagnosis = Array.isArray(out.problemDiagnosis) ? out.problemDiagnosis.slice(0, 20) : [];
  out.adjustmentReasons = Array.isArray(out.adjustmentReasons) ? out.adjustmentReasons.slice(0, 20) : [];
  out.timestampEvidence = Array.isArray(out.timestampEvidence) ? out.timestampEvidence.slice(0, 40) : [];
  out.model = OPENAI_GAMEPLAY_MODEL;
  out.configured = true;
  out.fullVideo = true;
  out.frameAnalysis = true;
  out.framesAnalyzed = frames.length;
  return out;
}
async function runOpenAITextFix(payload) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) return null;
  const prompt = `You are the final sensitivity refinement analyst for VG MENT4L Free Fire MAX.
BASE SENSITIVITY: ${JSON.stringify(payload.sensitivity)}
SELECTED PROBLEMS: ${JSON.stringify(payload.issues || [])}
PLAYER CUSTOM PROBLEM: ${JSON.stringify(payload.customText || '')}
PROFILE/GAME CONTEXT: ${JSON.stringify(payload.context || {})}
Return ONLY JSON: {"sensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"diagnosis":"","changes":[""],"confidence":"low|medium|high"}
Keep values 0-200. Make the smallest useful changes supported by the evidence. RAM is context only.`;
  const r = await fetchWithTimeout('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OPENAI_GAMEPLAY_MODEL, input: prompt, max_output_tokens: 1800 })
  }, 120000);
  const raw = await r.text();
  if (!r.ok) throw new Error(`OpenAI refinement HTTP ${r.status}: ${raw.slice(0, 1200)}`);
  const out = parseLooseJson(extractOpenAIOutput(JSON.parse(raw)));
  out.sensitivity = normSens(out.sensitivity);
  out.changes = Array.isArray(out.changes) ? out.changes.slice(0, 20) : [];
  out.model = OPENAI_GAMEPLAY_MODEL;
  return out;
}

async function runGeminiHudAnalysis(payload) {
  const key=String(process.env.GEMINI_API_KEY||'').trim();
  const model=String(process.env.GEMINI_MODEL||'gemini-3.8-flash').trim();
  if(!key) return null;
  const raw=String(payload.imageData||'');
  const m=raw.match(/^data:(image\\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if(!m) throw new Error('Valid compressed HUD image is required');
  const mime=m[1].toLowerCase().replace('image/jpg','image/jpeg');
  const prompt=`Analyze this Free Fire MAX HUD screenshot specifically for sensitivity calibration.

IMPORTANT:
- Analyze the actual uploaded HUD layout, not a generic HUD.
- Inspect fire-button position/size, joystick position, scope/aim controls, crouch/jump/prone/action cluster, spacing, edge distances, control density, portrait/landscape geometry, and likely drag path length.
- Explain which sensitivity categories should move because of this exact layout.
- Return JSON only.
- sensitivityDelta is a RELATIVE adjustment from the normal device/mode/style baseline, not the final 0-200 sensitivity.
- Keep each delta between -15 and +15. Do not invent exact hardware specifications.
- If an element is not clearly visible, mark it unknown rather than guessing.

PLAYER CONTEXT:
${JSON.stringify({
  device:payload.device||'',
  playerMode:payload.playerMode||'',
  playerStyle:payload.playerStyle||'',
  mode:payload.mode||'',
  fingers:payload.fingers||'',
  imageWidth:payload.width||0,
  imageHeight:payload.height||0
})}

JSON:
{
  "confidence":"low|medium|high",
  "layoutSummary":"",
  "fireButton":{"position":"left|center|right|unknown","size":"small|medium|large|unknown","edgeDistance":"near|medium|far|unknown"},
  "joystick":{"position":"left|center|right|unknown","size":"small|medium|large|unknown"},
  "scopeCluster":"left|center|right|mixed|unknown",
  "actionCluster":"left|center|right|mixed|unknown",
  "controlDensity":"low|medium|high",
  "dragPath":"short|medium|long|mixed|unknown",
  "sensitivityDelta":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},
  "reasons":[""],
  "warnings":[""]
}`;
  const r=await fetchWithTimeout(
    'https://generativelanguage.googleapis.com/v1beta/models/'+encodeURIComponent(model)+':generateContent',
    {
      method:'POST',
      headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
      body:JSON.stringify({
        contents:[{role:'user',parts:[
          {inline_data:{mime_type:mime,data:m[2]}},
          {text:prompt}
        ]}],
        generationConfig:{
          temperature:0,
          maxOutputTokens:900,
          responseMimeType:'application/json'
        }
      })
    },
    90000
  );
  const responseText=await r.text();
  if(!r.ok) throw new Error('Gemini HUD analysis HTTP '+r.status+': '+responseText.slice(0,1000));
  const out=parseJsonOutput(extractText(JSON.parse(responseText)));
  const d=out.sensitivityDelta||{};
  out.sensitivityDelta={
    general:clamp(d.general),red_dot:clamp(d.red_dot),scope_2x:clamp(d.scope_2x),
    scope_4x:clamp(d.scope_4x),sniper:clamp(d.sniper),free_look:clamp(d.free_look)
  };
  // Preserve the requested signed range: clamp() is 0-200, so normalize deltas separately.
  for(const k of Object.keys(out.sensitivityDelta)) out.sensitivityDelta[k]=Math.max(-15,Math.min(15,Math.round(Number(d[k])||0)));
  out.reasons=Array.isArray(out.reasons)?out.reasons.slice(0,12):[];
  out.warnings=Array.isArray(out.warnings)?out.warnings.slice(0,8):[];
  out.model=model;
  return out;
}

async function runGeminiTextFix(payload) {
  const key = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-3.8-flash').trim();
  if (!key) return null;
  const prompt = `You are the final sensitivity refinement analyst for VG MENT4L Free Fire MAX.
Analyze ALL selected problems and the player's custom sentence together. Do not ignore the custom sentence.
BASE SENSITIVITY: ${JSON.stringify(payload.sensitivity)}
SELECTED PROBLEMS: ${JSON.stringify(payload.issues || [])}
PLAYER CUSTOM PROBLEM: ${JSON.stringify(payload.customText || '')}
PROFILE/GAME CONTEXT: ${JSON.stringify(payload.context || {})}
Return ONLY JSON:
{"sensitivity":{"general":0,"red_dot":0,"scope_2x":0,"scope_4x":0,"sniper":0,"free_look":0},"diagnosis":"","changes":[""],"confidence":"low|medium|high"}
Keep values 0-200. Make the smallest useful changes supported by the evidence. RAM is context only.`;
  const r = await fetchWithTimeout('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: [{ type: 'text', text: prompt }] })
  }, 120000);
  const text = await r.text();
  if (!r.ok) throw new Error(`Gemini refinement HTTP ${r.status}: ${text.slice(0, 1000)}`);
  const out = parseJsonOutput(extractText(JSON.parse(text)));
  out.sensitivity = normSens(out.sensitivity);
  out.changes = Array.isArray(out.changes) ? out.changes.slice(0, 20) : [];
  out.model = model;
  return out;
}

async function saveNewProfile(clone) {
  let code;
  for (let i = 0; i < 20; i++) {
    const candidate = makeNewProfileCode();
    const exists = dbReady ? await dbGetProfile(candidate) : readJson(fileFor(PROFILES, candidate));
    if (!exists) { code = candidate; break; }
  }
  if (!code) throw new Error('Could not create a new Profile ID');
  const p = cleanProfile({ ...clone, code }, code);
  if (dbReady) await dbSaveProfile(p); else writeJson(fileFor(PROFILES, code), p);
  return p;
}
async function loadProfile(code) {
  if (dbReady) {
    const p = await dbGetProfile(code);
    if (p) return p;
  }
  return readJson(fileFor(PROFILES, code));
}

const routes = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/website1.html': ['website1.html', 'text/html; charset=utf-8'],
  '/website2.html': ['website2.html', 'text/html; charset=utf-8'],
  '/website3.html': ['website3.html', 'text/html; charset=utf-8'],
  '/robots.txt': ['robots.txt', 'text/plain; charset=utf-8'],
  '/sitemap.xml': ['sitemap.xml', 'application/xml; charset=utf-8']
};

const server = http.createServer(async (req, res) => {
  if (!ALLOW.has(req.method)) return json(res, 405, { error: 'Method not allowed' });
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    if (req.method === 'GET' && u.pathname === '/api/config') {
      return json(res, 200, {
        ok: true,
        latestOb: `OB${LATEST_OB}`,
        latestObNumber: LATEST_OB,
        officialSource: OFFICIAL_OB_URLS[`OB${LATEST_OB}`],
        backend: dbReady,
        storage: dbReady ? 'supabase-postgres' : 'local-fallback',
        gameplayAI: !!String(process.env.GEMINI_API_KEY || '').trim(),
        aiProvider: 'gemini',
        gameplayModel: String(process.env.GEMINI_MODEL || 'gemini-3.8-flash'),
        videoMode: 'full-video-direct-stream-fast-static',
        maxVideoBytes: GAMEPLAY_MAX_BODY,
        version: '8.0-fast-static-video'
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/health') {
      return json(res, 200, {
        ok: true, service: 'VG MENT4L API', version: '7.0-streamed-video', latestOb: `OB${LATEST_OB}`,
        database: dbReady ? 'connected' : 'fallback', databaseError: dbReady ? '' : dbError,
        gameplayAI: !!String(process.env.GEMINI_API_KEY || '').trim(), aiProvider: 'gemini'
      });
    }
    if (req.method === 'GET' && u.pathname === '/api/device-research') {
      const q = u.searchParams.get('device') || '';
      const hit = lookupDevice(q);
      return json(res, 200, { ok: true, device: hit, verified: !!hit, query: q, notice: hit ? 'Exact/known device profile found.' : 'Exact device not in the verified catalog; do not invent hardware specs.' });
    }
    if (req.method === 'POST' && u.pathname === '/api/hud-analyze') {
      const b=await readBody(req, MAX_BODY);
      if(!b.imageData) return json(res,400,{error:'HUD image is required'});
      try {
        const analysis=await runGeminiHudAnalysis(b);
        if(!analysis) return json(res,503,{error:'GEMINI_API_KEY is not configured'});
        return json(res,200,{ok:true,analysis});
      } catch(e) {
        console.error('HUD AI analysis failed:',e.message);
        return json(res,502,{error:e.message||'HUD AI analysis failed'});
      }
    }
    if (req.method === 'GET' && u.pathname === '/api/patch-research') {
      const ob = safeCode(u.searchParams.get('ob') || '');
      if (!/^OB\d+$/.test(ob)) return json(res, 400, { error: 'Valid OB required' });
      if (Number(ob.slice(2)) > LATEST_OB) return json(res, 409, { error: `${ob} is not officially supported yet`, latestOb: `OB${LATEST_OB}` });
      const result = await fetchOfficial(ob);
      if (!result) return json(res, 503, { error: 'Official Garena patch could not be fetched right now', ob });
      return json(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && u.pathname.startsWith('/api/profiles/')) {
      const code = safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if (!validCode(code)) return json(res, 400, { error: 'Invalid Profile ID' });
      const profile = await loadProfile(code);
      if (!profile) return json(res, 404, { error: 'Profile not found' });
      return json(res, 200, { profile, source: dbReady ? 'backend' : 'local-fallback' });
    }

    if ((req.method === 'POST' || req.method === 'PUT') && u.pathname === '/api/profiles') {
      const b = await readBody(req);
      const code = safeCode(b.code);
      if (!validCode(code)) return json(res, 400, { error: 'Valid Profile ID required' });
      const profile = cleanProfile(b, code);
      if (!profile) return json(res, 400, { error: 'Invalid profile' });
      if (dbReady) {
        await dbSaveProfile(profile);
        return json(res, 200, { ok: true, code, updatedAt: profile.updatedAt, source: 'backend' });
      }
      writeJson(fileFor(PROFILES, code), profile);
      return json(res, 200, { ok: true, code, updatedAt: profile.updatedAt, source: 'local-fallback', warning: 'Persistent database unavailable' });
    }

    if (req.method === 'POST' && u.pathname === '/api/profile-fix') {
      const b = await readBody(req);
      const oldCode = safeCode(b.code);
      if (!validCode(oldCode)) return json(res, 400, { error: 'Valid existing Profile ID required' });
      const old = await loadProfile(oldCode);
      if (!old) return json(res, 404, { error: 'Existing profile not found' });
      const issues = cleanIssueList(b.issues ?? b.issue);
      const custom = String(b.customText || b.custom || '').trim();
      if (!issues.length && !custom) return json(res, 400, { error: 'Select at least one problem or enter a custom problem' });
      const fixed = applyIssueList(old.sensitivity, issues, custom);
      const clone = JSON.parse(JSON.stringify(old));
      clone.sensitivity = fixed.sensitivity;
      clone.recalibration = { ...(clone.recalibration || {}), sourceProfileId: oldCode, issues, customText: custom, createdAt: new Date().toISOString() };
      const p = await saveNewProfile(clone);
      return json(res, 200, { ok: true, oldProfileId: oldCode, newProfileId: p.code, sensitivity: p.sensitivity, issues, customText: custom, oldProfileUnchanged: true, source: dbReady ? 'backend' : 'local-fallback' });
    }

    if (req.method === 'POST' && u.pathname === '/api/manual-fix') {
      const b = await readBody(req);
      const issues = cleanIssueList(b.issues ?? b.issue);
      const custom = String(b.customText || b.custom || '').trim();
      if (!issues.length && !custom) return json(res, 400, { error: 'Select at least one problem or enter a custom problem' });
      try {
        const ai = await runGeminiTextFix({ sensitivity: b.sensitivity, issues, customText: custom, context: b.context || {} });
        if (ai) return json(res, 200, { ok: true, sensitivity: ai.sensitivity, issues, customText: custom, diagnosis: ai.diagnosis, changes: ai.changes, model: ai.model });
      } catch (e) {
        console.error('Gemini manual fix failed:', e.message);
      }
      return json(res, 200, { ok: true, ...applyIssueList(b.sensitivity, issues, custom), warning: 'Gemini AI unavailable; conservative local fallback used.' });
    }

    // OPENAI VISION: browser samples the entire video timeline into chronological frames.
    if (req.method === 'POST' && u.pathname === '/api/gameplay-analyze-openai') {
      let b;
      try { b = await readBody(req, OPENAI_FRAME_BODY); }
      catch (e) { return json(res, 413, { error: 'Gameplay frame payload too large', detail: String(e?.message || e) }); }
      const frames = Array.isArray(b.frames) ? b.frames : [];
      if (!frames.length) return json(res, 400, { error: 'No gameplay frames were received.' });
      let context = b.context && typeof b.context === 'object' ? b.context : {};
      try {
        const result = await runOpenAIGameplayFrames(frames, context);
        return json(res, 200, { ok: true, temporary: true, videoStored: false, fullVideo: true, frameTimeline: true, framesReceived: frames.length, result });
      } catch (e) {
        console.error('OpenAI gameplay analysis failed:', e);
        return json(res, 502, { ok: false, error: 'OpenAI gameplay analysis failed', detail: String(e?.message || e) });
      }
    }

    // FULL VIDEO: the browser request is streamed directly to Gemini.
    // Render does not write the gameplay video to disk or database.
    if (req.method === 'POST' && u.pathname === '/api/gameplay-analyze') {
      const contentType = String(req.headers['content-type'] || '').toLowerCase();
      if (!contentType.startsWith('video/')) return json(res, 415, { error: 'Send the complete gameplay video as video/* body. Frames are not used.' });
      const size = Number(req.headers['content-length'] || 0);
      if (!Number.isFinite(size) || size <= 0) return json(res, 411, { error: 'Content-Length is required for full-video upload.' });
      if (size > GAMEPLAY_MAX_BODY) return json(res, 413, { error: 'Gameplay video is larger than the 2 GB limit.' });
      const key = String(process.env.GEMINI_API_KEY || '').trim();
      if (!key) return json(res, 503, { configured: false, error: 'GEMINI_API_KEY is not configured. Render Environment Variables mein Gemini API key add karo.' });

      let context = {};
      const rawContext = String(req.headers['x-vg-context'] || '');
      try { context = JSON.parse(decodeURIComponent(Buffer.from(rawContext, 'base64').toString('utf8'))); }
      catch { try { context = JSON.parse(Buffer.from(rawContext, 'base64').toString('utf8')); } catch {} }

      try {
        const result = await runGeminiVideo(req, contentType, size, context);
        return json(res, 200, { ok: true, temporary: true, videoStored: false, fullVideo: true, streamedDirectlyToGemini: true, bytesReceived: size, result });
      } catch (e) {
        console.error('Full-video Gemini analysis failed:', e);
        return json(res, 502, { ok: false, error: 'Full-video AI analysis failed', detail: String(e?.message || e) });
      }
    }

    if (req.method === 'POST' && u.pathname === '/api/gameplay-fix') {
      const b = await readBody(req);
      const issues = cleanIssueList(b.issues ?? b.issue);
      const custom = String(b.customText || b.custom || '').trim();
      if (!issues.length && !custom) return json(res, 400, { error: 'Select at least one problem or enter a custom problem' });

      let fixed;
      try {
        const ai = await runOpenAITextFix({ sensitivity: b.sensitivity, issues, customText: custom, context: b.context || {} });
        fixed = ai ? { sensitivity: ai.sensitivity, diagnosis: ai.diagnosis, changes: ai.changes, model: ai.model } : applyIssueList(b.sensitivity, issues, custom);
      } catch (e) {
        console.error('OpenAI gameplay refinement failed:', e.message);
        fixed = { ...applyIssueList(b.sensitivity, issues, custom), warning: 'OpenAI refinement failed; conservative local fallback used.' };
      }

      const oldCode = safeCode(b.code || '');
      if (validCode(oldCode)) {
        const old = await loadProfile(oldCode);
        if (old) {
          const clone = JSON.parse(JSON.stringify(old));
          clone.sensitivity = fixed.sensitivity;
          clone.recalibration = {
            ...(clone.recalibration || {}), sourceProfileId: oldCode, issues, customText: custom,
            source: 'full-video-ai-refinement', createdAt: new Date().toISOString(), aiModel: fixed.model || null
          };
          const p = await saveNewProfile(clone);
          return json(res, 200, { ok: true, oldProfileId: oldCode, newProfileId: p.code, sensitivity: p.sensitivity, issues, customText: custom, oldProfileUnchanged: true, diagnosis: fixed.diagnosis || '', changes: fixed.changes || [], model: fixed.model || null });
        }
      }
      return json(res, 200, { ok: true, newProfileId: null, sensitivity: fixed.sensitivity, issues, customText: custom, oldProfileUnchanged: true, diagnosis: fixed.diagnosis || '', changes: fixed.changes || [], model: fixed.model || null });
    }

    if (req.method === 'POST' && u.pathname === '/api/updates') {
      const b = await readBody(req);
      const code = safeCode(b.code || '');
      if (code && !validCode(code)) return json(res, 400, { error: 'Invalid Profile ID' });
      const item = { ...b, code: code || null, time: b.time || new Date().toISOString() };
      if (dbReady) { await dbSaveUpdate(item); return json(res, 200, { ok: true, source: 'backend' }); }
      const f = fileFor(UPDATES, code || 'manual');
      const arr = readJson(f) || [];
      arr.unshift(item);
      writeJson(f, arr.slice(0, 100));
      return json(res, 200, { ok: true, source: 'local-fallback' });
    }

    if (req.method === 'GET' && u.pathname.startsWith('/api/updates/')) {
      const code = safeCode(decodeURIComponent(u.pathname.split('/').pop()));
      if (!validCode(code)) return json(res, 400, { error: 'Invalid Profile ID' });
      if (dbReady) return json(res, 200, { updates: await dbGetUpdates(code), source: 'backend' });
      return json(res, 200, { updates: readJson(fileFor(UPDATES, code)) || [], source: 'local-fallback' });
    }

    const route = routes[u.pathname];
    if (req.method === 'GET' && route) return sendFile(res, path.join(ROOT, route[0]), route[1]);
    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: 'Server error', detail: String(e?.message || e) });
  }
});

server.requestTimeout = GAMEPLAY_TIMEOUT_MS;
server.headersTimeout = GAMEPLAY_TIMEOUT_MS;
server.keepAliveTimeout = 65000;

server.listen(PORT, async () => {
  console.log(`VG MENT4L running on http://localhost:${PORT}`);
  await initDb();
});
