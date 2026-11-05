// Opens the web page a QR code links to, and returns its text.
//
// The link was printed by whoever made the pack, so it may point anywhere.
// Before connecting, the server checks the address it is about to reach and
// refuses its own machine and private networks: a fake pack must not be able
// to make the server read its own admin pages or the local network.
//
// Nothing is saved. Every scan opens the page fresh.

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const TIMEOUT_MS = 8000;
const MAX_BYTES = 5_000_000; // a maker's batch list can be a few MB; stop reading after 5 MB
const MAX_REDIRECTS = 3;
const HEADERS = { 'user-agent': 'MedVerify research prototype (medicine verification)', accept: 'text/html,text/plain,text/csv' };

// Addresses the server must never connect to for a stranger's link.
const PRIVATE = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 3]]) PRIVATE.addSubnet(ip, bits, 'ipv4');
for (const [ip, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]]) PRIVATE.addSubnet(ip, bits, 'ipv6');

export function isPrivate(address) {
  // An IPv4 address written as IPv6 (::ffff:127.0.0.1) is checked as IPv4.
  const v4 = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) return PRIVATE.check(v4, 'ipv4');
  return PRIVATE.check(address, net.isIPv6(address) ? 'ipv6' : 'ipv4');
}

// Used by http(s).get instead of the normal lookup, so the check applies to
// the exact address the connection is made to.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const blocked = addresses.find((a) => isPrivate(a.address));
    if (blocked) return callback(new Error(`refusing to open a link to a private address (${blocked.address})`));
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

// Fetch a page, following up to three redirects. Returns { url, html, text }.
export function fetchPage(address, redirects = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol)) return reject(new Error('only web links can be opened'));
    if (url.port && !['80', '443'].includes(url.port)) return reject(new Error('only standard web ports can be opened'));
    if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivate(url.hostname.replace(/^\[|\]$/g, ''))) {
      return reject(new Error('refusing to open a link to a private address'));
    }

    const get = url.protocol === 'https:' ? https.get : http.get;
    const req = get(url, { headers: HEADERS, lookup: safeLookup, timeout: TIMEOUT_MS }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        return resolve(fetchPage(new URL(headers.location, url).href, redirects + 1));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`the page answered ${statusCode}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BYTES) res.destroy(); // keep what we have
      });
      res.on('close', () => resolve({ url: url.href, html: body, text: pageText(body) }));
    });
    req.on('timeout', () => req.destroy(new Error('the page took too long to answer')));
    req.on('error', reject);
  });
}

// HTML -> the visible words, upper-cased and single-spaced, for searching.
export function pageText(html) {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// Where on a maker's page the batch list may be. Makers rarely put it on the
// page the QR code opens: Neurobion's QR opens its home page, which links to
// "/en-in/product-batch-info", which loads the list from a CSV file.
//
//   pages: links on the same site whose address mentions batch, authentic or verify
//   files: data files (.csv, .txt) mentioned anywhere in the page
export function findLeads(page) {
  const here = new URL(page.url);
  const absolute = (href) => {
    try {
      return new URL(href.replace(/\u002F/gi, '/'), here).href;
    } catch {
      return null;
    }
  };
  const hrefs = [...page.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => absolute(m[1])?.split('#')[0]);
  const pages = hrefs.filter((u) => u && new URL(u).hostname === here.hostname && /batch|authentic|verif/i.test(new URL(u).pathname));
  const files = [...page.html.matchAll(/((?:https?:)?\/\/[^"'\s<>()]+?\.(?:csv|txt))(?=["'\s<>?)]|$)/gi)].map((m) => absolute(m[1]));
  return { pages: [...new Set(pages)], files: [...new Set(files.filter(Boolean))] };
}
