'use strict';
'require baseclass';
'require rpc';
'require ui';
'require fs';
'require fs-menutree as tree';
'require fs-prefs as prefs';

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
 * Prototype limits, deliberate: the strings are bare English until the command set settles, and
 * the table is a constant rather than something a third package could extend. */

const callRcList = rpc.declare({ object: 'rc', method: 'list', expect: { '': {} } });
const callRcInit = rpc.declare({ object: 'rc', method: 'init', params: [ 'name', 'action' ] });
const callSysInfo = rpc.declare({ object: 'system', method: 'info' });
const callBoard = rpc.declare({ object: 'system', method: 'board' });
const callNetDump = rpc.declare({ object: 'network.interface', method: 'dump', expect: { interface: [] } });
const callLogRead = rpc.declare({ object: 'log', method: 'read', params: [ 'lines', 'stream', 'oneshot' ], expect: { log: [] } });
const callReboot = rpc.declare({ object: 'system', method: 'reboot' });

/* ---- what this session may do ------------------------------------------- */

/* The menu tree, not fs-search's index: the index is built by the module that requires THIS one,
 * and asking it back would be a require cycle. Both read the same ACL-filtered blob. */
function reachable(path) {
	return !path || !!tree.nodeForSegs(path.split('/'));
}

/* `rc list` is fetched when this module is evaluated — that is already the first colon, and the
 * round trip is over before anyone finishes typing `:resta`. Suggestions stay synchronous; the
 * palette re-renders once `ready` settles. */
let _svc = {};
const ready = reachable('admin/system/startup')
	? callRcList().then((r) => { _svc = r || {}; }).catch(() => {})
	: Promise.resolve();

function serviceNames() {
	return Object.keys(_svc).sort();
}
function serviceHint(name) {
	const s = _svc[name] || {};
	return (s.enabled ? 'enabled' : 'disabled') + (s.running ? ' · running' : '');
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
	return Math.round((parseInt(bytes) || 0) / 1048576) + ' MB';
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
			pad('mode', 10) + prefs.currentMode(),
			pad('density', 10) + prefs.currentDensity(),
			pad('layout', 10) + prefs.currentLayout(),
			pad('rail', 10) + (prefs.currentRail() ? 'on' : 'off')
		].join('\n');
	}
	const fn = SETTINGS[arg];
	if (!fn) return 'unknown option "' + arg + '"';
	fn();
	return null;
}

function serviceAction(action) {
	return (arg) => {
		if (!arg) return 'which service?';
		if (!(arg in _svc)) return 'no init script named "' + arg + '"';
		return callRcInit(arg, action).then((code) => {
			if (code) return action + ' ' + arg + ': exit ' + code;
			return arg + ': ' + action + ' ok';
		});
	};
}

function listServices() {
	const names = serviceNames();
	if (!names.length) return 'no init scripts (or rc list is not permitted)';
	return names.map((n) => pad(n, 20) + serviceHint(n)).join('\n');
}

function interfaces() {
	return callNetDump().then((list) => {
		const rows = (list || []).filter((i) => i.interface !== 'loopback').map((i) => {
			const a = (i['ipv4-address'] || [])[0];
			const gw = (i.route || []).filter((r) => r.target === '0.0.0.0' && r.mask === 0)[0];
			return pad(i.interface, 12) + pad(i.up ? 'up' : 'down', 6)
				+ pad(a ? a.address + '/' + a.mask : '-', 20)
				+ pad(gw ? 'gw ' + gw.nexthop : '', 20)
				+ pad(i.proto, 10) + (i.up ? duration(i.uptime) : '');
		});
		return rows.length ? rows.join('\n') : 'no interfaces';
	});
}

