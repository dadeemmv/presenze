/**
 * Registratore di rete per yoU@B.
 *
 * Apre un Chrome con profilo dedicato su you.unibocconi.it, tu fai il login SSO, apri il
 * calendario e premi il tasto attendance. Ogni chiamata XHR/fetch (e i documenti) finisce in
 * .capture/<timestamp>.jsonl con metodo, URL, header, body e risposta: e' da li' che si
 * ricavano gli endpoint veri invece di indovinarli.
 *
 * Uso:  node tools/record.mjs [--minutes 15]
 * Ctrl+C per fermare prima.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = path.join(ROOT, '.chrome-profile');
const OUT_DIR = path.join(ROOT, '.capture');
const PORT = 9223;
const CDP = `http://127.0.0.1:${PORT}`;
const START = 'https://youatb.unibocconi.it/';

const mi = process.argv.indexOf('--minutes');
const MINUTES = mi > -1 ? Number(process.argv[mi + 1]) || 15 : 15;

const CHROMES = [
  process.env.ProgramFiles + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env['ProgramFiles(x86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe',
];

const KEEP_TYPES = new Set(['XHR', 'Fetch', 'Document', 'EventSource', 'WebSocket', 'Other']);
const NOISE = /google-analytics|googletagmanager|doubleclick|hotjar|clarity\.ms|\.woff2?(\?|$)|\.png|\.jpe?g|\.svg|\.css(\?|$)|\.js(\?|$)/i;

async function cdpUp() {
  try {
    return (await fetch(CDP + '/json/version', { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

async function openChrome() {
  if (await cdpUp()) return;
  const exe = CHROMES.find((p) => p && fs.existsSync(p));
  if (!exe) throw new Error('Chrome non trovato.');
  fs.mkdirSync(PROFILE, { recursive: true });
  spawn(exe, [`--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--no-first-run', '--no-default-browser-check', START], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  for (let i = 0; i < 30; i++) {
    if (await cdpUp()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Chrome non ha aperto la porta ${PORT}.`);
}

async function main() {
  await openChrome();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  const out = fs.createWriteStream(file, { flags: 'a' });
  const write = (o) => out.write(JSON.stringify(o) + '\n');

  const browser = await puppeteer.connect({ browserURL: CDP, defaultViewport: null });
  const attached = new WeakSet();
  let n = 0;

  async function attach(target) {
    if (!['page', 'service_worker', 'other'].includes(target.type())) return;
    if (attached.has(target)) return;
    attached.add(target);
    const s = await target.createCDPSession().catch(() => null);
    if (!s) return;
    const reqs = new Map();
    await s.send('Network.enable', { maxPostDataSize: 1 << 20 }).catch(() => {});

    s.on('Network.requestWillBeSent', (e) => {
      if (!KEEP_TYPES.has(e.type) || NOISE.test(e.request.url)) return;
      reqs.set(e.requestId, {
        t: new Date().toISOString(),
        type: e.type,
        method: e.request.method,
        url: e.request.url,
        reqHeaders: e.request.headers,
        // Il login SSO manda la password nel body: non deve mai finire su disco.
        postData: e.request.postData ? e.request.postData.replace(/((?:j_)?pass(?:word|wd)?=)[^&]*/gi, '$1[REDACTED]') : null,
        redirectedFrom: e.redirectResponse ? e.redirectResponse.url : null,
      });
    });
    s.on('Network.requestWillBeSentExtraInfo', (e) => {
      const r = reqs.get(e.requestId);
      if (r) r.reqHeadersRaw = e.headers;
    });
    s.on('Network.responseReceived', (e) => {
      const r = reqs.get(e.requestId);
      if (!r) return;
      r.status = e.response.status;
      r.resHeaders = e.response.headers;
      r.mime = e.response.mimeType;
    });
    s.on('Network.loadingFinished', async (e) => {
      const r = reqs.get(e.requestId);
      if (!r) return;
      reqs.delete(e.requestId);
      if (/json|text|xml|javascript/.test(r.mime || '')) {
        const b = await s.send('Network.getResponseBody', { requestId: e.requestId }).catch(() => null);
        if (b && !b.base64Encoded) r.body = b.body.length > 200_000 ? b.body.slice(0, 200_000) + '…[troncato]' : b.body;
      }
      write(r);
      n++;
      const short = r.url.length > 110 ? r.url.slice(0, 110) + '…' : r.url;
      console.log(`${String(r.status).padEnd(3)} ${r.method.padEnd(6)} ${short}`);
    });
    s.on('Network.loadingFailed', (e) => {
      const r = reqs.get(e.requestId);
      if (!r) return;
      reqs.delete(e.requestId);
      write({ ...r, failed: e.errorText });
    });
  }

  for (const t of browser.targets()) await attach(t);
  browser.on('targetcreated', attach);

  console.log('');
  console.log('  >>> Nella finestra Chrome: login SSO Bocconi, poi apri il calendario,');
  console.log('  >>> poi premi il tasto attendance su una lezione. Ctrl+C quando hai finito.');
  console.log(`  >>> Registro in ${file}`);
  console.log('');

  const stop = () => {
    out.end();
    browser.disconnect();
    console.log(`\nFermato. ${n} richieste in ${file}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  browser.on('disconnected', () => {
    out.end();
    console.log(`\nFinestra chiusa. ${n} richieste in ${file}`);
    process.exit(0);
  });
  setTimeout(stop, MINUTES * 60_000);
}

main().catch((e) => {
  console.error('ERRORE:', e.message);
  process.exit(1);
});
