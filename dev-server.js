/**
 * স্থানীয় ডেভ সার্ভার (নিজের কম্পিউটারে পরীক্ষার জন্য):
 *   dist/ ফোল্ডার + একটি নকল "Apps Script Web App" (/exec) — যেখানে আসল Code.gs + Api.gs চলে।
 *   চালান:  node build.mjs && node tests/dev-server.js   →  http://localhost:8123
 *   Web app URL: http://localhost:8123/exec    API Key: test-key
 */
const http = require('http'), fs = require('fs'), path = require('path');
const { makeEnv } = require('./harness');
const PORT = Number(process.env.PORT || 8123), KEY = 'test-key';
const dist = path.join(__dirname, '../dist');

const server = makeEnv({ server: true, now: process.env.NOW || new Date().toISOString() });
server.clock.now = new Date();   // আসল সময়
server.call('setupDatabase'); server.call('importExcelProducts');
require('vm').runInContext("PropertiesService.getScriptProperties().setProperty('API_KEY','" + KEY + "')", server.ctx);

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.css': 'text/css' };
http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/exec')) {
    let b = ''; req.on('data', c => b += c);
    req.on('end', () => {
      server.clock.now = new Date();
      const out = server.call('doPost', { postData: { contents: b } });
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(out.text);
    });
    return;
  }
  if (req.url === '/__state') {   // টেস্টের জন্য সার্ভারের ডাটা দেখা
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ tables: server.store.tables }));
  }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
  const f = path.join(dist, p);
  if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT, () => console.log('dev server: http://localhost:' + PORT + '   (Web app URL: /exec, API Key: ' + KEY + ')'));
