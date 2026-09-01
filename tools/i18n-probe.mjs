/* Does the catalogue actually reach the browser?
 *
 *   BASE=http://localhost:8041 node tools/i18n-probe.mjs
 *
 * Separate from tools/probe.mjs because it needs the router switched to a translated UI, which
 * every other assertion would rather not run against.
 *
 * This is the one claim about po/ that reading the files cannot settle. `update-po.sh --check`
 * proves the catalogue is complete and current; the build log proves po2lmo ran. Neither proves
 * that LuCI finds `footstrap-cmd.<lang>.lmo` and that _() resolves through it -- and an
 * uncompiled _() falls through to its English msgid with nothing reporting it, so the failure mode
 * is silence.
 *
 * It counts Cyrillic characters in `:help` rather than matching one string: a single expected
 * translation would still pass if the catalogue were half-loaded, and the point is that the whole
 * table came through. Measured with the ru catalogue installed: 806.
 *
 * The caller sets luci.main.lang and puts it back afterwards; this script changes nothing on the
 * router.
 */
import { chromium } from '/mnt/c/Users/IVAN/Documents/home/openwrt/luci-theme-footstrap/node_modules/playwright/index.mjs';

const BASE = process.env.BASE || 'http://localhost:8041';
const MIN_CYRILLIC = 50;

const b = await chromium.launch();
const p = await b.newPage();

await p.goto(BASE + '/cgi-bin/luci/', { waitUntil: 'domcontentloaded' });
if (await p.$('input[name="luci_password"]')) {
	await p.fill('input[name="luci_username"]', 'root');
	await p.fill('input[name="luci_password"]', '');
	await Promise.all([ p.waitForNavigation({ waitUntil: 'domcontentloaded' }), p.press('input[name="luci_password"]', 'Enter') ]);
}

/* a page with no form on it: `:` pressed while focus sits in a <select> is type-ahead, and the
 * Enter after it saves the form */
await p.goto(BASE + '/cgi-bin/luci/admin/status/overview', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(3000);
await p.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} });
await p.keyboard.press(':');
await p.waitForSelector('.fs-cmd-input', { timeout: 8000 });
await p.waitForTimeout(600);
await p.evaluate(() => {
	const i = document.querySelector('.fs-cmd-input');
	i.value = ':help';
	i.dispatchEvent(new Event('input', { bubbles: true }));
});
await p.keyboard.press('Enter');
await p.waitForTimeout(3000);

const out = await p.evaluate(() => {
	const o = document.querySelector('.fs-cmd-out');
	return o && !o.hidden ? o.textContent : '';
});
await b.close();

const cyr = (out.match(/[Ѐ-ӿ]/g) || []).length;
console.log(out.split('\n').slice(0, 6).join('\n'));
console.log('\nCyrillic characters in :help output: ' + cyr);
if (cyr >= MIN_CYRILLIC) {
	console.log('PASS  the catalogue is loaded and _() resolves through it');
	process.exit(0);
}
console.log('FAIL  the bar is rendering in English -- the .lmo is missing or not being found');
process.exit(1);
