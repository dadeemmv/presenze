/**
 * Copia la sessione Bocconi dal Chrome dedicato (porta 9223, aperto da tools/record.mjs)
 * nel barattolo dell'app. Serve per sviluppare senza rifare il login con la password.
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import { Jar } from '../lib/http.mjs';

const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9223', defaultViewport: null });
const page = (await b.pages())[0];
const s = await page.createCDPSession();
const { cookies } = await s.send('Storage.getCookies');
const jar = new Jar(fileURLToPath(new URL('../data/session.json', import.meta.url)));
jar.cookies = cookies
  .filter((c) => c.domain.replace(/^\./, '').endsWith('unibocconi.it'))
  .map((c) => ({ name: c.name, value: c.value, domain: c.domain.replace(/^\./, ''), hostOnly: !c.domain.startsWith('.'), path: c.path }));
jar.save();
console.log(`${jar.cookies.length} cookie importati.`);
b.disconnect();