function sysinfo() {
	return Promise.all([ callBoard(), callSysInfo() ]).then(([ b, i ]) => {
		const load = (i.load || []).map((n) => (n / 65536).toFixed(2)).join(' ');
		const mem = i.memory || {};
		return [
			/* a container stand fills in `system` and leaves `model` empty */
			pad('model', 12) + (b.model || b.system || '?'),
			pad('firmware', 12) + ((b.release || {}).description || '?'),
			pad('kernel', 12) + (b.kernel || '?'),
			pad('uptime', 12) + duration(i.uptime),
			pad('load', 12) + load,
			pad('memory', 12) + mib(mem.total - mem.available) + ' / ' + mib(mem.total)
		].join('\n');
	});
}

function logTail(filter) {
	const keep = (lines) => {
		let out = lines;
		if (filter) out = out.filter((l) => l.toLowerCase().includes(filter.toLowerCase()));
		out = out.slice(-40);
		return out.length ? out.join('\n') : 'nothing in the log matches "' + (filter || '') + '"';
	};
	return callLogRead(200, false, true)
		.then((rows) => keep((rows || []).map((r) => r.msg || '')))
		/* ubus `log` is absent when logd was replaced by syslog-ng or rsyslog; the wrapper is what
		 * luci-mod-status falls back to, under the same ACL */
		.catch(() => fs.exec_direct('/usr/libexec/syslog-wrapper')
			.then((txt) => keep(String(txt || '').trim().split(/\n/))));
}

function ping(arg) {
	if (!arg) return 'which host?';
	return fs.exec('/bin/ping', [ '-4', '-c', '3', '-W', '1', arg ])
		.then((r) => (r.stdout || r.stderr || 'no output').trim());
}

function reboot(arg, bang) {
	if (!bang) return 'this reboots the router now — run :reboot! to confirm';
	return callReboot().then(() => {
		ui.showModal('Rebooting…', [ E('p', { 'class': 'spinning' }, 'Waiting for device…') ]);
		ui.awaitReconnect();
		return null;
	});
}

const svcComplete = (p) => serviceNames().filter((n) => n.indexOf(p) === 0).map((n) => ({ value: n, hint: serviceHint(n) }));

const COMMANDS = [
	{ name: 'restart', arg: 'service', needs: 'admin/system/startup', help: 'restart an init script',
	  complete: svcComplete, run: serviceAction('restart') },
	{ name: 'start', arg: 'service', needs: 'admin/system/startup', help: 'start an init script',
	  complete: svcComplete, run: serviceAction('start') },
	{ name: 'stop', arg: 'service', needs: 'admin/system/startup', help: 'stop an init script',
	  complete: svcComplete, run: serviceAction('stop') },
	{ name: 'enable', arg: 'service', needs: 'admin/system/startup', help: 'enable at boot',
	  complete: svcComplete, run: serviceAction('enable') },
	{ name: 'disable', arg: 'service', needs: 'admin/system/startup', help: 'disable at boot',
	  complete: svcComplete, run: serviceAction('disable') },
	{ name: 'services', needs: 'admin/system/startup', help: 'every init script and its state',
	  run: listServices },

	{ name: 'ip', help: 'interface addresses, gateway and uptime', run: interfaces },
	{ name: 'sys', help: 'model, firmware, uptime, load, memory', run: sysinfo },
	{ name: 'log', arg: 'filter', free: true, help: 'the last 40 matching log lines', run: logTail },
	{ name: 'ping', arg: 'host', free: true, needs: 'admin/network/diagnostics', help: 'ping a host',
	  run: ping },

	{ name: 'set', arg: 'option', help: 'appearance axes; bare :set prints them',
	  complete: (p) => Object.keys(SETTINGS).filter((k) => k.indexOf(p) === 0).map((v) => ({ value: v })),
	  run: setOption },
	{ name: 'back', help: 'the previously visited page', run: () => {
		/* A recents entry is a key, and a section's key is `<page path>#<heading>` — navigating to
		 * that string verbatim would ask the dispatcher for a node named `system#Footstrap`. The
		 * page half is where `:back` goes; the section it names is on it. */
		const here = (L.env.dispatchpath || []).join('/');
		const prev = prefs.lsGetArr('fs-recent')
			.filter((x) => typeof x === 'string')
			.map((k) => (k.indexOf('#') < 0 ? k : k.slice(0, k.indexOf('#'))))
			.filter((p) => p !== here)[0];
		return prev ? { nav: prev.split('/') } : 'no previous page yet';
	} },

	{ name: 'apply', bang: 'skip the connectivity check', help: 'apply the unsaved changes',
	  /* ui.changes is luci-base's own singleton: the same path the Unsaved-changes banner runs */
	  run: (a, bang) => { ui.changes.apply(!bang); return null; } },
	{ name: 'revert', help: 'drop the unsaved changes', run: () => { ui.changes.revert(); return null; } },
	{ name: 'reboot', bang: 'no confirmation', needs: 'admin/system/reboot', help: 'reboot the router',
	  run: reboot }
];

