'use strict';
'require baseclass';
'require rpc';
'require ui';
'require fs';
'require fs-menutree as tree';
'require fs-prefs as prefs';
/* for `:e` only, and it costs nothing: fs-palette.js requires this module on every page already,
 * so by the time the first colon loads this one it is a resolved singleton. No cycle — sections
 * requires the theme's modules and never this one. */
'require fs-palette-sections as sections';

/* The command table, and nothing else. No UI: fs-palette-cmdline owns the bar, asks suggest() what
 * to offer for the line as typed and run() to execute it, and prints whatever comes back. Split
 * because the two change for different reasons — a command is added here, a key is bound there.
 *
 * Nothing here asks rpcd for a permission of its own. A command that acts is gated on a MENU NODE:
 * a node reaches the ACL-filtered /admin/menu blob iff the session holds the group its
 * `depends.acl` names, so `admin/system/reboot` present == `system.reboot` permitted and
 * `admin/system/startup` present == `rc list`/`rc init` permitted. A session without the group
 * never sees the command, and this package ships no acl.d of its own (see the Makefile).
 *
 * Every `needs` below was read off the shipped menu.d JSON rather than guessed; the pairing of a
 * node to the group that grants the object is what the whole design rests on, so it is checked
 * against luci's tree and not against memory:
 *
 *   admin/system/startup      luci-mod-system-init         rc list, rc init
 *   admin/system/reboot       luci-mod-system-reboot       system reboot
 *   admin/system/system       luci-mod-system-config       luci setLocaltime
 *   admin/network/diagnostics luci-mod-network-diagnostics /bin/ping, /bin/traceroute, nslookup
 *   admin/network/network     luci-mod-network-config      /sbin/ifup, /sbin/ifdown
 *   admin/network/wireless    luci-mod-network-config      /sbin/wifi
 *   admin/status/overview     luci-mod-status-index        system board, system info
 *   admin/status/logs         luci-mod-status-logs         log read, syslog-wrapper, /bin/dmesg -r
 *   admin/status/processes    luci-mod-status-processes    luci getProcessList, /bin/kill
 *   admin/status/routes       luci-mod-status-routes       /sbin/ip -[46] …
 *
 * `:ip` is the one command with no gate available: `network.interface dump` comes from
 * luci-base-network-status, which luci-base grants and which NO menu node names in its
 * depends.acl. There is nothing to test for, so it is offered to everyone and reports the denial
 * plainly if the session turns out not to hold it — see the `reject: true` note below.
 *
 * `reject: true` on every declaration that has an answer worth trusting. The default is to RESOLVE
 * with the ubus status code, which is how the log fallback used to be dead on arrival: with no
 * `log` object (logd replaced by syslog-ng) ubus returns a status, `expect: { log: [] }` coerces
 * it to an empty array, the promise resolves, and the reader is told the log is empty instead of
 * the wrapper being tried. The same default is why `:reboot!` could leave an unclosable "Rebooting"
 * modal over a router that never rebooted. */

const callRcList = rpc.declare({ object: 'rc', method: 'list', expect: { '': {} } });
/* not `reject`: a non-zero here is the init script's own exit status, which is the answer */
const callRcInit = rpc.declare({ object: 'rc', method: 'init', params: [ 'name', 'action' ] });
const callSysInfo = rpc.declare({ object: 'system', method: 'info', reject: true });
const callBoard = rpc.declare({ object: 'system', method: 'board', reject: true });
const callNetDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] }, reject: true });
const callLogRead = rpc.declare({ object: 'log', method: 'read', params: [ 'lines', 'stream', 'oneshot' ], expect: { log: [] }, reject: true });
const callReboot = rpc.declare({ object: 'system', method: 'reboot', reject: true });
const callProcList = rpc.declare({ object: 'luci', method: 'getProcessList', expect: { result: [] }, reject: true });
const callSetLocaltime = rpc.declare({ object: 'luci', method: 'setLocaltime', params: [ 'localtime' ], reject: true });

/* ---- what this session may do ------------------------------------------- */

/* The menu tree, not fs-search's index: the index is built by the module that requires THIS one,
 * and asking it back would be a require cycle. Both read the same ACL-filtered blob.
 *
 * `nodeForSegs` and never `resolveSegs`: an alias resolves somewhere else and would answer for a
 * permission the session may not hold. */
