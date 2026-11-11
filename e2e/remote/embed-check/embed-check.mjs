#!/usr/bin/env node
// dsh-remote-go · V0 iframe embedding check.
//
// Serves a minimal wrapper page on 127.0.0.1:<random> that embeds
//   http://127.0.0.1:<remote-port>/?token=<launch-token>
// in an <iframe>, drives a real Chrome through puppeteer-core, and records:
//   - whether the remote frame loads and where it ends up (token -> clean URL)
//   - whether the dsh-auth-* cookie was minted for this authority
//   - whether the app UI actually rendered (DOM size, text, composer)
//   - whether the WebSocket(s) connected and carried frames
//   - console/page/network errors that could explain a failure
//
// The wrapper page deliberately uses 127.0.0.1:<other-port>: same-site as the
// remote (scheme+host), different origin — the exact shape the plugin uses.
//
// Usage:
//   node embed-check.mjs --remote-port 41234 --token-file ../.token
// Optional:
//   --chrome <path> --out <json path> --screenshot <png path> --timeout-ms 45000
//
// Exit code 0 = V0 iframe gate passed, 1 = failed (result JSON still written).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = value;
      i++;
    }
  }
  return out;
}

/**
 * Portable Chrome discovery: --chrome, then CHROME_PATH, then the default
 * install location of each supported OS. No developer-specific path.
 * @returns {string | null}
 */
