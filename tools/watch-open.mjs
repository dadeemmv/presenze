/**
 * Sola lettura: interroga lo stato della presenza di una lezione ogni 90 s e salva l'HTML
 * grezzo del pannello appena la rilevazione si apre. Non registra niente.
 * Uso: node tools/watch-open.mjs <extcode> [minuti]
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Jar, Client } from '../lib/http.mjs';
import * as B from '../lib/bocconi.mjs';

const ext = process.argv[2];
const minutes = Number(process.argv[3] || 60);
const c = new Client(new Jar(fileURLToPath(new URL('../data/session.json', import.meta.url))));
const out = fileURLToPath(new URL(`../.capture/open-${ext}.html`, import.meta.url));
const until = Date.now() + minutes * 60_000;
const day = B.romeNow().slice(0, 10);
const [y, m, d] = day.split('-').map(Number);

while (Date.now() < until) {
  try {
    await c.get(`https://app.unibocconi.it/presences/lezionebbpage?extcode=${ext}&cod_lingua=ita`);
    const q = new URLSearchParams({ pk: '', extcode: ext, shareguid: '', year: y, month: m, day: d, _: Date.now() });
    const r = await c.get(`https://app.unibocconi.it/Presences/LezioneBBPage/ListaLezioniPartial?${q}`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const p = B.parsePanels(r.text)[0];
    console.log(B.romeNow().slice(11), JSON.stringify(p?.alerts), 'pk' in (p || {}) && p.pk ? 'FORM' : '');
    if (p && !p.alerts.some((a) => /non avviata/i.test(a))) {
      fs.writeFileSync(out, r.text);
      console.log('Rilevazione cambiata: salvato', out);
      process.exit(0);
    }
  } catch (e) {
    console.log(B.romeNow().slice(11), 'errore', e.message);
  }
  await new Promise((r) => setTimeout(r, 90_000));
}
console.log('Fine attesa senza apertura.');