function reachable(path) {
	return !path || !!tree.nodeForSegs(path.split('/'));
}

/* `rc list` is fetched when this module is evaluated — that is already the first colon, and the
 * round trip is usually over before anyone finishes typing `:resta`. USUALLY is not a contract: on
 * a busy router it is not, and a `:restart dnsmasq` submitted first would have been answered "no
 * init script named dnsmasq", which is a lie rather than a delay. So run() waits on this, and the
 * bar re-renders its candidates when it settles (fs-palette-cmdline calls back on `ready`).
 * suggest() stays synchronous, because it is called on every keystroke. */
let _svc = {};
const ready = reachable('admin/system/startup')
	? callRcList().then((r) => { _svc = r || {}; }).catch(() => {})
	: Promise.resolve();

function serviceNames() {
	return Object.keys(_svc).sort();
}
function serviceHint(name) {
	const s = _svc[name] || {};
	return (s.enabled ? _('enabled') : _('disabled')) + (s.running ? ' · ' + _('running') : '');
}

/* ---- output formatting -------------------------------------------------- */

function pad(s, n) {
	s = String(s == null ? '' : s);
	return s + ' '.repeat(Math.max(0, n - s.length));
}

function duration(sec) {
	sec = Math.max(0, parseInt(sec) || 0);
	const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
	return (d ? d + 'd ' : '') + (d || h ? h + 'h ' : '') + m + 'm';
}

function mib(bytes) {
	const n = parseInt(bytes);
	return (isNaN(n) ? 0 : Math.round(n / 1048576)) + ' MB';
}

/* Everything an operator types lands in argv, never in a shell, so there is no quoting to get
 * wrong. What there IS: rpcd execs these as root, and a bare argument that begins with `-` is read
 * by the tool as an OPTION. `:ping -f` would be a root flood ping of the router's own uplink.
 * Refusing the whole class is one line and costs nothing legitimate — no hostname, interface,
 * process id or search string starts with a dash. */
function optionLike(arg) {
	return (/^-/.test(String(arg || '')));
}

/* stdout, or stderr, or a plain statement that the tool said nothing — never an empty bar, which
 * reads as the command not having run. */
function output(r) {
	const s = String((r && (r.stdout || r.stderr)) || '').trim();
	return s || _('no output');
}

/* One shape for every diagnostic that is "run a tool, print what it said". */
function execTool(bin, args) {
	return fs.exec(bin, args).then(output);
}

/* ---- the commands ------------------------------------------------------- */

/* Each entry: `needs` is the menu path that both gates and documents the permission. `complete`
 * offers argument rows, synchronously. `free` means the argument is typed rather than chosen.
 * `run` returns a string, a promise of one, or one of { nav: segs } / null for "no output". */

const SETTINGS = {
	dark: () => prefs.applyMode('dark'),
	light: () => prefs.applyMode('light'),
	auto: () => prefs.applyMode('auto'),
	rail: () => prefs.applyRail(true),
	norail: () => prefs.applyRail(false),
	top: () => prefs.applyLayout('top'),
	sidebar: () => prefs.applyLayout('sidebar'),
	compact: () => prefs.applyDensity('compact'),
	normal: () => prefs.applyDensity('normal'),
	large: () => prefs.applyDensity('large')
};

function setOption(arg) {
	if (!arg) {
		return [
			pad(_('mode'), 10) + prefs.currentMode(),
			pad(_('density'), 10) + prefs.currentDensity(),
			pad(_('layout'), 10) + prefs.currentLayout(),
			pad(_('rail'), 10) + (prefs.currentRail() ? _('on') : _('off'))
		].join('\n');
	}
	const fn = SETTINGS[arg];
	if (!fn) return _('unknown option "%s"').format(arg);
	fn();
	return null;
}

function serviceAction(action) {
	return (arg) => {
		if (!arg) return _('which service?');
		if (!(arg in _svc)) return _('no init script named "%s"').format(arg);
		return callRcInit(arg, action).then((code) => {
			/* `code` is the UBUS status of the call, not the init script's exit status, so it is
			 * printed as the text ubus gives it rather than as a bare number that reads like one
			 * of the script's own. */
			if (code) return _('%s %s: %s').format(action, arg, rpc.getStatusText(code));
			return _('%s: %s ok').format(arg, action);
		});
	};
}