function resolveChrome() {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.PROGRAMFILES ?? 'C:/Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)';
  const candidates = [
    args.chrome,
    process.env.CHROME_PATH,
    localAppData && `${localAppData}/Google/Chrome/Application/chrome.exe`,
    `${programFiles}/Google/Chrome/Application/chrome.exe`,
    `${programFilesX86}/Google/Chrome/Application/chrome.exe`,
    localAppData && `${localAppData}/Microsoft/Edge/Application/msedge.exe`,
    `${programFilesX86}/Microsoft/Edge/Application/msedge.exe`,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const remotePort = Number(args['remote-port']);
const tokenFile = path.resolve(HERE, args['token-file'] ?? path.join(HERE, '..', '.token'));
const chromePath = resolveChrome();
const outPath = path.resolve(HERE, args.out ?? path.join(HERE, '..', 'evidence', 'embed-check.result.json'));
const screenshotPath = path.resolve(HERE, args.screenshot ?? path.join(HERE, '..', 'evidence', 'embed-check.png'));
const timeoutMs = Number(args['timeout-ms'] ?? 45000);

if (!Number.isInteger(remotePort) || remotePort <= 0) {
  console.error('embed-check: --remote-port is required (e.g. --remote-port 41234)');
  process.exit(2);
}
if (!fs.existsSync(tokenFile)) {
  console.error(`embed-check: token file not found: ${tokenFile}`);
  process.exit(2);
}
if (!chromePath) {
  console.error('embed-check: no Chrome/Edge found; pass --chrome <path> or set CHROME_PATH');
  process.exit(2);
}

const token = fs.readFileSync(tokenFile, 'utf8').trim();
const remoteUrl = `http://127.0.0.1:${remotePort}/`;
const seedUrl = `${remoteUrl}?token=${encodeURIComponent(token)}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function nowIso() {
  return new Date().toISOString();
}

// --- minimal wrapper page (same-site, different port) ----------------------
const wrapperHtml = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>dsh-remote-go V0 wrapper</title>
<style>html,body{margin:0;padding:0;height:100%;overflow:hidden}iframe{display:block;width:100vw;height:100vh;border:0}</style>
</head>
<body><iframe id="remote" title="remote dsh" src="${seedUrl.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}"></iframe></body>
</html>`;

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(wrapperHtml);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const wrapperPort = server.address().port;
const wrapperUrl = `http://127.0.0.1:${wrapperPort}/`;

const result = {
  generatedAt: nowIso(),
  kind: 'v0-iframe-embed-check',
  wrapperUrl,
  remoteUrl,
  seedUrlRedacted: `${remoteUrl}?token=${token.slice(0, 6)}<redacted>(len=${token.length})`,
  chromePath,
  timeoutMs,
  checks: [],
  frame: null,
  cookies: [],
  webSockets: null,
  consoleErrors: [],
  pageErrors: [],
  requestFailures: [],
  browser: null,
  wrapper: null,
  screenshot: null,
  error: null,
  verdict: 'fail',
};

function addCheck(id, expected, actual, pass, evidence = '') {
  result.checks.push({ id, expected, actual, pass, evidence });
}

let browser = null;
try {
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    defaultViewport: { width: 1440, height: 900 },
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,BackForwardCache',
      '--window-size=1440,900',
    ],
  });
  result.browser = await browser.version();

  const page = await browser.newPage();
  page.setDefaultTimeout(Math.min(timeoutMs, 30000));
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  const wsCreated = [];
  const wsHandshakes = [];
  const wsClosed = [];
  const wsErrors = [];
  let wsFramesReceived = 0;
  let wsFramesSent = 0;

  cdp.on('Network.webSocketCreated', (event) => {
    wsCreated.push({ url: event.url, requestId: event.requestId });
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', (event) => {
    wsHandshakes.push({
      url: event.response?.url,
      status: event.response?.status,
      headers: event.response?.headers,
    });
  });
  cdp.on('Network.webSocketFrameReceived', () => {
    wsFramesReceived++;
  });
  cdp.on('Network.webSocketFrameSent', () => {
    wsFramesSent++;
  });
  cdp.on('Network.webSocketClosed', (event) => {
    wsClosed.push({ url: event.url });
  });
  cdp.on('Network.webSocketFrameError', (event) => {
    wsErrors.push({ errorMessage: event.errorMessage, requestId: event.requestId });
  });

  page.on('console', (message) => {
    if (message.type() === 'error') result.consoleErrors.push(message.text().slice(0, 500));
  });
  page.on('pageerror', (error) => result.pageErrors.push(String(error).slice(0, 500)));
  page.on('requestfailed', (request) => {
    result.requestFailures.push({
      url: request.url(),
      method: request.method(),
      errorText: request.failure()?.errorText ?? '',
    });
  });

  const response = await page.goto(wrapperUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  addCheck('wrapper.loaded', 'wrapper page HTTP 200', `HTTP ${response?.status()}`, response?.status() === 200, wrapperUrl);

  // --- wait for the remote frame to appear in the frame tree --------------
  const deadline = Date.now() + timeoutMs;
  let remoteFrame = null;
  while (Date.now() < deadline) {
    remoteFrame = page.frames().find((frame) => {
      try {
        return new URL(frame.url()).hostname === '127.0.0.1' && Number(new URL(frame.url()).port) === remotePort;
      } catch {
        return false;
      }
    });
    if (remoteFrame) break;
    await sleep(250);
  }
  addCheck('frame.found', `iframe frame for 127.0.0.1:${remotePort}`, remoteFrame ? remoteFrame.url() : 'not found', Boolean(remoteFrame));

  let dom = null;
  if (remoteFrame) {
    // Wait until the app has rendered something meaningful, then take a snapshot.
    const renderDeadline = Date.now() + timeoutMs;
    while (Date.now() < renderDeadline) {
      try {
        dom = await remoteFrame.evaluate(() => ({
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          elementCount: document.querySelectorAll('*').length,
          bodyText: (document.body?.innerText ?? '').slice(0, 2000),
          htmlLength: document.documentElement?.outerHTML?.length ?? 0,
          hasComposer:
            Boolean(document.querySelector('textarea')) ||
            Boolean(document.querySelector('[contenteditable="true"]')) ||
            Boolean(document.querySelector('[contenteditable="plaintext-only"]')),
          hasSidebar: Boolean(document.querySelector('aside, nav, [class*="sidebar"]')),
          localStorageKeys: (() => {
            try { return Object.keys(localStorage).length; } catch { return -1; }
          })(),
          scriptCount: document.querySelectorAll('script').length,
          rootChildren: document.body?.children?.length ?? 0,
        }));
        if (dom && (dom.elementCount > 80 || dom.bodyText.trim().length > 80)) break;
      } catch (error) {
        dom = { evaluateError: String(error).slice(0, 500) };
      }
      await sleep(500);
    }

    // Give the app a moment to open its WebSocket(s).
    await sleep(1500);

    const frameUrl = remoteFrame.url();
    addCheck(
      'frame.cookie-exchange',
      'frame URL settles on clean / (no token) after 303',
      frameUrl,
      frameUrl === remoteUrl || (frameUrl.startsWith(remoteUrl) && !frameUrl.includes('token=')),
    );
    addCheck(
      'frame.dom-rendered',
      'remote DOM has > 80 elements or > 80 chars of text',
      dom ? `elements=${dom.elementCount}, textLength=${dom.bodyText?.trim().length ?? 0}` : 'no dom snapshot',
      Boolean(dom) && (dom.elementCount > 80 || (dom.bodyText ?? '').trim().length > 80),
      'frame.dom',
    );
    addCheck(
      'frame.no-error-text',
      'no login/401/error page text in remote body',
      (dom?.bodyText ?? '').replaceAll(/\s+/g, ' ').slice(0, 200),
      Boolean(dom) && !/unauthorized|\b401\b|login required|sign in to continue|failed to load/i.test(dom.bodyText ?? ''),
    );
    result.frame = {
      url: frameUrl,
      title: dom?.title ?? '',
      readyState: dom?.readyState ?? '',
      elementCount: dom?.elementCount ?? 0,
      bodyTextPreview: (dom?.bodyText ?? '').replaceAll(/\s+/g, ' ').trim().slice(0, 500),
      composerInputPresent: Boolean(dom?.hasComposer),
      sidebarPresent: Boolean(dom?.hasSidebar),
      scriptCount: dom?.scriptCount ?? 0,
      localStorageKeys: dom?.localStorageKeys ?? -1,
    };
  }

  // --- wrapper DOM snapshot ------------------------------------------------
  try {
    result.wrapper = await page.evaluate(() => {
      const iframe = document.querySelector('iframe');
      return {
        title: document.title,
        iframeCount: document.querySelectorAll('iframe').length,
        iframeSrcRedacted: (iframe?.getAttribute('src') ?? '').replace(/token=[^&]+/, 'token=<redacted>'),
        iframeLoadState: iframe?.contentDocument ? 'same-origin-readable' : 'cross-origin (expected)',
      };
    });
  } catch (error) {
    result.wrapper = { error: String(error).slice(0, 300) };
  }

  // --- cookies via CDP (version-agnostic) ----------------------------------
  try {
    const { cookies } = await cdp.send('Network.getAllCookies');
    result.cookies = cookies
      .filter((cookie) => cookie.name.startsWith('dsh-auth-'))
      .map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
        session: cookie.session,
        expires: cookie.expires,
      }));
    const authCookie = result.cookies[0];
    addCheck(
      'cookie.dsh-auth-present',
      'a dsh-auth-* cookie is stored for the remote authority',
      authCookie ? `${authCookie.name} domain=${authCookie.domain} httpOnly=${authCookie.httpOnly} sameSite=${authCookie.sameSite}` : 'none',
      Boolean(authCookie) &&
        authCookie.httpOnly === true &&
        String(authCookie.sameSite).toLowerCase() === 'strict' &&
        authCookie.domain.includes('127.0.0.1'),
      'Network.getAllCookies',
    );
  } catch (error) {
    addCheck('cookie.dsh-auth-present', 'a dsh-auth-* cookie is stored', `error: ${String(error).slice(0, 300)}`, false);
  }

  // --- WebSocket evidence --------------------------------------------------
  result.webSockets = {
    created: wsCreated,
    handshakes: wsHandshakes,
    closed: wsClosed,
    errors: wsErrors,
    framesReceived: wsFramesReceived,
    framesSent: wsFramesSent,
  };
  const mux = wsCreated.find((ws) => ws.url.includes('127.0.0.1'));
  addCheck(
    'websocket.created',
    'at least one WebSocket opened to 127.0.0.1:<remote-port>',
    wsCreated.length > 0 ? `${wsCreated.length} socket(s); first=${wsCreated[0].url}` : 'none',
    wsCreated.length > 0 && Boolean(mux),
  );
  const successfulHandshake = wsHandshakes.find((handshake) => handshake.status === 101);
  addCheck(
    'websocket.101',
    'WebSocket handshake answered 101',
    successfulHandshake ? `url=${successfulHandshake.url} status=101` : `handshakes=${JSON.stringify(wsHandshakes.map((h) => h.status))}`,
    Boolean(successfulHandshake),
  );
  addCheck(
    'websocket.traffic',
    'WebSocket carried frames (received > 0)',
    `received=${wsFramesReceived} sent=${wsFramesSent}`,
    wsFramesReceived > 0,
  );

  // --- errors --------------------------------------------------------------
  addCheck('console.no-fatal', 'no page-context uncaught errors', `${result.pageErrors.length} pageerror(s)`, result.pageErrors.length === 0);
  addCheck(
    'network.no-failed-remote-requests',
    'no failed network request to the remote origin',
    `${result.requestFailures.filter((failure) => failure.url.includes(`127.0.0.1:${remotePort}`)).length} failed remote request(s)`,
    result.requestFailures.filter((failure) => failure.url.includes(`127.0.0.1:${remotePort}`)).length === 0,
  );

  // --- screenshot ----------------------------------------------------------
  try {
    fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: false });
    result.screenshot = screenshotPath;
  } catch (error) {
    result.screenshot = `screenshot failed: ${String(error).slice(0, 200)}`;
  }

  result.verdict = result.checks.every((check) => check.pass) ? 'pass' : 'fail';
} catch (error) {
  result.error = {
    message: String(error?.message ?? error),
    stack: String(error?.stack ?? '').split('\n').slice(0, 6),
  };
  addCheck('run.completed', 'check finished without an exception', result.error.message, false);
  result.verdict = 'fail';
} finally {
  try { if (browser) await browser.close(); } catch {}
  await new Promise((resolve) => server.close(resolve));
  result.finishedAt = nowIso();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  const passed = result.checks.filter((check) => check.pass).length;
  console.log(`embed-check: verdict=${result.verdict} checks=${passed}/${result.checks.length}`);
  for (const check of result.checks) {
    console.log(`  [${check.pass ? 'PASS' : 'FAIL'}] ${check.id}: ${check.actual}`);
  }
  console.log(`result: ${outPath}`);
  if (result.screenshot && fs.existsSync(result.screenshot)) console.log(`screenshot: ${result.screenshot}`);
  process.exit(result.verdict === 'pass' ? 0 : 1);
}
