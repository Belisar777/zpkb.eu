/* eslint-disable no-console */
/**
 * Statický export WordPress (Falang) + stažení VŠECH souborů ze stejného originu:
 * - mapování cest: bez domény; pro uploads odstraň "wp-content/" => ../imgWP/uploads/YYYY/MM/file.ext
 * - ostatní zrcadlí kořen: ../imgWP/wp-content/... , ../imgWP/wp-includes/..., ...
 * - HTML stránky se nepřepisují (řeší je existující build .html)
 * - CSS: stáhne se a rekurzivně se stáhnou i url(...) a @import (bez přepisu obsahu)
 * - Inline style="...url(...)": přepis jen při úspěšném stažení
 * Node.js 18+ (global fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// =======================
// KONFIGURACE
// =======================
const API_URL = process.env.WP_API_URL;          // např. https://admin.zpkb.eu
const SITE_BASE_URL = process.env.SITE_BASE_URL; // např. https://zpkb.eu (PUBLIC URL)

const ROOT_DIST = path.join(__dirname, 'www');            // KOŘEN výstupu (assets + jazykové složky)
const TEMPLATE_DIR = path.join(__dirname, 'template');    // zdroj statických souborů (mimo index.html)
const TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'index.html'); // HTML šablona
const ENCODING = 'utf8';

// Jazyky – každý má vlastní složku i prefix v URL
const LANGS = [
	{ code: 'en', urlPrefix: 'en', outDir: path.join(ROOT_DIST, 'en'), homeTitle: 'News', notFoundTitle: '404 - Page not found' },
	{ code: 'fr', urlPrefix: 'fr', outDir: path.join(ROOT_DIST, 'fr'), homeTitle: 'Nouvelles', notFoundTitle: '404 - Page introuvable' },
	{ code: 'cs', urlPrefix: 'cs', outDir: path.join(ROOT_DIST, 'cs'), homeTitle: 'Novinky', notFoundTitle: '404 - Stránka nenalezena' },
];

// Uložiště lokálních souborů (společné pro všechny jazyky)
const STATIC_ROOT = path.join(ROOT_DIST, 'imgWP');         // www/imgWP/...
const PUBLIC_STATIC_PREFIX_FROM_LANG = '../imgWP';         // relativně z www/{lang}/*.html

// Přípony, které považujeme za HTML stránky (nepřepisujeme je na lokální soubory)
const HTML_EXT = new Set(['', '.html', '.htm']);

// Typické přípony souborů, které *ano* chceme stahovat (statika, média, dokumenty)
const FILE_EXT = new Set([
	'.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.svg', '.ico',
	'.mp4', '.webm', '.mov', '.avi', '.mp3', '.ogg', '.wav',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z',
	'.css', '.js', '.json', '.xml', '.txt', '.csv',
	'.woff', '.woff2', '.ttf', '.otf', '.eot'
]);

// =======================
// UTIL (FS / řetězce / URL)
// =======================
function ensureDir(dir) {
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function copyDirRecursive(src, dest, excludeFile) {
	ensureDir(dest);
	const entries = fs.readdirSync(src, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(src, entry.name);
		const destPath = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDirRecursive(srcPath, destPath, excludeFile);
		} else if (entry.isFile() && entry.name !== excludeFile) {
			fs.copyFileSync(srcPath, destPath);
		}
	}
}
function generateLanguageRedirect(langs) {
	const targetPath = path.join(ROOT_DIST, 'index.html');
	const def = langs[langs.length - 1];
	const langCases = langs.slice(0, -1).map(l => `if (short === "${l.code}") location.replace("${l.urlPrefix}/");`).join('\n      ');
	const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${def.urlPrefix}/">
<title>Redirecting…</title>
<script>try{var nav=navigator.language||navigator.userLanguage||"";var short=(nav.split("-")[0]||"").toLowerCase();${langCases}location.replace("${def.urlPrefix}/");}catch(e){location.replace("${def.urlPrefix}/");}</script>
<noscript><meta http-equiv="refresh" content="0; url=${def.urlPrefix}/"></noscript>
</head><body>Redirecting…</body></html>`;
	fs.writeFileSync(targetPath, html, ENCODING);
}
function joinUrl(...parts) {
	const filtered = parts.filter(Boolean).map(String);
	if (filtered.length === 0) return '';
	const first = filtered.shift();
	const base = first.replace(/\/+$/, '');
	const rest = filtered.map((p, i) => (i === filtered.length - 1 && /^[?#]/.test(p)) ? p : p.replace(/^\/+/, '').replace(/\/+$/g, '')).filter(Boolean);
	let url = [base, ...rest].join('/');
	url = url.replace(/\/(\?)/, '$1');
	return url;
}
function escapeHtml(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s) {
	return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
function stripHtml(s) { return String(s).replace(/<[^>]*>/g, '').trim(); }
function toWebPath(...segments) {
	return segments.flat().filter(Boolean).join('/').replace(/\\+/g, '/'); // "\" -> "/"
}
function hash8(str) {
	return crypto.createHash('sha1').update(str).digest('hex').slice(0, 8);
}
function sameOrigin(a, b) {
	try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}
function extnameLower(p) {
	return path.posix.extname(p || '').toLowerCase();
}

// =======================
// ŠABLONA + MENU ENGINE
// =======================
function injectToTemplate(templateHtml, content, meta = {}) {
	let html = templateHtml;
	if (html.includes('<!--CONTENT-->')) {
		html = html.replace('<!--CONTENT-->', content || '');
	} else if (html.match(/<\/main>/i)) {
		html = html.replace(/<\/main>/i, `${content || ''}\n</main>`);
	} else {
		html = html.replace(/<\/body>/i, `${content || ''}\n</body>`);
	}
	if (meta.menus && typeof meta.menus === 'object') {
		for (const [location, menuHtml] of Object.entries(meta.menus)) {
			const marker = new RegExp(`<!--\\s*MENU:${location}\\s*-->`, 'i');
			if (marker.test(html)) html = html.replace(marker, menuHtml || '');
		}
	}
	if (meta.title) {
		if (html.match(/<title>.*?<\/title>/i)) {
			html = html.replace(/<title>.*?<\/title>/i, `<title>${escapeHtml(meta.title)}</title>`);
		} else {
			html = html.replace(/<\/head>/i, `  <title>${escapeHtml(meta.title)}</title>\n</head>`);
		}
	}
	if (meta.excerpt) {
		const tag = `<meta name="description" content="${escapeAttr(stripHtml(meta.excerpt))}">`;
		if (html.match(/<meta[^>]+name=["']description["']/i)) {
			html = html.replace(/<meta[^>]+name=["']description["'][^>]*>/i, tag);
		} else {
			html = html.replace(/<\/head>/i, `  ${tag}\n</head>`);
		}
	}
	const placeholders = {
		author: meta.author || '',
		type: meta.type || '',
		date: meta.modified || '',
		slug: meta.slug || '',
		lang: meta.lang || '',
	};
	for (const [k, v] of Object.entries(placeholders)) {
		html = html.replace(new RegExp(`{{${k}}}`, 'g'), String(v));
	}
	return html;
}
function toStaticHref(itemUrl, langCode) {
	if (!itemUrl) return '#';
	try {
		const u = new URL(itemUrl);
		const p = u.pathname || '/';
		const segments = p.split('/').filter(Boolean);
		if (segments.length === 0 || (segments.length === 1 && segments[0] === langCode)) return `${langCode}/`;
		const last = segments[segments.length - 1] || '';
		if (last && !last.includes('.')) return `${langCode}/${last}.html`;
		return itemUrl;
	} catch {
		return itemUrl;
	}
}
function renderMenuItems(items, langCode) {
	let html = '';
	for (const item of items || []) {
		const href = toStaticHref(item.url, langCode);
		const title = escapeHtml(item.title || '');
		const target = item.target && item.target.toLowerCase() === '_blank' ? ' target="_blank" rel="noopener"' : '';
		html += `<li><a href="${escapeAttr(href)}"${target}>${title}</a>`;
		if (Array.isArray(item.children) && item.children.length > 0) {
			html += `<ul>${renderMenuItems(item.children, langCode)}</ul>`;
		}
		html += `</li>`;
	}
	return html;
}
function generateMenusByLocation(menuForLang, langCode) {
	const result = {};
	for (const menuObj of menuForLang || []) {
		const location = menuObj.location || 'menu';
		const itemsHtml = renderMenuItems(menuObj.items || [], langCode);
		result[location] = `<ul class="menu menu-${escapeAttr(location)}">${itemsHtml}</ul>`;
	}
	return result;
}

// =======================
// SITEMAP
// =======================
function formatDateISO(dateStr) { try { const d = new Date(dateStr); if (!isNaN(d.getTime())) return d.toISOString(); } catch { } return undefined; }
function buildSitemapXml(entries) {
	const urlsXml = entries.map(e => {
		const lastmodTag = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : '';
		const changefreqTag = e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : '';
		const priorityTag = (typeof e.priority === 'number') ? `<priority>${e.priority.toFixed(1)}</priority>` : '';
		return `  <url>
    <loc>${e.loc}</loc>
    ${lastmodTag}
    ${changefreqTag}
    ${priorityTag}
  </url>`;
	}).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlsXml}
</urlset>`;
}
function buildSitemapIndexXml(sitemaps) {
	const sitemapsXml = sitemaps.map(s => {
		const lastmodTag = s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : '';
		return `  <sitemap>
    <loc>${s.loc}</loc>
    ${lastmodTag}
  </sitemap>`;
	}).join('\n');
	return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapsXml}
</sitemapindex>`;
}

// =======================
// GENEROVÁNÍ VÝPISU ČLÁNKŮ (validní HTML)
// =======================
function generateArticleListHtml(items, langCode) {
	const sortedPosts = (items || [])
		.filter(item => item.type === 'post')
		.filter(item => item.content !== '')
		.sort((a, b) => new Date(b.date || b.modified) - new Date(a.date || a.modified));

	if (sortedPosts.length === 0) return '';

	let html = '<div class="articles">';
	for (const post of sortedPosts) {
		const href = `${langCode}/${post.slug}.html`;
		const title = post.title || '';
		const imgHtml = post.featured_image
			? `<a class="article-card__thumb" href="${escapeAttr(href)}"><img src="${escapeAttr(post.featured_image)}" alt="${escapeAttr(title)}"></a>`
			: '';
		html += `
<article class="article-card">
  ${imgHtml}
  <h4 class="article-card__title"><a href="${escapeAttr(href)}">${escapeHtml(title)}</a></h4>
  <p class="article-card__excerpt">${post.excerpt || ''}</p>
  <p><a href="${escapeAttr(href)}">Číst dál</a></p>
</article>`;
	}
	html += '</div>';
	return html;
}

// =======================
// STAŽENÍ A PŘEPSÁNÍ VŠECH SOUBORŮ V HTML/CSS
// =======================

// --- CSS regexy ---
const CSS_URL_RE = /url\(([^)]+)\)/gi;
const CSS_IMPORT_RE = /@import\s+(?:url\()?["']?([^"')\s]+)["']?\)?/gi;

/**
 * Mapuje vzdálenou URL na lokální cestu pod www/imgWP/… (bez domény).
 * - pokud cesta začíná "wp-content/uploads/", odřízne "wp-content/" => "uploads/…"
 * - jinak zachová zbytek kořenové cesty beze změny
 * - query -> krátký hash v názvu
 * Vrací { diskPath, publicWebPath, absUrl } nebo null (jiný origin).
 */
