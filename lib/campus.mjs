/**
 * "Sei in Bocconi?" dai segnali che manda il telefono.
 *
 * Wi-Fi: le LAN dell'universita' escono su 193.205.16.0/20 (RIPE, netname UNI-BOCCONI, GARR):
 * se l'IP pubblico del telefono cade li' dentro, il telefono e' sulla rete Bocconi. Il nome della
 * rete da solo vale solo se e' una rete Bocconi: "eduroam" esiste in ogni ateneo, quindi con
 * eduroam serve anche l'IP.
 * GPS: in alternativa, distanza dall'aula della lezione.
 */
import { meters } from './bocconi.mjs';

const NETS = (process.env.BOCCONI_NETS || '193.205.16.0/20').split(',').map((s) => s.trim()).filter(Boolean);
const SSIDS = (process.env.BOCCONI_SSIDS || 'bocconi').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const toInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + Number(o), 0) >>> 0;
const isV4 = (ip) => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);

export function inBocconiNet(ip) {
  ip = String(ip || '').replace(/^::ffff:/, '').trim();
  if (!isV4(ip)) return false;
  return NETS.some((cidr) => {
    const [base, bits] = cidr.split('/');
    const mask = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0;
    return (toInt(ip) & mask) === (toInt(base) & mask);
  });
}

export const isBocconiSsid = (ssid) => {
  const s = String(ssid || '').toLowerCase();
  return !!s && SSIDS.some((x) => s.includes(x));
};

/** Ritorna { on, how, detail } per una lezione, dati i segnali del telefono. */
export function onCampus(signal, lesson, radius) {
  const { ip, ssid, lat, lng, accuracy } = signal;
  if (ip && inBocconiNet(ip)) return { on: true, how: 'wifi', detail: `rete Bocconi (${ip})` };
  if (isBocconiSsid(ssid)) return { on: true, how: 'wifi', detail: `Wi-Fi "${ssid}"` };
  const here = { lat: Number(lat), lng: Number(lng) };
  if (Number.isFinite(here.lat) && Number.isFinite(here.lng) && lesson.lat != null) {
    const dist = Math.round(meters(here, lesson));
    const slack = Math.min(Number(accuracy) || 0, 150);
    return dist <= radius + slack
      ? { on: true, how: 'gps', detail: `${dist} m dall'aula` }
      : { on: false, how: 'gps', detail: `${dist} m dall'aula (limite ${radius} m)` };
  }
  const seen = [ip && `IP ${ip}`, ssid && `Wi-Fi "${ssid}"`].filter(Boolean).join(', ');
  return { on: false, how: 'none', detail: seen ? `${seen}: non è la rete Bocconi` : 'nessun segnale (né Wi-Fi né posizione)' };
}
