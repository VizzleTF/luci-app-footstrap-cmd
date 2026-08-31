'use strict';
'require baseclass';
'require fs-palette-sections as sections';

/* The package's entry point — the one module named in `footstrap.settings.plugin`, which the
 * theme's chrome requires at the end of its init and knows nothing else about.
 *
 * It stays small on purpose: everything it turns on is either lazy (the command line arrives with
 * the first colon) or idle (the section index fills in between navigations). An admin who never
 * presses `:` pays for this file and the section source, nothing more.
 *
 * Note what is NOT required here: `fs-search`. The palette is fetched by the theme on the first
 * gesture and most sessions never make one, so a package that required it to register would pull
 * 4.5 KB onto every page for a list nobody opens. The section source is pushed onto
 * `window.__fsSearchSources` instead — the theme reads that array when it builds its pool. */

/* This package's stylesheet is loaded by this package: the theme's cascade.css is concatenated
 * from its own styles/ tree at package time and nothing outside that tree can join it.
 * data-fs-chrome marks the link as zone-1 so the theme's fence covers what it paints. */
function addStylesheet() {
	if (document.getElementById('fs-palette-css')) return;
	document.head.appendChild(E('link', {
		'id': 'fs-palette-css',
		'rel': 'stylesheet',
		'data-fs-chrome': '',
		'href': L.resource('../palette/palette.css')
	}));
}

/* `:` opens the command line, and nothing is fetched until it is pressed. The guard is the theme's,
 * copied deliberately rather than shared: a keystroke inside a field, a contenteditable or a
 * .cbi-dropdown belongs to whoever is typing, and fs-select.js's typeahead reads punctuation as a
 * search character. */
function wireColon() {
	let pending = false, mod = null;
	document.addEventListener('keydown', (ev) => {
		if (ev.defaultPrevented || ev.key !== ':' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
		if (ev.target.closest?.('input, textarea, select, [contenteditable], .cbi-dropdown')) return;
		ev.preventDefault();
		if (mod) { mod.open(); return; }
		if (pending) return;
		pending = true;
		window.L.require('fs-palette-cmdline').then((m) => { pending = false; mod = m; m.open(); },
			(e) => { pending = false; console.error('palette: the command line did not load', e); });
	});
}

addStylesheet();
wireColon();
sections.register();

return baseclass.extend({});
