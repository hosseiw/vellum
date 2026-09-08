/** Vellum document model. Coordinates are local to the parent; affine transforms compose top-down. */
export const uid = () => globalThis.crypto?.randomUUID?.() || `v${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const identity = () => [1, 0, 0, 1, 0, 0];
export const multiply = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
export const inverse = m => {
    const d = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(d) < 1e-12)
        return identity();
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
};
export const point = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
export function localMatrix(n) { const r = (n.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), cx = n.w / 2, cy = n.h / 2; return [c, s, -s, c, n.x + cx - c * cx + s * cy, n.y + cy - s * cx - c * cy]; }
export function boxOf(m, w, h) { const p = [point(m, 0, 0), point(m, w, 0), point(m, w, h), point(m, 0, h)]; const xs = p.map(v => v.x), ys = p.map(v => v.y); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }; }
export function union(boxes) {
    if (!boxes.length)
        return null;
    let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
    for (const q of boxes) {
        x = Math.min(x, q.x);
        y = Math.min(y, q.y);
        r = Math.max(r, q.x + q.w);
        b = Math.max(b, q.y + q.h);
    }
    return { x, y, w: r - x, h: b - y };
}
export const intersects = (a, b) => a.x <= b.x + b.w && a.x + a.w >= b.x && a.y <= b.y + b.h && a.y + a.h >= b.y;
export function color(c, opacity = 1) {
    if (!c || c === 'none')
        return [0, 0, 0, 0];
    let hex = c.replace('#', '');
    if (hex.length === 3)
        hex = hex.split('').map(x => x + x).join('');
    return [parseInt(hex.slice(0, 2), 16) / 255 || 0, parseInt(hex.slice(2, 4), 16) / 255 || 0, parseInt(hex.slice(4, 6), 16) / 255 || 0, (hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1) * opacity];
}
export function node(type, props = {}) { return { id: uid(), type, name: type[0].toUpperCase() + type.slice(1), parentId: null, x: 0, y: 0, w: 160, h: 100, rotation: 0, fill: '#a38bff', fill2: '#e1d8ff', fillType: 'solid', gradientAngle: 90, fillOpacity: 1, stroke: '#000000', strokeWidth: 0, radius: 0, opacity: 1, visible: true, locked: false, clip: false, shadow: false, shadowColor: '#000000', shadowOpacity: .16, shadowBlur: 20, shadowX: 0, shadowY: 6, version: 0, ...(type === 'text' ? { text: 'Type something', fontFamily: 'Inter', fontSize: 24, fontWeight: 400, fontStyle: 'normal', lineHeight: 1.35, letterSpacing: 0, textAlign: 'left', textDecoration: 'none', textCase: 'none', direction: 'auto', fill: '#20202a', w: 240, h: 44 } : {}), ...(type === 'frame' ? { fill: '#ffffff', w: 400, h: 300, clip: true } : {}), ...(type === 'group' ? { fill: 'none' } : {}), ...props }; }
export class DocumentModel {
    constructor(data) { this.data = data || makeStarter(); this.revision = 0; this._sceneRevision = -1; this._scene = []; this._map = new Map(); this._world = new Map(); this.refresh(); }
    get page() { return this.data.pages.find(p => p.id === this.data.pageId) || this.data.pages[0]; }
    get nodes() { return this.page.nodes; }
    get(id) { return this._map.get(id); }
    refresh() { this._map = new Map(this.nodes.map(n => [n.id, n])); this.revision++; this._sceneRevision = -1; }
    touch(n) {
        if (n)
            n.version = (n.version || 0) + 1;
        this.revision++;
        this._sceneRevision = -1;
    }
    add(n) { this.nodes.push(n); this._map.set(n.id, n); this.touch(n); return n; }
    children(id) { return this.nodes.filter(n => n.parentId === id); }
    descendants(id) {
        const out = [], seen = new Set([id]);
        const visit = p => {
            for (const n of this.children(p)) {
                if (!seen.has(n.id)) {
                    seen.add(n.id);
                    out.push(n);
                    visit(n.id);
                }
            }
        };
        visit(id);
        return out;
    }
    roots(ids) { const set = new Set(ids); return ids.map(id => this.get(id)).filter(n => n && !this.ancestors(n).some(p => set.has(p.id))); }
    ancestors(n) {
        const a = [], seen = new Set([n.id]);
        let p = this.get(n.parentId);
        while (p && !seen.has(p.id)) {
            seen.add(p.id);
            a.push(p);
            p = this.get(p.parentId);
        }
        return a;
    }
    remove(ids) {
        const all = new Set(ids);
        for (const id of ids)
            for (const n of this.descendants(id))
                all.add(n.id);
        this.page.nodes = this.nodes.filter(n => !all.has(n.id));
        this.refresh();
    }
    scene() {
        if (this._sceneRevision === this.revision)
            return this._scene;
        const out = [], world = new Map(), byParent = new Map();
        for (const n of this.nodes) {
            const pid = this.get(n.parentId) ? n.parentId : null;
            if (!byParent.has(pid))
                byParent.set(pid, []);
            byParent.get(pid).push(n);
        }
        const walk = (pid, m, opacity, clips, hidden, locked, depth) => {
            if (depth > 100)
                return;
            for (const n of byParent.get(pid) || []) {
                const mat = multiply(m, localMatrix(n)), box = boxOf(mat, n.w, n.h), o = opacity * n.opacity, hide = hidden || !n.visible, lock = locked || n.locked;
                const item = { node: n, matrix: mat, inverse: inverse(mat), box, opacity: o, clips, hidden: hide, locked: lock };
                world.set(n.id, item);
                if (!hide)
                    out.push(item);
                const next = n.type === 'frame' && n.clip ? [...clips, { matrix: mat, inverse: inverse(mat), w: n.w, h: n.h, radius: n.radius }] : clips;
                walk(n.id, mat, o, next, hide, lock, depth + 1);
            }
        };
        walk(null, identity(), 1, [], false, false, 0);
        this._world = world;
        this._scene = out;
        this._sceneRevision = this.revision;
        return out;
    }
    world(id) { this.scene(); return this._world.get(id); }
    bounds(ids) { return union((ids ? ids.map(id => this.world(id)) : this.scene().filter(s => !s.node.parentId)).filter(Boolean).map(s => s.box)); }
    snapshot() { return JSON.stringify({ name: this.data.name, pages: this.data.pages, pageId: this.data.pageId, tokens: this.data.tokens }); }
    restore(s) { Object.assign(this.data, JSON.parse(s)); this.refresh(); }
    serialize() { return JSON.stringify({ ...this.data, format: 'vellum', version: 1 }, null, 2); }
    static parse(text) {
        const d = JSON.parse(text);
        if (d.format !== 'vellum' || d.version !== 1 || !Array.isArray(d.pages) || !d.pages.length)
            throw new Error('This is not a supported Vellum document.');
        if (d.pages.length > 100)
            throw new Error('A document can contain at most 100 pages.');
        const all = new Set();
        let total = 0;
        const valid = new Set(['rect', 'ellipse', 'text', 'frame', 'group', 'path', 'line', 'image']);
        for (const p of d.pages) {
            if (typeof p.id !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(p.id) || typeof p.name !== 'string' || !Array.isArray(p.nodes))
                throw new Error('Invalid page.');
            total += p.nodes.length;
            if (total > 50000)
                throw new Error('Document exceeds 50,000 layers.');
            const ids = new Set(p.nodes.map(n => n.id));
            for (let i = 0; i < p.nodes.length; i++) {
                const n = p.nodes[i];
                if (typeof n.id !== 'string' || !/^[-_a-zA-Z0-9]{1,128}$/.test(n.id) || all.has(n.id) || !valid.has(n.type))
                    throw new Error('Invalid or duplicate layer.');
                all.add(n.id);
                for (const k of ['x', 'y', 'w', 'h', 'rotation', 'opacity']) {
                    if (typeof n[k] !== 'number' || !Number.isFinite(n[k]) || Math.abs(n[k]) > 1e7)
                        throw new Error(`Invalid ${k} in layer.`);
                }
                if (n.w < 0 || n.h < 0)
                    throw new Error('Negative layer dimensions.');
                if (n.parentId && !ids.has(n.parentId))
                    throw new Error('Invalid layer parent.');
                if (typeof n.name !== 'string')
                    n.name = n.type;
                if (n.text !== undefined && typeof n.text !== 'string')
                    throw new Error('Invalid text content.');
                if (n.points) {
                    if (!Array.isArray(n.points) || n.points.length > 50000)
                        throw new Error('Invalid vector path.');
                    for (const p of n.points)
                        for (const q of [p, p.in, p.out].filter(Boolean))
                            if (!Number.isFinite(q.x) || !Number.isFinite(q.y))
                                throw new Error('Invalid vector point.');
                }
                if (n.text && n.text.length > 100000)
                    throw new Error('Text layer is too large.');
                p.nodes[i] = node(n.type, n);
            }
            const map = new Map(p.nodes.map(n => [n.id, n]));
            for (const n of p.nodes) {
                const seen = new Set([n.id]);
                let par = map.get(n.parentId), depth = 0;
                while (par) {
                    if (seen.has(par.id) || ++depth > 100)
                        throw new Error('Cyclic or overly deep hierarchy.');
                    seen.add(par.id);
                    par = map.get(par.parentId);
                }
            }
        }
        d.assets ||= {};
        for (const v of Object.values(d.assets)) {
            if (typeof v !== 'string' || !/^data:image\/(png|jpeg|webp|gif|svg\+xml);/i.test(v))
                throw new Error('Unsupported image asset.');
        }
        d.tokens ||= defaultTokens();
        d.pageId = d.pages.some(p => p.id === d.pageId) ? d.pageId : d.pages[0].id;
        return d;
    }
}
export class History {
    constructor(doc) { this.doc = doc; this.undoStack = []; this.redoStack = []; this.pending = null; }
    // Strings are immutable: shallow copies retain image/font data without serializing binary
    // payloads into every geometry snapshot. Replacing a document is therefore reversible.
    capture(label) {
        return { label, snapshot: this.doc.snapshot(), assets: { ...this.doc.data.assets }, fonts: { ...this.doc.data.fonts } };
    }
    apply(entry) {
        this.doc.data.assets = { ...entry.assets };
        this.doc.data.fonts = { ...entry.fonts };
        this.doc.restore(entry.snapshot);
    }
    begin(label = 'Edit') { if (!this.pending)
        this.pending = this.capture(label); }
    commit() {
        if (!this.pending)
            return false;
        const entry = this.pending;
        this.pending = null;
        const sameMap = (a, b = {}) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => a[key] === b[key]);
        if (entry.snapshot === this.doc.snapshot() && sameMap(entry.assets, this.doc.data.assets) && sameMap(entry.fonts, this.doc.data.fonts))
            return false;
        this.undoStack.push(entry);
        if (this.undoStack.length > 80)
            this.undoStack.shift();
        this.redoStack = [];
        return true;
    }
    cancel() { if (this.pending) {
        this.apply(this.pending);
        this.pending = null;
    } }
    undo() {
        this.commit();
        const entry = this.undoStack.pop();
        if (!entry)
            return null;
        this.redoStack.push(this.capture(entry.label));
        this.apply(entry);
        return entry.label;
    }
    redo() {
        const entry = this.redoStack.pop();
        if (!entry)
            return null;
        this.undoStack.push(this.capture(entry.label));
        this.apply(entry);
        return entry.label;
    }
}
export function defaultTokens() { return { colors: [{ name: 'Brand / Iris', value: '#8462e8' }, { name: 'Brand / Lavender', value: '#eee8fb' }, { name: 'Neutral / Ink', value: '#242130' }, { name: 'Neutral / Paper', value: '#faf9fc' }, { name: 'Accent / Mint', value: '#c7e6d7' }, { name: 'Accent / Peach', value: '#f2d4bb' }], typography: [{ name: 'Display / Large', size: 40, weight: 600, lineHeight: 1.1 }, { name: 'Heading / Medium', size: 24, weight: 600, lineHeight: 1.25 }, { name: 'Body / Regular', size: 14, weight: 400, lineHeight: 1.5 }, { name: 'Label / Small', size: 11, weight: 500, lineHeight: 1.3 }] }; }
export function makeStarter() {
    const p = { id: uid(), name: 'Design exploration', nodes: [] }, ds = { id: uid(), name: 'Design system', nodes: [] }, play = { id: uid(), name: 'Playground', nodes: [] };
    let page = p;
    const add = (type, props) => { const n = node(type, props); page.nodes.push(n); return n; };
    const rect = (parent, x, y, w, h, fill, radius = 0, name = 'Surface', extra = {}) => add('rect', { parentId: parent?.id || null, x, y, w, h, fill, radius, name, ...extra });
    const text = (parent, x, y, w, h, str, size = 14, fill = '#282431', weight = 400, extra = {}) => add('text', { parentId: parent?.id || null, x, y, w, h, text: str, fontSize: size, fill, fontWeight: weight, name: str.length > 28 ? str.slice(0, 27) + '…' : str, lineHeight: 1.3, ...extra });
    const ellipse = (parent, x, y, w, h, fill, extra = {}) => add('ellipse', { parentId: parent?.id || null, x, y, w, h, fill, name: 'Ellipse', ...extra });
    const ln = (parent, x, y, w, h, stroke = '#e9e6ee', sw = 1) => add('line', { parentId: parent?.id || null, x, y, w, h, fill: 'none', stroke, strokeWidth: sw, name: 'Divider' });
    const dash = add('frame', { x: 0, y: 0, w: 1000, h: 720, fill: '#faf9fc', radius: 12, name: '01 · Workspace / Desktop', shadow: true, shadowOpacity: .24, shadowBlur: 24, shadowY: 12 });
    const side = add('frame', { parentId: dash.id, x: 0, y: 0, w: 184, h: 720, fill: '#ffffff', name: 'Navigation', clip: false });
    text(side, 28, 30, 26, 35, '◒', 30, '#8260df', 700);
    text(side, 62, 34, 99, 30, 'forma', 24, '#282431', 650, { letterSpacing: -1.2 });
    rect(side, 18, 95, 148, 37, '#f5f3f8', 7, 'Workspace switcher');
    rect(side, 27, 103, 20, 20, '#e8e0f6', 5);
    text(side, 31, 105, 17, 18, 'S', 12, '#7a5dc1', 650);
    text(side, 55, 106, 93, 20, 'Studio workspace', 10, '#5d566a', 500);
    text(side, 150, 106, 10, 17, '⌄', 12, '#81778c');
    text(side, 27, 159, 125, 15, 'WORKSPACE', 8, '#a29aaa', 550, { letterSpacing: 1.3 });
    const nav = [['▦', 'Overview', true], ['□', 'My projects', false], ['◷', 'Schedule', false], ['▤', 'All tasks', false], ['◇', 'Team members', false]];
    nav.forEach(([icon, label, active], i) => {
        if (active)
            rect(side, 15, 185 + i * 42, 154, 35, '#eee8fb', 7, label + ' active');
        text(side, 28, 194 + i * 42, 20, 20, icon, 14, active ? '#815dd9' : '#a399af', 500);
        text(side, 57, 195 + i * 42, 103, 18, label, 10, active ? '#7954d3' : '#77707f', active ? 600 : 400);
        if (label === 'All tasks') {
            rect(side, 140, 197 + i * 42, 17, 15, '#f0edf4', 4);
            text(side, 145, 199 + i * 42, 12, 13, '8', 8, '#8d829b', 500);
        }
    });
    ln(side, 24, 415, 136, 0);
    text(side, 27, 440, 110, 18, 'FAVORITES', 8, '#a29aaa', 550, { letterSpacing: 1.2 });
    text(side, 29, 475, 137, 20, '●     Website redesign', 10, '#8f7dae');
    text(side, 29, 509, 137, 20, '●     Mobile experience', 10, '#89a897');
    rect(side, 19, 593, 146, 68, '#f7f4fc', 9, 'Upgrade card');
    text(side, 31, 605, 126, 20, 'Room for more ideas.', 10, '#625075', 600);
    text(side, 31, 629, 126, 20, 'Explore Forma Pro   ↗', 9, '#9370d6', 500);
    ellipse(side, 25, 679, 25, 25, '#e9d8c9');
    text(side, 31, 684, 17, 18, 'JD', 8, '#8c6958', 600);
    text(side, 59, 680, 97, 18, 'Jamie Davis', 10, '#4c425b', 500);
    text(side, 59, 695, 90, 13, 'Personal account', 7, '#aaa0b2');
    ln(dash, 184, 0, 0, 720, '#ece9f1');
    text(dash, 219, 31, 150, 24, 'Overview', 15, '#40394c', 600);
    text(dash, 744, 36, 148, 19, '⌕    Search anything…', 10, '#a89faf');
    ellipse(dash, 930, 28, 28, 28, '#efe9f8');
    text(dash, 939, 35, 16, 17, '✧', 12, '#8d75b8');
    ln(dash, 184, 79, 816, 0, '#ebe8f0');
    text(dash, 219, 105, 465, 38, 'Good morning, Jamie', 27, '#302937', 600, { letterSpacing: -.8 });
    text(dash, 220, 149, 493, 25, "Let’s make space for your best work.", 11, '#9a91a3');
    rect(dash, 811, 114, 152, 32, '#ffffff', 6, 'Date', { stroke: '#e9e4ef', strokeWidth: 1 });
    text(dash, 824, 123, 136, 20, '▦   Monday, September 7', 9, '#83788f');
    const hero = add('frame', { parentId: dash.id, x: 219, y: 191, w: 464, h: 158, fill: '#eae1fa', radius: 11, name: 'Your ideas. In motion.', clip: true });
    text(hero, 25, 20, 240, 18, 'A LITTLE FOCUS GOES A LONG WAY', 7.5, '#9b83bb', 600, { letterSpacing: .9 });
    text(hero, 25, 47, 289, 36, 'Your ideas. In motion.', 24, '#624984', 600, { letterSpacing: -.6 });
    text(hero, 25, 84, 273, 20, 'Turn today’s inspiration into tomorrow’s great work.', 9, '#9580af');
    rect(hero, 25, 113, 112, 28, '#8260d4', 6, 'Explore projects');
    text(hero, 40, 121, 93, 15, 'Explore projects   ↗', 8, '#ffffff', 500);
    ellipse(hero, 336, 28, 158, 158, '#d4c2ed', { name: 'Decorative orb' });
    ellipse(hero, 363, 51, 101, 101, '#e4d7f4');
    ellipse(hero, 389, 77, 48, 48, '#f5effd');
    rect(hero, 324, 32, 66, 14, '#eae1fa', 5, 'Orbit cut', { rotation: -38 });
    rect(hero, 352, 129, 88, 16, '#eae1fa', 7, 'Orbit cut', { rotation: -38 });
    const progress = add('frame', { parentId: dash.id, x: 699, y: 191, w: 265, h: 158, fill: '#ffffff', radius: 11, name: 'Weekly progress' });
    text(progress, 18, 19, 192, 24, 'Your weekly progress', 11, '#615469', 600);
    text(progress, 18, 49, 114, 48, '82%', 34, '#4f425b', 600, { letterSpacing: -1.5 });
    text(progress, 19, 96, 113, 18, '↑  12% from last week', 8, '#80a18d');
    text(progress, 19, 129, 163, 19, 'You’re finding your rhythm. Nice work.', 8, '#aaa0b1');
    ellipse(progress, 168, 56, 69, 69, 'none', { stroke: '#eee8f7', strokeWidth: 8, name: 'Progress track' });
    add('path', { parentId: progress.id, x: 168, y: 56, w: 69, h: 69, points: [{ x: 34.5, y: 0 }, { x: 63, y: 14 }, { x: 69, y: 43 }, { x: 49, y: 65 }, { x: 20, y: 67 }, { x: 1, y: 44 }], closed: false, stroke: '#a286d8', strokeWidth: 8, fill: 'none', name: 'Progress arc' });
    text(progress, 186, 78, 44, 23, '✦', 24, '#9e82d5', 600);
    text(dash, 220, 379, 309, 29, 'Your projects', 17, '#4b4057', 600, { letterSpacing: -.3 });
    text(dash, 874, 384, 97, 20, 'View all projects  →', 9, '#ab9db7');
    const cards = [{ x: 219, bg: '#f0eaf9', dot: '#9d81c5', name: 'Website redesign', tag: 'Design', pct: 72, people: '#dcc9d8', desc: 'A fresh perspective for a familiar brand.' }, { x: 471, bg: '#eaf1ec', dot: '#87a691', name: 'Mobile experience', tag: 'Product', pct: 48, people: '#c8d6ce', desc: 'Small screen. Big possibilities.' }, { x: 723, bg: '#f6efe7', dot: '#c4a47f', name: 'Brand foundations', tag: 'Strategy', pct: 91, people: '#e1c6b4', desc: 'Everything that makes us, us.' }];
    cards.forEach((c, i) => { const frame = add('frame', { parentId: dash.id, x: c.x, y: 420, w: 241, h: 170, fill: '#ffffff', radius: 10, name: c.name, stroke: '#eeeaf2', strokeWidth: 1 }); rect(frame, 15, 16, 31, 31, c.bg, 8, 'Project icon'); text(frame, 25, 22, 24, 25, ['✳', '▦', '◇'][i], 17, c.dot); text(frame, 208, 18, 20, 19, '···', 12, '#aca1b7'); text(frame, 16, 61, 210, 24, c.name, 13, '#5f526c', 600); text(frame, 16, 88, 218, 21, c.desc, 8, '#ab9fb5'); rect(frame, 16, 117, 208, 4, '#f3eff6', 2, 'Progress track'); rect(frame, 16, 117, 208 * c.pct / 100, 4, c.dot, 2, 'Progress'); ellipse(frame, 17, 140, 17, 17, c.people); ellipse(frame, 30, 140, 17, 17, '#e8e0ed', { stroke: '#ffffff', strokeWidth: 2 }); ellipse(frame, 43, 140, 17, 17, '#d9d0e4', { stroke: '#ffffff', strokeWidth: 2 }); text(frame, 182, 141, 44, 14, `${c.pct}% done`, 8, '#9d8eaa'); });
    text(dash, 220, 618, 276, 25, 'A little momentum', 16, '#554760', 600, { letterSpacing: -.4 });
    text(dash, 819, 623, 150, 18, 'Your most recent activity', 8, '#b0a3bb');
    rect(dash, 220, 656, 743, 43, '#ffffff', 8, 'Activity');
    ellipse(dash, 235, 667, 22, 22, '#e8dceb');
    text(dash, 242, 672, 15, 15, 'A', 8, '#a178b3', 500);
    text(dash, 269, 670, 463, 19, 'Alex added new explorations to Website redesign', 10, '#8b7b99');
    text(dash, 882, 672, 72, 16, '2 min ago', 8, '#b5a9bf');
    const mob = add('frame', { x: 1064, y: 0, w: 310, h: 670, fill: '#22202c', radius: 28, name: '02 · Focus / Mobile', shadow: true, shadowOpacity: .28, shadowBlur: 22, shadowY: 12 });
    text(mob, 24, 19, 55, 24, '9:41', 12, '#faf8fd', 600);
    rect(mob, 230, 25, 12, 7, '#d6d0e2', 2);
    rect(mob, 248, 22, 15, 10, 'none', 2, 'Battery', { stroke: '#d6d0e2', strokeWidth: 1 });
    rect(mob, 250, 24, 10, 6, '#d6d0e2', 1);
    text(mob, 24, 66, 202, 23, 'forma', 22, '#f0eafb', 600, { letterSpacing: -1 });
    ellipse(mob, 258, 66, 27, 27, '#393341');
    text(mob, 266, 72, 16, 18, '✧', 13, '#b0a0ca');
    text(mob, 24, 127, 260, 78, 'Find your\nflow state.', 35, '#f6f1ff', 500, { letterSpacing: -1.4, lineHeight: 1.1 });
    text(mob, 25, 221, 260, 24, 'Less noise. More of what matters.', 11, '#9d91ad');
    const focus = add('frame', { parentId: mob.id, x: 20, y: 268, w: 270, h: 211, fill: '#b7a0e3', fill2: '#9c82cd', fillType: 'linear', gradientAngle: 140, radius: 17, name: 'Focus session' });
    text(focus, 19, 17, 214, 20, 'YOUR DAILY MOMENT', 8, '#f2e8ff', 600, { letterSpacing: 1 });
    ellipse(focus, 91, 47, 89, 89, 'none', { stroke: '#cdb9ef', strokeWidth: 2 });
    ellipse(focus, 99, 55, 73, 73, 'none', { stroke: '#e0cffb', strokeWidth: 1 });
    text(focus, 104, 76, 100, 41, '25:00', 29, '#ffffff', 400, { letterSpacing: -1.2 });
    text(focus, 104, 113, 90, 14, 'MINUTES OF FOCUS', 5.4, '#f0e5ff', 600, { letterSpacing: .7 });
    rect(focus, 20, 158, 230, 36, '#f4edfd', 9, 'Start session');
    text(focus, 88, 169, 123, 19, 'Start a session   ↗', 10, '#8e72b8', 600);
    text(mob, 24, 511, 234, 24, 'Make a little progress', 14, '#e4dbf0', 500);
    rect(mob, 23, 549, 124, 53, '#2d2836', 10);
    rect(mob, 160, 549, 127, 53, '#2d2836', 10);
    text(mob, 36, 559, 104, 22, '4.5 hours', 16, '#dcd1ea', 500);
    text(mob, 37, 583, 97, 13, 'FOCUSED THIS WEEK', 6, '#857591', 550, { letterSpacing: .5 });
    text(mob, 174, 559, 102, 22, '7 day streak', 16, '#dcd1ea', 500);
    text(mob, 175, 583, 103, 13, 'LOOK AT YOU GO', 6, '#857591', 550, { letterSpacing: .5 });
    text(mob, 43, 627, 35, 27, '◒', 21, '#b49acc');
    text(mob, 143, 629, 35, 27, '▦', 19, '#70637f');
    text(mob, 241, 629, 35, 27, '◷', 19, '#70637f');
    rect(mob, 116, 659, 78, 3, '#736681', 2);
    text(null, 0, 785, 600, 40, 'The little details, considered.', 22, '#a89ab8', 500, { letterSpacing: -.6 });
    text(null, 0, 825, 800, 22, 'A calm foundation. An expressive personality. A design system that gives ideas room to grow.', 10, '#736a80');
    const tokens = add('frame', { x: 0, y: 883, w: 466, h: 162, fill: '#f8f6fc', radius: 10, name: '03 · Color palette' });
    text(tokens, 23, 20, 300, 20, 'A softer kind of bold', 12, '#766284', 600);
    const sw = ['#8462e8', '#baa4df', '#e7dcf4', '#c7e0d3', '#edcfb7', '#2b2535'];
    sw.forEach((c, i) => { rect(tokens, 23 + i * 72, 57, 60, 60, c, 9, 'Color ' + c); text(tokens, 23 + i * 72, 130, 65, 15, c.toUpperCase(), 7, '#ac9aba', 500); });
    const types = add('frame', { x: 491, y: 883, w: 395, h: 162, fill: '#eae1f5', radius: 10, name: '04 · Typography' });
    text(types, 22, 18, 310, 20, 'TYPE THAT SETS THE TONE', 7, '#b29ac7', 600, { letterSpacing: 1 });
    text(types, 22, 53, 341, 57, 'Room to create.', 32, '#775b92', 500, { letterSpacing: -1.1 });
    text(types, 23, 124, 354, 19, 'Inter   /   Regular · Medium · Semibold', 9, '#ad96c0');
    const buttonFrame = add('frame', { x: 911, y: 883, w: 463, h: 162, fill: '#f7f5fb', radius: 10, name: '05 · Building blocks' });
    text(buttonFrame, 22, 20, 392, 20, 'Small pieces. Endless possibilities.', 12, '#877296', 500);
    rect(buttonFrame, 22, 62, 137, 36, '#9271ce', 7, 'Primary button', { component: true });
    text(buttonFrame, 48, 74, 106, 20, 'Create something  ↗', 9, '#ffffff', 500);
    rect(buttonFrame, 176, 62, 124, 36, '#e9e0f4', 7, 'Secondary button');
    text(buttonFrame, 200, 74, 93, 20, 'Take a look   →', 9, '#a182be', 500);
    rect(buttonFrame, 317, 62, 121, 36, '#ffffff', 7, 'Ghost button', { stroke: '#e5dcec', strokeWidth: 1 });
    text(buttonFrame, 341, 74, 90, 20, 'Maybe later', 9, '#ae94c1', 500);
    rect(buttonFrame, 23, 118, 69, 22, '#e8e0f4', 11, 'Design tag');
    text(buttonFrame, 39, 124, 54, 15, '●  Design', 8, '#a085bb');
    rect(buttonFrame, 107, 118, 85, 22, '#e5ede7', 11, 'Progress tag');
    text(buttonFrame, 120, 124, 74, 15, '●  In progress', 8, '#9bb7a5');
    rect(buttonFrame, 207, 118, 88, 22, '#f0e6dc', 11, 'Priority tag');
    text(buttonFrame, 222, 124, 70, 15, '●  High priority', 8, '#c3a07f');
    page = ds;
    const system = add('frame', { x: 0, y: 0, w: 1100, h: 850, fill: '#faf8fd', name: 'Forma / Design foundations', radius: 12 });
    text(system, 60, 58, 980, 75, 'Designed to give ideas room.', 46, '#51425f', 500, { letterSpacing: -1.6 });
    text(system, 62, 149, 870, 30, 'Our visual language is calm, considered, and quietly expressive.', 17, '#9e8cac');
    text(system, 63, 235, 800, 30, '01 / Color foundations', 21, '#766184', 500);
    defaultTokens().colors.forEach((c, i) => { rect(system, 63 + i * 164, 291, 143, 108, c.value, 12, c.name); text(system, 63 + i * 164, 418, 158, 23, c.name, 11, '#85718f', 500); text(system, 63 + i * 164, 445, 143, 20, c.value.toUpperCase(), 10, '#b1a0bc'); });
    text(system, 63, 515, 800, 30, '02 / Typographic scale', 21, '#766184', 500);
    defaultTokens().typography.forEach((t, i) => { text(system, 64, 576 + i * 62, 270, 28, t.name, 11, '#ab97b8'); text(system, 360, 564 + i * 62, 680, 57, 'Make something meaningful.', t.size, '#776082', t.weight, { lineHeight: t.lineHeight, letterSpacing: t.size > 30 ? -1 : 0 }); });
    return { format: 'vellum', version: 1, name: 'Forma · Product design', pageId: p.id, pages: [p, ds, play], tokens: defaultTokens(), assets: {} };
}
