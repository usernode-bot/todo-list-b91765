// The app must not name a platform hostname.
//
// This is the failure this file exists to prevent, and it has already happened
// once: the bridge, the usernode-native kit and the Tailwind runtime were
// loaded from an absolute platform hostname, the platform moved to a new
// domain, the old host stopped answering, and the app lost its styling, its
// kit and — because the shell asks the bridge whether a service worker is
// controlling the document — its ability to open offline at all. Three tags,
// one dead hostname, whole app down.
//
// The platform now serves /usernode-bridge/, /usernode-native/ and
// /usernode-tailwind/ from every app's OWN origin, so a relative path reaches
// the same files and cannot go stale. Links to the platform itself still need
// an absolute origin, and that one comes from the environment at boot
// (USERNODE_PLATFORM_ORIGIN) rather than from anything written down here.
//
// Run with: node --test tests/platform-origin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const INDEX = read('public', 'index.html');
const LANDING = read('public', 'landing.html');
const SW = read('public', 'sw.js');
const SERVER = read('server.js');

const PLACEHOLDER = '__USERNODE_PLATFORM_ORIGIN__';
const FRONTEND = [
  ['public/index.html', INDEX],
  ['public/landing.html', LANDING],
  ['public/sw.js', SW],
];

test('no platform asset is loaded from an absolute URL', () => {
  // Scheme-relative ("//host/usernode-…") counts too: it inherits the page's
  // scheme but still names a host.
  const absolute = /(?:https?:)?\/\/[^"'\s)]*\/usernode-(?:bridge|native|tailwind)\//g;
  for (const [name, src] of FRONTEND) {
    const hits = src.match(absolute) || [];
    assert.deepEqual(hits, [],
      `${name} reaches a platform asset by hostname. Use the relative path — ` +
      'the platform serves these prefixes from this app\'s own origin, and a ' +
      'hostname written here dies the next time the platform moves.');
  }
});

test('the shell and the landing page load all three platform assets relatively', () => {
  for (const src of ['/usernode-tailwind/v1/tailwind.js',
                     '/usernode-native/v1/native.css',
                     '/usernode-native/v1/native.js']) {
    assert.ok(INDEX.includes('"' + src + '"'), `index.html must load ${src}`);
    assert.ok(LANDING.includes('"' + src + '"'), `landing.html must load ${src}`);
  }
  // The bridge is the app shell's alone, and it is not optional: it is how the
  // shell answers the platform frame, which is what lets the app open offline.
  assert.ok(INDEX.includes('"/usernode-bridge/v1/bridge.js"'),
    'index.html must load the bridge — without it the shell refuses to mount offline');
});

test('the service worker caches the platform assets as same-origin paths', () => {
  const start = SW.indexOf('const HOSTED_ASSETS = [');
  assert.notEqual(start, -1, 'the worker still precaches the platform assets by name');
  const block = SW.slice(start, SW.indexOf('];', start));
  const entries = block.match(/'[^']+'/g) || [];
  assert.ok(entries.length >= 3, 'the kit, Tailwind and the bridge are all precached');
  for (const m of entries) {
    assert.ok(m.startsWith("'/"), `HOSTED_ASSETS entry ${m} must be an absolute-path URL`);
  }
  // A platform hostname in the cross-origin list is how the dead host stayed
  // reachable-looking after the tags themselves were fixed.
  const hosts = SW.slice(SW.indexOf('const ASSET_HOSTS'), SW.indexOf('const HOSTED_ASSETS'));
  assert.doesNotMatch(hosts, /usernodelabs\.org|onhomeroom\.com/,
    'ASSET_HOSTS must not name a platform hostname; those files are same-origin now');
});

test('the landing page takes the platform origin from the environment', () => {
  // Two links: the "Open it in Usernode" anchor and the demo list's CTA.
  assert.equal(LANDING.split(PLACEHOLDER).length - 1, 2,
    `landing.html should carry ${PLACEHOLDER} for both of its platform links`);
  assert.doesNotMatch(LANDING, /usernodelabs\.org|onhomeroom\.com/,
    'landing.html must name no platform hostname at all — the server substitutes it');
  assert.doesNotMatch(INDEX, /usernodelabs\.org|onhomeroom\.com/,
    'index.html must name no platform hostname at all');

  // The two halves have to agree on the spelling, or the page ships a literal
  // "__USERNODE_PLATFORM_ORIGIN__" as an href and the link is simply broken.
  assert.ok(SERVER.includes(PLACEHOLDER),
    'server.js must substitute the same placeholder landing.html carries');
  assert.match(SERVER, /process\.env\.USERNODE_PLATFORM_ORIGIN/,
    'the origin comes from the platform-injected env var');

  const rendered = LANDING.split(PLACEHOLDER).join('https://platform.example');
  assert.doesNotMatch(rendered, /__USERNODE_/,
    'nothing placeholder-shaped may survive rendering');
  assert.ok(rendered.includes('href="https://platform.example"'),
    'the anchor resolves to the injected origin');
});

test('a bad USERNODE_PLATFORM_ORIGIN is rejected rather than written into the page', () => {
  // The value lands in an href and in a JS string literal, so it is validated
  // as a plain http(s) origin instead of being trusted.
  const block = SERVER.slice(SERVER.indexOf('const PLATFORM_ORIGIN ='),
                             SERVER.indexOf('const LANDING_HTML'));
  assert.match(block, /new URL\(/, 'the injected value is parsed, not interpolated blind');
  assert.match(block, /u\.origin === raw/,
    'and it has to BE an origin — a value carrying a path or a query is refused');
  assert.match(block, /PLATFORM_ORIGIN_FALLBACK/, 'with a fallback when it is unset or unusable');
});
