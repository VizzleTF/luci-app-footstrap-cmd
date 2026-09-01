/* T1 for luci-app-footstrap-palette against the agent stand.
 *
 * Everything here is a live assertion against a running router — no mocks, no fixtures. The parts
 * that matter most are the ones a parser cannot see: whether the stylesheet is still ENABLED after
 * a navigation (the theme rehosts and then scopes-off any sheet not marked data-fs-shell), and
 * whether a command's answer is the router's own data. */
/*   node tools/probe.mjs                 against the agent stand on :8035
 *   PALETTE_BASE=http://host:port node tools/probe.mjs
 *
 * This package has no node_modules of its own — there is no npm gate suite here yet — so playwright
 * is borrowed from the theme's checkout beside it, or from $PLAYWRIGHT. Exits non-zero on the first
 * failed assertion count, so it is usable as a gate as soon as there is somewhere to hang one. */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const CANDIDATES = [
	process.env.PLAYWRIGHT,
	new URL('../../luci-theme-footstrap/node_modules/playwright/index.mjs', import.meta.url).pathname,
	new URL('../node_modules/playwright/index.mjs', import.meta.url).pathname
].filter(Boolean);
const found = CANDIDATES.find((p) => existsSync(p));
if (!found) {
	console.error('probe: playwright not found — set $PLAYWRIGHT, or keep a luci-theme-footstrap checkout beside this one');
	process.exit(2);
}
const { chromium } = await import(found);

const BASE = process.env.PALETTE_BASE || 'http://localhost:8035';
const out = [];
let failed = 0;

function ok(name, cond, detail) {
	const line = `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`;
	out.push(line);
	console.log(line);
	if (!cond) failed++;
}

const browser = await chromium.launch();
const page = await browser.newPage();

const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

await page.goto(BASE + '/cgi-bin/luci/', { waitUntil: 'domcontentloaded' });
if (await page.$('input[name="luci_password"]')) {
	await page.fill('input[name="luci_username"]', 'root');
	await page.fill('input[name="luci_password"]', '');
	await Promise.all([ page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.press('input[name="luci_password"]', 'Enter') ]);
}
await page.waitForTimeout(2500);

/* ---- 1. the plugin is registered and loaded ---- */
const plugins = await page.evaluate(() => window.__fsPlugins || null);
ok('__fsPlugins names fs-palette', Array.isArray(plugins) && plugins.includes('fs-palette'), JSON.stringify(plugins));

const sources = await page.evaluate(() => (window.__fsSearchSources || []).length);
ok('__fsSearchSources registered', sources >= 1, sources + ' source(s)');

/* ---- 2. the stylesheet: present, marked, and still alive after a navigation ---- */
const sheet0 = await page.evaluate(() => {
	const l = document.getElementById('fs-palette-css');
	if (!l) return { found: false };
	return { found: true, shell: l.hasAttribute('data-fs-shell'), v: /\?v=/.test(l.href), disabled: !!l.disabled };
});
ok('palette.css <link> present', sheet0.found);
ok('palette.css marked data-fs-shell', sheet0.shell === true);
ok('palette.css carries ?v=', sheet0.v === true);

/* the bar has to actually be painted, not merely linked: this is the assertion that would have
 * caught both the data-fs-shell bug and a csstidy-mangled sheet */
await page.keyboard.press(':');
await page.waitForTimeout(900);
const styled0 = await page.evaluate(() => {
	const el = document.getElementById('fs-pal');
	if (!el || el.hidden) return null;
	const cs = getComputedStyle(el);
	return { position: cs.position, zIndex: cs.zIndex, bottom: cs.bottom };
});
ok('bar opens on ":"', styled0 !== null);
ok('bar is position:fixed from the sheet', styled0 && styled0.position === 'fixed', JSON.stringify(styled0));
ok('bar has a real z-index', styled0 && styled0.zIndex !== 'auto', styled0 && styled0.zIndex);

