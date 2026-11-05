// Opens a web page in a real (headless) browser, for pages that fill
// themselves in with JavaScript.
//
// Many makers' verification pages arrive empty and fetch their answer after
// loading. Abbott's QR opens abbott.psverify.com, whose HTML says only
// "Verification in process…"; a script then asks the server and writes
// "This Product is GENUINE", the batch and the dates into the page. A plain
// fetch (link.js) never sees that, so for those pages the agent opens them the
// way a phone would.
//
// It uses the Chrome or Edge already installed (puppeteer-core downloads
// nothing). Set CHROME_PATH to choose one. With no browser, this is skipped.
//
// The link is a stranger's, like in link.js: every request the page makes is
// checked, and any to this machine or a private network is refused.

import dns from 'node:dns/promises';
import fs from 'node:fs';

import puppeteer from 'puppeteer-core';

import { isPrivate, pageText } from './link.js';

const TIMEOUT_MS = 15000;
const PLACES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export const browserPath = (env = process.env) => env.CHROME_PATH || PLACES.find((p) => fs.existsSync(p)) || null;

// One browser for the whole server, started on first use.
let started = null;
function browser() {
  const path = browserPath();
  if (!path) return Promise.reject(new Error('no Chrome or Edge on this server'));
  started ??= puppeteer.launch({ executablePath: path, headless: true, args: ['--no-first-run', '--disable-extensions'] })
    .catch((err) => { started = null; throw err; });
  return started;
}

// May the page load this address? Web addresses on standard ports, never private ones.
async function allowed(address) {
  const url = new URL(address);
  if (url.protocol === 'data:') return true; // images inlined in the page
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  if (url.port && !['80', '443'].includes(url.port)) return false;
  const found = await dns.lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => []);
  return found.length > 0 && !found.some((a) => isPrivate(a.address));
}

// Open the page, let its scripts run, and return what it shows: { url, html, text }.
export async function renderPage(address) {
  if (!(await allowed(address))) throw new Error('refusing to open this link');
  const page = await (await browser()).newPage();
  try {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      // Pictures, fonts and video are not needed to read the page.
      if (['image', 'media', 'font'].includes(req.resourceType())) return req.abort();
      allowed(req.url()).then((ok) => (ok ? req.continue() : req.abort())).catch(() => req.abort());
    });
    // Wait until the page has stopped asking for things: by then its answer is in.
    await page.goto(address, { waitUntil: 'networkidle0', timeout: TIMEOUT_MS }).catch((err) => {
      if (err.name !== 'TimeoutError') throw err; // a slow page still shows what it has
    });
    const html = await page.content();
    return { url: page.url(), html, text: pageText(html) };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (started) await (await started).close().catch(() => {});
  started = null;
}
