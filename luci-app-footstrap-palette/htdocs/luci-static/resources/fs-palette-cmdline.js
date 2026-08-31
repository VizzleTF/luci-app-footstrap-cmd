'use strict';
'require baseclass';
'require fs-palette-commands as commands';

/* The command line: one line on the bottom edge of the window, opened by `:`.
 *
 * Deliberately NOT the search palette's shape. The palette is a centred dialog because it answers
 * "which page" with a list and then goes away; this answers "do what" and has to leave the page it
 * is acting on visible behind it — a `:restart dnsmasq` typed while reading the log should not
 * cover the log. No scrim and no aria-modal for the same reason: a pointerdown anywhere else closes
 * it and the page underneath keeps working.
 *
 * Everything it knows about commands comes from fs-palette-commands: this file is the input, the
 * candidate strip, the echo area and the keys, and nothing else. */

let _root = null, _input = null, _out = null, _hint = null;
let _hist = [], _at = -1, _draft = '';
let _rows = null, _pick = -1;
/* Bumped by every submit, open and close. `:ping` takes three seconds and `:log` a round trip;
 * without this the answer to one command lands in whatever the bar is showing by the time it
 * arrives — measured on a stand, ping's output printed over a later `:set`. */
let _gen = 0;

const HIST_KEY = 'fs-palette-history';
const HIST_MAX = 50;

function histAll() {
	try {
		const v = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
		return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
	} catch (e) { return []; }
}
function histPush(line) {
	try {
		localStorage.setItem(HIST_KEY, JSON.stringify([ line ].concat(histAll().filter((l) => l !== line)).slice(0, HIST_MAX)));
	} catch (e) {}
}

function echo(text, bad) {
	_out.textContent = text || '';
	_out.hidden = !text;
	_out.classList.toggle('bad', !!bad);
	_out.scrollTop = 0;
}

/* vim's wildmenu: the candidates on one wrapping row, the current one marked. It is also the only
 * place a command's help text is shown, so it is drawn whenever there is something to complete —
 * not only after a Tab. */
function drawHint() {
	_hint.innerHTML = '';
	if (!_rows || !_rows.length) { _hint.hidden = true; return; }
	_rows.slice(0, 40).forEach((r, i) => {
		_hint.appendChild(E('span', {
			'class': 'fs-pal-cand' + (i === _pick ? ' active' : ''),
			'title': r.hint || ''
		}, [ r.title ]));
	});
	const cur = _rows[_pick < 0 ? 0 : _pick];
	_hint.appendChild(E('span', { 'class': 'fs-pal-help' }, [ cur && cur.hint ? cur.hint : '' ]));
	_hint.hidden = false;
}

function refresh() {
	const v = _input.value;
	_rows = (v.charAt(0) === ':') ? commands.suggest(v.slice(1)) : [];
	_pick = -1;
	drawHint();
}

function cycle(dir) {
	if (!_rows || !_rows.length) return;
	_pick = (_pick + dir + _rows.length) % _rows.length;
	_input.value = _rows[_pick].line;
	drawHint();
}

function submit() {
	const line = _input.value.replace(/^:/, '').trim();
	if (!line) { close(); return; }
	histPush(':' + line);
	_hist = histAll();
	_at = -1;
	const mine = ++_gen;
	echo('…');
	commands.run(line).then((res) => {
		if (mine !== _gen) return;
		if (res && res.nav) { close(false); go(res.nav); return; }
		/* nothing to print means the command WAS the effect — `:set dark`, `:apply`, `:reboot!` —
		 * and an empty bar left open in front of it is noise */
		if (res == null) { close(); return; }
		echo(String(res));
		_input.value = '';
		refresh();
	}, (e) => { if (mine === _gen) echo(String(e.message || e), true); });
}

/* navigation goes through an anchor, so the theme's router owns the decision and no copy of it
 * lives here */
function go(segs) {
	const a = E('a', { 'href': L.url.apply(L, segs) });
	_root.appendChild(a);
	a.click();
	a.remove();
}

function histStep(dir) {
	if (!_hist.length) return;
	if (_at < 0) _draft = _input.value;
	const next = _at + dir;
	if (next < -1 || next >= _hist.length) return;
	_at = next;
	_input.value = (_at < 0) ? _draft : _hist[_at];
	refresh();
}

function build() {
	_out = E('pre', { 'class': 'fs-pal-out', 'aria-live': 'polite', 'hidden': '' });
	_hint = E('div', { 'class': 'fs-pal-hint', 'hidden': '' });
	_input = E('input', {
		'type': 'text', 'class': 'fs-pal-input', 'aria-label': 'Command',
		'autocomplete': 'off', 'autocapitalize': 'off', 'spellcheck': 'false'
	});
	_root = E('div', {
		'id': 'fs-pal', 'class': 'fs-pal',
		/* a zone-1 root: this is parented to <body>, outside the <nav> that carries the theme's
		 * mark, so without it the fence against foreign CSS does not cover the bar */
		'data-fs-chrome': '',
		'role': 'dialog', 'aria-label': 'Command line', 'hidden': ''
	}, [ _out, _hint, E('div', { 'class': 'fs-pal-line' }, [ _input ]) ]);
	document.body.appendChild(_root);

	_input.addEventListener('input', refresh);

	_root.addEventListener('keydown', (ev) => {
		const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
		switch (ev.key) {
		case 'Escape': ev.preventDefault(); close(); return;
		case 'Enter': ev.preventDefault(); submit(); return;
		case 'Tab': ev.preventDefault(); cycle(ev.shiftKey ? -1 : 1); return;
		case 'ArrowUp': ev.preventDefault(); histStep(1); return;
		case 'ArrowDown': ev.preventDefault(); histStep(-1); return;
		}
		if (!ctrl) return;
		/* the readline keys a shell and vim's cmdline both answer to */
		if (ev.key === 'p') { ev.preventDefault(); histStep(1); }
		else if (ev.key === 'n') { ev.preventDefault(); histStep(-1); }
		else if (ev.key === 'u') { ev.preventDefault(); _input.value = ':'; refresh(); }
		else if (ev.key === 'c') { ev.preventDefault(); close(); }
	});

	/* not modal: a click on the page is the user going back to it, and vim's cmdline leaves the
	 * same way */
	document.addEventListener('pointerdown', (ev) => {
		if (_root && !_root.hidden && !_root.contains(ev.target)) close();
	});
}

function open() {
	if (!_root) build();
	_hist = histAll();
	_at = -1;
	_draft = '';
	_gen++;
	/* the colon is IN the field, not a label beside it: it is part of what the user is typing, so
	 * backspacing over it leaves the command line the way it does in vim */
	_input.value = ':';
	echo('');
	_root.hidden = false;
	_input.focus();
	_input.setSelectionRange(1, 1);
	refresh();
}

function close(returnFocus = true) {
	if (!_root || _root.hidden) return;
	_root.hidden = true;
	_gen++;
	echo('');
	_rows = null;
	drawHint();
	if (returnFocus && document.activeElement === _input) _input.blur();
}

return baseclass.extend({ open, close });
