/* eslint-disable no-console */
// Požadavek: Node.js 18+ (kvůli globálnímu fetch)
const fs = require('fs');
const path = require('path');

// =======================
// KONFIGURACE
// =======================
const API_URL = process.env.WP_API_URL;                      // např. https://admin.zpkb.eu
const SITE_BASE_URL = process.env.SITE_BASE_URL;             // např. https://zpkb.eu (PUBLIC URL)
const ROOT_DIST = path.join(__dirname, 'www');           // KOŘEN výstupu (assets + jazykové složky)
const TEMPLATE_DIR = path.join(__dirname, 'template');     // zdroj statických souborů (kromě index.html)
const TEMPLATE_FILE = path.join(TEMPLATE_DIR, 'index.html'); // HTML šablona
const ENCODING = 'utf8';

// Jazyky – každý má vlastní složku pro HTML i prefix v URL.
const LANGS = [
  { code: 'en', urlPrefix: 'en', outDir: path.join(ROOT_DIST, 'en'), homeTitle: 'Home', notFoundTitle: '404' },
  { code: 'fr', urlPrefix: 'fr', outDir: path.join(ROOT_DIST, 'fr'), homeTitle: 'Maison', notFoundTitle: '404' },
  { code: 'cs', urlPrefix: 'cs', outDir: path.join(ROOT_DIST, 'cs'), homeTitle: 'Domů', notFoundTitle: '404' },
];

// =======================
// POMOCNÉ FUNKCE
// =======================
function ensureDir(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

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

  const defaultLang = langs[langs.length - 1];
  const redirectLogic = langs.slice(0, -1).map(l =>
    `if (short === "${l.code}") location.href = "${l.urlPrefix}/";`
  ).join('\n    ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Redirecting...</title>
  <script>
    const short = (navigator.language || "en").toLowerCase().substring(0, 2);
    ${redirectLogic}
    location.href = "${defaultLang.urlPrefix}/";
  </script>
</head>
<body>
  <noscript>
    ${langs.map(l => `<a href="${l.urlPrefix}/">${l.code.toUpperCase()}</a>`).join(' ')}
  </noscript>
</body>
</html>`;

  fs.writeFileSync(targetPath, html, 'utf8');
}

/**
 * Bezpečné spojení URL segmentů: joinUrl('https://a', 'en', '?x=1') -> 'https://a/en/?x=1'
 */
function joinUrl(...parts) {
  const first = parts.shift() || '';
  const rest = parts
    .filter(Boolean)
    .map((p, i) => (i === parts.length - 1 ? p.replace(/^\/+/, '') : p.replace(/^\/+|\/+$/g, '')));
  let url = [first.replace(/\/+$/, ''), ...rest].join('/');
  url = url.replace(/\/\?/, '/?'); // '/?query' fix
  return url;
}

/**
 * Vloží data do HTML šablony a nahradí obsah v <section id="genContent">,
 * přepíše vnitřek #menu, doplní <title> a <meta name="description">,
 * a nahradí simple placeholdery {{author}}, {{type}}, {{date}}, {{slug}}, {{lang}}.
 */
function injectToTemplate(templateHtml, content, meta = {}) {
  let html = templateHtml;

  // 1) Hlavní obsah
  html = html.replace(
    /<section id="genContent">.*?<\/section>/s,
    `<section id="genContent">${content || ''}</section>`
  );

  // 2) Vnitřek #menu (zachová <div id="menu"...> a </div>)
  const menuRegex = /(<div id="menu"[^>]*>)(.*?)(<\/div>)/s;
  if (meta.menu) {
    html = html.replace(menuRegex, `$1${meta.menu}$3`);
  }

  // 3) <title> a <meta name="description">
  if (meta.title) {
    html = html.replace(/<title>.*?<\/title>/i, `<title>${meta.title}</title>`);
  }
  if (meta.excerpt) {
    const metaTag = `<meta name="description" content="${meta.excerpt}">`;
    if (html.match(/<meta name="description"[^>]*>/i)) {
      html = html.replace(/<meta name="description" content=".*?">/i, metaTag);
    } else {
      html = html.replace('</head>', `  ${metaTag}\n</head>`);
    }
  }

  // 4) Placeholdery
  const placeholders = {
    author: meta.author || '',
    type: meta.type || '',
    date: meta.modified || '',
    slug: meta.slug || '',
    lang: meta.lang || '',
  };
  for (const [k, v] of Object.entries(placeholders)) {
    html = html.replace(new RegExp(`{{${k}}}`, 'g'), v);
  }

  return html;
}

/**
 * Vnitřek menu – POZN.: v původním komentáři bylo "relativně (slug.html)".
 * Pokud chceš čistě relativní cesty, můžeš dát jen `${p.slug}.html`.
 * Níže ponechávám tvojí variantu s jazykem (případně přidej leading slash).
 */
function generateMenuInnerHtml(indexData) {
  let html = `
    <div class="myBarItem close" title="Zavřít okno">
      <svg class="bx"><use xlink:href="/sprites/bx-basic.svg#bx-x"></use></svg>
    </div>`;

  indexData.forEach(p => {
    if (p.type === 'page') {
      const titleUpper = (p.title || '').toUpperCase();
      html += `
        <a href="${p.lang}/${p.slug}.html" class="myBarItem" title="${titleUpper}">
          <span class="menuText">${titleUpper}</span>
        </a>`;
    }
  });
  return html;
}

// =======================
// SITEMAP – POMOCNÉ FUNKCE
// =======================
function formatDateISO(dateStr) {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (e) { }
  return undefined;
}

/**
 * Vygeneruje XML pro sitemap (jednoho jazyka).
 * @param {Array<{loc:string,lastmod?:string,changefreq?:string,priority?:number}>} entries
 */
function buildSitemapXml(entries) {
  const urlsXml = entries.map(e => {
    const lastmodTag = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : '';
    const changefreqTag = e.changefreq ? `<changefreq>${e.changefreq}</changefreq>` : '';
    const priorityTag = (typeof e.priority === 'number') ? `<priority>${e.priority.toFixed(1)}</priority>` : '';
    return (
      `  <url>
    <loc>${e.loc}</loc>
    ${lastmodTag}
    ${changefreqTag}
    ${priorityTag}
  </url>`
    );
  }).join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by static builder -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urlsXml}
</urlset>
`);
}

