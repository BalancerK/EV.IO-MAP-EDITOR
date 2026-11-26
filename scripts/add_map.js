// Add, refresh or remove ev.io maps in maps/extra-maps.json — the hosted list of extra maps the
// EV.IO custom server and the EV.IO UI Enhancer extension merge into their map lists.
//
//   node scripts/add_map.js 830 [831 ...]      add or refresh (re-run after a map is re-uploaded)
//   node scripts/add_map.js --remove 830        remove
//
// Each entry is resolved from the map's public node record, https://ev.io/node/<nid>?_format=json,
// so the list carries everything a reader needs (title, file, images) and readers make one request
// for the whole list. Run by hand or by the "Add ev.io map" GitHub Actions workflow.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const LIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'maps', 'extra-maps.json');
// Readers accept only map files on ev.io's own file store; refuse anything else up front too.
export const EVMAP_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/maps\/[A-Za-z0-9._%-]+\.evmap$/;
const IMAGE_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/[A-Za-z0-9._%\/-]+\.(png|jpe?g)$/i;
// The map's background sound (its Ambient Track); readers send it to the game as the room's ambient URL.
const AMBIENT_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/ambient_tracks\/[A-Za-z0-9._%-]+\.(ogg|mp3)$/i;
// Environment Effect terms on ev.io. The node record gives only the term id (ev.io will not serve the
// term page itself); readers turn these names into the game's weather flags.
const EFFECT_TERMS = { 66: 'Snow', 67: 'Rain', 68: 'Lightning', 69: 'Dust' };

const first = (v) => (Array.isArray(v) ? v[0] : v);
const tidyUrl = (u) => (u ? u.replace('https://ev.io//', 'https://ev.io/') : null);

async function getJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'evio-map-list/1.0' } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
}

async function resolve(nid) {
    const node = await getJson(`https://ev.io/node/${nid}?_format=json`);
    if (first(node.type)?.target_id !== 'map') throw new Error(`ev.io/node/${nid} is not a map`);
    const evmapUrl = tidyUrl(first(node.field_map)?.url);
    if (!evmapUrl || !EVMAP_URL_RE.test(evmapUrl)) throw new Error(`ev.io/node/${nid}: no usable .evmap file (${evmapUrl})`);
    const img = (f) => { const u = tidyUrl(first(f)?.url); return u && IMAGE_URL_RE.test(u) ? u : null; };
    let author = null;
    const uid = first(node.uid)?.target_id;
    if (uid) {
        try { author = first((await getJson(`https://ev.io/user/${uid}?_format=json`)).name)?.value || null; } catch { /* optional */ }
    }
    return {
        nid,
        title: String(first(node.title)?.value || `Map ${nid}`).slice(0, 80),
        author,
        evmapUrl,
        thumbUrl: img(node.field_map_thumbnail),
        largeImageUrl: img(node.field_large_image),
        ambientUrl: (() => { const u = tidyUrl(first(node.field_ambient_track)?.url); return u && AMBIENT_URL_RE.test(u) ? u : null; })(),
        effects: (node.field_environment_effect || []).map((t) => EFFECT_TERMS[t && t.target_id]).filter(Boolean),
        approvedForPrivateGames: !!first(node.field_allow_private_games)?.value,
        updated: first(node.changed)?.value || null,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const remove = args[0] === '--remove';
    const nids = (remove ? args.slice(1) : args).map(Number);
    if (!nids.length || nids.some((n) => !Number.isInteger(n) || n <= 0)) {
        console.error('usage: node scripts/add_map.js <nid> [nid ...]   |   node scripts/add_map.js --remove <nid> [nid ...]');
        process.exit(2);
    }
    const list = fs.existsSync(LIST) ? JSON.parse(fs.readFileSync(LIST, 'utf8')) : { version: 1, maps: [] };
    const before = JSON.stringify([...list.maps].sort((a, b) => a.nid - b.nid));
    for (const nid of nids) {
        const before = list.maps.length;
        list.maps = list.maps.filter((m) => m.nid !== nid);
        if (remove) { console.log(before === list.maps.length ? `#${nid} was not listed` : `removed #${nid}`); continue; }
        const entry = await resolve(nid);
        list.maps.push(entry);
        console.log(`${before === list.maps.length ? 'refreshed' : 'added'} #${nid} "${entry.title}"${entry.author ? ` by ${entry.author}` : ''} -> ${entry.evmapUrl}`);
    }
    list.maps.sort((a, b) => a.title.localeCompare(b.title));
    if (JSON.stringify([...list.maps].sort((a, b) => a.nid - b.nid)) === before) {
        console.log('list unchanged');
        return;   // leave the file (and its timestamp) alone, so a no-op run commits nothing
    }
    list.updated = new Date().toISOString();
    fs.mkdirSync(path.dirname(LIST), { recursive: true });
    fs.writeFileSync(LIST, JSON.stringify(list, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch((e) => { console.error(e.message); process.exit(1); });
}
