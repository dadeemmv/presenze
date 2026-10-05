/**
 * Bocconi Attendance - server locale.
 *
 *   node server.mjs                          ascolta su 127.0.0.1:4377
 *   $env:HOST="100.x.y.z"; node server.mjs   per raggiungerlo dal telefono via Tailscale
 *
 * Tutto il lavoro su yoU@B passa dal connettore MCP (lib/connector.mjs): l'app ne e' un client
 * in processo, e lo stesso connettore e' esposto su /mcp per un client esterno.
 *
 * Due modalita':
 *   classica  - la presenza la metti tu, dal tasto "Registra" della lezione (POST /api/register).
 *   assistita - il telefono segnala che e' sul Wi-Fi Bocconi (POST /api/signal con l'IP pubblico
 *               e/o il nome della rete, o in alternativa la posizione); per CAMPUS_TTL minuti, ogni
 *               lezione in corso o che inizia entro 15 minuti viene registrata dal connettore appena
 *               il docente apre la rilevazione.
 *   sempre    - registra ogni lezione appena il docente apre la rilevazione, senza controllare
 *               dove sei. Per chi e' in aula col Wi-Fi che non va. Si attiva solo dopo aver
 *               confermato il promemoria sul Codice d'onore.
 * La modalita' resta l'ultima scelta, anche dopo un riavvio o un nuovo login.
 * Login una volta sola: le credenziali yoU@B si salvano cifrate (DPAPI, lib/secret.mjs) e quando
 * la sessione SSO scade il client rifa' il login da solo. "Scollega" le cancella.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Jar, Client } from './lib/http.mjs';
import { createConnector } from './lib/connector.mjs';
import * as B from './lib/bocconi.mjs';
import { onCampus } from './lib/campus.mjs';
import { SecretStore } from './lib/secret.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, 'data');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4377);
const RADIUS = Number(process.env.RADIUS || 300); // metri dall'aula, se il segnale e' il GPS
const EARLY = 15; // minuti prima dell'inizio in cui la lezione conta gia'
const POLL_MS = 2 * 60_000;
const CAMPUS_TTL = Number(process.env.CAMPUS_TTL || 90); // minuti di validita' del segnale "sei in Bocconi"

fs.mkdirSync(DATA, { recursive: true });
const bocconi = new Client(new Jar(path.join(DATA, 'session.json')));
const secrets = new SecretStore(DATA);
bocconi.creds = secrets.load();
const APP_FILE = path.join(DATA, 'app.json');
const LOG_FILE = path.join(DATA, 'log.jsonl');

let app = {};
try {
  app = JSON.parse(fs.readFileSync(APP_FILE, 'utf8'));
} catch {}
const saveApp = () => fs.writeFileSync(APP_FILE, JSON.stringify(app, null, 2), { mode: 0o600 });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ connettore

const newConnector = () => createConnector(bocconi, { username: () => app.username ?? null });

const mcp = new McpClient({ name: 'presenze-app', version: '0.1.0' });
{
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await newConnector().connect(serverSide);
  await mcp.connect(clientSide);
}

class Relogin extends Error {}

/** Chiama un tool del connettore e restituisce il suo structuredContent. */
async function tool(name, args = {}) {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) {
    const e = r.structuredContent || {};
    throw e.relogin ? new Relogin(e.error) : new Error(e.error || r.content?.[0]?.text || `${name} fallito`);
  }
  return r.structuredContent;
}

// ------------------------------------------------------------------ log

function log(kind, msg, extra = {}) {
  const row = { t: B.romeNow(), kind, msg, ...extra };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  console.log(`[${row.t.slice(11)}] ${kind}: ${msg}`);
  return row;
}

