// The original .evmap files that opened documents are based on, kept in the browser (IndexedDB),
// so a reload can show the map's geometry again without asking for the file. Each file is stored
// once under its content hash; files no document refers to are pruned.
const DB = 'evio-map-editor';
const STORE = 'base-maps';

function open() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function run(mode, fn) {
    const db = await open();
    try {
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, mode);
            const req = fn(tx.objectStore(STORE));
            tx.oncomplete = () => resolve(req && req.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    } finally { db.close(); }
}

/** A short content hash naming a file (SHA-256, first 16 bytes as hex). */
export async function fileKey(bytes) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return 'sha256:' + Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}
export async function putFile(key, bytes, name) {
    try { await run('readwrite', (s) => s.put({ name, bytes, savedAt: Date.now() }, key)); return true; } catch { return false; }
}
export async function getFile(key) {
    try { return (await run('readonly', (s) => s.get(key))) || null; } catch { return null; }
}
/** Delete stored files other than `keep` (the keys still in use). */
export async function pruneFiles(keep) {
    try {
        const keys = await run('readonly', (s) => s.getAllKeys());
        const drop = (keys || []).filter((k) => !keep.includes(k));
        if (drop.length) await run('readwrite', (s) => { drop.forEach((k) => s.delete(k)); return null; });
    } catch { /* storage unavailable */ }
}