function listServices() {
	const names = serviceNames();
	if (!names.length) return _('no init scripts (or rc list is not permitted)');
	return names.map((n) => pad(n, 20) + serviceHint(n)).join('\n');
}

function interfaces() {
	return callNetDump().then((list) => {
		const rows = (list || []).filter((i) => i.interface !== 'loopback').map((i) => {
			const a = (i['ipv4-address'] || [])[0];
			const gw = (i.route || []).filter((r) => r.target === '0.0.0.0' && r.mask === 0)[0];
			return pad(i.interface, 12) + pad(i.up ? _('up') : _('down'), 6)
				+ pad(a ? a.address + '/' + a.mask : '-', 20)
				+ pad(gw ? 'gw ' + gw.nexthop : '', 20)
				+ pad(i.proto, 10) + (i.up ? duration(i.uptime) : '');
		});
		return rows.length ? rows.join('\n') : _('no interfaces');
	});
}

/* The names `:ifup`/`:ifdown` complete over, and the only list either needs. `network.interface
 * dump` is already fetched for `:ip`, so this adds no round trip of its own — but it is a
 * DIFFERENT grant from the one that runs ifup, which is why the two are gated apart. */
let _ifaces = [];

function ifaceComplete(p) {
	return _ifaces.filter((n) => n.indexOf(p) === 0).map((n) => ({ value: n }));
}

function warmInterfaces() {
	if (!reachable('admin/network/network')) return;
	callNetDump().then((list) => {
		_ifaces = (list || []).map((i) => i.interface).filter((n) => n && n !== 'loopback').sort();
	}).catch(() => {});
}

function ifAction(bin) {
	return (arg) => {
		if (!arg) return _('which interface?');
		if (optionLike(arg)) return _('not an interface name: %s').format(arg);
		return execTool(bin, [ arg ]).then((txt) => (txt === _('no output') ? _('%s: ok').format(arg) : txt));
	};
}

const WIFI_ACTIONS = [ 'up', 'down', 'reload', 'status' ];

function wifi(arg) {
	const a = arg || 'reload';
	if (WIFI_ACTIONS.indexOf(a) < 0) return _('unknown action "%s" — one of: %s').format(a, WIFI_ACTIONS.join(' '));
	return execTool('/sbin/wifi', [ a ]);
}

function sysinfo() {
	return Promise.all([ callBoard(), callSysInfo() ]).then(([ b, i ]) => {
		const load = (i.load || []).map((n) => (n / 65536).toFixed(2)).join(' ');
		const mem = i.memory || {};
		return [
			/* a container stand fills in `system` and leaves `model` empty */
			pad(_('model'), 12) + (b.model || b.system || '?'),
			pad(_('firmware'), 12) + ((b.release || {}).description || '?'),
			pad(_('kernel'), 12) + (b.kernel || '?'),
			pad(_('uptime'), 12) + duration(i.uptime),
			pad(_('load'), 12) + load,
			pad(_('memory'), 12) + mib(mem.total - mem.available) + ' / ' + mib(mem.total)
		].join('\n');
	});
}

const LOG_LINES = 40;

function keepLines(lines, filter) {
	/* Blank lines are dropped before anything else. `split(/\n/)` on an empty body yields `['']`,
	 * which is one line by every count below — the bar then printed a single empty string, and an
	 * empty echo area is hidden, so the command looked as though it had never run. */
	let out = lines.filter((l) => String(l || '').trim() !== '');
	if (filter) out = out.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
	out = out.slice(-LOG_LINES);
	if (out.length) return out.join('\n');
	return filter ? _('nothing in the log matches "%s"').format(filter) : _('the log is empty');
}

function logTail(filter) {
	return callLogRead(200, false, true)
		.then((rows) => keepLines((rows || []).map((r) => r.msg || ''), filter))
		/* ubus `log` is absent when logd was replaced by syslog-ng or rsyslog; the wrapper is what
		 * luci-mod-status falls back to, under the same ACL. Reached only because the declaration
		 * carries `reject: true` — without it the missing object resolves as an empty log. */
		.catch(() => fs.exec_direct('/usr/libexec/syslog-wrapper')
			.then((txt) => keepLines(String(txt || '').trim().split(/\n/), filter)));
}

