'use strict';
'require baseclass';
'require fs-router as router';
'require fs-prefs as prefs';
'require fs-cmd-commands as commands';

/* The command line: one line on the bottom edge of the window, opened by `:`.
 *
 * Deliberately NOT the search palette's shape. The palette is a centred dialog because it answers
 * "which page" with a list and then goes away; this answers "do what" and has to leave the page it
 * is acting on visible behind it — a `:restart dnsmasq` typed while reading the log should not
 * cover the log. No scrim and no aria-modal for the same reason: a pointerdown anywhere else closes
 * it and the page underneath keeps working.
 *
 * Everything it knows about commands comes from fs-cmd-commands: this file is the input, the
 * candidate strip, the echo area and the keys, and nothing else. */

let _root = null, _input = null, _out = null, _hint = null, _list = null, _help = null;
let _hist = [], _view = [], _at = -1, _draft = '';
let _rows = null, _pick = -1;
/* Where focus was when the bar opened, so closing it puts the reader back rather than on <body>.
 * Held as a node and checked before use: the router can replace the page under an open bar. */
let _returnTo = null;
/* Bumped by every submit, open and close. `:ping` takes three seconds and `:log` a round trip;
 * without this the answer to one command lands in whatever the bar is showing by the time it
 * arrives — measured on a stand, ping's output printed over a later `:set`. */
let _gen = 0;

const HIST_KEY = 'fs-cmd-history';
const HIST_MAX = 50;

/* prefs owns the try/catch around localStorage and the "is it really an array" guard; a private
 * copy of that here was a second implementation of the same corruption handling. */
function histAll() {
	return prefs.lsGetArr(HIST_KEY).filter((x) => typeof x === 'string');
}

function histPush(line) {
	prefs.lsSet(HIST_KEY, JSON.stringify([ line ].concat(histAll().filter((l) => l !== line)).slice(0, HIST_MAX)));
}

function echo(text, bad) {
	_out.textContent = text || '';
	_out.hidden = !text;
	_out.classList.toggle('bad', !!bad);
	_out.scrollTop = 0;
}

/* vim's wildmenu: the candidates on one wrapping row, the current one marked. It is also the only
 * place a command's help text is shown for a command being completed — `:help` is what shows it
 * for one that is not.
 *
 * Each candidate is a <button>, not a <span>: the strip was keyboard-only, and a reader who had
 * found the row they wanted with the mouse had no way to take it. Taking one fills the line, and
 * submits it only when the line is complete — a command still waiting for an argument leaves the
 * bar open with the cursor after the space, which is what Tab does.
 *
 * The listbox holds OPTIONS and nothing else: the help line is a sibling, because a listbox with a
 * stray non-option child is an invalid tree and a screen reader is free to do anything with it.
 * `aria-activedescendant` on the input is what announces the Tab-cycled candidate without moving
 * focus off the field the user is typing in — the same shape the theme's own palette uses. */
function drawHint() {
	_list.innerHTML = '';
	if (!_rows || !_rows.length) {
		_hint.hidden = true;
		_input.setAttribute('aria-expanded', 'false');
		_input.removeAttribute('aria-activedescendant');
		return;
	}
	_rows.slice(0, 40).forEach((r, i) => {
		_list.appendChild(E('button', {
			'type': 'button',
			'id': 'fs-cmd-cand-' + i,
			'role': 'option',
			'aria-selected': i === _pick ? 'true' : 'false',
			'class': 'fs-cmd-cand' + (i === _pick ? ' active' : ''),
			'title': r.hint || '',
			'tabindex': '-1',
			'click': (ev) => { ev.preventDefault(); take(i); }
		}, [ r.title ]));
	});
	const cur = _rows[_pick < 0 ? 0 : _pick];
	_help.textContent = cur && cur.hint ? cur.hint : '';
	_hint.hidden = false;
	_input.setAttribute('aria-expanded', 'true');
	if (_pick >= 0) _input.setAttribute('aria-activedescendant', 'fs-cmd-cand-' + _pick);
	else _input.removeAttribute('aria-activedescendant');
}

function take(i) {
	if (!_rows || !_rows[i]) return;
	_pick = i;
	_input.value = _rows[i].line;
	_input.focus();
	/* a line that ends in a space is a command still asking for its argument */
	if (/\s$/.test(_input.value)) { refresh(); return; }
	submit();
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
	_view = _hist;
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
	}, (e) => { if (mine === _gen) echo(String((e && e.message) || e), true); });
}

