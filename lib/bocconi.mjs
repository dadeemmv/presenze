/**
 * Le tre cose di yoU@B che servono: chi sei, il calendario delle lezioni, la presenza.
 *
 * Endpoint ricavati dalla registrazione di rete del 5 ott 2026 (tools/record.mjs):
 *   calendario  app.unibocconi.it/Calendars/CalendarioLezioniUtenteResource?format=json&start&end
 *   lezioni     agenda-app.unibocconi.it/lol/presences.php          (lista del giorno, con extcode)
 *   stato       app.unibocconi.it/Presences/LezioneBBPage/ListaLezioniPartial?extcode&year&month&day
 *   presenza    app.unibocconi.it/Presences/LezioneBBPage/RilevaPresenza?pk&pin&where   (GET, come fa la pagina)
 * La presenza si apre quando il docente preme "Start Lesson": prima di allora il form non c'e'.
 */
const APP = 'https://app.unibocconi.it';
const AGENDA = 'https://agenda-app.unibocconi.it';
const XHR = { 'X-Requested-With': 'XMLHttpRequest', Accept: '*/*' };

const strip = (s) =>
  String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&agrave;/g, 'à')
    .replace(/&egrave;/g, 'è')
    .replace(/[ \t]+/g, ' ')
    .trim();

const pad = (n) => String(n).padStart(2, '0');

