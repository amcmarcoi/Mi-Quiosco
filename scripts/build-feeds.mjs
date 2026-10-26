// Lee los medios desde Firestore (lectura pública), descarga cada RSS/sitemap
// directamente (sin CORS) y genera feeds.json en la raíz del repo.
// Se ejecuta en GitHub Actions. Node 20+ (fetch global).

import { writeFileSync } from 'fs';

const PROJECT = 'mi-quiosco-48211';
const API_KEY = 'AIzaSyBkzM8j9-uw8hrDimBF0ez2ER4j54Vk3Ko'; // apiKey pública del proyecto
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/medios?pageSize=300&key=${API_KEY}`;
const MAX_ITEMS = 15;

function campo(f) {
    if (!f) return '';
    return f.stringValue ?? f.integerValue ?? f.doubleValue ?? '';
}

async function obtenerMedios() {
    const r = await fetch(FIRESTORE);
    if (!r.ok) throw new Error('Firestore ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.documents || []).map(d => ({
        n: campo(d.fields?.n),
        t: campo(d.fields?.t),
        u: campo(d.fields?.u),
        tipo: campo(d.fields?.tipo) || 'rss',
    })).filter(m => m.u);
}

function limpiar(s) {
    return (s || '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim();
}

function parseRSS(xml) {
    let bloques = xml.match(/<item[\s>][\s\S]*?<\/item>/gi);
    if (!bloques || bloques.length === 0) bloques = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    return bloques.map(b => {
        const tit = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
        let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
        if (!link.trim()) {
            const m = b.match(/<link[^>]*href=["']([^"']+)["']/i);
            if (m) link = m[1];
        }
        let img = '';
        let m = b.match(/<media:(?:content|thumbnail)[^>]*url=["']([^"']+)["']/i);
        if (m) img = m[1];
        if (!img) { m = b.match(/<enclosure[^>]*url=["']([^"']+)["']/i); if (m) img = m[1]; }
        if (!img) { m = b.match(/<img[^>]+src=["']([^"']+)["']/i); if (m) img = m[1]; }
        return { titulo: limpiar(tit) || limpiar(link), link: limpiar(link), img: (img || '').trim() };
    }).filter(x => x.link).slice(0, MAX_ITEMS);
}

function parseSitemap(xml) {
    const bloques = xml.match(/<url>[\s\S]*?<\/url>/gi) || [];
    return bloques.map(b => {
        const loc = (b.match(/<loc>([\s\S]*?)<\/loc>/i) || [])[1] || '';
        const tit = (b.match(/<news:title>([\s\S]*?)<\/news:title>/i) || b.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || loc;
        const img = (b.match(/<image:loc>([\s\S]*?)<\/image:loc>/i) || [])[1] || '';
        return { titulo: limpiar(tit), link: limpiar(loc), img: limpiar(img) };
    }).filter(x => x.link).slice(0, MAX_ITEMS);
}

async function descargar(m) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20000);
    try {
        const r = await fetch(m.u, {
            signal: ctrl.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; QuioscoBot/1.0)' },
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const xml = await r.text();
        return m.tipo === 'sitemap' ? parseSitemap(xml) : parseRSS(xml);
    } finally {
        clearTimeout(timer);
    }
}

const medios = await obtenerMedios();
const salida = { generadoEn: Date.now(), medios: [] };

for (const m of medios) {
    let items = [];
    try {
        items = await descargar(m);
        console.log(`OK  ${m.n} — ${items.length} noticias`);
    } catch (e) {
        console.error(`ERR ${m.n} (${m.u}): ${e.message}`);
    }
    salida.medios.push({ n: m.n, t: m.t, u: m.u, tipo: m.tipo, items });
}

writeFileSync('feeds.json', JSON.stringify(salida));
console.log(`\nGenerado feeds.json con ${salida.medios.length} medios.`);
