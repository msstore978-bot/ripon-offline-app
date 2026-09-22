/**
 * build.mjs — GitHub Actions (বা নিজের কম্পিউটারে `node build.mjs`) দিয়ে dist/ ফোল্ডার বানায়।
 *   • web/ ফোল্ডারের অ্যাপ কপি করে
 *   • apps-script/Code.gs + Barcode.gs → dist/gas/*.gs.txt (একটাই সোর্স; অফলাইনে ব্রাউজারে এটাই চলে)
 *   • Hind Siliguri ফন্ট নামিয়ে লোকাল করে (ইন্টারনেট ছাড়াও বাংলা সুন্দর দেখাবে)
 *   • Service Worker-এ ফাইলের তালিকা ও ভার্সন বসায়
 */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'gas'), { recursive: true });
cpSync(join(root, 'web'), dist, { recursive: true });
cpSync(join(root, 'apps-script', 'Code.gs'), join(dist, 'gas', 'Code.gs.txt'));
cpSync(join(root, 'apps-script', 'Barcode.gs'), join(dist, 'gas', 'Barcode.gs.txt'));
writeFileSync(join(dist, '.nojekyll'), '');

/* ---- ফন্ট লোকাল করা (ব্যর্থ হলে Google Fonts লিংকই থাকবে; Service Worker সেটা ক্যাশ করবে) ---- */
async function localizeFonts() {
  const cssUrl = 'https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;500;600;700&display=swap';
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
  const res = await fetch(cssUrl, { headers: { 'User-Agent': ua } });
  if (!res.ok) throw new Error('fonts css ' + res.status);
  let css = await res.text();
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)].map((m) => m[1]))];
  if (!urls.length) throw new Error('no font files found');
  mkdirSync(join(dist, 'fonts'), { recursive: true });
  let i = 0;
  for (const u of urls) {
    const r = await fetch(u);
    if (!r.ok) throw new Error('font ' + r.status);
    const name = `hind-siliguri-${i++}.woff2`;
    writeFileSync(join(dist, 'fonts', name), Buffer.from(await r.arrayBuffer()));
    css = css.split(u).join(name);
  }
  writeFileSync(join(dist, 'fonts', 'fonts.css'), css);
  let html = readFileSync(join(dist, 'index.html'), 'utf8');
  html = html
    .replace(/<link rel="preconnect"[^>]*>\s*/g, '')
    .replace(/<link href="https:\/\/fonts\.googleapis\.com[^>]*>/, '<link rel="stylesheet" href="fonts/fonts.css">');
  writeFileSync(join(dist, 'index.html'), html);
  console.log(`✔ ফন্ট লোকাল হয়েছে (${urls.length}টি ফাইল)`);
}
try { await localizeFonts(); }
catch (e) { console.warn('⚠ ফন্ট লোকাল করা যায়নি (' + e.message + ') — Google Fonts লিংক রাখা হলো'); }

/* ---- ফাইলের তালিকা + ভার্সন ---- */
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(dist).map((p) => relative(dist, p).split(sep).join('/'))
  .filter((f) => f !== 'sw.js' && f !== '.nojekyll').sort();
const hash = createHash('sha1');
files.forEach((f) => { hash.update(f); hash.update(readFileSync(join(dist, f))); });
const version = hash.digest('hex').slice(0, 10);

const precache = ['./', ...files];
let sw = readFileSync(join(dist, 'sw.js'), 'utf8');
sw = sw.replace('__VERSION__', version).replace('__FILES__', JSON.stringify(precache).replace(/\\/g, '\\\\').replace(/'/g, "\\'"));
writeFileSync(join(dist, 'sw.js'), sw);
writeFileSync(join(dist, 'version.json'), JSON.stringify({ version, files: precache.length, built: new Date().toISOString() }));
console.log(`✔ dist/ প্রস্তুত — ভার্সন ${version}, ${precache.length}টি ফাইল প্রি-ক্যাশ হবে`);