/** Data/ora locale di Milano senza fuso, nel formato che usa il calendario: 2026-10-05T16:30:00. */
export function romeNow(d = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(d)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Minuti fra due orari locali "YYYY-MM-DDTHH:MM:SS" (b - a). */
export const minutesBetween = (a, b) => (Date.parse(b + 'Z') - Date.parse(a + 'Z')) / 60_000;

/** Anno accademico come lo scrive Bocconi negli extcode: 2026 per il 2026/27. */
const academicYear = (iso) => {
  const [y, m] = iso.split('-').map(Number);
  return m >= 8 ? y : y - 1;
};

/** Login SSO e verifica: si atterra davvero su app.unibocconi.it, non sulla pagina dell'IdP. */
export async function login(client, username, password) {
  client.jar.clear();
  client.creds = { username: String(username).trim(), password: String(password) };
  try {
    const r = await client.get(`${APP}/Calendars/CalendarioUtenteWidget?view_type=agendaWeek&cod_lingua=ita&cod_target=0`);
    if (new URL(r.url).hostname !== 'app.unibocconi.it') throw new Error('Login non completato.');
    return { username: client.creds.username };
  } catch (e) {
    client.creds = null;
    client.jar.clear();
    throw e;
  }
}

/** Lezioni fra due date (YYYY-MM-DD, estremi inclusi), dal calendario della dashboard. */
export async function lessons(client, from, to) {
  const end = new Date(Date.parse(to + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
  const q = new URLSearchParams({ format: 'json', start: `${from}T00:00:00+02:00`, end: `${end}T00:00:00+02:00` });
  const raw = await client.getJson(`${APP}/Calendars/CalendarioLezioniUtenteResource?${q}`);
  if (!Array.isArray(raw)) throw new Error('Calendario in un formato inatteso.');
  return raw
    .map((e) => {
      const d = String(e.description || '');
      const lez = /<b>Lezione:<\/b>\s*(\d+)\s*-\s*(.+?)\s*\(Classe\s*(\d+)\)/i.exec(d);
      const code = lez?.[1] || /^(\d+)/.exec(e.title || '')?.[1] || null;
      const classe = lez?.[3] || null;
      const geo = /query=(-?\d+\.\d+),(-?\d+\.\d+)/.exec(d);
      return {
        code,
        course: lez ? strip(lez[2]) : strip(e.title),
        classe,
        extcode: code && classe ? `${code}_${classe.padStart(2, '0')}_${academicYear(e.start)}` : null,
        teachers: strip(/<b>Docenti:<\/b>(.*?)<br/i.exec(d)?.[1]),
        room: strip(/<b>Posizione:<\/b>(.*?)<a /i.exec(d)?.[1]),
        lat: geo ? Number(geo[1]) : null,
        lng: geo ? Number(geo[2]) : null,
        start: e.start,
        end: e.end,
        onCampus: /in presenza/i.test(e.title || ''),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Lo stato della presenza per una lezione del giorno: gia' registrata, aperta, o non ancora aperta. */
export async function attendanceState(client, extcode, dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number);
  // La pagina madre apre la sessione dell'app Presences, poi il parziale porta i dati veri.
  await client.get(`${APP}/presences/lezionebbpage?extcode=${encodeURIComponent(extcode)}&cod_lingua=ita`);
  const q = new URLSearchParams({ pk: '', extcode, shareguid: '', year: y, month: m, day: d, _: Date.now() });
  const r = await client.get(`${APP}/Presences/LezioneBBPage/ListaLezioniPartial?${q}`, {
    headers: { ...XHR, Referer: `${APP}/presences/lezionebbpage?extcode=${extcode}&cod_lingua=ita` },
  });
  return parsePanels(r.text);
}

/** Un pannello per lezione: idImpegno, shareGuid, messaggi, e il form di presenza se c'e'. */
export function parsePanels(html) {
  const chunks = html.split(/<div class="collapsePanel lesson"/).slice(1);
  return chunks.map((c) => {
    const val = (id) => {
      const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`, 'i').exec(c)?.[0];
      if (!tag) return undefined;
      return { value: /value="([^"]*)"/i.exec(tag)?.[1] ?? '', type: (/type="([^"]*)"/i.exec(tag)?.[1] || 'text').toLowerCase() };
    };
    const where = [...c.matchAll(/<input[^>]*name="whereRadios"[^>]*>/gi)].map((m) => {
      const tag = m[0];
      const id = /id="([^"]*)"/i.exec(tag)?.[1];
      const label = id ? strip(new RegExp(`<label[^>]*for="${id}"[^>]*>([\\s\\S]*?)</label>`, 'i').exec(c)?.[1]) : '';
      return { value: /value="([^"]*)"/i.exec(tag)?.[1] ?? '', label, disabled: /\bdisabled\b/i.test(tag) };
    });
    const alerts = [...c.matchAll(/<div class="alert[^"]*"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/gi)].map((m) => strip(m[0]).replace(/\s+/g, ' '));
    return {
      idImpegno: /data-idimpegno="([^"]+)"/i.exec(c)?.[1] || null,
      shareGuid: /data-shareguid="([^"]+)"/i.exec(c)?.[1] || null,
      title: strip(/<h3 class="panelTitle">[\s\S]*?<span>([\s\S]*?)<\/span>/i.exec(c)?.[1]),
      time: /(\d{2}:\d{2})\s*-\s*(\d{2}:\d{2})/.exec(c)?.slice(1, 3) || null,
      pk: val('pk'),
      pin: val('pin'),
      where,
      alerts,
      registered: alerts.some((a) => /presenza registrata|attendance registered|already/i.test(a)),
    };
  });
}

/** Sceglie l'opzione "in aula" fra quelle offerte. Se non e' chiara, nessuna: meglio non registrare che registrare male. */
export function pickOnCampus(where) {
  const ok = where.filter((w) => !w.disabled);
  return ok.find((w) => /campus|aula|presenza|in person|classroom/i.test(`${w.label} ${w.value}`)) || (ok.length === 1 ? ok[0] : null);
}

export async function register(client, extcode, { pk, pin, where }) {
  const q = new URLSearchParams({ pk, pin, where, _: Date.now() });
  const r = await client.get(`${APP}/Presences//LezioneBBPage/RilevaPresenza?${q}`, {
    headers: { ...XHR, Referer: `${APP}/presences/lezionebbpage?extcode=${extcode}&cod_lingua=ita` },
  });
  try {
    return JSON.parse(r.text);
  } catch {
    throw new Error(`RilevaPresenza ha risposto in modo inatteso (${r.status}).`);
  }
}

/** Distanza in metri fra due punti (haversine). */
export function meters(a, b) {
  const R = 6_371_000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export { pad, strip, AGENDA };