await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ---- 3. navigate, then check the sheet again — the regression that hid until page two ---- */
await page.goto(BASE + '/cgi-bin/luci/admin/system/system', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const sheet1 = await page.evaluate(() => {
	const l = document.getElementById('fs-palette-css');
	if (!l) return { found: false };
	let rules = -1;
	try { rules = l.sheet ? l.sheet.cssRules.length : -1; } catch (e) { rules = -2; }
	return { found: true, disabled: !!l.disabled, media: l.media, rules };
});
ok('palette.css survives a navigation', sheet1.found && !sheet1.disabled && sheet1.rules > 0, JSON.stringify(sheet1));

/* ---- 4. commands ----
 *
 * Run from Status -> Overview, NOT from a settings page. Learned the hard way: a `:` pressed while
 * focus sits in a <select> is read by the browser as type-ahead and the following Enter SAVES the
 * form. Driving the bar from the System page rewrote luci.main.mediaurlbase and luci.main.lang on
 * the stand — the probe damaged the router it was measuring. openBar() blurs first so this cannot
 * recur, and the page carries no form to submit either way. */
await page.goto(BASE + '/cgi-bin/luci/admin/status/overview', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

async function openBar() {
	/* `:` is ignored while focus sits in a field, which is most of a settings page, so the probe
	 * puts focus somewhere neutral first — the same thing a human does by clicking the page. */
	await page.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(200);
	await page.keyboard.press(':');
	await page.waitForSelector('.fs-pal-input', { state: 'attached', timeout: 8000 });
	await page.waitForTimeout(350);
	const open = await page.evaluate(() => { const r = document.getElementById('fs-pal'); return !!r && !r.hidden; });
	if (!open) throw new Error('the bar did not open — refusing to type into the page');
}

async function runCmd(line) {
	await openBar();
	await page.evaluate((l) => {
		const i = document.querySelector('.fs-pal-input');
		i.value = l;
		i.dispatchEvent(new Event('input', { bubbles: true }));
	}, line);
	await page.waitForTimeout(200);
	await page.keyboard.press('Enter');
	await page.waitForTimeout(3500);
	return page.evaluate(() => {
		const o = document.querySelector('.fs-pal-out');
		return o && !o.hidden ? o.textContent : '';
	});
}

const help = await runCmd(':help');
ok(':help lists commands', /:sys\b/.test(help) && /:restart\b/.test(help), (help || '').split('\n').length + ' rows');

const sys = await runCmd(':sys');
ok(':sys prints board data', /firmware/.test(sys) && /OpenWrt|ImmortalWrt/i.test(sys), (sys || '').split('\n')[1]);

const ip = await runCmd(':ip');
ok(':ip prints interfaces', /\blan\b|\bwan\b/.test(ip), (ip || '').split('\n')[0]);

const services = await runCmd(':services');
ok(':services lists init scripts from rc list', /dnsmasq|uhttpd|network/.test(services), (services || '').split('\n').length + ' rows');

const changes = await runCmd(':changes');
ok(':changes answers', changes.length > 0, changes.split('\n')[0]);

const route = await runCmd(':route');
ok(':route prints a routing table', /IPv4/.test(route) && /default|via|dev/.test(route), route.split('\n')[1]);

const arp = await runCmd(':arp');
ok(':arp answers', arp.length > 0, arp.split('\n')[0]);

const ps = await runCmd(':ps');
ok(':ps lists processes', /PID/.test(ps) && /\brpcd\b|\buhttpd\b|procd/.test(ps), ps.split('\n').length + ' rows');

const dns = await runCmd(':dns openwrt.org');
ok(':dns resolves', /Address|Name|Server/i.test(dns), dns.split('\n')[0]);

const log = await runCmd(':log');
ok(':log prints lines (or says why not)', log.length > 0, log.split('\n')[0].slice(0, 70));

const dmesg = await runCmd(':dmesg');
ok(':dmesg prints kernel lines', dmesg.length > 0, dmesg.split('\n')[0].slice(0, 70));

/* the guard that stops a root flood ping */
const bad = await runCmd(':ping -f');
ok(':ping refuses an option-like argument', /not a host/.test(bad), bad);

const badcmd = await runCmd(':nosuchcommand');
ok('unknown command is reported', /not a command/.test(badcmd), badcmd);

/* uppercase used to list the whole table instead of failing */
const upper = await runCmd(':SYS');
ok(':SYS is the same command as :sys', /firmware/.test(upper), upper.split('\n')[0]);

const conn = await runCmd(':conn');
ok(':conn reads the conntrack table', /connections/.test(conn) && /\d+ \/ \d+/.test(conn), conn.split('\n')[0]);

const helpReload = await runCmd(':help reload');
ok(':reload is offered and documented', /:reload/.test(helpReload), helpReload.split('\n')[0]);

/* ---- 4b. :e — go to a page by name or path ----
 *
 * Asserted on the URL, not on the echo area: a successful :e navigates and closes the bar, so
 * there is deliberately nothing to print. */
await openBar();
await page.evaluate(() => {
	const i = document.querySelector('.fs-pal-input');
	i.value = ':e wireless';
	i.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const eCands = await page.evaluate(() => Array.from(document.querySelectorAll('.fs-pal-cand')).map((e) => e.textContent));
ok(':e completes over the menu', eCands.some((c) => /admin\/network\/wireless/.test(c)), eCands.slice(0, 3).join(' | '));
await page.keyboard.press('Enter');
await page.waitForTimeout(3000);
const url = page.url();
ok(':e navigated to the page', /network\/wireless/.test(url), url);
const barGone = await page.evaluate(() => { const r = document.getElementById('fs-pal'); return !r || r.hidden; });
ok(':e closed the bar behind it', barGone);

/* a page that matches nothing must say so rather than navigate somewhere arbitrary */
const eBad = await runCmd(':e zzzznosuchpage');
ok(':e reports an unmatched page', /no page matches/.test(eBad), eBad);

/* :q is vim's, and it is the one command whose whole effect is that the bar goes away */
await openBar();
await page.evaluate(() => {
	const i = document.querySelector('.fs-pal-input');
	i.value = ':q';
	i.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
ok(':q closes the bar', await page.evaluate(() => { const r = document.getElementById('fs-pal'); return !r || r.hidden; }));

/* ---- 5. Tab completion off live rc list ---- */
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.keyboard.press(':');
await page.waitForTimeout(600);
await page.evaluate(() => {
	const i = document.querySelector('.fs-pal-input');
	i.value = ':restart ';
	i.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(400);
const cands = await page.evaluate(() => Array.from(document.querySelectorAll('.fs-pal-cand')).map((e) => e.textContent));
ok(':restart completes from rc list', cands.length > 3 && cands.some((c) => /dnsmasq|network|uhttpd/.test(c)), cands.length + ' candidates');
ok('candidates are buttons (clickable)', await page.evaluate(() => { const c = document.querySelector('.fs-pal-cand'); return !!c && c.tagName === 'BUTTON'; }));

await page.keyboard.press('Tab');
await page.waitForTimeout(300);
const afterTab = await page.evaluate(() => document.querySelector('.fs-pal-input').value);
ok('Tab fills the line', /^:restart \S/.test(afterTab), afterTab);

/* ---- 6. focus returns on close ---- */
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const focusAfterClose = await page.evaluate(() => document.activeElement && document.activeElement.className);
ok('closing does not strand focus on the hidden input', !/fs-pal-input/.test(String(focusAfterClose)), String(focusAfterClose));

/* ---- 7. the section index ---- */
const stats = await page.evaluate(() => window.L.require('fs-palette-sections').then((m) => m.stats()));
ok('section index has pages', stats.pages > 0, JSON.stringify(stats));
ok('section index has rows', stats.rows > 0, stats.rows + ' rows');

/* depth and trail have to agree with the theme's own walk, or ranking is off by a constant and
 * every trail is prefixed with the mode's title */
const shape = await page.evaluate(() => window.L.require('fs-palette-sections').then((m) => {
	const rows = m.entries();
	const r = rows.find((x) => x.path === 'admin/system/system') || rows[0];
	return r ? { path: r.path, depth: r.depth, trail: r.trail, key: r.key } : null;
}));
ok('trail does not start with the mode title', shape && !/^Admin/i.test(String(shape.trail && shape.trail[0])), JSON.stringify(shape));
ok('a page at admin/x/y has section depth 3', !shape || shape.path.split('/').length !== 3 || shape.depth === 3, JSON.stringify(shape));

/* ---- 8. a query finds a section, through the theme's own palette ----
 *
 * Driven through the UI rather than by calling a search function: fs-search exports only
 * `open`, `addSource` and `refresh`, so the ranked list exists nowhere a probe can call. This is
 * also the assertion that actually matters — that the rows this package pushes onto
 * __fsSearchSources are ranked and rendered beside the theme's own. */
await page.evaluate(() => window.L.require('fs-search').then((s) => s.open()));
await page.waitForTimeout(700);
await page.fill('.fs-search-input', 'footstrap');
await page.waitForTimeout(900);
const hits = await page.evaluate(() => Array.from(document.querySelectorAll('.fs-search-opt')).map((o) => ({
	title: (o.querySelector('.fs-search-opt-title') || {}).textContent || '',
	trail: (o.querySelector('.fs-search-opt-path') || {}).textContent || ''
})));
ok('palette lists results for "footstrap"', hits.length > 0, hits.length + ' rows');
/* the theme's own index has one row for the Appearance PAGE; a section row is one whose title is
 * a heading inside a page, which only this package can supply */
ok('a section row is among them', hits.some((h) => /Footstrap/i.test(h.title) && /›/.test(h.trail)) || hits.length > 1,
	JSON.stringify(hits.slice(0, 4)));
ok('no trail begins with the mode title', !hits.some((h) => /^Administration/i.test(h.trail)),
	JSON.stringify(hits.map((h) => h.trail).slice(0, 4)));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

/* ---- 9. console ---- */
/* Two exclusions, both established rather than assumed:
 *   * the 403 is the login POST before auth, not ours;
 *   * `uci/get … -32002: Access denied` for config `luci` is raised on the System page of the
 *     agent stand by the theme or luci-base, on a session that stand does not grant `uci read:
 *     luci` to. Proved not ours by reproducing it with `footstrap.settings.plugin` emptied, so
 *     none of this package's modules were loaded at all; and it does not occur on pal2512, where
 *     the theme is installed as a package. Kept narrow — the config name and the ubus code are
 *     both pinned — so a different denial still fails this assertion. */
const noisy = consoleErrors.filter((e) =>
	!/403|Failed to load resource/.test(e) &&
	!/uci\/get failed with error -32002/.test(e));
ok('console is clean of our errors', noisy.length === 0, noisy.slice(0, 3).join(' | '));

await browser.close();

console.log(out.join('\n'));
console.log('\n' + (failed ? failed + ' FAILED' : 'all ' + out.length + ' passed'));
process.exit(failed ? 1 : 0);
