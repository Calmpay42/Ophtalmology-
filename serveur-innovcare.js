/*
 * Serveur de synchronisation OphtaSuite (aucune dépendance, Node.js 18+)
 *
 * Variables d'environnement :
 *   OPHTA_API_KEY  Clé d'accès (OBLIGATOIRE en ligne). Longue et unique.
 *   DATA_DIR       Dossier de stockage. Sur Render : le chemin du disque persistant (ex : /var/data).
 *   PORT           Fourni automatiquement par Render. Par défaut 4550 en local.
 *
 * Routes utilisées par l'application :
 *   GET  /api/ping   -> { ok: true }
 *   GET  /api/db     -> la base (404 si vide)
 *   POST /api/db     -> remplace la base
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = parseInt(process.env.PORT, 10) || 4550;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const DB_FILE = path.join(DATA_DIR, 'ophta-db.json');
const MAX_BODY = 100 * 1024 * 1024; // 100 Mo
const BACKUP_EVERY_MS = 60 * 60 * 1000; // une sauvegarde au plus par heure
const BACKUP_KEEP = 72;

const HOSTED = !!(process.env.RENDER || process.env.OPHTA_API_KEY || process.env.PORT);
let API_KEY = (process.env.OPHTA_API_KEY || '').trim();
if (HOSTED && !API_KEY) {
  API_KEY = crypto.randomBytes(24).toString('hex');
  console.warn('\n[ATTENTION] OPHTA_API_KEY non définie : clé temporaire générée :\n  ' + API_KEY +
    '\nDéfinissez OPHTA_API_KEY dans les réglages de l\'hébergeur pour une clé stable.\n');
}

fs.mkdirSync(BACKUP_DIR, { recursive: true });

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Protection simple contre les essais de clés répétés
const fails = new Map();
function clientIp(req) {
  return ((req.headers['x-forwarded-for'] || '').split(',')[0] || req.socket.remoteAddress || '').trim();
}
function isBlocked(ip) {
  const f = fails.get(ip);
  return !!f && f.count >= 20 && Date.now() - f.first < 15 * 60 * 1000;
}
function noteFail(ip) {
  const now = Date.now();
  const f = fails.get(ip);
  if (!f || now - f.first > 15 * 60 * 1000) fails.set(ip, { count: 1, first: now });
  else f.count++;
}

function send(res, status, body, type, extra) {
  res.writeHead(status, Object.assign({
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'x-api-key, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  }, extra || {}));
  res.end(body);
}

function backupIfNeeded() {
  try {
    if (!fs.existsSync(DB_FILE)) return;
    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    const last = files[files.length - 1];
    if (last) {
      const age = Date.now() - fs.statSync(path.join(BACKUP_DIR, last)).mtimeMs;
      if (age < BACKUP_EVERY_MS) return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(DB_FILE, path.join(BACKUP_DIR, 'db-' + stamp + '.json'));
    const all = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
    all.slice(0, Math.max(0, all.length - BACKUP_KEEP)).forEach(f => {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) {}
    });
  } catch (e) { console.error('Sauvegarde auto échouée :', e.message); }
}

// Compression : l'appli relit la base très souvent ; gzip réduit fortement le trafic sortant (facturé).
let gzCache = { mtime: 0, size: 0, buf: null };
function readDbGz() {
  const st = fs.statSync(DB_FILE);
  if (!gzCache.buf || gzCache.mtime !== st.mtimeMs || gzCache.size !== st.size) {
    gzCache = { mtime: st.mtimeMs, size: st.size, buf: zlib.gzipSync(fs.readFileSync(DB_FILE)) };
  }
  return gzCache.buf;
}

function saveDb(text) {
  backupIfNeeded();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, DB_FILE); // écriture atomique
}

const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (req.method === 'OPTIONS') return send(res, 204, '');
  if (url === '/' || url === '/health') return send(res, 200, 'OphtaSuite serveur OK', 'text/plain; charset=utf-8');

  if (!url.startsWith('/api/')) return send(res, 404, '{"error":"not found"}');

  if (API_KEY) {
    const ip = clientIp(req);
    if (isBlocked(ip)) return send(res, 429, '{"error":"too many attempts"}');
    const key = req.headers['x-api-key'] || '';
    if (!safeEqual(key, API_KEY)) { noteFail(ip); return send(res, 401, '{"error":"unauthorized"}'); }
  }

  if (url === '/api/ping' && req.method === 'GET') return send(res, 200, '{"ok":true}');

  if (url === '/api/db' && req.method === 'GET') {
    if (!fs.existsSync(DB_FILE)) return send(res, 404, '{}');
    try {
      if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
        return send(res, 200, readDbGz(), null, { 'Content-Encoding': 'gzip', 'Vary': 'Accept-Encoding' });
      }
      return send(res, 200, fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) { return send(res, 500, '{"error":"read failed"}'); }
  }

  if (url === '/api/db' && req.method === 'POST') {
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { aborted = true; send(res, 413, '{"error":"too large"}'); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(text); } catch (e) { return send(res, 400, '{"error":"invalid json"}'); }
      try { saveDb(text); return send(res, 200, '{"ok":true}'); }
      catch (e) { console.error('Écriture échouée :', e.message); return send(res, 500, '{"error":"write failed"}'); }
    });
    req.on('error', () => {});
    return;
  }

  return send(res, 404, '{"error":"not found"}');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('OphtaSuite serveur démarré sur le port ' + PORT);
  console.log('Stockage : ' + DATA_DIR);
  console.log(API_KEY ? 'Clé d\'accès : activée' : 'Clé d\'accès : désactivée (réseau local)');
  if (!process.env.DATA_DIR) console.warn('[ATTENTION] DATA_DIR non défini : sur Render sans disque persistant, les données seront PERDUES à chaque redémarrage.');
});
