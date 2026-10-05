/**
 * HTTP con barattolo dei cookie e login SSO Bocconi (Shibboleth), senza browser.
 *
 * Il giro SAML e' sempre lo stesso: la risorsa rimbalza su idp.unibocconi.it, l'IdP chiede
 * j_username/j_password (solo se non ha gia' una sessione sua), poi risponde con un form
 * auto-post che porta SAMLResponse all'ACS del servizio (/Shibboleth.sso/SAML2/POST).
 * Qui il form lo si posta a mano e si torna sulla risorsa di partenza.
 *
 * Il barattolo vale come una password finche' la sessione e' viva: sta in data/ e basta.
 */
import fs from 'node:fs';
import path from 'node:path';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');

export class Jar {
  constructor(file) {
    this.file = file;
    this.cookies = [];
    try {
      this.cookies = JSON.parse(fs.readFileSync(file, 'utf8')).cookies || [];
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ saved: new Date().toISOString(), cookies: this.cookies }), { mode: 0o600 });
  }

  clear() {
    this.cookies = [];
    try {
      fs.unlinkSync(this.file);
    } catch {}
  }

  header(url) {
    const u = new URL(url);
    return this.cookies
      .filter((c) => (c.hostOnly ? u.hostname === c.domain : u.hostname === c.domain || u.hostname.endsWith('.' + c.domain)))
      .filter((c) => u.pathname.startsWith(c.path || '/'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  absorb(url, res) {
    const u = new URL(url);
    for (const line of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      if (i < 1) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      let domain = u.hostname;
      let hostOnly = true;
      let p = '/';
      let expired = false;
      for (const a of attrs) {
        const [k, v = ''] = a.split('=').map((s) => s.trim());
        const key = k.toLowerCase();
        if (key === 'domain' && v) {
          domain = v.replace(/^\./, '').toLowerCase();
          hostOnly = false;
        } else if (key === 'path' && v) p = v;
        else if (key === 'max-age' && Number(v) <= 0) expired = true;
        else if (key === 'expires' && Date.parse(v) < Date.now()) expired = true;
      }
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.domain === domain && c.path === p));
      if (!expired && value) this.cookies.push({ name, value, domain, hostOnly, path: p });
    }
  }
}

export class LoginError extends Error {}

export class Client {
  constructor(jar) {
    this.jar = jar;
    this.creds = null; // { username, password } solo in memoria, mai su disco
  }

  async request(url, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'User-Agent': UA, 'Accept-Language': 'it-IT,it;q=0.9', ...headers };
    const cookie = this.jar.header(url);
    if (cookie) h.Cookie = cookie;
    if (body && !h['Content-Type']) h['Content-Type'] = 'application/x-www-form-urlencoded';
    const res = await fetch(url, { method, body, headers: h, redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    this.jar.absorb(url, res);
    return res;
  }

  /**
   * GET che attraversa il giro SSO. Ritorna { url, status, text } della risorsa finale.
   * Se l'IdP chiede le credenziali e non le abbiamo, LoginError: tocca rifare il login dall'app.
   */
  async get(url, { headers } = {}) {
    let method = 'GET';
    let body;
    let triedPassword = false;
    for (let hop = 0; hop < 15; hop++) {
      const res = await this.request(url, { method, body, headers: method === 'GET' ? headers : {} });
      if (res.status >= 300 && res.status < 400) {
        url = new URL(res.headers.get('location'), url).toString();
        method = 'GET';
        body = undefined;
        continue;
      }
      const text = await res.text();
      const host = new URL(url).hostname;

      // Form auto-post verso l'ACS del servizio.
      if (/name="SAMLResponse"/.test(text)) {
        const action = decode(/<form[^>]*action="([^"]+)"/i.exec(text)?.[1] || '');
        const fields = new URLSearchParams();
        for (const m of text.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) fields.set(decode(m[1]), decode(m[2]));
        url = new URL(action, url).toString();
        method = 'POST';
        body = fields.toString();
        continue;
      }

      // Pagina di login dell'IdP.
      if (host === 'idp.unibocconi.it' && /name="j_username"/.test(text)) {
        if (!this.creds) throw new LoginError('Sessione Bocconi scaduta: rifai il login.');
        if (triedPassword) throw new LoginError('Credenziali Bocconi rifiutate.');
        triedPassword = true;
        const action = decode(/<form[^>]*action="([^"]+)"/i.exec(text)?.[1] || '');
        method = 'POST';
        url = new URL(action || url, url).toString();
        body = new URLSearchParams({ j_username: this.creds.username, j_password: this.creds.password, _eventId_proceed: '' }).toString();
        continue;
      }

      // Altri passi intermedi dell'IdP (consenso, local storage): si prosegue col form che c'e'.
      if (host === 'idp.unibocconi.it' && /_eventId_proceed/.test(text)) {
        const action = decode(/<form[^>]*action="([^"]+)"/i.exec(text)?.[1] || '');
        const fields = new URLSearchParams({ _eventId_proceed: '' });
        for (const m of text.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) fields.set(decode(m[1]), decode(m[2]));
        method = 'POST';
        url = new URL(action || url, url).toString();
        body = fields.toString();
        continue;
      }

      this.jar.save();
      return { url, status: res.status, text };
    }
    throw new Error('Troppi rimbalzi nel giro SSO.');
  }

  async getJson(url) {
    const r = await this.get(url, { headers: { Accept: 'application/json, text/javascript, */*', 'X-Requested-With': 'XMLHttpRequest' } });
    try {
      return JSON.parse(r.text);
    } catch {
      throw new Error(`Risposta non JSON da ${new URL(url).pathname} (${r.status}).`);
    }
  }
}