function mapRemoteToLocal(remoteUrl) {
	if (!sameOrigin(remoteUrl, API_URL)) return null;
	let u;
	try { u = new URL(remoteUrl); } catch { return null; }

	let pathname = decodeURIComponent(u.pathname || '/').replace(/^\/+/, ''); // bez leading '/'
	if (pathname.toLowerCase().startsWith('wp-content/uploads/')) {
		// => 'uploads/...'
		pathname = pathname.slice('wp-content/'.length);
	}
	const ext = extnameLower(pathname) || '.bin';
	const dir = path.posix.dirname(pathname);
	const base = path.posix.basename(pathname, ext);
	const baseWithHash = u.search ? `${base}-${hash8(u.search)}` : base;

	const relWebPath = toWebPath(dir, `${baseWithHash}${ext}`);          // 'uploads/2026/02/file.jpg' nebo 'wp-content/themes/.../file.css'
	const diskPath = path.join(STATIC_ROOT, relWebPath);
	const publicWebPath = toWebPath(PUBLIC_STATIC_PREFIX_FROM_LANG, relWebPath);
	return { diskPath, publicWebPath, absUrl: u.href };
}

// --- Nízkourovňové fetch helpery (throw) ---
async function fetchArrayBuffer(url) {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText} - ${url}`);
	const ab = await res.arrayBuffer();
	return { ab: Buffer.from(ab), headers: Object.fromEntries(res.headers.entries()) };
}
// --- Bezpečné obálky: neházejí výjimku, vrací true/false resp. {ok,text} ---
async function safeDownloadBinary(remoteUrl, diskPath) {
	try {
		ensureDir(path.dirname(diskPath));
		if (fs.existsSync(diskPath)) return true;
		const res = await fetch(remoteUrl);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const ab = await res.arrayBuffer();
		fs.writeFileSync(diskPath, Buffer.from(ab));
		return true;
	} catch (e) {
		console.warn(`WARN download binary failed (${remoteUrl}): ${e.message}`);
		return false;
	}
}
async function safeDownloadText(remoteUrl, diskPath) {
	try {
		ensureDir(path.dirname(diskPath));
		if (fs.existsSync(diskPath)) {
			return { ok: true, text: fs.readFileSync(diskPath, ENCODING) };
		}
		const res = await fetch(remoteUrl);
		if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
		const text = await res.text();
		fs.writeFileSync(diskPath, text, ENCODING);
		return { ok: true, text };
	} catch (e) {
		console.warn(`WARN download text failed (${remoteUrl}): ${e.message}`);
		return { ok: false, text: '' };
	}
}

// --- CSS: prefetch url(...) a @import (rekurzivně), bez přepisu obsahu ---
async function prefetchCssDependencies(remoteCssUrl, cssText) {
	const urlCandidates = Array.from(cssText.matchAll(CSS_URL_RE))
		.map(m => (m[1] || '').trim().replace(/^['"]|['"]$/g, ''))
		.filter(Boolean);

	const importCandidates = Array.from(cssText.matchAll(CSS_IMPORT_RE))
		.map(m => (m[1] || '').trim())
		.filter(Boolean);

	const all = [...urlCandidates, ...importCandidates];
	if (all.length === 0) return;

	for (const ref of all) {
		let abs;
		try { abs = new URL(ref, remoteCssUrl).href; } catch { continue; }
		const mapping = mapRemoteToLocal(abs);
		if (!mapping) continue;

		const ext = extnameLower(mapping.absUrl);
		if (ext === '.css') {
			const { ok, text } = await safeDownloadText(mapping.absUrl, mapping.diskPath);
			if (ok) {
				// rekurzivně projdi další závislosti
				await prefetchCssDependencies(mapping.absUrl, text);
			}
		} else {
			await safeDownloadBinary(mapping.absUrl, mapping.diskPath);
		}
	}
}

// --- Parsování HTML tagů a atributů ---
function parseTagAttributes(tagHtml) {
	const attrs = {};
	const attrRegex = /([\w:-]+)(\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
	let m;
	while ((m = attrRegex.exec(tagHtml)) !== null) {
		const name = (m[1] || '').toLowerCase();
		const raw = (m[3] || '').trim();
		const unquoted = raw.replace(/^['"]|['"]$/g, '');
		attrs[name] = unquoted;
	}
	return attrs;
}
function replaceAttrValue(tagHtml, attrName, newValue) {
	if (newValue == null) return tagHtml;
	const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
	if (re.test(tagHtml)) {
		return tagHtml.replace(re, `${attrName}="${newValue}"`);
	} else {
		const end = tagHtml.endsWith('/>') ? '/>' : '>';
		return tagHtml.replace(new RegExp(`${end}$`), ` ${attrName}="${newValue}" ${end}`);
	}
}
async function replaceTagsAsync(html, regex, replacer) {
	const matches = [];
	let m;
	while ((m = regex.exec(html)) !== null) {
		matches.push({ start: m.index, end: m.index + m[0].length, tag: m[0] });
	}
	if (matches.length === 0) return html;
	let out = html;
	for (let i = matches.length - 1; i >= 0; i--) {
		const { start, end, tag } = matches[i];
		const newTag = await replacer(tag);
		out = out.slice(0, start) + newTag + out.slice(end);
	}
	return out;
}

// --- Inline style atributy: bezpečné přepsání url(...) jen při úspěchu ---
async function rewriteInlineStyleUrls(html) {
	// Najdi všechny style="..."; zpracuj sekvenčně s await
	const matches = [];
	const re = /\bstyle\s*=\s*("([^"]*)"|'([^']*)')/gi;
	let m;
	while ((m = re.exec(html)) !== null) {
		matches.push({ start: m.index, end: m.index + m[0].length, full: m[0], quoted: m[1] });
	}
	if (matches.length === 0) return html;

	let out = html;
	for (let i = matches.length - 1; i >= 0; i--) {
		const { start, end, full, quoted } = matches[i];
		const styleVal = (quoted || '').slice(1, -1);
		let newStyle = styleVal;
		// Pro každé url(...) — jen absolutní http(s)
		const subs = [];
		for (const mm of styleVal.matchAll(CSS_URL_RE)) {
			const raw = (mm[1] || '').trim().replace(/^['"]|['"]$/g, '');
			let abs;
			try { abs = new URL(raw).href; } catch { continue; }
			const map = mapRemoteToLocal(abs);
			if (!map) continue;
			const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
			if (ok) {
				subs.push({ from: mm[0], to: `url("${map.publicWebPath}")` });
			}
		}
		// Aplikuj náhrady ve style hodnotě
		for (const s of subs) {
			newStyle = newStyle.split(s.from).join(s.to);
		}
		const replacement = `style="${newStyle}"`;
		out = out.slice(0, start) + replacement + out.slice(end);
	}
	return out;
}

/**
 * Lokalizuje soubory v HTML:
 * - přepíše a stáhne URL v: img/src(+data-src, srcset), source/src|srcset, link[href], script[src],
 *   a[href] (jen soubory, ne HTML stránky), video/audio/track/object/embed, poster,
 *   inline style url(...) (bezpečně, jen při úspěchu), <style>…</style> (CSS závislosti se prefetchují)
 * - pouze pro URL ze stejného originu jako WP_API_URL
 */
async function localizeAssets(html, langCode) {
	ensureDir(STATIC_ROOT);

	// 1) <img ...> + data-src/srcset
	const imgTagRegex = /<img\b[^>]*>/gi;
	html = await replaceTagsAsync(html, imgTagRegex, async (tag) => {
		const attrs = parseTagAttributes(tag);
		const urlCandidates = new Set();

		['src', 'data-src'].forEach(k => { const v = attrs[k]; if (v && /^https?:\/\//i.test(v)) urlCandidates.add(v); });
		['srcset', 'data-srcset'].forEach(k => {
			const v = attrs[k];
			if (v) v.split(',').map(s => s.trim()).filter(Boolean).forEach(entry => {
				const u = entry.split(/\s+/)[0]; if (u && /^https?:\/\//i.test(u)) urlCandidates.add(u);
			});
		});
		if (urlCandidates.size === 0) return tag;

		const urlMap = new Map();
		for (const remoteUrl of urlCandidates) {
			const map = mapRemoteToLocal(remoteUrl);
			if (!map) continue;
			const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
			if (ok) urlMap.set(remoteUrl, map.publicWebPath);
		}
		if (urlMap.size === 0) return tag;

		let newTag = tag;
		if (attrs['src'] && urlMap.has(attrs['src'])) newTag = replaceAttrValue(newTag, 'src', urlMap.get(attrs['src']));
		if (attrs['data-src'] && urlMap.has(attrs['data-src'])) newTag = replaceAttrValue(newTag, 'data-src', urlMap.get(attrs['data-src']));

		if (attrs['srcset']) {
			const rebuilt = attrs['srcset'].split(',').map(s => s.trim()).filter(Boolean).map(entry => {
				const [u, ...rest] = entry.split(/\s+/);
				return [(urlMap.get(u) || u), ...rest].join(' ');
			}).join(', ');
			newTag = replaceAttrValue(newTag, 'srcset', rebuilt);
		}
		if (attrs['data-srcset']) {
			const rebuilt = attrs['data-srcset'].split(',').map(s => s.trim()).filter(Boolean).map(entry => {
				const [u, ...rest] = entry.split(/\s+/);
				return [(urlMap.get(u) || u), ...rest].join(' ');
			}).join(', ');
			newTag = replaceAttrValue(newTag, 'data-srcset', rebuilt);
		}
		if (attrs['poster'] && /^https?:\/\//i.test(attrs['poster'])) {
			const map = mapRemoteToLocal(attrs['poster']);
			if (map) {
				const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
				if (ok) newTag = replaceAttrValue(newTag, 'poster', map.publicWebPath);
			}
		}
		return newTag;
	});

	// 2) <source ...> (uvnitř <picture> i <video>)
	const sourceTagRegex = /<source\b[^>]*>/gi;
	html = await replaceTagsAsync(html, sourceTagRegex, async (tag) => {
		const attrs = parseTagAttributes(tag);
		if (attrs['src'] && /^https?:\/\//i.test(attrs['src'])) {
			const map = mapRemoteToLocal(attrs['src']);
			if (map) {
				const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
				if (ok) tag = replaceAttrValue(tag, 'src', map.publicWebPath);
			}
		}
		if (attrs['srcset']) {
			const parts = attrs['srcset'].split(',').map(s => s.trim()).filter(Boolean);
			const rebuilt = [];
			for (const entry of parts) {
				const [u, ...rest] = entry.split(/\s+/);
				let outU = u;
				const map = /^https?:\/\//i.test(u) ? mapRemoteToLocal(u) : null;
				if (map) {
					const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
					if (ok) outU = map.publicWebPath;
				}
				rebuilt.push([outU, ...rest].join(' '));
			}
			tag = replaceAttrValue(tag, 'srcset', rebuilt.join(', '));
		}
		return tag;
	});

	// 3) <link ...> (stylesheet, icon, manifest, preload...)
	const linkTagRegex = /<link\b[^>]*>/gi;
	html = await replaceTagsAsync(html, linkTagRegex, async (tag) => {
		const attrs = parseTagAttributes(tag);
		const href = attrs['href'];
		if (!href || !/^https?:\/\//i.test(href)) return tag;

		const map = mapRemoteToLocal(href);
		if (!map) return tag;

		const ext = extnameLower(map.absUrl);
		if (ext === '.css') {
			const { ok, text } = await safeDownloadText(map.absUrl, map.diskPath);
			if (ok) await prefetchCssDependencies(map.absUrl, text);
			return ok ? replaceAttrValue(tag, 'href', map.publicWebPath) : tag;
		} else {
			const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
			return ok ? replaceAttrValue(tag, 'href', map.publicWebPath) : tag;
		}
	});

	// 4) <script src=...>
	const scriptTagRegex = /<script\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>\s*<\/script>/gi;
	html = await replaceTagsAsync(html, scriptTagRegex, async (tag) => {
		const attrs = parseTagAttributes(tag);
		const src = attrs['src'];
		if (!src || !/^https?:\/\//i.test(src)) return tag;
		const map = mapRemoteToLocal(src);
		if (!map) return tag;
		const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
		return ok ? replaceAttrValue(tag, 'src', map.publicWebPath) : tag;
	});

	// 5) <a href=...> — pouze „soubory“, nikoli HTML stránky
	const anchorTagRegex = /<a\b[^>]*>/gi;
	html = await replaceTagsAsync(html, anchorTagRegex, async (tag) => {
		const attrs = parseTagAttributes(tag);
		const href = attrs['href'];
		if (!href || !/^https?:\/\//i.test(href)) return tag;
		if (!isDownloadableFile(href)) return tag; // HTML stránky a neznámé necháme být
		const map = mapRemoteToLocal(href);
		if (!map) return tag;
		const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
		return ok ? replaceAttrValue(tag, 'href', map.publicWebPath) : tag;
	});

	// 6) <video>, <audio>, <track>, <object data>, <embed src>
	const genericTags = [
		{ re: /<video\b[^>]*>/gi, attrs: ['src', 'poster'] },
		{ re: /<audio\b[^>]*>/gi, attrs: ['src'] },
		{ re: /<track\b[^>]*>/gi, attrs: ['src'] },
		{ re: /<object\b[^>]*>/gi, attrs: ['data'] },
		{ re: /<embed\b[^>]*>/gi, attrs: ['src'] },
	];
	for (const g of genericTags) {
		html = await replaceTagsAsync(html, g.re, async (tag) => {
			let out = tag;
			const attrs = parseTagAttributes(tag);
			for (const a of g.attrs) {
				const val = attrs[a];
				if (val && /^https?:\/\//i.test(val)) {
					const map = mapRemoteToLocal(val);
					if (map) {
						const ok = await safeDownloadBinary(map.absUrl, map.diskPath);
						if (ok) out = replaceAttrValue(out, a, map.publicWebPath);
					}
				}
			}
			return out;
		});
	}

	// 7) inline style="background-image:url(...)" — bezpečně (jen při úspěchu)
	html = await rewriteInlineStyleUrls(html);

	// 8) <style> bloky – jen prefetch závislostí (obsah beze změny)
	const styleBlockRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
	html = await replaceTagsAsync(html, styleBlockRegex, async (tag) => {
		const m = tag.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i);
		const css = (m && m[1]) || '';
		if (!css) return tag;
		// Inline CSS nemá vlastní URL, prefetch zde nedává smysl,
		// ale typicky neobsahuje absolutní http(s) URL; pokud ano, řeší rewriteInlineStyleUrls.
		return tag;
	});

	return html;
}

/** Rozhodne, zda je URL „soubor“, který stahujeme (nikoli HTML stránka) — podle přípony. */
function isDownloadableFile(urlStr) {
	try {
		const u = new URL(urlStr);
		const ext = extnameLower(u.pathname);
		if (HTML_EXT.has(ext)) return false; // HTML stránky necháváme být
		if (ext && FILE_EXT.has(ext)) return true;
		// Pokud není přípona nebo neznámá, opatrně NEchat být (abychom nenasávali dynamické .php apod.)
		return false;
	} catch {
		return false;
	}
}

// =======================
// BUILD PRO JEDEN JAZYK
// =======================
async function buildOneLanguage(lang) {
	console.log(`\n=== Build language: ${lang.code} (/${lang.urlPrefix}) ===`);
	ensureDir(ROOT_DIST);
	ensureDir(lang.outDir);
	ensureDir(STATIC_ROOT);

	const templateHtml = fs.readFileSync(TEMPLATE_FILE, ENCODING);

	// Jazyková cache
	const CACHE_FILE = path.join(__dirname, `cache.${lang.code}.json`);
	let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, ENCODING)) : {};
	const newCache = {};
	const validFiles = new Set(['index.html', '404.html']);
	const allItemsData = [];

	// 1) INDEX – přehled položek
	const indexUrl = joinUrl(API_URL, lang.urlPrefix, '?get_static_index=1');
	console.log(`Index URL: ${indexUrl}`);
	const indexRes = await fetch(indexUrl);
	if (!indexRes.ok) throw new Error(`Index fetch failed [${lang.code}]: ${indexRes.status} ${indexRes.statusText}`);
	const indexJson = await indexRes.json();
	const items = indexJson.languages?.[lang.code] || [];

	// 2) DETAILY – per‑post (s cache)
	for (const item of items) {
		const fileName = `${item.slug}.html`;
		validFiles.add(fileName);
		const cacheKey = `${item.id}`;

		if (cache[cacheKey] && cache[cacheKey].modified === item.modified) {
			newCache[cacheKey] = cache[cacheKey];
		} else {
			const detailUrl = joinUrl(API_URL, lang.urlPrefix, `?get_static_post=${item.id}`);
			console.log(`Stahuji ${item.id}`);
			const postRes = await fetch(detailUrl);
			if (!postRes.ok) {
				console.warn(`WARN [${lang.code}] post ${item.id} fetch failed: ${postRes.status} ${postRes.statusText}`);
				continue;
			}
			const data = await postRes.json();
			newCache[cacheKey] = {
				id: item.id,
				modified: item.modified,
				title: data.title,
				slug: item.slug,
				type: data.type,
				author: data.author_name,
				excerpt: data.excerpt,
				content: data.content,
				featured_image: data.featured_image_url,
				lang: lang.code,
				date: data.date
			};
		}
		allItemsData.push(newCache[cacheKey]);
	}

	// 3) MENUS
	const menuUrl = joinUrl(API_URL, lang.urlPrefix, '?get_menus=1');
	console.log(`Menu URL [${lang.code}]: ${menuUrl}`);
	const menuRes = await fetch(menuUrl);
	if (!menuRes.ok) throw new Error(`Menu fetch failed [${lang.code}]: ${menuRes.status} ${menuRes.statusText}`);
	const menuJson = await menuRes.json();
	const menuForLang = menuJson.languages?.[lang.code] || [];
	const menusByLocation = generateMenusByLocation(menuForLang, lang.code);

	// 4) STRÁNKY – generuj a lokalizuj soubory
	for (const pageMeta of allItemsData) {
		if (pageMeta.content !== '') {
			const fileName = `${pageMeta.slug}.html`;
			const pageContent = `
