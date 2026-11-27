// Optional dependency-free local server: node server.cjs
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const allowed = new Set(['index.html', 'styles.css', 'app.js', 'model.js', 'gift-sources.js', 'published-data.js']);
allowed.add(decodeURIComponent('%E5%A4%AA%E8%81%AA%E6%98%8E-%E9%99%88%E7%BB%AE%E8%B4%9E.mp3'));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
types['.mp3'] = 'audio/mpeg';
http.createServer((req, res) => {
  let name;
  try { name = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname.slice(1)) || 'index.html'; }
  catch { res.writeHead(400); return res.end('Invalid URL'); }
  if (!allowed.has(name)) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(__dirname, name), (error, data) => {
    if (error) { res.writeHead(500); return res.end('Unable to read file'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(name)], 'Cache-Control': 'no-store' }); res.end(data);
  });
}).listen(4173, '127.0.0.1', () => console.log('Open http://127.0.0.1:4173'));