function visible() {
	return COMMANDS.filter((c) => reachable(c.needs));
}

function lookup(name) {
	return visible().filter((c) => c.name === name)[0] || null;
}

/* one parse for suggesting and for running, so what a row offers is what Enter does */
const LINE = /^([a-z]*)(!?)(\s+)?([\s\S]*)$/;

function parse(rest) {
	const m = LINE.exec(String(rest || '').replace(/^\s+/, ''));
	return m ? { name: m[1], bang: m[2] === '!', gap: !!m[3], arg: (m[4] || '').trim() } : null;
}

/* ---- what the palette lists --------------------------------------------- */

/* A row is { line, title, hint, run } — `line` is what the input becomes when the row is taken,
 * `run` says whether taking it EXECUTES or only completes. Enter on a command that still needs an
 * argument fills the line instead of running it, which is what makes `:restart<Enter>` safe. */
function suggest(rest) {
	const p = parse(rest);
	if (!p) return [];
	const bang = p.bang ? '!' : '';

	if (!p.gap) {
		return visible().filter((c) => c.name.indexOf(p.name) === 0).map((c) => ({
			line: ':' + c.name + bang + (c.arg ? ' ' : ''),
			title: ':' + c.name + bang + (c.arg ? ' {' + c.arg + '}' : ''),
			hint: c.help + (c.bang && !p.bang ? ' · ! ' + c.bang : ''),
			run: !c.arg
		}));
	}

	const cmd = lookup(p.name);
	if (!cmd) return [];

	const rows = (cmd.complete ? cmd.complete(p.arg) : []).map((c) => ({
		line: ':' + cmd.name + bang + ' ' + c.value,
		title: ':' + cmd.name + bang + ' ' + c.value,
		hint: c.hint || cmd.help,
		run: true
	}));
	/* a typed argument no candidate matches is still an argument when the command takes free text
	 * (`:ping 8.8.8.8`), and `:set` with nothing typed still runs — it prints the axes */
	if (!rows.length && (cmd.free || !cmd.complete || !p.arg)) {
		rows.push({
			line: ':' + cmd.name + bang + (p.arg ? ' ' + p.arg : ''),
			title: ':' + cmd.name + bang + (p.arg ? ' ' + p.arg : ''),
			hint: cmd.help,
			run: true
		});
	}
	return rows;
}

/* Runs a full line (with or without its colon). Resolves to a string to print, null for nothing,
 * or { nav: segs } for "the palette should navigate there". */
function run(line) {
	const p = parse(String(line || '').replace(/^:/, ''));
	const cmd = p && lookup(p.name);
	if (!cmd) return Promise.resolve('not a command: ' + (p ? p.name : line));
	let res;
	try { res = cmd.run(p.arg, p.bang); }
	catch (e) { return Promise.resolve(String(e.message || e)); }
	return Promise.resolve(res);
}

return baseclass.extend({
	ready,
	suggest,
	run
});
