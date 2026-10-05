/**
 * Le credenziali yoU@B salvate una volta sola, cifrate.
 *
 * Su Windows con DPAPI (ConvertFrom-SecureString): il file si decifra solo con questo utente
 * Windows su questo PC, copiato altrove non serve a niente. Altrove AES-256-GCM con una chiave
 * in data/.key, che vale quanto il file: e' il ripiego, non la protezione vera.
 *
 * Servono perche' la sessione SSO dura poche ore: quando scade, il client rifa' il login da solo
 * e lo studente non deve rientrare mai piu'.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const WIN = process.platform === 'win32';

function psRun(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

export class SecretStore {
  constructor(dir) {
    this.file = path.join(dir, WIN ? 'credentials.dpapi' : 'credentials.enc');
    this.keyFile = path.join(dir, '.key');
  }

  save(creds) {
    const payload = JSON.stringify(creds);
    let out;
    if (WIN) {
      // Il segreto passa da una variabile d'ambiente, mai dalla riga di comando.
      out = psRun('ConvertFrom-SecureString (ConvertTo-SecureString -String $env:PRESENZE_SECRET -AsPlainText -Force)', { PRESENZE_SECRET: Buffer.from(payload, 'utf8').toString('base64') }); // base64: la console di PowerShell non e' UTF-8
    } else {
      const key = this.#key();
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(payload, 'utf8'), c.final()]);
      out = [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
    }
    fs.writeFileSync(this.file, out, { mode: 0o600 });
  }

  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const blob = fs.readFileSync(this.file, 'utf8').trim();
      let payload;
      if (WIN) {
        payload = psRun(
          '$s = ConvertTo-SecureString $env:PRESENZE_BLOB; ' +
            '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
          { PRESENZE_BLOB: blob }
        );
        payload = Buffer.from(payload, 'base64').toString('utf8');
      } else {
        const [iv, tag, enc] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
        const d = crypto.createDecipheriv('aes-256-gcm', this.#key(), iv);
        d.setAuthTag(tag);
        payload = Buffer.concat([d.update(enc), d.final()]).toString('utf8');
      }
      const creds = JSON.parse(payload);
      return creds.username && creds.password ? creds : null;
    } catch {
      return null;
    }
  }

  clear() {
    try {
      fs.unlinkSync(this.file);
    } catch {}
  }

  #key() {
    if (!fs.existsSync(this.keyFile)) fs.writeFileSync(this.keyFile, crypto.randomBytes(32), { mode: 0o600 });
    return fs.readFileSync(this.keyFile);
  }
}