function recentLog(n = 40) {
  try {
    return fs.readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).reverse().map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ presenza automatica

const registerArgs = (l) => ({ extcode: l.extcode, date: l.start.slice(0, 10), start: l.start.slice(11, 16) });
const lessonKey = (l) => `${l.extcode}@${l.start}`;
const inWindow = (l, now) => l.extcode && B.minutesBetween(now, l.start) <= EARLY && B.minutesBetween(now, l.end) > 0;

/** Ultimo segnale "sei in Bocconi" dal telefono. Vale CAMPUS_TTL minuti, poi serve un segnale nuovo. */
let lastOnCampus = null;
/** Lezioni gia' chiuse oggi (registrate o in errore): non si ritentano. */
const done = new Set();

const campusFresh = () => lastOnCampus && B.minutesBetween(lastOnCampus.t, B.romeNow()) <= CAMPUS_TTL;

/**
 * Modalita' assistita: per ogni lezione nella finestra, se sei in Bocconi, il connettore registra.
 * Se il docente non ha ancora aperto la rilevazione si riprova al giro dopo.
 */
async function assistTick() {
  const always = app.mode === 'always';
  if (!always && (app.mode !== 'assisted' || !campusFresh())) return null;
  const now = B.romeNow();
  const { lessons } = await tool('youatb_calendar');
  let last = null;
  for (const l of lessons.filter((x) => inWindow(x, now) && !done.has(lessonKey(x)))) {
    const r = await tool('youatb_register_attendance', registerArgs(l));
    if (r.state === 'not_open') {
      if (!pending.has(lessonKey(l))) {
        const why = always ? 'modalità sempre attiva' : 'sei in Bocconi';
        last = log('armed', `${l.course}: ${why}, registro appena il docente apre la rilevazione.`, { extcode: l.extcode });
      }
      pending.add(lessonKey(l));
      continue;
    }
    done.add(lessonKey(l));
    pending.delete(lessonKey(l));
    stateCache.clear();
    const how = always ? 'sempre attiva, senza controllo posizione' : lastOnCampus.detail;
    last = log(r.state, `${l.course}: ${r.messages.join(' · ')} (${how})`, { extcode: l.extcode });
  }
  return last;
}
/** Lezioni in attesa che il docente apra la rilevazione (solo per non ripetere il log). */
const pending = new Set();

/** Segnale dal telefono: IP pubblico e/o nome del Wi-Fi, oppure posizione GPS. */
async function signal(sig) {
  if (app.mode === 'always') return (await assistTick()) || log('skip', 'Modalità sempre attiva: registro comunque, il segnale non serve.');
  if (app.mode !== 'assisted') return log('skip', 'Modalità classica: la presenza la metti tu dal tasto della lezione.');
  const { lessons } = await tool('youatb_calendar');
  const now = B.romeNow();
  const ref = lessons.find((l) => inWindow(l, now)) || lessons.find((l) => l.lat != null) || {};
  const c = onCampus(sig, ref, RADIUS);
  if (!c.on) return log('skip', `Non risulti in Bocconi: ${c.detail}.`);
  lastOnCampus = { t: now, how: c.how, detail: c.detail };
  if (!lessons.some((l) => inWindow(l, now))) return log('campus', `Sei in Bocconi (${c.detail}). Nessuna lezione adesso: vale per le prossime ${CAMPUS_TTL} min.`);
  return (await assistTick()) || log('campus', `Sei in Bocconi (${c.detail}).`);
}

const stateCache = new Map();
/** Lezioni di oggi con lo stato della presenza letto dal connettore. Le lezioni lontane non si interrogano. */
async function lessonsWithState() {
  const now = B.romeNow();
  const { lessons } = await tool('youatb_calendar');
  return Promise.all(
    lessons.map(async (l) => {
      if (B.minutesBetween(now, l.start) > 60) return { ...l, state: 'later' };
      const k = lessonKey(l);
      const hit = stateCache.get(k);
      if (hit && Date.now() - hit.at < 30_000) return { ...l, ...hit.v };
      const r = await tool('youatb_attendance_status', registerArgs(l));
      const v = { state: r.state, messages: r.messages };
      stateCache.set(k, { at: Date.now(), v });
      return { ...l, ...v };
    })
  );
}

setInterval(() => assistTick().catch((e) => log('error', e.message)), POLL_MS).unref();

// ------------------------------------------------------------------ http

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => {
      if (s.length < 1e5) s += c;
    });
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve(Object.fromEntries(new URLSearchParams(s)));
      }
    });
  });

function authed(req, url) {
  if (!app.tokenHash) return false;
  const cookie = /(?:^|;\s*)ab=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
  const t = cookie || bearer || url.searchParams.get('k');
  return !!t && sha(t) === app.tokenHash;
}