function dmesg(filter) {
	/* the ACL pattern is `/bin/dmesg -r`, matched as a whole command line: the argument is not
	 * ours to choose */
	return fs.exec('/bin/dmesg', [ '-r' ]).then((r) => {
		/* dmesg exits 0 with an empty stdout and its complaint on STDERR when the kernel ring
		 * buffer is not readable — `klogctl: Operation not permitted`, which is what an
		 * unprivileged container and a hardened kernel (dmesg_restrict=1) both give. Reading only
		 * stdout turned that into "the log is empty", which sends the reader looking for a missing
		 * log rather than at a permission. */
		const raw = String((r && r.stdout) || '').trim();
		if (!raw) return output(r);
		/* `-r` prefixes each line with its raw syslog priority, `<4>` and friends; the number is
		 * noise for a reader who asked for the tail of the log */
		return keepLines(raw.split(/\n/).map((l) => l.replace(/^<\d+>/, '')), filter);
	});
}

function ping(arg) {
	if (!arg) return _('which host?');
	if (optionLike(arg)) return _('not a host: %s').format(arg);
	return execTool('/bin/ping', [ '-4', '-c', '3', '-W', '1', arg ]);
}

function traceroute(arg) {
	if (!arg) return _('which host?');
	if (optionLike(arg)) return _('not a host: %s').format(arg);
	return execTool('/bin/traceroute', [ '-4', '-q', '1', '-w', '2', arg ]);
}

function nslookup(arg) {
	if (!arg) return _('which name?');
	if (optionLike(arg)) return _('not a name: %s').format(arg);
	return execTool('/usr/bin/nslookup', [ arg ]);
}

/* Both halves of the routes ACL are exact command-line patterns —
 * `/sbin/ip -[46] route show table all` and `/sbin/ip -[46] neigh show` — so the arguments are
 * fixed and a "nicer" variation is simply denied by rpcd. */
function ipShow(what) {
	return () => Promise.all([
		fs.exec('/sbin/ip', [ '-4' ].concat(what)).catch(() => null),
		fs.exec('/sbin/ip', [ '-6' ].concat(what)).catch(() => null)
	]).then(([ v4, v6 ]) => {
		const out = [];
		const add = (label, r) => {
			const s = String((r && r.stdout) || '').trim();
			if (s) out.push(label, s);
		};
		add('IPv4', v4);
		add('IPv6', v6);
		return out.length ? out.join('\n') : _('no output');
	});
}

function processes() {
	return callProcList().then((list) => {
		const rows = (list || []).slice()
			.sort((a, b) => (parseFloat(b['%CPU']) || 0) - (parseFloat(a['%CPU']) || 0))
			.slice(0, LOG_LINES)
			.map((p) => pad(p.PID, 8) + pad(p.USER, 10) + pad(p['%CPU'], 6) + pad(p['%MEM'], 6) + p.COMMAND);
		if (!rows.length) return _('no processes');
		return [ pad(_('PID'), 8) + pad(_('USER'), 10) + pad(_('CPU'), 6) + pad(_('MEM'), 6) + _('COMMAND') ]
			.concat(rows).join('\n');
	});
}

/* TERM by default and KILL on the bang, the same two signals the Processes page offers. The pid is
 * checked here rather than left to the tool: `/bin/kill` is granted with no argument pattern, so
 * an unchecked argument is the one place in this table where a typo could reach a signal spec. */
function kill(arg, bang) {
	if (!arg) return _('which pid?');
	if (!(/^\d+$/.test(String(arg)))) return _('not a pid: %s').format(arg);
	return execTool('/bin/kill', [ bang ? '-9' : '-15', String(arg) ])
		.then((txt) => (txt === _('no output') ? _('%s: signalled').format(arg) : txt));
}

/* ---- going to a page by name ----
 *
 * `:e` is vim's, and it is the one command that needs no permission of its own in any sense: the
 * page list IS the ACL-filtered menu, so a page the session may not open is not in it to complete.
 *
 * Completion matches the PATH and the TITLE both, because an admin knows a page by one or the
 * other and rarely by the same one twice — `:e wireless` and `:e admin/network/wireless` reach the
 * same row. Ranked path-prefix first, then title-prefix, then anything containing the text, so the
 * exact thing typed does not sit under a substring match. */
