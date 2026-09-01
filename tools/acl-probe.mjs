/* Does a restricted session actually see fewer commands?
 *
 * Driven by tools/acl-gate.sh, which creates the login and removes it again. Run that, not this.
 *
 * The whole design rests on this and nothing else checked it: this package ships no acl.d, and
 * every acting command is offered only when the menu node carrying the ACL group that grants it is
 * reachable. Every other test runs as root, where every node is reachable — so the gate could be,
 * and for a while was, wired to a condition that is always true.
 *
 * What it caught: `/admin/menu` is NOT a pre-filtered tree. It carries every node and marks the
 * ones the session may reach with `satisfied`. Testing presence alone answered "yes" for all of
 * them, and the bar offered `:restart`, `:ifup`, `:wifi` and the rest to a session holding none of
 * their groups. Nothing could be executed that way — rpcd refuses the call regardless — but the
 * README promises a restricted account sees fewer commands, and it did not.
 *
 * The login holds luci-base, the theme and luci-mod-status-index, so the expected split is exact
 * rather than approximate: everything gated on a system, network or other status group must be
 * gone, and the ungated commands plus `:sys`/`:conn` must remain.
 */
import { chromium } from '/mnt/c/Users/IVAN/Documents/home/openwrt/luci-theme-footstrap/node_modules/playwright/index.mjs';
const BASE = process.env.BASE || 'http://localhost:8040';
const USER = process.env.USER_NAME || 'viewer';

const b = await chromium.launch();
const p = await b.newPage();
await p.goto(BASE + '/cgi-bin/luci/', { waitUntil: 'domcontentloaded' });
await p.fill('input[name="luci_username"]', USER);
await p.fill('input[name="luci_password"]', '');
await p.press('input[name="luci_password"]', 'Enter');
await p.waitForTimeout(5000);
/* the session-expiry toast the stand shows on a fresh restricted login covers the page; dismiss
 * it so a stray click target cannot swallow the colon */
await p.evaluate(() => { document.querySelectorAll('.alert-message, .notification').forEach((n) => n.remove()); });
console.log('landed on:', p.url());

await p.evaluate(() => { try { document.activeElement && document.activeElement.blur(); } catch (e) {} });
await p.keyboard.press(':');
await p.waitForSelector('.fs-pal-input', { timeout: 8000 });
await p.waitForTimeout(800);
await p.evaluate(() => { const i = document.querySelector('.fs-pal-input'); i.value = ':help'; i.dispatchEvent(new Event('input', { bubbles: true })); });
await p.keyboard.press('Enter');
await p.waitForTimeout(3000);
const out = await p.evaluate(() => { const o = document.querySelector('.fs-pal-out'); return o && !o.hidden ? o.textContent : ''; });
const shown = (out.match(/^:([a-z]+)/gm) || []).map((x) => x.slice(1)).sort();
await b.close();

const ALL = ['apply','arp','back','changes','conn','disable','dmesg','dns','e','enable','help','ifdown','ifup','ip','kill','log','ping','ps','q','reboot','reload','restart','revert','route','services','set','start','stop','sys','time','trace','wifi'];
const hidden = ALL.filter((c) => !shown.includes(c));
console.log('\nvisible (' + shown.length + '):', shown.join(' '));
console.log('hidden  (' + hidden.length + '):', hidden.join(' '));

const MUST_HIDE = ['reboot','restart','stop','disable','enable','start','reload','services','ping','trace','dns','ifup','ifdown','wifi','log','dmesg','ps','kill','route','arp','time'];
const MUST_SHOW = ['help','e','q','set','back','changes','apply','revert','ip','sys','conn'];
const leaked = MUST_HIDE.filter((c) => shown.includes(c));
const missing = MUST_SHOW.filter((c) => !shown.includes(c));
console.log('\nleaked (should be hidden):', leaked.length ? leaked.join(' ') : 'none');
console.log('missing (should be shown):', missing.length ? missing.join(' ') : 'none');
const okAll = leaked.length === 0 && missing.length === 0;
console.log(okAll ? 'PASS  the gate holds' : 'FAIL');
process.exit(okAll ? 0 : 1);