const STATIC = {
  '/': 'index.html',
  '/app.css': 'app.css',
  '/app.js': 'app.js',
  '/manifest.webmanifest': 'manifest.webmanifest',
  '/icon.svg': 'icon.svg',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
};
const MIME = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const f = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': MIME[f.split('.').pop()], 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(ROOT, 'public', f)));
      }

      // Dare accesso: il login Bocconi avviene qui, il connettore riceve solo la sessione.
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const { username, password } = await readBody(req);
        if (!username || !password) return send(res, 400, { error: 'Matricola e password obbligatorie.' });
        await B.login(bocconi, username, password);
        secrets.save(bocconi.creds);
        const token = crypto.randomBytes(24).toString('base64url');
        app = { tokenHash: sha(token), username: bocconi.creds.username, since: B.romeNow(), mode: app.mode || 'classic' };
        saveApp();
        log('login', `Accesso a yoU@B concesso (${app.username}).`);
        return send(res, 200, { ok: true, username: app.username, token }, { 'Set-Cookie': `ab=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
      }

      if (!url.pathname.startsWith('/api/') && url.pathname !== '/mcp') return send(res, 404, { error: 'not found' });
      if (!authed(req, url)) return send(res, 401, { error: 'login richiesto' });

      // Lo stesso connettore per un client MCP esterno (stateless: un'istanza per richiesta).
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') return send(res, 405, { error: 'usa POST' });
        const server = newConnector();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
          transport.close();
          server.close();
        });
        await server.connect(transport);
        return transport.handleRequest(req, res, await readBody(req));
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        bocconi.creds = null;
        bocconi.jar.clear();
        secrets.clear();
        pending.clear();
        done.clear();
        lastOnCampus = null;
        app = { mode: app.mode };
        saveApp();
        log('logout', 'Accesso a yoU@B revocato.');
        return send(res, 200, { ok: true }, { 'Set-Cookie': 'ab=; Path=/; Max-Age=0' });
      }

      if (url.pathname === '/api/status' && req.method === 'GET') {
        let lessons = [];
        let sessionError = null;
        try {
          lessons = await lessonsWithState();
        } catch (e) {
          sessionError = e instanceof Relogin ? e.message : `yoU@B non risponde: ${e.message}`;
        }
        return send(res, 200, {
          username: app.username,
          mode: app.mode || 'classic',
          now: B.romeNow(),
          campus: campusFresh() ? lastOnCampus : null,
          campusTtl: CAMPUS_TTL,
          sessionError,
          lessons,
          log: recentLog(),
        });
      }

      if (url.pathname === '/api/mode' && req.method === 'POST') {
        const { mode, ack } = await readBody(req);
        if (!['classic', 'assisted', 'always'].includes(mode)) return send(res, 400, { error: 'Modalità sconosciuta.' });
        if (mode === 'always' && ack !== true) return send(res, 400, { error: "Per la modalità sempre attiva serve confermare il promemoria sul Codice d'onore." });
        app.mode = mode;
        pending.clear();
        if (mode === 'always') app.alwaysAckAt = B.romeNow();
        saveApp();
        const MSG = {
          classic: 'Modalità classica: la presenza la metti tu.',
          assisted: 'Modalità assistita: registro da solo quando sei sulla rete Bocconi.',
          always: "Modalità sempre attiva: registro ogni lezione senza controllare dove sei. Promemoria sul Codice d'onore confermato.",
        };
        log('mode', MSG[mode]);
        if (mode !== 'classic') assistTick().catch((e) => log('error', e.message));
        return send(res, 200, { mode });
      }

      // Modalita' classica: il tasto "Registra" della lezione, come su yoU@B.
      if (url.pathname === '/api/register' && req.method === 'POST') {
        const { extcode, start } = await readBody(req);
        const l = (await tool('youatb_calendar')).lessons.find((x) => x.extcode === extcode && x.start.slice(11, 16) === start);
        if (!l) return send(res, 404, { error: 'Lezione non trovata oggi.' });
        const r = await tool('youatb_register_attendance', registerArgs(l));
        stateCache.clear();
        if (r.state !== 'not_open') done.add(lessonKey(l));
        return send(res, 200, log(r.state, `${l.course}: ${r.messages.join(' · ') || 'Rilevazione non ancora aperta dal docente.'}`, { extcode }));
      }

      // Segnale dal telefono (Comandi iOS all'ingresso sul Wi-Fi Bocconi, o il tasto dell'app).
      if (url.pathname === '/api/signal' && req.method === 'POST') {
        const body = { ...Object.fromEntries(url.searchParams), ...(await readBody(req)) };
        if (!body.ip) body.ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
        return send(res, 200, await signal(body));
      }

      send(res, 404, { error: 'not found' });
    } catch (e) {
      const relogin = e instanceof Relogin || e.name === 'LoginError';
      log('error', e.message);
      send(res, relogin ? 401 : 500, { error: e.message, relogin });
    }
  })
  .listen(PORT, HOST, () => console.log(`Bocconi Attendance su http://${HOST}:${PORT}  (connettore MCP su /mcp)`));
