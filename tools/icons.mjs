/** Rigenera public/icon-192.png e icon-512.png da public/icon.svg con Chrome headless. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const pub = (f) => fileURLToPath(new URL(`../public/${f}`, import.meta.url));
const exe = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
  .map((p) => p && `${p}\\Google\\Chrome\\Application\\chrome.exe`)
  .find((p) => p && fs.existsSync(p));
const svg = fs.readFileSync(pub('icon.svg'), 'utf8');
const b = await puppeteer.launch({ executablePath: exe, headless: true });
const page = await b.newPage();
for (const size of [192, 512]) {
  await page.setViewport({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: pub(`icon-${size}.png`), omitBackground: true });
}
await b.close();
console.log('icone pronte');