function pageRows(p) {
	const q = String(p || '').toLowerCase();
	const all = sections.pages();
	if (!q) return all.slice(0, 40).map(pageRow);
	const rank = (j) => {
		const path = j.path.toLowerCase(), title = j.title.toLowerCase();
		if (path === q || title === q) return 0;
		if (path.indexOf(q) === 0) return 1;
		if (title.indexOf(q) === 0) return 2;
		if (path.indexOf(q) >= 0 || title.indexOf(q) >= 0) return 3;
		return 9;
	};
	return all.map((j) => ({ j: j, r: rank(j) }))
		.filter((x) => x.r < 9)
		.sort((a, b) => a.r - b.r)
		.slice(0, 40)
		.map((x) => pageRow(x.j));
}

function pageRow(j) {
	return { value: j.path, hint: j.trail.concat([ j.title ]).join(' › ') };
}

function edit(arg) {
	if (!arg) return _('which page?');
	const rows = pageRows(arg);
	if (!rows.length) return _('no page matches "%s"').format(arg);
	/* the same ranking the candidates were offered in, so Enter on a typed line goes where the
	 * first candidate said it would */
	return { nav: rows[0].value.split('/') };
}

/* The conntrack table, from the two /proc files luci-mod-status-index already grants a read on —
 * the same pair the Status page's network box reads. No new grant, and it is the one number that
 * says whether a router is about to start dropping connections. */
function conntrack() {
	return Promise.all([
		fs.trimmed('/proc/sys/net/netfilter/nf_conntrack_count'),
		fs.trimmed('/proc/sys/net/netfilter/nf_conntrack_max')
	]).then(([ c, m ]) => {
		const cur = parseInt(c) || 0, max = parseInt(m) || 0;
		if (!max) return _('the conntrack table is not readable here');
		return pad(_('connections'), 14) + cur + ' / ' + max + '  (' + Math.round(cur * 100 / max) + '%)';
	});
}

function setTime() {
	return callSetLocaltime(Math.floor(Date.now() / 1000))
		.then(() => _("the router's clock is now this browser's"));
}

/* The unsaved changeset, from the singleton the banner already keeps. No RPC and no new grant: if
 * this session may see the page, it may see what it has changed on it. */
function changes() {
	const all = (ui.changes && ui.changes.changes) || {};
	const out = [];
	for (const config of Object.keys(all).sort()) {
		for (const c of (all[config] || [])) {
			const op = c[0], rest = c.slice(1).filter((x) => x != null && x !== '');
			out.push(pad(op, 10) + config + (rest.length ? '.' + rest.join('.') : ''));
		}
	}
	if (!out.length) return _('nothing to apply');
	return out.join('\n') + '\n\n' + _('%d change(s) — :apply to commit, :revert to drop').format(out.length);
}

function reboot(arg, bang) {
	if (!bang) return _('this reboots the router now — run :reboot! to confirm');
	/* The modal goes up only after ubus has ACCEPTED the call. `reject: true` is what makes that
	 * possible: with the default the promise resolves on a refusal too, and the reader would be
	 * left looking at an "Waiting for device…" spinner, with no way to dismiss it, over a router
	 * that is not rebooting. */
	return callReboot().then(() => {
		ui.showModal(_('Rebooting…'), [ E('p', { 'class': 'spinning' }, _('Waiting for device…')) ]);
		ui.awaitReconnect();
		return null;
	});
}

const svcComplete = (p) => serviceNames().filter((n) => n.indexOf(p) === 0).map((n) => ({ value: n, hint: serviceHint(n) }));

