import { layoutText } from './renderer.js';
const e = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const f = n => Math.round(n * 10000) / 10000;
function dFor(n) {
    if (n.type === 'line')
        return `M0 0L${f(n.w)} ${f(n.h)}`;
    const pts = n.points || [];
    if (!pts.length)
        return '';
    const sx = n.w / (n.pathW || n.w || 1), sy = n.h / (n.pathH || n.h || 1);
    const xy = p => `${f(p.x * sx)} ${f(p.y * sy)}`;
    let d = 'M' + xy(pts[0]);
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        d += a.out || b.in ? `C${xy(a.out || a)} ${xy(b.in || b)} ${xy(b)}` : `L${xy(b)}`;
    }
    if (n.closed) {
        const a = pts.at(-1), b = pts[0];
        if (a.out || b.in)
            d += `C${xy(a.out || a)} ${xy(b.in || b)} ${xy(b)}`;
        d += 'Z';
    }
    return d;
}
export function exportSVG(doc, ids) {
    const roots = doc.roots(ids), box = doc.bounds(roots.map(n => n.id));
    if (!box)
        throw new Error('Nothing to export.');
    const include = new Set();
    for (const n of roots) {
        include.add(n.id);
        doc.descendants(n.id).forEach(c => include.add(c.id));
    }
    let defs = '', body = '', index = 0;
    for (const s of doc.scene()) {
        const n = s.node;
        if (!include.has(n.id) || n.type === 'group')
            continue;
        const prefix = 'v' + index++;
        let fill = n.fill || 'none';
        if (n.fillType === 'linear' && n.fill !== 'none') {
            const r = n.gradientAngle * Math.PI / 180, c = Math.cos(r), ss = Math.sin(r), len = Math.abs(n.w * c) + Math.abs(n.h * ss);
            defs += `<linearGradient id="${prefix}g" gradientUnits="userSpaceOnUse" x1="${f(n.w / 2 - c * len / 2)}" y1="${f(n.h / 2 - ss * len / 2)}" x2="${f(n.w / 2 + c * len / 2)}" y2="${f(n.h / 2 + ss * len / 2)}"><stop stop-color="${e(n.fill)}"/><stop offset="1" stop-color="${e(n.fill2)}"/></linearGradient>`;
            fill = `url(#${prefix}g)`;
        }
        let attrs = `fill="${e(fill)}" fill-opacity="${f(n.fillOpacity ?? 1)}" stroke="${e(n.stroke || 'none')}" stroke-width="${f(n.strokeWidth || 0)}" stroke-linecap="round" stroke-linejoin="round"`;
        let item = '';
        if (n.shadow) {
            defs += `<filter id="${prefix}s" x="-100%" y="-100%" width="300%" height="300%" color-interpolation-filters="sRGB"><feDropShadow dx="${f(n.shadowX || 0)}" dy="${f(n.shadowY || 0)}" stdDeviation="${f((n.shadowBlur || 20) / 2)}" flood-color="${e(n.shadowColor || '#000000')}" flood-opacity="${f(n.shadowOpacity ?? .16)}"/></filter>`;
            attrs += ` filter="url(#${prefix}s)"`;
        }
        if (n.type === 'text') {
            const l = layoutText(n), anchor = n.textAlign === 'center' ? 'middle' : n.textAlign === 'right' ? 'end' : 'start', x = n.textAlign === 'center' ? n.w / 2 : n.textAlign === 'right' ? n.w : 0;
            defs += `<clipPath id="${prefix}t"><rect width="${f(n.w)}" height="${f(n.h)}"/></clipPath>`;
            item = `<text clip-path="url(#${prefix}t)" font-family="${e(n.fontFamily)}, sans-serif" font-size="${f(n.fontSize)}" font-weight="${e(n.fontWeight)}" font-style="${e(n.fontStyle)}" letter-spacing="${f(n.letterSpacing || 0)}" text-anchor="${anchor}" text-decoration="${e(n.textDecoration || 'none')}" direction="${n.direction === 'rtl' ? 'rtl' : 'ltr'}" fill="${e(fill)}" fill-opacity="${f(n.fillOpacity ?? 1)}" xml:space="preserve">${l.lines.map((line, i) => `<tspan x="${f(x)}" y="${f(l.baseline + i * l.lineHeight)}">${e(line)}</tspan>`).join('')}</text>`;
        }
        else if (n.type === 'image') {
            defs += `<clipPath id="${prefix}i"><rect width="${f(n.w)}" height="${f(n.h)}" rx="${f(n.radius || 0)}"/></clipPath>`;
            item = `<image href="${e(doc.data.assets[n.assetId] || '')}" width="${f(n.w)}" height="${f(n.h)}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${prefix}i)"/>`;
            if (n.strokeWidth)
                item += `<rect width="${f(n.w)}" height="${f(n.h)}" rx="${f(n.radius)}" fill="none" stroke="${e(n.stroke)}" stroke-width="${f(n.strokeWidth)}"/>`;
        }
        else if (n.type === 'ellipse')
            item = `<ellipse cx="${f(n.w / 2)}" cy="${f(n.h / 2)}" rx="${f(n.w / 2)}" ry="${f(n.h / 2)}" ${attrs}/>`;
        else if (n.type === 'path' || n.type === 'line')
            item = `<path d="${dFor(n)}" ${attrs}/>`;
        else
            item = `<rect width="${f(n.w)}" height="${f(n.h)}" rx="${f(Math.min(n.radius || 0, n.w / 2, n.h / 2))}" ${attrs}/>`;
        let wrapped = `<g transform="matrix(${s.matrix.map(f).join(' ')})" opacity="${f(s.opacity)}"><title>${e(n.name)}</title>${item}</g>`;
        s.clips.forEach((c, j) => { defs += `<clipPath id="${prefix}c${j}" clipPathUnits="userSpaceOnUse"><rect width="${f(c.w)}" height="${f(c.h)}" rx="${f(c.radius || 0)}" transform="matrix(${c.matrix.map(f).join(' ')})"/></clipPath>`; wrapped = `<g clip-path="url(#${prefix}c${j})">${wrapped}</g>`; });
        body += wrapped;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${f(box.w)}" height="${f(box.h)}" viewBox="${f(box.x)} ${f(box.y)} ${f(box.w)} ${f(box.h)}"><title>${e(doc.data.name)}</title><desc>Created with Vellum. Text uses installed fonts, which are not embedded.</desc><defs>${defs}</defs>${body}</svg>`;
}