/**
 * Vygeneruje sitemap index (v kořeni webu), který ukazuje na jazykové sitemapy.
 * @param {Array<{loc:string,lastmod?:string}>} sitemaps
 */
function buildSitemapIndexXml(sitemaps) {
  const sitemapsXml = sitemaps.map(s => {
    const lastmodTag = s.lastmod ? `<lastmod>${s.lastmod}</lastmod>` : '';
    return (
      `  <sitemap>
    <loc>${s.loc}</loc>
    ${lastmodTag}
  </sitemap>`
    );
  }).join('\n');

  return (
    `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by static builder -->
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapsXml}
</sitemapindex>
`);
}

// =======================
// BUILD PRO JEDEN JAZYK
// =======================
async function buildOneLanguage(lang) {
  console.log(`\n=== Build language: ${lang.code} (/ ${lang.urlPrefix} ) ===`);
  ensureDir(ROOT_DIST);
  ensureDir(lang.outDir);

  const templateHtml = fs.readFileSync(TEMPLATE_FILE, ENCODING);

  // Jazyková cache (odděleně pro každý jazyk)
  const CACHE_FILE = path.join(__dirname, `cache.${lang.code}.json`);
  let cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, ENCODING)) : {};
  const newCache = {};
  const validFiles = new Set(['index.html', '404.html']); // soubory, které mají v jazykové složce po buildu zůstat
  const allItemsData = [];

  // 1) INDEX FETCH – pod jazykovým prefixem
  const indexUrl = joinUrl(API_URL, lang.urlPrefix, '?get_static_index=1');
  console.log(`Index URL: ${indexUrl}`);
  const indexRes = await fetch(indexUrl);
  if (!indexRes.ok) {
    throw new Error(`Index fetch failed [${lang.code}]: ${indexRes.status} ${indexRes.statusText}`);
  }
  const items = await indexRes.json();

  // 2) DETAILY – per‑post fetch
  for (const item of items) {
    const fileName = `${item.slug}.html`;
    validFiles.add(fileName);

    const cacheKey = `${item.id}`; // cache držíme per jazyk => samostatný soubor cache.{lang}.json
    if (cache[cacheKey] && cache[cacheKey].modified === item.modified && cache[cacheKey].content === item.content) {
      newCache[cacheKey] = cache[cacheKey];
    } else {
      const detailUrl = joinUrl(API_URL, lang.urlPrefix, `?get_static_post=${item.id}`);
      const postRes = await fetch(detailUrl);
      console.log("Stahuji ${item.id}");

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
        lang: lang.code,
      };
    }
    allItemsData.push(newCache[cacheKey]);
  }

  // 3) Menu (jen pages, relativní odkazy vs. jazykový prefix – viz poznámka ve funkci)
  const menuInner = generateMenuInnerHtml(allItemsData);

  // 4) Stránky
  allItemsData.forEach(pageMeta => {
    const fileName = `${pageMeta.slug}.html`;
    const pageContent =
      `<h2>${pageMeta.title || ''}</h2><div class="entry-content">${pageMeta.content || ''}</div>`;
    const finalHtml = injectToTemplate(templateHtml, pageContent, { ...pageMeta, menu: menuInner });
    fs.writeFileSync(path.join(lang.outDir, fileName), finalHtml, ENCODING);

    // delete pageMeta.content; // do cache neukládáme velká těla
  });

  // 5) Jazykový index a 404 (v /cs/ a /en/)
  const indexHtml = injectToTemplate(
    templateHtml,
    `<h2>${lang.homeTitle}</h2>`,
    { title: lang.homeTitle, menu: menuInner, lang: lang.code }
  );
  fs.writeFileSync(path.join(lang.outDir, 'index.html'), indexHtml, ENCODING);

  const errorHtml = injectToTemplate(
    templateHtml,
    `<h2>${lang.notFoundTitle}</h2>`,
    { title: lang.notFoundTitle, menu: menuInner, lang: lang.code }
  );
  fs.writeFileSync(path.join(lang.outDir, '404.html'), errorHtml, ENCODING);

  // === 5.5) SITEMAP PRO DANÝ JAZYK ===
  if (!SITE_BASE_URL) {
    console.warn('WARN: Missing env SITE_BASE_URL (např. https://zpkb.eu). Sitemap se nevygeneruje.');
  } else {
    const baseLangUrl = joinUrl(SITE_BASE_URL, lang.urlPrefix, '/'); // např. https://zpkb.eu/cs/
    const nowIso = new Date().toISOString();

    const entries = [];

    // Domovská (jazykový index)
    entries.push({
      loc: baseLangUrl,             // https://zpkb.eu/cs/
      lastmod: nowIso,
      changefreq: 'weekly',
      priority: 1.0
    });

    // Všechny stránky (slugy). 404 do sitemapy nedáváme.
    for (const meta of allItemsData) {
      const lastmod = meta.modified ? formatDateISO(meta.modified) : undefined;
      entries.push({
        loc: joinUrl(baseLangUrl, `${meta.slug}.html`), // https://zpkb.eu/cs/slug.html
        lastmod,
        changefreq: 'monthly',
        priority: (meta.slug === 'kontakt' || meta.slug === 'contact') ? 0.8 : 0.6
      });
    }

    // Zapsat sitemap.xml v jazykové složce
    const langSitemapXml = buildSitemapXml(entries);
    fs.writeFileSync(path.join(lang.outDir, 'sitemap.xml'), langSitemapXml, ENCODING);
    console.log(`Sitemap generated: ${path.join(lang.outDir, 'sitemap.xml')}`);
  }

  // 6) Úklid sirotků v JEN TOMTO jazyce (týká se jen .html souborů)
  fs.readdirSync(lang.outDir).forEach(file => {
    if (file.endsWith('.html') && !validFiles.has(file)) {
      fs.unlinkSync(path.join(lang.outDir, file));
    }
  });

  // 7) Ulož cache pro jazyk
  fs.writeFileSync(CACHE_FILE, JSON.stringify(newCache, null, 2), ENCODING);

  console.log(`✔ Done language: ${lang.code}`);
}

// =======================
// HLAVNÍ DRIVER
// =======================
async function buildAll() {
  console.log('--- Build Started ---');
  if (!API_URL) throw new Error('Missing env WP_API_URL (např. https://admin.zpkb.eu)');

  // 0) Připrav root a zkopíruj ASSETS JEDNOU (bez index.html)
  ensureDir(ROOT_DIST);
  copyDirRecursive(TEMPLATE_DIR, ROOT_DIST, 'index.html');

  generateLanguageRedirect(LANGS);

  // 1) Pro každý jazyk vygeneruj HTML do /{code}/
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

  // 3) Volitelně robots.txt
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

buildAll().catch(err => { console.error(err); process.exit(1); });