const COMMANDS = [
	{ name: 'restart', arg: 'service', needs: 'admin/system/startup', help: _('restart an init script'),
	  complete: svcComplete, run: serviceAction('restart') },
	{ name: 'start', arg: 'service', needs: 'admin/system/startup', help: _('start an init script'),
	  complete: svcComplete, run: serviceAction('start') },
	{ name: 'stop', arg: 'service', needs: 'admin/system/startup', help: _('stop an init script'),
	  complete: svcComplete, run: serviceAction('stop') },
	{ name: 'enable', arg: 'service', needs: 'admin/system/startup', help: _('enable at boot'),
	  complete: svcComplete, run: serviceAction('enable') },
	{ name: 'disable', arg: 'service', needs: 'admin/system/startup', help: _('disable at boot'),
	  complete: svcComplete, run: serviceAction('disable') },
	{ name: 'reload', arg: 'service', needs: 'admin/system/startup', help: _('reload an init script'),
	  complete: svcComplete, run: serviceAction('reload') },
	{ name: 'services', needs: 'admin/system/startup', help: _('every init script and its state'),
	  run: listServices },

	{ name: 'ip', help: _('interface addresses, gateway and uptime'), run: interfaces },
	{ name: 'ifup', arg: 'interface', needs: 'admin/network/network', help: _('bring an interface up'),
	  complete: ifaceComplete, run: ifAction('/sbin/ifup') },
	{ name: 'ifdown', arg: 'interface', needs: 'admin/network/network', help: _('take an interface down'),
	  complete: ifaceComplete, run: ifAction('/sbin/ifdown') },
	{ name: 'wifi', arg: 'action', needs: 'admin/network/wireless', help: _('reload, up, down or status; bare :wifi reloads'),
	  complete: (p) => WIFI_ACTIONS.filter((a) => a.indexOf(p) === 0).map((v) => ({ value: v })),
	  run: wifi },

	{ name: 'sys', needs: 'admin/status/overview', help: _('model, firmware, uptime, load, memory'), run: sysinfo },
	{ name: 'conn', needs: 'admin/status/overview', help: _('conntrack entries against the table size'),
	  run: conntrack },
	{ name: 'log', arg: 'filter', free: true, needs: 'admin/status/logs',
	  help: _('the last 40 matching log lines'), run: logTail },
	{ name: 'dmesg', arg: 'filter', free: true, needs: 'admin/status/logs',
	  help: _('the last 40 matching kernel messages'), run: dmesg },
	{ name: 'ps', needs: 'admin/status/processes', help: _('the 40 busiest processes'), run: processes },
	{ name: 'kill', arg: 'pid', free: true, bang: _('SIGKILL instead of SIGTERM'),
	  needs: 'admin/status/processes', help: _('signal a process'), run: kill },
	{ name: 'route', needs: 'admin/status/routes', help: _('the routing table, v4 and v6'),
	  run: ipShow([ 'route', 'show', 'table', 'all' ]) },
	{ name: 'arp', needs: 'admin/status/routes', help: _('the neighbour table, v4 and v6'),
	  run: ipShow([ 'neigh', 'show' ]) },

	{ name: 'ping', arg: 'host', free: true, needs: 'admin/network/diagnostics', help: _('ping a host'),
	  run: ping },
	{ name: 'trace', arg: 'host', free: true, needs: 'admin/network/diagnostics',
	  help: _('traceroute to a host'), run: traceroute },
	{ name: 'dns', arg: 'name', free: true, needs: 'admin/network/diagnostics',
	  help: _('resolve a name'), run: nslookup },

	{ name: 'time', needs: 'admin/system/system', help: _("set the router's clock from this browser"),
	  run: setTime },

	{ name: 'set', arg: 'option', help: _('appearance axes; bare :set prints them'),
	  complete: (p) => Object.keys(SETTINGS).filter((k) => k.indexOf(p) === 0).map((v) => ({ value: v })),
	  run: setOption },
	/* Kept here rather than beside `:enable`, which shares its prefix, because the table's order is
	 * what `:help` prints and these three are the navigation group. A bare `:e` therefore lists
	 * `:enable` first; one more keystroke — the space — settles it, because a line with a gap is
	 * looked up by exact name and never by prefix. */
	{ name: 'e', arg: 'page', free: true, help: _('go to a page by name or path'),
	  complete: pageRows, run: edit },
	{ name: 'q', help: _('close the command line'), run: () => null },
	{ name: 'back', help: _('the previously visited page'), run: () => {
		/* A recents entry is a key, and a section's key is `<page path>#<heading>` — navigating to
		 * that string verbatim would ask the dispatcher for a node named `system#Footstrap`. The
		 * page half is where `:back` goes; the section it names is on it. */
		const here = (L.env.dispatchpath || []).join('/');
		const prev = prefs.lsGetArr('fs-recent')
			.filter((x) => typeof x === 'string')
			.map((k) => (k.indexOf('#') < 0 ? k : k.slice(0, k.indexOf('#'))))
			.filter((p) => p !== here)[0];
		return prev ? { nav: prev.split('/') } : _('no previous page yet');
	} },

	{ name: 'changes', help: _('the unsaved changes, as uci commands'), run: changes },
	{ name: 'apply', bang: _('skip the connectivity check'), help: _('apply the unsaved changes'),
	  /* ui.changes is luci-base's own singleton: the same path the Unsaved-changes banner runs */
	  run: (a, bang) => { ui.changes.apply(!bang); return null; } },
	{ name: 'revert', help: _('drop the unsaved changes'), run: () => { ui.changes.revert(); return null; } },
	{ name: 'reboot', bang: _('no confirmation'), needs: 'admin/system/reboot', help: _('reboot the router'),
	  run: reboot },

	/* Last in the table and first in the list a bare `:` shows, because it is the only row that
	 * explains the others. The help text lives on each command and was until now visible only
	 * while completing one — an operator who did not already know a name could not find it. */
	{ name: 'help', arg: 'command', help: _('every command this session may run'),
	  complete: (p) => visible().filter((c) => c.name.indexOf(p) === 0).map((c) => ({ value: c.name, hint: c.help })),
	  run: help }
];

