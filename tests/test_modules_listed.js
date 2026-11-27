// index.html versions every module through its MODULES list (so a deploy never runs old cached
// scripts): every file in src/ must be listed, or that file can be served stale after an update.
//   node tests/test_modules_listed.js
import fs from 'fs';
import path from 'path';
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const listed = new Set(JSON.parse(html.match(/var MODULES = (\[[^\]]*\])/)[1].replace(/'/g, '"')));
const files = [];
const walk = (d) => { for (const f of fs.readdirSync(path.join(root, 'src', d), { withFileTypes: true })) { const r = d ? `${d}/${f.name}` : f.name; if (f.isDirectory()) walk(r); else if (f.name.endsWith('.js')) files.push(r); } };
walk('');
const missing = files.filter((f) => !listed.has(f)), extra = [...listed].filter((f) => !files.includes(f));
if (missing.length || extra.length) { console.log('FAIL index.html MODULES', { missing, extra }); process.exit(1); }
console.log(`all ${files.length} modules listed`);