/* navigation goes through an anchor, so the theme's router owns the decision and no copy of it
 * lives here */
function go(segs) {
	const a = E('a', { 'href': L.url.apply(L, segs) });
	_root.appendChild(a);
	a.click();
	a.remove();
}

/* Up filters by what has been typed, the way a shell and vim's cmdline both do: `:re<Up>` walks
 * the `:restart …` lines and not the whole list. The unfiltered list is what an empty line gets,
 * so the plain "last command" gesture is unchanged. */
function histStep(dir) {
	if (_at < 0) {
		_draft = _input.value;
		const pre = _draft.replace(/^:/, '');
		_view = pre ? _hist.filter((l) => l.slice(1).indexOf(pre) === 0) : _hist;
	}
	if (!_view.length) return;
	const next = _at + dir;
	if (next < -1 || next >= _view.length) return;
	_at = next;
	_input.value = (_at < 0) ? _draft : _view[_at];
	refresh();
}

function build() {
	_out = E('pre', { 'class': 'fs-cmd-out', 'aria-live': 'polite', 'hidden': '' });
	_list = E('div', { 'id': 'fs-cmd-list', 'class': 'fs-cmd-cands', 'role': 'listbox', 'aria-label': _('Candidates') });
	_help = E('div', { 'class': 'fs-cmd-help' });
	_hint = E('div', { 'class': 'fs-cmd-hint', 'hidden': '' }, [ _list, _help ]);
	_input = E('input', {
		'type': 'text', 'class': 'fs-cmd-input', 'aria-label': _('Command'),
		/* combobox over a listbox, not a bare text field: without this the candidate strip is
		 * invisible to a screen reader and Tab appears to change the field's value for no
		 * announced reason */
		'role': 'combobox',
		'aria-controls': 'fs-cmd-list',
		'aria-expanded': 'false',
		'aria-autocomplete': 'list',
		'autocomplete': 'off', 'autocapitalize': 'off', 'spellcheck': 'false'
	});
	_root = E('div', {
		'id': 'fs-cmd', 'class': 'fs-cmd',
		/* a zone-1 root: this is parented to <body>, outside the <nav> that carries the theme's
		 * mark, so without it the fence against foreign CSS does not cover the bar */
		'data-fs-chrome': '',
		'role': 'dialog', 'aria-label': _('Command line'), 'hidden': ''
	}, [ _out, _hint, E('div', { 'class': 'fs-cmd-line' }, [ _input ]) ]);
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

	/* A bar left open rides a Back or a Forward onto the next page, still showing the previous
	 * page's output, and the answer to a command started there would print over it. The theme's
	 * own palette closes on the same signal and for the same reason. */
	router.onNavigate(() => close(false));
}

function open() {
	if (!_root) build();
	/* only a real element, and never the bar's own input: reopening must not make the bar the
	 * thing the bar returns to */
	const a = document.activeElement;
	_returnTo = (a && a !== document.body && a !== _input && document.contains(a)) ? a : null;
	_hist = histAll();
	_view = _hist;
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
	/* `rc list` may still be in flight on the first colon; the candidate strip is empty until it
	 * lands and there is nothing else to redraw it. Guarded by the generation so a slow answer
	 * cannot repaint a bar that has since been closed and reopened. */
	const mine = _gen;
	commands.ready.then(() => { if (mine === _gen && _root && !_root.hidden) refresh(); });
}

function close(returnFocus = true) {
	if (!_root || _root.hidden) return;
	_root.hidden = true;
	_gen++;
	echo('');
	_rows = null;
	drawHint();
	/* Focus has to go somewhere deliberate. Leaving it on the hidden input drops it to <body> and
	 * costs a keyboard reader their place on the page; `returnFocus === false` is for the paths
	 * that are about to move focus themselves (a navigation). */
	if (returnFocus && document.activeElement === _input) {
		if (_returnTo && document.contains(_returnTo)) {
			try { _returnTo.focus({ preventScroll: true }); } catch (e) { _input.blur(); }
		}
		else _input.blur();
	}
	_returnTo = null;
}

return baseclass.extend({ open, close });