function help(arg) {
	const rows = visible().filter((c) => !arg || c.name === arg);
	if (!rows.length) return _('not a command: %s').format(arg);
	return rows.map((c) => {
		const sig = ':' + c.name + (c.arg ? ' {' + c.arg + '}' : '');
		return pad(sig, 20) + c.help + (c.bang ? '  ·  ! ' + c.bang : '');
	}).join('\n');
}

function visible() {
	return COMMANDS.filter((c) => reachable(c.needs));
}

function lookup(name) {
	return visible().filter((c) => c.name === name)[0] || null;
}

/* one parse for suggesting and for running, so what a row offers is what Enter does.
 *
 * The name is lower-cased rather than matched case-sensitively: `[a-z]*` against `:REST` matched
 * the EMPTY string, which made `p.gap` false and listed the whole table as if nothing had been
 * typed. */
const LINE = /^([a-zA-Z]*)(!?)(\s+)?([\s\S]*)$/;

function parse(rest) {
	const m = LINE.exec(String(rest || '').replace(/^\s+/, ''));
	return m ? { name: m[1].toLowerCase(), bang: m[2] === '!', gap: !!m[3], arg: (m[4] || '').trim() } : null;
}

/* ---- what the palette lists --------------------------------------------- */

/* A row is { line, title, hint } — `line` is what the input becomes when the row is taken. A
 * command that still needs an argument offers a line ending in a space, so taking it completes
 * rather than runs; the run itself is guarded by each command's own "which service?" answer, which
 * is the check that actually holds when the line was typed rather than chosen. */
function suggest(rest) {
	const p = parse(rest);
	if (!p) return [];
	const bang = p.bang ? '!' : '';

	if (!p.gap) {
		return visible().filter((c) => c.name.indexOf(p.name) === 0).map((c) => ({
			line: ':' + c.name + bang + (c.arg ? ' ' : ''),
			title: ':' + c.name + bang + (c.arg ? ' {' + c.arg + '}' : ''),
			hint: c.help + (c.bang && !p.bang ? ' · ! ' + c.bang : '')
		}));
	}

	const cmd = lookup(p.name);
	if (!cmd) return [];

	const rows = (cmd.complete ? cmd.complete(p.arg) : []).map((c) => ({
		line: ':' + cmd.name + bang + ' ' + c.value,
		title: ':' + cmd.name + bang + ' ' + c.value,
		hint: c.hint || cmd.help
	}));
	/* a typed argument no candidate matches is still an argument when the command takes free text
	 * (`:ping 8.8.8.8`), and `:set` with nothing typed still runs — it prints the axes */
	if (!rows.length && (cmd.free || !cmd.complete || !p.arg)) {
		rows.push({
			line: ':' + cmd.name + bang + (p.arg ? ' ' + p.arg : ''),
			title: ':' + cmd.name + bang + (p.arg ? ' ' + p.arg : ''),
			hint: cmd.help
		});
	}
	return rows;
}

/* Runs a full line (with or without its colon). Resolves to a string to print, null for nothing,
 * or { nav: segs } for "the palette should navigate there".
 *
 * Behind `ready`, so a command submitted before `rc list` has answered is held rather than
 * answered wrongly. Everything that does not depend on it is already resolved by then. */
function run(line) {
	return ready.then(() => {
		const p = parse(String(line || '').replace(/^:/, ''));
		const cmd = p && lookup(p.name);
		if (!cmd) return _('not a command: %s').format(p ? p.name : line);
		return cmd.run(p.arg, p.bang);
	}).catch((e) => String((e && e.message) || e));
}

warmInterfaces();

return baseclass.extend({
	ready,
	suggest,
	run
});