<section class="page">
  <h3>${escapeHtml(pageMeta.title || '')}</h3>
  ${pageMeta.content || ''}
</section>`;
			const finalHtml = injectToTemplate(templateHtml, pageContent, { ...pageMeta, menus: menusByLocation });
			let localizedHtml = await localizeAssets(finalHtml, lang.code);
			localizedHtml = await rewriteInlineStyleUrls(localizedHtml); // jistota pro inline styly
			fs.writeFileSync(path.join(lang.outDir, fileName), localizedHtml, ENCODING);
		}
	}

	// 5) Jazykový INDEX a 404
	const articleListHtml = generateArticleListHtml(allItemsData, lang.code);
	let indexHtml = injectToTemplate(
		templateHtml,
		`<section class="home"><h3>${escapeHtml(lang.homeTitle)}</h3>${articleListHtml}</section>`,
		{ title: lang.homeTitle, menus: menusByLocation, lang: lang.code }
	);
	ensureDir(lang.outDir);
	indexHtml = await localizeAssets(indexHtml, lang.code);
	indexHtml = await rewriteInlineStyleUrls(indexHtml);
	fs.writeFileSync(path.join(lang.outDir, 'index.html'), indexHtml, ENCODING);

	let errorHtml = injectToTemplate(
		templateHtml,
		`<section class="not-found"><h3>${escapeHtml(lang.notFoundTitle)}</h3></section>`,
		{ title: lang.notFoundTitle, menus: menusByLocation, lang: lang.code }
	);
	errorHtml = await localizeAssets(errorHtml, lang.code);
	errorHtml = await rewriteInlineStyleUrls(errorHtml);
	fs.writeFileSync(path.join(lang.outDir, '404.html'), errorHtml, ENCODING);

	// 6) SITEMAP pro jazyk
	if (!SITE_BASE_URL) {
		console.warn('WARN: Missing env SITE_BASE_URL (např. https://zpkb.eu). Sitemap se nevygeneruje.');
	} else {
		const baseLangUrl = joinUrl(SITE_BASE_URL, lang.urlPrefix, '/');
		const nowIso = new Date().toISOString();
		const entries = [];
		entries.push({ loc: baseLangUrl, lastmod: nowIso, changefreq: 'weekly', priority: 1.0 });
		for (const meta of allItemsData) {
			if (meta.content !== '') {
				const lastmod = meta.modified ? formatDateISO(meta.modified) : undefined;
				entries.push({
					loc: joinUrl(baseLangUrl, `${meta.slug}.html`),
					lastmod, changefreq: 'monthly',
					priority: (meta.slug === 'kontakt' || meta.slug === 'contact') ? 0.8 : 0.6
				});
			}
		}
		const langSitemapXml = buildSitemapXml(entries);
		fs.writeFileSync(path.join(lang.outDir, 'sitemap.xml'), langSitemapXml, ENCODING);
		console.log(`Sitemap generated: ${path.join(lang.outDir, 'sitemap.xml')}`);
	}

	// 7) Úklid sirotků (jen .html v jazykové složce)
	fs.readdirSync(lang.outDir).forEach(file => {
		if (file.endsWith('.html') && !validFiles.has(file)) {
			fs.unlinkSync(path.join(lang.outDir, file));
		}
	});

	// 8) Ulož cache
	fs.writeFileSync(path.join(__dirname, `cache.${lang.code}.json`), JSON.stringify(newCache, null, 2), ENCODING);
	console.log(`✔ Done language: ${lang.code}`);
}

// =======================
// HLAVNÍ DRIVER
// =======================
async function buildAll() {
	console.log('--- Build Started ---');
	if (!API_URL) throw new Error('Missing env WP_API_URL (např. https://admin.zpkb.eu)');

	// 0) Root + assets (bez index.html)
	ensureDir(ROOT_DIST);
	ensureDir(STATIC_ROOT);
	copyDirRecursive(TEMPLATE_DIR, ROOT_DIST, 'index.html');

	// Root redirect podle prohlížečového jazyka
	generateLanguageRedirect(LANGS);

	// 1) Vygeneruj jazyky
	for (const lang of LANGS) {
		await buildOneLanguage(lang);
	}

	// 2) Kořenový sitemap index
	if (!SITE_BASE_URL) {
		console.warn('WARN: Missing env SITE_BASE_URL. Root sitemap index nebude vytvořen.');
	} else {
		const nowIso = new Date().toISOString();
		const sitemaps = LANGS.map(lang => ({
			loc: joinUrl(SITE_BASE_URL, lang.urlPrefix, 'sitemap.xml'),
			lastmod: nowIso
		}));
		const sitemapIndexXml = buildSitemapIndexXml(sitemaps);
		fs.writeFileSync(path.join(ROOT_DIST, 'sitemap.xml'), sitemapIndexXml, ENCODING);
		console.log(`Root sitemap index generated: ${path.join(ROOT_DIST, 'sitemap.xml')}`);
	}

	// 3) robots.txt
	try {
		if (SITE_BASE_URL) {
			const robots = [
				'User-agent: *',
				'Allow: /',
				`Sitemap: ${joinUrl(SITE_BASE_URL, 'sitemap.xml')}`,
				''
			].join('\n');
			fs.writeFileSync(path.join(ROOT_DIST, 'robots.txt'), robots, ENCODING);
			console.log(`robots.txt generated: ${path.join(ROOT_DIST, 'robots.txt')}`);
		}
	} catch (e) {
		console.warn('WARN: Nepodařilo se zapsat robots.txt:', e.message);
	}

	console.log('--- Build Complete ---');
}

buildAll().catch(err => {
	console.error(err);
	process.exit(1);
});
