import { DocumentModel, History, node, uid, clamp, point, inverse, multiply, identity, localMatrix, boxOf, union, intersects, makeStarter } from './document.js';
import { Renderer, fontSpec, layoutText, displayText, pathFor } from './renderer.js';
import { icon, hydrateIcons } from './icons.js';
import { exportSVG } from './svg.js';
import { storage } from './storage.js';
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => Math.round(n * 100) / 100;
const round = n => Math.round(n * 10) / 10;
const isInput = e => e instanceof HTMLElement && (e.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.tagName));
const defaultOptions = { grid: false, snap: true, rulers: false, theme: 'dark' };
let options = { ...defaultOptions };
try {
    Object.assign(options, JSON.parse(localStorage.getItem('vellum-options') || '{}'));
}
catch { }
document.documentElement.dataset.theme = options.theme;
let saveTimer, toastTimer;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.remove('hidden'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 3200); }

await storage.init();
const storageMode = storage.mode === 'sqlite' ? 'SQLite' : 'IndexedDB';

let initial = null;
try {
    const projectsList = await storage.listProjects();
    if (projectsList.length > 0) {
        const current = await storage.getProject(projectsList[0].id);
        if (current?.document_data) {
            initial = DocumentModel.parse(current.document_data);
            storage.activeProjectId = current.id;
        }
    } else {
        let legacyData = null;
        try {
            const legDb = await new Promise((res, rej) => { const r = indexedDB.open('vellum-editor', 1); r.onsuccess = () => res(r.result); r.onerror = rej; });
            legacyData = await new Promise((res, rej) => { const r = legDb.transaction('documents').objectStore('documents').get('current'); r.onsuccess = () => res(r.result); r.onerror = rej; });
        } catch {
            legacyData = localStorage.getItem('vellum-document');
        }
        if (legacyData) {
            try {
                initial = DocumentModel.parse(legacyData);
            } catch { }
        }
        if (!initial) {
            const starterDoc = new DocumentModel();
            initial = starterDoc.data;
        }
        const initialDoc = new DocumentModel(initial);
        const starterId = 'proj_' + Date.now().toString(36);
        const starterName = initialDoc.data.name || 'Forma · Product design';
        await storage.saveProject({
            id: starterId,
            name: starterName,
            documentData: initialDoc.serialize(),
            thumbnail: null,
            pageCount: initialDoc.data.pages.length,
            layerCount: initialDoc.data.pages.reduce((acc, p) => acc + p.nodes.length, 0)
        });
        storage.activeProjectId = starterId;
    }
} catch (e) {
    console.warn('Project storage initialization fallback', e);
    const starterDoc = new DocumentModel();
    initial = starterDoc.data;
}

const doc = new DocumentModel(initial), history = new History(doc);

// Startup check: CLI argument or ensure starter file in ~/Documents/Vellum
if (storage.isTauri) {
    setTimeout(async () => {
        try {
            const cliFileContent = await storage.getCliFileArg();
            if (cliFileContent) {
                await loadDocumentText(cliFileContent, 'Opened Document');
            } else {
                const files = await storage.listDocumentsFiles();
                if (!files.length && doc.data) {
                    await storage.saveToDocuments(doc.data.name || 'Forma · Product design', doc.serialize());
                }
            }
        } catch (err) {
            console.warn('Initial file check error', err);
        }
    }, 250);
}
const state = { selection: new Set(), expanded: new Set(), tool: 'select', camera: { x: 60, y: 70, zoom: .6 }, pageViews: new Map(), hover: null, gesture: null, space: false, pen: [], penHover: null, pathEdit: null, guides: [], marquee: null, inspectorTab: 'design', leftTab: 'layers', editing: null, clipboard: null, pointers: new Map(), pinch: null, previewIndex: 0, previewFrames: [], selectionVersion: 0, dirty: false };
const area = $('#canvas-area'), overlay = $('#overlay'), octx = overlay.getContext('2d');
let scheduled = false, lastInspector = 0, uiQueued = false;
const renderer = new Renderer($('#scene'), doc, status => { $('#engine-label').textContent = status === 'WebGPU' ? 'WebGPU accelerated' : status === 'Canvas 2D' ? 'Canvas 2D fallback' : status; $('#engine-label').title = status === 'WebGPU' ? 'Shapes: instanced GPU quads. Text and paths: cached raster atlas.' : renderer?.gpuError || status; }, () => invalidate());
function saveOptions() {
    try {
        localStorage.setItem('vellum-options', JSON.stringify(options));
    }
    catch { }
}
function generateThumbnail() {
    try {
        const scene = $('#scene');
        if (!scene || !scene.width || !scene.height) return null;
        const thumb = document.createElement('canvas');
        thumb.width = 320;
        thumb.height = 200;
        const ctx = thumb.getContext('2d');
        ctx.fillStyle = '#1e1e22';
        ctx.fillRect(0, 0, 320, 200);
        ctx.drawImage(scene, 0, 0, 320, 200);
        return thumb.toDataURL('image/jpeg', 0.65);
    } catch {
        return null;
    }
}
function saveSoon() {
    state.dirty = true;
    const backendName = storage.mode === 'sqlite' ? 'SQLite' : 'locally';
    $('#save-indicator').innerHTML = `<i></i> Saving to ${backendName}`;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 500);
}
async function save() {
    clearTimeout(saveTimer);
    const data = doc.serialize();
    try {
        const thumb = generateThumbnail();
        const pageCount = doc.data.pages.length;
        const layerCount = doc.data.pages.reduce((acc, p) => acc + p.nodes.length, 0);
        const projectId = storage.activeProjectId || ('proj_' + Date.now().toString(36));
        storage.activeProjectId = projectId;
        await storage.saveProject({
            id: projectId,
            name: doc.data.name || 'Untitled design',
            documentData: data,
            thumbnail: thumb,
            pageCount,
            layerCount
        });
        if (storage.isTauri) {
            storage.saveToDocuments(doc.data.name || 'Untitled design', data).catch(() => {});
        }
        state.dirty = false;
        const backendName = storage.mode === 'sqlite' ? 'SQLite' : 'locally';
        $('#save-indicator').innerHTML = `<i></i> Saved to ${backendName}`;
    } catch (e) {
        console.error('Save failed', e);
        $('#save-indicator').innerHTML = '<i style="background:var(--danger)"></i> Save failed';
        toast('Save failed. Export your .vellum file to keep your work.');
    }
}
function invalidate() {
    if (scheduled)
        return;
    scheduled = true;
    requestAnimationFrame(() => {
        scheduled = false;
        renderer.render(state.camera);
        drawOverlay();
        $('#performance').textContent = `${renderer.visibleCount} layers · ${renderer.cpuMs.toFixed(1)} ms CPU`;
        $('#zoom-value').textContent = `${Math.round(state.camera.zoom * 100)}%`;
        const spacing = 20 * state.camera.zoom;
        $('#canvas-world').style.backgroundImage = options.grid && spacing >= 5 ? 'radial-gradient(var(--dot) .7px, transparent .7px)' : 'none';
        $('#canvas-world').style.backgroundSize = `${spacing}px ${spacing}px`;
        $('#canvas-world').style.backgroundPosition = `${state.camera.x}px ${state.camera.y}px`;
        if (state.editing)
            positionTextEditor();
    });
}
function refreshUI() { renderPages(); renderLayers(); renderInspector(); $('#file-name').textContent = doc.data.name; $('#canvas-page-name').textContent = doc.page.name; hydrateIcons(); }
function syncComponents() {
    const sources = new Map(doc.data.pages.flatMap(p => p.nodes).map(n => [n.id, n]));
    for (const page of doc.data.pages)
        for (const n of page.nodes) {
            if (!n.sourceId)
                continue;
            const src = sources.get(n.sourceId);
            if (!src)
                continue;
            const omitted = new Set(['id', 'parentId', 'component', 'sourceId', 'isInstance', 'version', 'overrides', 'prototypeTarget', 'name', ...(n.isInstance ? ['x', 'y', 'rotation'] : [])]);
            for (const [k, v] of Object.entries(src)) {
                if (omitted.has(k) || Object.hasOwn(n.overrides || {}, k))
                    continue;
                if (JSON.stringify(n[k]) !== JSON.stringify(v)) {
                    n[k] = structuredClone(v);
                    n.version++;
                }
            }
        }
    doc.touch();
}
function changed({ ui = true, commit = false } = {}) {
    doc.touch();
    if (commit) {
        applyAllLayouts();
        syncComponents();
        history.commit();
        saveSoon();
    }
    if (ui)
        refreshUI();
    else if (!uiQueued) {
        uiQueued = true;
        setTimeout(() => {
            uiQueued = false;
            renderLayers();
            if (!isInput(document.activeElement))
                renderInspector();
        }, 80);
    }
    invalidate();
}
function transaction(label, fn) { finishText(); history.begin(label); fn(); changed({ commit: true }); }
function select(ids, { reveal = false } = {}) {
    state.selection = new Set(ids.filter(id => doc.get(id)));
    state.selectionVersion++;
    state.pathEdit = null;
    if (reveal) {
        for (const id of state.selection)
            for (const n of doc.ancestors(doc.get(id)))
                state.expanded.add(n.id);
    }
    renderLayers();
    renderInspector();
    invalidate();
}
function selected() { return [...state.selection].map(id => doc.get(id)).filter(Boolean); }
function selectedRoots() { return doc.roots([...state.selection]); }
function activeNode() { return selected()[0] || null; }
function screenToWorld(x, y) { return { x: (x - state.camera.x) / state.camera.zoom, y: (y - state.camera.y) / state.camera.zoom }; }
function worldToScreen(x, y) { return { x: x * state.camera.zoom + state.camera.x, y: y * state.camera.zoom + state.camera.y }; }
function eventPoint(e) { const b = area.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; }
function eventWorld(e) { const p = eventPoint(e); return screenToWorld(p.x, p.y); }
function fit(ids = null) {
    const b = doc.bounds(ids);
    if (!b) {
        state.camera = { x: 80, y: 100, zoom: 1 };
        invalidate();
        return;
    }
    const w = area.clientWidth, h = area.clientHeight;
    state.camera.zoom = clamp(Math.min((w - 90) / Math.max(1, b.w), (h - 205) / Math.max(1, b.h)), .02, 2);
    state.camera.x = (w - b.w * state.camera.zoom) / 2 - b.x * state.camera.zoom;
    state.camera.y = 67 - b.y * state.camera.zoom;
    invalidate();
}
function zoomAt(factor, x = area.clientWidth / 2, y = area.clientHeight / 2) { const w = screenToWorld(x, y); state.camera.zoom = clamp(state.camera.zoom * factor, .02, 64); state.camera.x = x - w.x * state.camera.zoom; state.camera.y = y - w.y * state.camera.zoom; invalidate(); }
function setTool(tool) {
    finishText();
    if (state.pen.length)
        finishPen();
    state.tool = tool;
    state.pathEdit = null;
    $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    overlay.style.cursor = tool === 'hand' ? 'grab' : tool === 'text' ? 'text' : ['rect', 'frame', 'ellipse', 'line', 'pen'].includes(tool) ? 'crosshair' : 'default';
    $('#canvas-hint').textContent = tool === 'pen' ? 'Click to add points · Drag for Bézier handles · Enter to finish · Click first point to close' : tool === 'text' ? 'Click to add text · Double-click existing text to edit' : 'Space to pan · ⌘/Ctrl scroll to zoom · ? for shortcuts';
    invalidate();
}
function getSelectionBounds() { return doc.bounds([...state.selection]); }
function switchPage(id) {
    finishText();
    state.pageViews.set(doc.page.id, { camera: { ...state.camera }, selection: [...state.selection] });
    doc.data.pageId = id;
    doc.refresh();
    state.selection.clear();
    state.pathEdit = null;
    state.pen = [];
    const view = state.pageViews.get(id);
    if (view) {
        state.camera = { ...view.camera };
        state.selection = new Set(view.selection.filter(i => doc.get(i)));
    }
    else
        fit();
    refreshUI();
    saveSoon();
    invalidate();
}
function renderPages() { $('#page-list').innerHTML = doc.data.pages.map(p => `<button class="page-row ${p.id === doc.page.id ? 'active' : ''}" data-page="${p.id}">${icon('page', 13)}<span>${esc(p.name)}</span>${p.id === doc.page.id ? '<span class="page-check">✓</span>' : ''}</button>`).join(''); }
function renderLayers() {
    $('#layer-count').textContent = doc.nodes.length;
    $('#tree-heading').textContent = state.leftTab === 'layers' ? 'Layers' : 'Local components';
    $('#layer-tree').classList.toggle('hidden', state.leftTab !== 'layers');
    $('#assets-panel').classList.toggle('hidden', state.leftTab !== 'assets');
    if (state.leftTab === 'assets') {
        renderAssets();
        return;
    }
    const q = $('#search-layers').value.trim().toLowerCase();
    let html = '';
    const walk = (parent, depth) => {
        for (const n of [...doc.children(parent)].reverse()) {
            const matches = !q || n.name.toLowerCase().includes(q) || n.text?.toLowerCase().includes(q);
            if (q && !matches && !doc.descendants(n.id).some(c => c.name.toLowerCase().includes(q) || c.text?.toLowerCase().includes(q)))
                continue;
            const children = doc.children(n.id), hasChildren = children.length > 0, open = state.expanded.has(n.id) || !!q;
            html += `<div class="layer-row ${state.selection.has(n.id) ? 'selected' : ''} ${!n.visible ? 'dim' : ''} ${n.component || n.isInstance ? 'component' : ''}" data-layer="${n.id}" style="--depth:${depth}" role="treeitem" aria-selected="${state.selection.has(n.id)}" ${hasChildren ? `aria-expanded="${open}"` : ''} draggable="true"><button class="expand" data-expand="${n.id}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(n.name)}">${hasChildren ? (open ? '⌄' : '›') : ''}</button><span class="layer-icon">${icon(n.component ? 'component' : n.isInstance ? 'instance' : n.type, 13)}</span><span class="layer-name" title="${esc(n.name)}">${esc(n.name)}</span><button class="lock ${n.locked ? 'is-locked' : ''}" data-lock="${n.id}" title="${n.locked ? 'Unlock' : 'Lock'}">${icon(n.locked ? 'lock' : 'unlock', 12)}</button><button class="visibility ${!n.visible ? 'is-hidden' : ''}" data-visibility="${n.id}" title="${n.visible ? 'Hide' : 'Show'}">${icon(n.visible ? 'eye' : 'eyeOff', 12)}</button></div>`;
            if (hasChildren && open)
                walk(n.id, depth + 1);
        }
    };
    walk(null, 0);
    $('#layer-tree').innerHTML = html || '<div class="empty-state">A fresh canvas.<br>Press R to draw your first shape.</div>';
}
function renderAssets() { const components = doc.data.pages.flatMap(p => p.nodes).filter(n => n.component); $('#assets-panel').innerHTML = `<p class="small-label">Double-click a component to place an instance.</p>${components.map(n => `<div class="asset-card" data-component="${n.id}"><div class="asset-preview"><div class="asset-button" style="background:${safeColor(n.fill)}">${esc(n.name)}</div></div><div class="asset-caption">${esc(n.name)}<span>◇</span></div></div>`).join('')}<h4>Quick insert</h4><div class="asset-card" data-asset="button"><div class="asset-preview"><span class="asset-button">Get started ↗</span></div><div class="asset-caption">Button / Primary<span>＋</span></div></div><div class="asset-card" data-asset="card"><div class="asset-preview"><div style="background:#eee8fb;padding:16px 25px;border-radius:10px;color:#8462e8">A little inspiration.</div></div><div class="asset-caption">Card / Content<span>＋</span></div></div><div class="asset-card" data-asset="badge"><div class="asset-preview"><span style="padding:7px 18px;background:#d4e8dc;color:#537962;border-radius:20px">● In progress</span></div><div class="asset-caption">Badge / Status<span>＋</span></div></div>`; }
function safeColor(c) { return /^#[\da-f]{3,8}$/i.test(c) ? c : '#8462e8'; }
function field(label, prop, value, opts = {}) { return `<label class="field" title="${esc(opts.title || prop)}"><span>${label}</span><input type="number" data-prop="${prop}" value="${fmt(value ?? 0)}" aria-label="${esc(opts.title || prop)}" step="${opts.step || 1}" ${opts.min !== undefined ? `min="${opts.min}"` : ''} ${opts.max !== undefined ? `max="${opts.max}"` : ''}>${opts.unit ? `<i class="unit">${opts.unit}</i>` : ''}</label>`; }
function section(title, body, action = '', extra = '') { return `<section class="inspector-section ${extra}"><div class="section-heading"><span>${title}</span>${action}</div>${body}</section>`; }
function colorField(prop, value, opacityProp = null, opacity = 1) { return `<div class="fill-row"><div class="hex-field"><input type="color" value="${safeColor(value)}" data-prop="${prop}" aria-label="${prop} color"><input type="text" data-hex="${prop}" value="${esc(value === 'none' ? 'None' : (value || '#000000').replace('#', '').toUpperCase())}" aria-label="${prop} hex color" spellcheck="false"></div>${opacityProp ? field('', opacityProp, opacity * 100, { unit: '%', min: 0, max: 100 }) : ''}</div>`; }
function selectField(prop, value, values) { return `<select class="full-width" data-prop="${prop}" aria-label="${prop}">${values.map(o => { const [v, l] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`; }).join('')}</select>`; }
function renderInspector() {
    if (state.editing && isInput(document.activeElement) && document.activeElement !== $('#text-editor'))
        return;
    const ns = selected(), n = ns[0];
    let html = '';
    if (state.inspectorTab === 'prototype') {
        renderPrototype(n);
        return;
    }
    if (!n) {
        html += section('Page', `<div class="fill-row"><div class="hex-field"><input type="color" id="canvas-color" value="${options.canvasColor || (options.theme === 'dark' ? '#1a1a1d' : '#e8e7ec')}" aria-label="Canvas color"><input type="text" value="${options.canvasColor || (options.theme === 'dark' ? '1A1A1D' : 'E8E7EC')}" readonly aria-label="Canvas hex"></div><span class="small-label">100%</span></div><label class="checkbox-row"><input type="checkbox" data-option="grid" ${options.grid ? 'checked' : ''}>Pixel grid</label>`, icon('sliders', 14));
        html += section('Start with a frame', `<div class="property-grid"><button class="wide-button" data-preset="desktop">Desktop</button><button class="wide-button" data-preset="phone">Phone</button><button class="wide-button" data-preset="tablet">Tablet</button><button class="wide-button" data-preset="square">Social</button></div>`);
        html += section('Local color styles', doc.data.tokens.colors.map(c => `<button class="style-row full-width" data-insert-color="${safeColor(c.value)}"><span class="style-swatch" style="background:${safeColor(c.value)}"></span><span class="style-info" style="text-align:left">${esc(c.name)}<small>${esc(c.value.toUpperCase())}</small></span>${icon('component', 12)}</button>`).join(''), `<button class="icon-button small" data-action="tokens" title="Edit design tokens">${icon('sliders', 14)}</button>`);
        html += section('Text styles', doc.data.tokens.typography.map((t, i) => `<button class="typography-style full-width" data-type-style="${i}"><span class="type-icon">Aa</span><div style="text-align:left">${esc(t.name)}<small>Inter · ${t.size} / ${round(t.size * t.lineHeight)} · ${t.weight}</small></div></button>`).join(''));
        html += section('Your work, your device', `<p>No account. No uploads. This document is saved locally in your browser.</p><button class="wide-button" data-action="saveFile" style="margin-top:13px">${icon('download', 13)} Save a portable copy</button>`);
    }
    else {
        const multi = ns.length > 1;
        html += section(`<span class="section-title">${icon(multi ? 'layers' : n.component ? 'component' : n.isInstance ? 'instance' : n.type, 14)}<span class="selection-name">${multi ? `${ns.length} layers selected` : esc(n.name)}</span></span>`, `<div class="selection-meta">${multi ? 'Edit shared properties' : n.isInstance ? 'Component instance' : n.component ? 'Main component' : `${n.type[0].toUpperCase() + n.type.slice(1)} · ${Math.round(n.w)} × ${Math.round(n.h)}`}</div>`, `<button class="icon-button small" data-action="selectionMenu" title="Layer actions">···</button>`);
        const align = [['alignLeft', 'left'], ['alignCenter', 'center'], ['alignRight', 'right'], ['alignTop', 'top'], ['alignMiddle', 'middle'], ['alignBottom', 'bottom']].map(([i, a]) => `<button data-align="${a}" title="Align ${a}">${icon(i, 15)}</button>`).join('');
        html += section('Position', `<div class="align-buttons">${align}</div><div class="property-grid">${field('X', 'x', n.x)}${field('Y', 'y', n.y)}${field(icon('rotate', 12), 'rotation', n.rotation, { unit: '°' })}${field(icon('radius', 12), 'radius', n.radius, { min: 0 })}</div>`);
        html += section('Layout', `<div class="property-grid">${field('W', 'w', n.w, { min: .1 })}${field('H', 'h', n.h, { min: .1 })}</div>${['frame', 'group'].includes(n.type) ? `<label class="checkbox-row"><input type="checkbox" data-prop="clip" ${n.clip ? 'checked' : ''} ${n.type === 'group' ? 'disabled' : ''}>Clip content</label><div class="field-label"><span>Auto layout</span><span>Gap / Padding</span></div>${selectField('layout', n.layout || 'none', [['none', 'Freeform'], ['horizontal', 'Horizontal stack'], ['vertical', 'Vertical stack']])}${n.layout && n.layout !== 'none' ? `<div class="property-grid" style="margin-top:8px">${field('↔', 'gap', n.gap ?? 16, { min: 0 })}${field('⊞', 'padding', n.padding ?? 16, { min: 0 })}</div><div style="margin-top:8px">${selectField('layoutAlign', n.layoutAlign || 'start', [['start', 'Align start'], ['center', 'Align center'], ['end', 'Align end']])}</div>` : ''}` : ''}`, `<button class="icon-button small" data-action="toggleLayout" title="Toggle auto layout">${icon('plus', 14)}</button>`);
        html += section('Appearance', `<div class="property-grid">${field(icon('opacity', 12), 'opacity', n.opacity * 100, { unit: '%', min: 0, max: 100 })}<div class="segmented"><button data-toggle="visible" class="${n.visible ? 'active' : ''}" title="Toggle visibility">${icon('eye', 14)}</button><button data-toggle="locked" class="${n.locked ? 'active' : ''}" title="Toggle lock">${icon('lock', 14)}</button></div></div>`);
        if (ns.every(x => x.type === 'text')) {
            html += section('Typography', `<div class="stack">${selectField('fontFamily', n.fontFamily, [...new Set(['Inter', 'Arial', 'Helvetica Neue', 'Georgia', 'Times New Roman', 'Verdana', 'Courier New', 'monospace', 'serif', 'sans-serif', ...Object.keys(doc.data.fonts || {}), n.fontFamily])])}<div class="property-grid">${selectField('fontWeight', n.fontWeight, [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold'], [900, 'Black']])}${field('Ag', 'fontSize', n.fontSize, { min: 1, max: 512 })}</div><div class="property-grid">${field('↕', 'lineHeight', n.lineHeight * 100, { unit: '%', min: 50, max: 500 })}${field('↔', 'letterSpacing', n.letterSpacing, { unit: 'px', step: .1 })}</div><div class="property-grid"><div class="segmented">${['left', 'center', 'right'].map(a => `<button data-text-align="${a}" class="${n.textAlign === a ? 'active' : ''}" title="Align text ${a}">${icon('text' + a[0].toUpperCase() + a.slice(1), 14)}</button>`).join('')}</div><div class="segmented"><button data-text-style="bold" class="${n.fontWeight >= 700 ? 'active' : ''}" title="Bold">${icon('bold', 14)}</button><button data-text-style="italic" class="${n.fontStyle === 'italic' ? 'active' : ''}" title="Italic">${icon('italic', 14)}</button><button data-text-style="underline" class="${n.textDecoration === 'underline' ? 'active' : ''}" title="Underline">${icon('underline', 14)}</button></div></div>${selectField('textCase', n.textCase, [['none', 'Original case'], ['upper', 'UPPERCASE'], ['lower', 'lowercase'], ['title', 'Title Case']])}${selectField('direction', n.direction || 'auto', [['auto', 'Automatic direction'], ['ltr', 'Left to right'], ['rtl', 'Right to left']])}<div class="property-grid"><button class="wide-button" data-action="editText">Edit text</button><button class="wide-button" data-action="loadFont">Load font…</button></div></div>`, icon('text', 14));
        }
        if (n.type !== 'group')
            html += section('Fill', `${selectField('fillType', n.fillType || 'solid', [['solid', 'Solid'], ['linear', 'Linear gradient']])}${colorField('fill', n.fill, 'fillOpacity', n.fillOpacity)}${n.fillType === 'linear' ? `${colorField('fill2', n.fill2)}<div style="margin-top:8px">${field('∠', 'gradientAngle', n.gradientAngle, { unit: '°' })}</div>` : ''}<div class="color-tokens">${doc.data.tokens.colors.map(c => `<button data-fill="${safeColor(c.value)}" title="${esc(c.name)}" style="background:${safeColor(c.value)}"></button>`).join('')}</div>`, `<button class="icon-button small" data-action="toggleFill" title="Toggle fill">${icon(n.fill === 'none' ? 'plus' : 'minus', 14)}</button>`);
        if (!['group', 'text'].includes(n.type))
            html += section('Stroke', n.strokeWidth > 0 ? `${colorField('stroke', n.stroke)}<div style="margin-top:8px">${field('W', 'strokeWidth', n.strokeWidth, { min: 0, max: 1000 })}</div>` : '<span class="small-label">No stroke</span>', `<button class="icon-button small" data-action="toggleStroke" title="Toggle stroke">${icon(n.strokeWidth ? 'minus' : 'plus', 14)}</button>`);
        if (!['group', 'text', 'path', 'line'].includes(n.type))
            html += section('Effects', n.shadow ? `<div class="fill-row"><span class="small-label">Drop shadow</span><button class="icon-button small" data-action="toggleShadow" style="margin-left:auto" title="Remove shadow">${icon('eye', 14)}</button></div><div class="property-grid" style="margin-top:8px">${field('X', 'shadowX', n.shadowX)}${field('Y', 'shadowY', n.shadowY)}${field('↔', 'shadowBlur', n.shadowBlur, { min: 0 })}${field('α', 'shadowOpacity', n.shadowOpacity * 100, { unit: '%', min: 0, max: 100 })}</div>${colorField('shadowColor', n.shadowColor || '#000000')}` : '<span class="small-label">No effects</span>', `<button class="icon-button small" data-action="toggleShadow" title="Toggle shadow">${icon(n.shadow ? 'minus' : 'plus', 14)}</button>`);
        if (n.parentId) {
            html += section('Constraints', `<div class="property-grid">${selectField('constraintH', n.constraintH || 'left', [['left', 'Left'], ['right', 'Right'], ['center', 'Center'], ['stretch', 'Left + right'], ['scale', 'Scale']])}${selectField('constraintV', n.constraintV || 'top', [['top', 'Top'], ['bottom', 'Bottom'], ['center', 'Center'], ['stretch', 'Top + bottom'], ['scale', 'Scale']])}</div>`);
        }
        html += section('Export', `<div class="property-grid" style="margin-bottom:8px"><select id="export-scale" aria-label="Export scale"><option value="1">1×</option><option value="2" selected>2×</option><option value="3">3×</option></select><select id="export-format" aria-label="Export format"><option>PNG</option><option>SVG</option></select></div><button class="export-button" data-action="exportSelection">${icon('download', 13)} Export ${multi ? 'selection' : esc(n.name.length > 21 ? n.name.slice(0, 20) + '…' : n.name)}</button>`);
        html += section('Developer', `<button class="wide-button" data-action="inspectCSS">${icon('code', 14)} Inspect CSS</button>`);
    }
    $('#inspector').innerHTML = html;
    lastInspector = performance.now();
}
function renderPrototype(n) { const frames = doc.nodes.filter(n => n.type === 'frame' && !n.parentId); $('#inspector').innerHTML = section('Prototype', `<p>Connect a layer to a frame. In preview, clicking that layer navigates to the destination.</p>`) + (n ? section('Interaction', `<div class="field-label">On click → Navigate to</div>${selectField('prototypeTarget', n.prototypeTarget || '', [['', 'No destination'], ...frames.map(f => [f.id, f.name])])}<p>Transition: instant. Keyboard arrows also navigate between frames.</p>`) : section('Select a layer', '<p>Select a button, card, or other layer to add an interaction.</p>')) + section('Flow preview', `<button class="wide-button primary" data-action="present">${icon('play', 14)} Present frames</button><p>Preview is local. It does not publish or upload your design.</p>`); }
function constrainChildren(n, oldW, oldH) {
    if (!['frame', 'group'].includes(n.type))
        return;
    const dx = n.w - oldW, dy = n.h - oldH;
    for (const c of doc.children(n.id)) {
        if (n.type === 'group') {
            const sx = n.w / (oldW || 1), sy = n.h / (oldH || 1), cw = c.w, ch = c.h;
            c.x *= sx;
            c.y *= sy;
            c.w *= sx;
            c.h *= sy;
            if (c.type === 'text')
                c.fontSize *= Math.min(sx, sy);
            constrainChildren(c, cw, ch);
        }
        else {
            switch (c.constraintH) {
                case 'right':
                    c.x += dx;
                    break;
                case 'center':
                    c.x += dx / 2;
                    break;
                case 'stretch':
                    c.w = Math.max(1, c.w + dx);
                    break;
                case 'scale':
                    c.x *= n.w / (oldW || 1);
                    c.w *= n.w / (oldW || 1);
                    break;
            }
            switch (c.constraintV) {
                case 'bottom':
                    c.y += dy;
                    break;
                case 'center':
                    c.y += dy / 2;
                    break;
                case 'stretch':
                    c.h = Math.max(1, c.h + dy);
                    break;
                case 'scale':
                    c.y *= n.h / (oldH || 1);
                    c.h *= n.h / (oldH || 1);
                    break;
            }
        }
        doc.touch(c);
    }
}
function applyLayout(n) {
    if (!n.layout || n.layout === 'none')
        return;
    const children = doc.children(n.id).filter(c => c.visible), pad = n.padding ?? 16, gap = n.gap ?? 16, horizontal = n.layout === 'horizontal';
    let pos = pad;
    for (const c of children) {
        const available = (horizontal ? n.h : n.w) - pad * 2, size = horizontal ? c.h : c.w, cross = pad + (n.layoutAlign === 'center' ? (available - size) / 2 : n.layoutAlign === 'end' ? available - size : 0);
        if (horizontal) {
            c.x = pos;
            c.y = cross;
            pos += c.w + gap;
        }
        else {
            c.y = pos;
            c.x = cross;
            pos += c.h + gap;
        }
        doc.touch(c);
    }
}
function applyAllLayouts() {
    for (const n of [...doc.nodes].reverse())
        applyLayout(n);
}
function setProperty(prop, value, { live = false } = {}) {
    if (!state.selection.size)
        return;
    if (!history.pending)
        history.begin(`Change ${prop}`);
    for (const n of selected()) {
        let v = value;
        if (['opacity', 'fillOpacity', 'shadowOpacity'].includes(prop))
            v = clamp(+v / 100, 0, 1);
        if (prop === 'lineHeight')
            v = clamp(+v / 100, .5, 5);
        if (prop === 'fontWeight')
            v = +v;
        if (['w', 'h'].includes(prop))
            v = Math.max(.1, +v);
        if (['radius', 'strokeWidth', 'shadowBlur', 'gap', 'padding'].includes(prop))
            v = Math.max(0, +v);
        if (prop === 'fontSize')
            v = clamp(+v, 1, 512);
        if (typeof v === 'number' && !Number.isFinite(v))
            continue;
        const ow = n.w, oh = n.h;
        n[prop] = v;
        if (n.sourceId) {
            n.overrides ||= {};
            n.overrides[prop] = v;
        }
        if (prop === 'w' || prop === 'h')
            constrainChildren(n, ow, oh);
        if (n.type === 'text' && ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'fontStyle', 'textCase'].includes(prop))
            n.h = Math.max(n.h, layoutText(n).height);
        if (['layout', 'gap', 'padding', 'layoutAlign'].includes(prop))
            applyLayout(n);
        doc.touch(n);
    }
    changed({ ui: !live, commit: !live });
}
function toggleProperty(prop) {
    const n = activeNode();
    if (n)
        setProperty(prop, !n[prop]);
}
function cloneNodes(roots, offset = 20, asInstance = false) {
    const results = [];
    for (const root of roots) {
        const children = doc.descendants(root.id), all = [root, ...children], map = new Map(all.map(n => [n.id, uid()]));
        for (const src of all) {
            const copy = structuredClone(src);
            copy.id = map.get(src.id);
            copy.parentId = src.id === root.id ? src.parentId : map.get(src.parentId);
            copy.version = 0;
            if (src.id === root.id) {
                copy.x += offset;
                copy.y += offset;
                copy.name = asInstance ? src.name : src.name + ' copy';
                results.push(copy);
            }
            if (asInstance) {
                copy.sourceId = src.id;
                copy.component = false;
                copy.isInstance = src.id === root.id;
                copy.overrides = {};
            }
            doc.add(copy);
        }
    }
    return results;
}
function duplicate() {
    if (!state.selection.size)
        return;
    transaction('Duplicate layers', () => { const copies = cloneNodes(selectedRoots()); select(copies.map(n => n.id)); });
    toast('Selection duplicated');
}
function removeSelection() {
    if (!state.selection.size)
        return;
    transaction('Delete layers', () => { doc.remove([...state.selection]); state.selection.clear(); });
}
function copySelection() {
    const roots = selectedRoots();
    if (!roots.length)
        return;
    const all = roots.flatMap(n => [n, ...doc.descendants(n.id)]), rootIds = roots.map(n => n.id);
    const nodes = structuredClone(all);
    for (const n of nodes.filter(n => rootIds.includes(n.id))) {
        const w = doc.world(n.id), angle = Math.atan2(w.matrix[1], w.matrix[0]) * 180 / Math.PI;
        n.parentId = null;
        n.rotation = angle;
        const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
        n.x = w.matrix[4] - n.w / 2 + c * n.w / 2 - s * n.h / 2;
        n.y = w.matrix[5] - n.h / 2 + s * n.w / 2 + c * n.h / 2;
    }
    state.clipboard = { format: 'vellum-clipboard', rootIds, nodes, assets: structuredClone(doc.data.assets) };
    navigator.clipboard?.writeText(JSON.stringify(state.clipboard)).catch(() => { });
    toast(`${roots.length} layer${roots.length > 1 ? 's' : ''} copied`);
}
async function pasteSelection() {
    let payload = state.clipboard;
    try {
        const str = await navigator.clipboard.readText();
        if (str) {
            try {
                const parsed = JSON.parse(str);
                if (parsed.format === 'vellum-clipboard' && Array.isArray(parsed.nodes))
                    payload = parsed;
                else if (!payload) {
                    createTextAtCenter(str);
                    return;
                }
            }
            catch {
                if (!payload) {
                    createTextAtCenter(str);
                    return;
                }
            }
        }
    }
    catch { }
    if (!payload) {
        toast('Nothing copied yet. Copy a layer first.');
        return;
    }
    transaction('Paste layers', () => {
        const temp = { format: 'vellum', version: 1, name: 'Clipboard', pageId: 'paste', pages: [{ id: 'paste', name: 'Paste', nodes: payload.nodes }], assets: payload.assets || {} };
        let data;
        try {
            data = DocumentModel.parse(JSON.stringify(temp));
        }
        catch (e) {
            toast('Clipboard data is not valid.');
            return;
        }
        const map = new Map(data.pages[0].nodes.map(n => [n.id, uid()]));
        Object.assign(doc.data.assets, data.assets);
        const roots = [];
        for (const src of data.pages[0].nodes) {
            const n = structuredClone(src);
            n.id = map.get(src.id);
            n.parentId = map.get(src.parentId) || null;
            if (payload.rootIds.includes(src.id)) {
                n.x += 24;
                n.y += 24;
                roots.push(n.id);
            }
            doc.add(n);
        }
        select(roots);
    });
}
function groupSelection(asFrame = false) {
    const roots = selectedRoots();
    if (!roots.length)
        return;
    transaction(asFrame ? 'Frame selection' : 'Group layers', () => {
        const commonParent = roots.every(n => n.parentId === roots[0].parentId) ? roots[0].parentId : null;
        const pm = commonParent ? doc.world(commonParent).matrix : identity(), inv = inverse(pm);
        const rects = roots.map(n => boxOf(multiply(inv, doc.world(n.id).matrix), n.w, n.h));
        const b = union(rects), g = node(asFrame ? 'frame' : 'group', { name: asFrame ? 'Frame' : 'Group', parentId: commonParent, x: b.x, y: b.y, w: b.w, h: b.h, fill: asFrame ? '#ffffff' : 'none', clip: asFrame });
        const worldBefore = new Map(roots.map(n => [n.id, doc.world(n.id).matrix]));
        const firstIndex = Math.min(...roots.map(n => doc.nodes.indexOf(n)));
        doc.add(g);
        doc.nodes.splice(doc.nodes.indexOf(g), 1);
        doc.nodes.splice(firstIndex, 0, g);
        doc.refresh();
        const gi = inverse(doc.world(g.id).matrix);
        for (const n of roots) {
            const m = multiply(gi, worldBefore.get(n.id));
            setFromMatrix(n, m);
            n.parentId = g.id;
            doc.touch(n);
        }
        state.expanded.add(g.id);
        select([g.id]);
    });
}
function setFromMatrix(n, m) { const angle = Math.atan2(m[1], m[0]); n.rotation = angle * 180 / Math.PI; const c = Math.cos(angle), s = Math.sin(angle); n.x = m[4] - n.w / 2 + c * n.w / 2 - s * n.h / 2; n.y = m[5] - n.h / 2 + s * n.w / 2 + c * n.h / 2; }
function ungroupSelection() {
    transaction('Ungroup', () => {
        const ids = [];
        for (const g of selectedRoots()) {
            if (!['group', 'frame'].includes(g.type))
                continue;
            const parent = g.parentId, pm = parent ? doc.world(parent).matrix : identity(), inv = inverse(pm), children = doc.children(g.id);
            const transformed = children.map(c => [c, multiply(inv, doc.world(c.id).matrix)]);
            for (const [c, m] of transformed) {
                c.parentId = parent;
                setFromMatrix(c, m);
                ids.push(c.id);
                doc.touch(c);
            }
            doc.remove([g.id]);
        }
        select(ids);
    });
}
function reorder(direction) {
    if (!state.selection.size)
        return;
    transaction('Reorder layers', () => {
        const roots = selectedRoots();
        for (const n of direction.includes('back') ? [...roots].reverse() : roots) {
            const siblings = doc.children(n.parentId), index = siblings.indexOf(n);
            let target;
            if (direction === 'front')
                target = siblings.at(-1);
            else if (direction === 'back')
                target = siblings[0];
            else if (direction === 'forward')
                target = siblings[index + 1];
            else
                target = siblings[index - 1];
            if (!target || target === n)
                continue;
            doc.nodes.splice(doc.nodes.indexOf(n), 1);
            const at = doc.nodes.indexOf(target) + (direction === 'front' || direction === 'forward' ? 1 : 0);
            doc.nodes.splice(at, 0, n);
        }
        doc.refresh();
    });
}
function alignSelection(mode) {
    const roots = selectedRoots();
    if (!roots.length)
        return;
    transaction(`Align ${mode}`, () => {
        const b = roots.length === 1 && roots[0].parentId ? doc.world(roots[0].parentId).box : doc.bounds(roots.map(n => n.id));
        for (const n of roots) {
            const w = doc.world(n.id).box;
            let dx = 0, dy = 0;
            if (mode === 'left')
                dx = b.x - w.x;
            if (mode === 'center')
                dx = b.x + b.w / 2 - w.x - w.w / 2;
            if (mode === 'right')
                dx = b.x + b.w - w.x - w.w;
            if (mode === 'top')
                dy = b.y - w.y;
            if (mode === 'middle')
                dy = b.y + b.h / 2 - w.y - w.h / 2;
            if (mode === 'bottom')
                dy = b.y + b.h - w.y - w.h;
            const inv = n.parentId ? doc.world(n.parentId).inverse : identity();
            n.x += inv[0] * dx + inv[2] * dy;
            n.y += inv[1] * dx + inv[3] * dy;
            doc.touch(n);
        }
    });
}
function distribute(horizontal) {
    const roots = selectedRoots();
    if (roots.length < 3) {
        toast('Select at least three layers to distribute.');
        return;
    }
    transaction('Distribute spacing', () => {
        const sorted = roots.map(n => ({ n, b: doc.world(n.id).box })).sort((a, b) => horizontal ? a.b.x - b.b.x : a.b.y - b.b.y);
        const first = sorted[0].b, last = sorted.at(-1).b;
        const total = sorted.reduce((s, i) => s + (horizontal ? i.b.w : i.b.h), 0), extent = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y, gap = (extent - total) / (roots.length - 1);
        let at = horizontal ? first.x : first.y;
        for (const { n, b } of sorted) {
            const delta = at - (horizontal ? b.x : b.y), inv = n.parentId ? doc.world(n.parentId).inverse : identity();
            n.x += horizontal ? inv[0] * delta : inv[2] * delta;
            n.y += horizontal ? inv[1] * delta : inv[3] * delta;
            doc.touch(n);
            at += (horizontal ? b.w : b.h) + gap;
        }
    });
}
function makeComponent() {
    if (!state.selection.size)
        return;
    if (state.selection.size > 1)
        groupSelection();
    transaction('Create component', () => { const n = activeNode(); n.component = true; n.isInstance = false; doc.touch(n); });
    toast('Main component created. Find it in Assets.');
}
function instantiate(id) {
    const sourcePage = doc.data.pages.find(p => p.nodes.some(n => n.id === id));
    const source = sourcePage?.nodes.find(n => n.id === id);
    if (!source)
        return;
    transaction('Place component instance', () => {
        const old = doc.data.pageId;
        let root;
        if (sourcePage.id !== old) {
            doc.data.pageId = sourcePage.id;
            doc.refresh();
            const all = [source, ...doc.descendants(source.id)].map(n => structuredClone(n));
            doc.data.pageId = old;
            doc.refresh();
            const ids = new Map(all.map(n => [n.id, uid()]));
            for (const n of all) {
                const src = n.id;
                n.id = ids.get(src);
                n.parentId = src === id ? null : ids.get(n.parentId);
                n.sourceId = src;
                n.component = false;
                n.isInstance = src === id;
                n.overrides = {};
                doc.add(n);
                if (src === id)
                    root = n;
            }
        }
        else
            root = cloneNodes([source], 0, true)[0];
        const c = screenToWorld(area.clientWidth / 2, area.clientHeight / 2);
        root.parentId = null;
        root.x = c.x - root.w / 2;
        root.y = c.y - root.h / 2;
        doc.touch(root);
        select([root.id]);
    });
}
function createAtCenter(type, props = {}) { const c = screenToWorld(area.clientWidth / 2, area.clientHeight / 2); let n; transaction(`Insert ${type}`, () => { n = node(type, props); n.x = c.x - n.w / 2; n.y = c.y - n.h / 2; doc.add(n); select([n.id]); }); return n; }
function createTextAtCenter(text) { const n = createAtCenter('text', { text, name: text.slice(0, 28), w: 360, h: 70, fontSize: 28, fill: options.theme === 'dark' ? '#f0eaf8' : '#282431' }); n.h = layoutText(n).height; doc.touch(n); changed({ commit: true }); }
function insertAsset(type) {
    const center = screenToWorld(area.clientWidth / 2, area.clientHeight / 2);
    transaction('Insert ' + type, () => {
        let f;
        if (type === 'button') {
            f = doc.add(node('frame', { name: 'Button / Primary', x: center.x - 90, y: center.y - 24, w: 180, h: 48, fill: '#8462e8', radius: 9, clip: false, component: false }));
            doc.add(node('text', { parentId: f.id, x: 20, y: 14, w: 140, h: 24, text: 'Get started   ↗', name: 'Label', fill: '#ffffff', fontSize: 14, fontWeight: 500, textAlign: 'center' }));
        }
        else if (type === 'badge') {
            f = doc.add(node('frame', { name: 'Badge / Status', x: center.x - 72, y: center.y - 17, w: 144, h: 34, fill: '#d4e8dc', radius: 17 }));
            doc.add(node('text', { parentId: f.id, x: 14, y: 8, w: 120, h: 22, text: '●  In progress', name: 'Status', fontSize: 12, fill: '#537962' }));
        }
        else {
            f = doc.add(node('frame', { name: 'Card / Content', x: center.x - 150, y: center.y - 100, w: 300, h: 200, fill: '#eee8fb', radius: 16, shadow: true }));
            doc.add(node('text', { parentId: f.id, x: 25, y: 29, w: 250, h: 80, text: 'A little\ninspiration.', name: 'Heading', fontSize: 30, fill: '#77559b', fontWeight: 600, lineHeight: 1.15 }));
            doc.add(node('text', { parentId: f.id, x: 25, y: 139, w: 250, h: 42, text: 'Give your next big idea\na little room to grow.', name: 'Body', fontSize: 13, fill: '#a18bb5' }));
        }
        select([f.id]);
        state.expanded.add(f.id);
    });
}
function preset(name) { const sizes = { desktop: [1440, 900], phone: [390, 844], tablet: [834, 1194], square: [1080, 1080] }; const [w, h] = sizes[name]; const n = createAtCenter('frame', { name: name[0].toUpperCase() + name.slice(1), w, h, fill: '#ffffff' }); fit([n.id]); }
function resetRasterCaches() { renderer.images.images.clear(); renderer.images.pending.clear(); renderer.atlas?.reset(); renderer.cache.clear(); }
function undo() {
    finishText();
    const label = history.undo();
    resetRasterCaches();
    if (!label)
        return;
    state.selection = new Set([...state.selection].filter(id => doc.get(id)));
    refreshUI();
    saveSoon();
    invalidate();
    toast('Undo: ' + label);
}
function redo() {
    finishText();
    const label = history.redo();
    resetRasterCaches();
    if (!label)
        return;
    state.selection = new Set([...state.selection].filter(id => doc.get(id)));
    refreshUI();
    saveSoon();
    invalidate();
    toast('Redo: ' + label);
}
function download(blob, name) { const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000); }
function safeName(s) { return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, 120) || 'Vellum'; }
async function saveFile() {
    finishText();
    const serialized = doc.serialize();
    const fileName = safeName(doc.data.name) + '.vellum';
    if (storage.isTauri) {
        try {
            const res = await storage.saveToDocuments(fileName, serialized);
            toast(`Saved to Documents/Vellum/${res.filename || fileName}`);
            saveSoon();
            return;
        } catch (e) {
            console.error('Save to Documents failed:', e);
        }
    }
    download(new Blob([serialized], { type: 'application/json' }), fileName);
    toast('Portable document exported. Includes all pages and images.');
}
async function doExport(format, scale = 2, ids = [...state.selection]) {
    finishText();
    if (!ids.length)
        ids = doc.nodes.filter(n => !n.parentId).map(n => n.id);
    if (!ids.length) {
        toast('Add something to the canvas first.');
        return;
    }
    const name = safeName(ids.length === 1 ? doc.get(ids[0]).name : doc.page.name);
    try {
        if (format === 'SVG') {
            download(new Blob([exportSVG(doc, ids)], { type: 'image/svg+xml' }), name + '.svg');
        }
        else {
            const canvas = await renderer.exportCanvas(ids, scale);
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
            if (!blob)
                throw new Error('Image encoding failed.');
            download(blob, name + `@${scale}x.png`);
        }
        toast(`${format} exported`);
    }
    catch (e) {
        toast(e.message);
    }
}
async function loadDocumentText(text, fallbackName = 'Imported Project') {
    try {
        const data = DocumentModel.parse(text);
        finishText();
        history.begin('Open document');
        Object.assign(doc.data, data);
        doc.refresh();
        history.commit();
        state.selection.clear();
        state.expanded.clear();
        state.pageViews.clear();
        renderer.images.images.clear();
        renderer.images.pending.clear();
        renderer.atlas?.reset();
        renderer.cache.clear();
        await loadStoredFonts();
        fit();
        refreshUI();

        const name = data.name || fallbackName.replace(/\.vellum$/i, '') || 'Imported Project';
        const projId = 'proj_' + Date.now().toString(36);
        storage.activeProjectId = projId;
        await storage.saveProject({
            id: projId,
            name: name,
            documentData: doc.serialize(),
            thumbnail: generateThumbnail(),
            pageCount: doc.data.pages.length,
            layerCount: doc.data.pages.reduce((acc, p) => acc + p.nodes.length, 0)
        });
        saveSoon();
        toast('Opened ' + name);
        return true;
    } catch (e) {
        toast('Could not open document: ' + e.message);
        return false;
    }
}
async function importDocument(file) {
    if (!file)
        return;
    if (file.size > 80 * 1024 * 1024) {
        toast('File exceeds the 80 MB import limit.');
        return;
    }
    try {
        const text = await file.text();
        await loadDocumentText(text, file.name);
    }
    catch (e) {
        toast(e.message);
    }
}
async function importImage(file, location = null) {
    if (!file)
        return;
    if (file.size > 25 * 1024 * 1024) {
        toast('Please use an image under 25 MB.');
        return;
    }
    if (!file.type.startsWith('image/')) {
        toast('Choose an image file.');
        return;
    }
    try {
        const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        const img = await new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Could not decode this image.')); i.src = url; });
        if (img.naturalWidth * img.naturalHeight > 64e6)
            throw new Error('Image exceeds the 64 megapixel limit.');
        transaction('Place image', () => { const asset = uid(); doc.data.assets[asset] = url; const scale = Math.min(1, 800 / img.naturalWidth, 800 / img.naturalHeight), w = img.naturalWidth * scale, h = img.naturalHeight * scale, c = location || screenToWorld(area.clientWidth / 2, area.clientHeight / 2); const n = doc.add(node('image', { assetId: asset, name: file.name, x: c.x - w / 2, y: c.y - h / 2, w, h, fill: '#ffffff' })); renderer.images.images.set(asset, img); select([n.id]); });
        toast('Image placed. Original resolution preserved.');
    }
    catch (e) {
        toast(e.message || 'Could not read the image.');
    }
}
function selectionGeometry() {
    const roots = selectedRoots();
    if (!roots.length)
        return null;
    if (roots.length === 1) {
        const n = roots[0], s = doc.world(n.id);
        return { matrix: s.matrix, w: n.w, h: n.h, node: n };
    }
    const b = getSelectionBounds();
    return { matrix: [1, 0, 0, 1, b.x, b.y], w: b.w, h: b.h, node: null };
}
function handlesFor(g) { const positions = [['nw', 0, 0], ['n', .5, 0], ['ne', 1, 0], ['e', 1, .5], ['se', 1, 1], ['s', .5, 1], ['sw', 0, 1], ['w', 0, .5]]; const list = positions.map(([name, x, y]) => { const p = point(g.matrix, g.w * x, g.h * y); return { name, ...worldToScreen(p.x, p.y) }; }); const p = point(g.matrix, g.w / 2, -25 / state.camera.zoom); list.push({ name: 'rotate', ...worldToScreen(p.x, p.y) }); return list; }
function outline(ctx, g, color = '#a58dff', width = 1) { const p = [[0, 0], [g.w, 0], [g.w, g.h], [0, g.h]].map(([x, y]) => { const w = point(g.matrix, x, y); return worldToScreen(w.x, w.y); }); ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath(); p.forEach((v, i) => i ? ctx.lineTo(v.x, v.y) : ctx.moveTo(v.x, v.y)); ctx.closePath(); ctx.stroke(); return p; }
function drawOverlay() {
    const c = octx, dpr = renderer.dpr || 1;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, overlay.width, overlay.height);
    c.scale(dpr, dpr);
    const z = state.camera.zoom, accent = options.theme === 'dark' ? '#ad96ff' : '#8a64e8';
    for (const s of doc.scene()) {
        if (s.node.type !== 'frame' || s.node.parentId)
            continue;
        const p = worldToScreen(s.box.x, s.box.y);
        if (p.y < -30 || p.x > area.clientWidth || p.x + s.box.w * z < 0)
            continue;
        c.font = '10px Inter, -apple-system, BlinkMacSystemFont, sans-serif';
        c.fillStyle = state.selection.has(s.node.id) ? accent : options.theme === 'dark' ? '#8d839a' : '#8c8297';
        c.fillText(s.node.name, p.x, p.y - 12);
    }
    if (state.hover && !state.selection.has(state.hover) && state.tool === 'select' && !state.gesture && !state.editing) {
        const s = doc.world(state.hover);
        if (s)
            outline(c, { matrix: s.matrix, w: s.node.w, h: s.node.h }, '#a18ae7', .8);
    }
    const g = selectionGeometry();
    if (g && !state.editing && !state.pathEdit) {
        const corners = outline(c, g, accent, 1.2);
        if (!state.gesture || !['move', 'marquee'].includes(state.gesture.kind)) {
            const handles = handlesFor(g);
            c.strokeStyle = accent;
            c.fillStyle = options.theme === 'dark' ? '#242426' : '#ffffff';
            const top = handles.find(h => h.name === 'n'), rot = handles.at(-1);
            c.beginPath();
            c.moveTo(top.x, top.y);
            c.lineTo(rot.x, rot.y);
            c.stroke();
            for (const h of handles) {
                if (h.name === 'rotate') {
                    c.beginPath();
                    c.arc(h.x, h.y, 3, 0, Math.PI * 2);
                    c.fill();
                    c.stroke();
                }
                else {
                    c.fillRect(h.x - 3, h.y - 3, 6, 6);
                    c.strokeRect(h.x - 3, h.y - 3, 6, 6);
                }
            }
        }
        const label = `${fmt(g.w)} × ${fmt(g.h)}`, p = { x: (corners[2].x + corners[3].x) / 2, y: Math.max(corners[2].y, corners[3].y) + 15 };
        c.font = '9px Inter, sans-serif';
        const tw = c.measureText(label).width;
        c.fillStyle = accent;
        c.beginPath();
        c.roundRect(p.x - tw / 2 - 7, p.y - 5, tw + 14, 18, 4);
        c.fill();
        c.fillStyle = '#ffffff';
        c.fillText(label, p.x - tw / 2, p.y + 7);
    }
    if (state.marquee) {
        const m = state.marquee;
        c.strokeStyle = accent;
        c.fillStyle = '#a38bff16';
        c.lineWidth = 1;
        c.fillRect(m.x, m.y, m.w, m.h);
        c.strokeRect(m.x + .5, m.y + .5, m.w, m.h);
    }
    c.strokeStyle = '#e77aa0';
    c.lineWidth = .8;
    c.setLineDash([4, 3]);
    for (const guide of state.guides) {
        c.beginPath();
        if (guide.axis === 'x') {
            const x = worldToScreen(guide.value, 0).x;
            c.moveTo(x, 40);
            c.lineTo(x, area.clientHeight - 85);
        }
        else {
            const y = worldToScreen(0, guide.value).y;
            c.moveTo(0, y);
            c.lineTo(area.clientWidth, y);
        }
        c.stroke();
    }
    c.setLineDash([]);
    if (state.pen.length) {
        drawPen(c, state.pen, identity(), accent, state.penHover);
    }
    if (state.pathEdit) {
        const n = doc.get(state.pathEdit), s = n && doc.world(n.id);
        if (n && s) {
            const sx = n.w / (n.pathW || n.w || 1), sy = n.h / (n.pathH || n.h || 1), m = multiply(s.matrix, [sx, 0, 0, sy, 0, 0]);
            drawPen(c, n.points, m, accent, null, n.closed);
        }
    }
    if (options.rulers)
        drawRulers(c);
}
function drawPen(c, pts, m, accent, hover = null, closed = false) {
    if (!pts.length)
        return;
    const transform = p => { const wp = point(m, p.x, p.y); return worldToScreen(wp.x, wp.y); };
    c.strokeStyle = accent;
    c.fillStyle = options.theme === 'dark' ? '#242426' : '#fff';
    c.lineWidth = 1.3;
    c.beginPath();
    let p = transform(pts[0]);
    c.moveTo(p.x, p.y);
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], q = transform(b);
        if (a.out || b.in) {
            const c1 = transform(a.out || a), c2 = transform(b.in || b);
            c.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, q.x, q.y);
        }
        else
            c.lineTo(q.x, q.y);
    }
    if (hover) {
        const hp = transform(hover);
        c.lineTo(hp.x, hp.y);
    }
    if (closed)
        c.closePath();
    c.stroke();
    for (const a of pts) {
        const p = transform(a);
        for (const key of ['in', 'out'])
            if (a[key]) {
                const h = transform(a[key]);
                c.beginPath();
                c.moveTo(p.x, p.y);
                c.lineTo(h.x, h.y);
                c.stroke();
                c.beginPath();
                c.arc(h.x, h.y, 3, 0, Math.PI * 2);
                c.fill();
                c.stroke();
            }
        c.fillRect(p.x - 3, p.y - 3, 6, 6);
        c.strokeRect(p.x - 3, p.y - 3, 6, 6);
    }
}
function drawRulers(c) {
    const z = state.camera.zoom;
    let step = 100;
    while (step * z < 45)
        step *= 2;
    while (step * z > 160)
        step /= 2;
    c.fillStyle = options.theme === 'dark' ? '#242426ee' : '#fffffff0';
    c.fillRect(0, 0, area.clientWidth, 17);
    c.fillRect(0, 0, 17, area.clientHeight);
    c.strokeStyle = options.theme === 'dark' ? '#5a5364' : '#c4bccd';
    c.fillStyle = options.theme === 'dark' ? '#8d839a' : '#8c8297';
    c.font = '8px sans-serif';
    for (let x = Math.floor(-state.camera.x / z / step) * step; x < (area.clientWidth - state.camera.x) / z; x += step) {
        const sx = x * z + state.camera.x;
        c.beginPath();
        c.moveTo(sx, 12);
        c.lineTo(sx, 17);
        c.stroke();
        c.fillText(String(round(x)), sx + 3, 10);
    }
    for (let y = Math.floor(-state.camera.y / z / step) * step; y < (area.clientHeight - state.camera.y) / z; y += step) {
        const sy = y * z + state.camera.y;
        c.beginPath();
        c.moveTo(12, sy);
        c.lineTo(17, sy);
        c.stroke();
        c.save();
        c.translate(9, sy - 3);
        c.rotate(-Math.PI / 2);
        c.fillText(String(round(y)), 0, 0);
        c.restore();
    }
}
function insideRound(x, y, w, h, r = 0) {
    if (x < 0 || y < 0 || x > w || y > h)
        return false;
    r = Math.min(r, w / 2, h / 2);
    const cx = clamp(x, r, w - r), cy = clamp(y, r, h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1e-6;
}
const hitCtx = document.createElement('canvas').getContext('2d');
function hitTest(world, { deep = false, framesOnly = false } = {}) {
    const scene = doc.scene();
    for (let i = scene.length - 1; i >= 0; i--) {
        const s = scene[i], n = s.node;
        if (s.locked || n.id === state.editing || n.type === 'group' || framesOnly && n.type !== 'frame')
            continue;
        let clipped = false;
        for (const clip of s.clips) {
            const q = point(clip.inverse, world.x, world.y);
            if (!insideRound(q.x, q.y, clip.w, clip.h, clip.radius)) {
                clipped = true;
                break;
            }
        }
        if (clipped)
            continue;
        const p = point(s.inverse, world.x, world.y), tol = 4 / state.camera.zoom;
        let hit = false;
        if (n.type === 'ellipse')
            hit = ((p.x - n.w / 2) / (n.w / 2 + tol)) ** 2 + ((p.y - n.h / 2) / (n.h / 2 + tol)) ** 2 <= 1;
        else if (n.type === 'path' || n.type === 'line') {
            hitCtx.lineWidth = Math.max(n.strokeWidth, 8 / state.camera.zoom);
            hit = n.fill !== 'none' && hitCtx.isPointInPath(pathFor(n), p.x, p.y) || hitCtx.isPointInStroke(pathFor(n), p.x, p.y);
        }
        else
            hit = p.x >= -tol && p.y >= -tol && p.x <= n.w + tol && p.y <= n.h + tol;
        if (hit) {
            if (!deep && !framesOnly) {
                const groups = doc.ancestors(n).filter(p => p.type === 'group' || p.isInstance || p.component);
                if (groups.length)
                    return groups[0];
            }
            return n;
        }
    }
    return null;
}
function pathHandleAt(screen) {
    const n = doc.get(state.pathEdit);
    if (!n)
        return null;
    const s = doc.world(n.id), sx = n.w / (n.pathW || n.w || 1), sy = n.h / (n.pathH || n.h || 1), m = multiply(s.matrix, [sx, 0, 0, sy, 0, 0]);
    for (let i = 0; i < n.points.length; i++) {
        const a = n.points[i];
        for (const key of ['in', 'out', 'anchor']) {
            const p = key === 'anchor' ? a : a[key];
            if (!p)
                continue;
            const w = point(m, p.x, p.y), sp = worldToScreen(w.x, w.y);
            if (Math.hypot(sp.x - screen.x, sp.y - screen.y) < 7)
                return { index: i, key, matrix: m };
        }
    }
    return null;
}
function saveOriginals(roots) {
    const all = new Map();
    for (const n of roots) {
        all.set(n.id, structuredClone(n));
        for (const c of doc.descendants(n.id))
            all.set(c.id, structuredClone(c));
    }
    return all;
}
function pointerDown(e) {
    if (e.button === 2)
        return;
    closeMenu();
    if (e.target !== overlay)
        return;
    overlay.focus({ preventScroll: true });
    const p = eventPoint(e), w = screenToWorld(p.x, p.y);
    state.pointers.set(e.pointerId, p);
    overlay.setPointerCapture(e.pointerId);
    if (e.pointerType === 'touch' && state.pointers.size === 2) {
        if (state.gesture && history.pending) {
            history.cancel();
            state.gesture = null;
        }
        const [a, b] = [...state.pointers.values()];
        state.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), camera: { ...state.camera }, center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
        return;
    }
    if (state.editing)
        finishText();
    if (e.button === 1 || state.space || state.tool === 'hand') {
        state.gesture = { kind: 'pan', start: p, camera: { ...state.camera } };
        overlay.style.cursor = 'grabbing';
        return;
    }
    if (state.pathEdit) {
        const handle = pathHandleAt(p);
        if (handle) {
            history.begin('Edit vector point');
            state.gesture = { kind: 'path-edit', id: state.pathEdit, handle, start: w, original: structuredClone(doc.get(state.pathEdit)) };
            return;
        }
        else
            state.pathEdit = null;
    }
    if (state.tool === 'pen') {
        if (state.pen.length >= 2) {
            const first = worldToScreen(state.pen[0].x, state.pen[0].y);
            if (Math.hypot(first.x - p.x, first.y - p.y) < 8) {
                finishPen(true);
                return;
            }
        }
        const a = { x: w.x, y: w.y };
        if (e.shiftKey && state.pen.length) {
            const prev = state.pen.at(-1), angle = Math.round(Math.atan2(w.y - prev.y, w.x - prev.x) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(w.x - prev.x, w.y - prev.y);
            a.x = prev.x + Math.cos(angle) * len;
            a.y = prev.y + Math.sin(angle) * len;
        }
        state.pen.push(a);
        state.gesture = { kind: 'pen-handle', index: state.pen.length - 1, start: p };
        invalidate();
        return;
    }
    if (state.tool === 'text') {
        const existing = hitTest(w, { deep: true });
        if (existing?.type === 'text') {
            select([existing.id]);
            startText(existing);
            return;
        }
        const parent = hitTest(w, { framesOnly: true }), local = parent ? point(doc.world(parent.id).inverse, w.x, w.y) : w;
        history.begin('Create text');
        const n = doc.add(node('text', { x: local.x, y: local.y, parentId: parent?.id || null, w: 240, h: 44, text: 'Type something', fill: parent ? '#302937' : options.theme === 'dark' ? '#efe8f8' : '#302937' }));
        select([n.id]);
        state.tool = 'select';
        $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === 'select'));
        startText(n, true);
        return;
    }
    if (['rect', 'ellipse', 'frame', 'line'].includes(state.tool)) {
        history.begin('Draw ' + state.tool);
        const parent = state.tool === 'frame' ? null : hitTest(w, { framesOnly: true }), inv = parent ? doc.world(parent.id).inverse : identity(), local = point(inv, w.x, w.y), type = state.tool;
        const n = doc.add(node(type, { x: local.x, y: local.y, w: .1, h: .1, parentId: parent?.id || null, name: type === 'frame' ? 'Frame' : type[0].toUpperCase() + type.slice(1), fill: type === 'frame' ? '#ffffff' : type === 'line' ? 'none' : '#b8a2e2', stroke: type === 'line' ? '#a18ad0' : '#000000', strokeWidth: type === 'line' ? 2 : 0, radius: type === 'rect' ? 8 : 0 }));
        state.selection = new Set([n.id]);
        state.gesture = { kind: 'create', id: n.id, start: w, localStart: local, parentInverse: inv, type };
        refreshUI();
        invalidate();
        return;
    }
    const geo = selectionGeometry();
    if (geo) {
        const handle = handlesFor(geo).find(h => Math.hypot(h.x - p.x, h.y - p.y) < 7);
        if (handle) {
            history.begin(handle.name === 'rotate' ? 'Rotate layers' : 'Resize layers');
            state.gesture = { kind: handle.name === 'rotate' ? 'rotate' : 'resize', handle: handle.name, start: w, geometry: structuredClone(geo), originals: saveOriginals(selectedRoots()), roots: selectedRoots().map(n => n.id), center: point(geo.matrix, geo.w / 2, geo.h / 2) };
            return;
        }
    }
    const hit = hitTest(w, { deep: e.metaKey || e.ctrlKey });
    if (hit) {
        if (e.shiftKey) {
            if (state.selection.has(hit.id))
                state.selection.delete(hit.id);
            else
                state.selection.add(hit.id);
            renderLayers();
            renderInspector();
            invalidate();
            if (!state.selection.has(hit.id))
                return;
        }
        else if (!state.selection.has(hit.id))
            select([hit.id]);
        history.begin(e.altKey ? 'Duplicate and move' : 'Move layers');
        if (e.altKey) {
            const clones = cloneNodes(selectedRoots(), 0);
            select(clones.map(n => n.id));
        }
        const roots = selectedRoots().filter(n => !doc.world(n.id).locked);
        state.gesture = { kind: 'move', start: w, originals: saveOriginals(roots), roots: roots.map(n => n.id), bounds: doc.bounds(roots.map(n => n.id)), parentMatrices: new Map(roots.map(n => [n.id, n.parentId ? doc.world(n.parentId).inverse : identity()])), moved: false };
    }
    else {
        const old = e.shiftKey ? new Set(state.selection) : new Set();
        if (!e.shiftKey)
            select([]);
        state.gesture = { kind: 'marquee', start: p, old, deep: e.ctrlKey || e.metaKey };
        state.marquee = { x: p.x, y: p.y, w: 0, h: 0 };
        invalidate();
    }
}
function smartSnap(dx, dy, g, disabled) {
    state.guides = [];
    if (disabled || !options.snap || !g.bounds)
        return { dx, dy };
    const moved = new Set(g.originals.keys()), box = { ...g.bounds, x: g.bounds.x + dx, y: g.bounds.y + dy }, threshold = 5 / state.camera.zoom;
    let bestX = threshold, bestY = threshold, adjustX = 0, adjustY = 0;
    const parentIds = new Set(g.roots.map(id => doc.get(id)?.parentId));
    for (const s of doc.scene()) {
        if (moved.has(s.node.id) || !parentIds.has(s.node.parentId) || s.locked)
            continue;
        const b = s.box;
        for (const x of [b.x, b.x + b.w / 2, b.x + b.w])
            for (const bx of [box.x, box.x + box.w / 2, box.x + box.w])
                if (Math.abs(x - bx) < bestX) {
                    bestX = Math.abs(x - bx);
                    adjustX = x - bx;
                    state.guides = state.guides.filter(g => g.axis !== 'x');
                    state.guides.push({ axis: 'x', value: x });
                }
        for (const y of [b.y, b.y + b.h / 2, b.y + b.h])
            for (const by of [box.y, box.y + box.h / 2, box.y + box.h])
                if (Math.abs(y - by) < bestY) {
                    bestY = Math.abs(y - by);
                    adjustY = y - by;
                    state.guides = state.guides.filter(g => g.axis !== 'y');
                    state.guides.push({ axis: 'y', value: y });
                }
    }
    return { dx: dx + adjustX, dy: dy + adjustY };
}
function pointerMove(e) {
    const p = eventPoint(e), w = screenToWorld(p.x, p.y);
    if (state.pointers.has(e.pointerId))
        state.pointers.set(e.pointerId, p);
    if (state.pinch && state.pointers.size >= 2) {
        const [a, b] = [...state.pointers.values()], center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, pinch = state.pinch, ratio = Math.hypot(a.x - b.x, a.y - b.y) / Math.max(1, pinch.distance);
        state.camera.zoom = clamp(pinch.camera.zoom * ratio, .02, 64);
        state.camera.x = center.x - (pinch.center.x - pinch.camera.x) / pinch.camera.zoom * state.camera.zoom;
        state.camera.y = center.y - (pinch.center.y - pinch.camera.y) / pinch.camera.zoom * state.camera.zoom;
        invalidate();
        return;
    }
    const g = state.gesture;
    if (!g) {
        if (state.tool === 'pen') {
            state.penHover = w;
            invalidate();
            return;
        }
        if (state.tool === 'select') {
            const hit = hitTest(w, { deep: e.ctrlKey || e.metaKey });
            const hover = hit?.id || null;
            const geo = selectionGeometry(), h = geo && handlesFor(geo).find(h => Math.hypot(h.x - p.x, h.y - p.y) < 7);
            overlay.style.cursor = h ? h.name === 'rotate' ? 'crosshair' : ({ nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize' }[h.name]) : state.pathEdit ? 'crosshair' : state.space ? 'grab' : 'default';
            if (hover !== state.hover) {
                state.hover = hover;
                invalidate();
            }
        }
        return;
    }
    if (g.kind === 'pan') {
        state.camera.x = g.camera.x + p.x - g.start.x;
        state.camera.y = g.camera.y + p.y - g.start.y;
        invalidate();
        return;
    }
    if (g.kind === 'pen-handle') {
        const a = state.pen[g.index];
        if (Math.hypot(p.x - g.start.x, p.y - g.start.y) > 3) {
            a.out = { x: w.x, y: w.y };
            a.in = { x: 2 * a.x - w.x, y: 2 * a.y - w.y };
            state.penHover = null;
            invalidate();
        }
        return;
    }
    if (g.kind === 'path-edit') {
        const n = doc.get(g.id), q = point(inverse(g.handle.matrix), w.x, w.y), a = n.points[g.handle.index], orig = g.original.points[g.handle.index];
        if (g.handle.key === 'anchor') {
            const dx = q.x - orig.x, dy = q.y - orig.y;
            a.x = q.x;
            a.y = q.y;
            for (const key of ['in', 'out'])
                if (orig[key])
                    a[key] = { x: orig[key].x + dx, y: orig[key].y + dy };
        }
        else {
            a[g.handle.key] = q;
            if (!e.altKey) {
                const other = g.handle.key === 'in' ? 'out' : 'in';
                a[other] = { x: 2 * a.x - q.x, y: 2 * a.y - q.y };
            }
        }
        doc.touch(n);
        changed({ ui: false });
        return;
    }
    if (g.kind === 'marquee') {
        state.marquee = { x: Math.min(g.start.x, p.x), y: Math.min(g.start.y, p.y), w: Math.abs(p.x - g.start.x), h: Math.abs(p.y - g.start.y) };
        const tl = screenToWorld(state.marquee.x, state.marquee.y), b = { ...tl, w: state.marquee.w / state.camera.zoom, h: state.marquee.h / state.camera.zoom };
        state.selection = new Set(g.old);
        for (const s of doc.scene()) {
            if (s.locked || !g.deep && s.node.parentId)
                continue;
            if (s.box.x >= b.x && s.box.y >= b.y && s.box.x + s.box.w <= b.x + b.w && s.box.y + s.box.h <= b.y + b.h)
                state.selection.add(s.node.id);
        }
        renderLayers();
        renderInspector();
        invalidate();
        return;
    }
    if (g.kind === 'create') {
        const n = doc.get(g.id), q = point(g.parentInverse, w.x, w.y);
        let dx = q.x - g.localStart.x, dy = q.y - g.localStart.y;
        if (e.shiftKey) {
            const size = Math.max(Math.abs(dx), Math.abs(dy));
            dx = Math.sign(dx || 1) * size;
            dy = Math.sign(dy || 1) * size;
        }
        if (g.type === 'line') {
            const len = Math.hypot(dx, dy);
            n.x = g.localStart.x + dx / 2 - len / 2;
            n.y = g.localStart.y + dy / 2 - .05;
            n.w = Math.max(.1, len);
            n.h = .1;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI;
            n.rotation = e.shiftKey ? Math.round(angle / 45) * 45 : angle;
        }
        else {
            n.x = g.localStart.x + Math.min(0, dx);
            n.y = g.localStart.y + Math.min(0, dy);
            n.w = Math.max(.1, Math.abs(dx));
            n.h = Math.max(.1, Math.abs(dy));
            if (e.altKey) {
                n.x = g.localStart.x - n.w;
                n.y = g.localStart.y - n.h;
                n.w *= 2;
                n.h *= 2;
            }
        }
        doc.touch(n);
        changed({ ui: false });
        return;
    }
    if (g.kind === 'move') {
        let dx = w.x - g.start.x, dy = w.y - g.start.y;
        if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy))
                dy = 0;
            else
                dx = 0;
        }
        ({ dx, dy } = smartSnap(dx, dy, g, e.ctrlKey || e.metaKey));
        g.moved ||= Math.hypot(dx, dy) * state.camera.zoom > 2;
        for (const id of g.roots) {
            const n = doc.get(id), orig = g.originals.get(id), inv = g.parentMatrices.get(id);
            n.x = orig.x + inv[0] * dx + inv[2] * dy;
            n.y = orig.y + inv[1] * dx + inv[3] * dy;
            doc.touch(n);
        }
        changed({ ui: false });
        return;
    }
    if (g.kind === 'resize') {
        const local = point(inverse(g.geometry.matrix), w.x, w.y), origW = g.geometry.w, origH = g.geometry.h;
        let left = 0, top = 0, right = origW, bottom = origH;
        if (g.handle.includes('w'))
            left = Math.min(local.x, right - .1);
        if (g.handle.includes('e'))
            right = Math.max(local.x, left + .1);
        if (g.handle.includes('n'))
            top = Math.min(local.y, bottom - .1);
        if (g.handle.includes('s'))
            bottom = Math.max(local.y, top + .1);
        if (e.shiftKey) {
            const ratio = origW / (origH || 1), nw = right - left, nh = bottom - top;
            if (nw / nh > ratio) {
                if (g.handle.includes('n'))
                    top = bottom - nw / ratio;
                else
                    bottom = top + nw / ratio;
            }
            else {
                if (g.handle.includes('w'))
                    left = right - nh * ratio;
                else
                    right = left + nh * ratio;
            }
        }
        if (e.altKey) {
            if (g.handle.includes('w'))
                right = origW - left;
            if (g.handle.includes('e'))
                left = origW - right;
            if (g.handle.includes('n'))
                bottom = origH - top;
            if (g.handle.includes('s'))
                top = origH - bottom;
        }
        const nw = Math.max(.1, right - left), nh = Math.max(.1, bottom - top), sx = nw / origW, sy = nh / origH;
        for (const [id, orig] of g.originals) {
            const n = doc.get(id);
            if (n)
                Object.assign(n, structuredClone(orig));
        }
        doc.touch();
        if (g.roots.length === 1) {
            const n = doc.get(g.roots[0]), orig = g.originals.get(n.id), worldTL = point(g.geometry.matrix, left, top), parentInv = n.parentId ? doc.world(n.parentId).inverse : identity(), tl = point(parentInv, worldTL.x, worldTL.y);
            n.w = nw;
            n.h = nh;
            const angle = n.rotation * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
            n.x = tl.x - nw / 2 + c * nw / 2 - s * nh / 2;
            n.y = tl.y - nh / 2 + s * nw / 2 + c * nh / 2;
            constrainChildren(n, orig.w, orig.h);
            if (n.type === 'text')
                n.h = Math.max(n.h, n.fontSize * n.lineHeight);
            doc.touch(n);
        }
        else {
            for (const id of g.roots) {
                const n = doc.get(id), orig = g.originals.get(id), world = doc.world(id), oldBox = world.box, newX = g.geometry.matrix[4] + left + (oldBox.x - g.geometry.matrix[4]) * sx, newY = g.geometry.matrix[5] + top + (oldBox.y - g.geometry.matrix[5]) * sy, inv = n.parentId ? doc.world(n.parentId).inverse : identity(), delta = { x: newX - oldBox.x, y: newY - oldBox.y };
                n.x = orig.x + inv[0] * delta.x + inv[2] * delta.y;
                n.y = orig.y + inv[1] * delta.x + inv[3] * delta.y;
                n.w = orig.w * sx;
                n.h = orig.h * sy;
                if (n.type === 'text')
                    n.fontSize = orig.fontSize * Math.min(sx, sy);
                constrainChildren(n, orig.w, orig.h);
                doc.touch(n);
            }
        }
        changed({ ui: false });
        return;
    }
    if (g.kind === 'rotate') {
        const a = Math.atan2(w.y - g.center.y, w.x - g.center.x), start = Math.atan2(g.start.y - g.center.y, g.start.x - g.center.x);
        let delta = (a - start) * 180 / Math.PI;
        if (e.shiftKey)
            delta = Math.round(delta / 15) * 15;
        for (const id of g.roots) {
            const n = doc.get(id), orig = g.originals.get(id);
            n.rotation = orig.rotation + delta;
            if (g.roots.length > 1) {
                const parent = n.parentId ? doc.world(n.parentId).matrix : identity(), inv = inverse(parent), wc = point(parent, orig.x + orig.w / 2, orig.y + orig.h / 2), rad = delta * Math.PI / 180, dx = wc.x - g.center.x, dy = wc.y - g.center.y, q = point(inv, g.center.x + dx * Math.cos(rad) - dy * Math.sin(rad), g.center.y + dx * Math.sin(rad) + dy * Math.cos(rad));
                n.x = q.x - n.w / 2;
                n.y = q.y - n.h / 2;
            }
            doc.touch(n);
        }
        changed({ ui: false });
    }
}
function pointerUp(e) {
    state.pointers.delete(e.pointerId);
    if (state.pinch) {
        if (state.pointers.size < 2)
            state.pinch = null;
        state.gesture = null;
        return;
    }
    const g = state.gesture;
    state.gesture = null;
    state.guides = [];
    state.marquee = null;
    if (!g)
        return;
    if (g.kind === 'create') {
        const n = doc.get(g.id);
        if (n && n.w < 3 && n.h < 3) {
            n.w = n.type === 'frame' ? 400 : 120;
            n.h = n.type === 'frame' ? 300 : n.type === 'line' ? 0.1 : 100;
            doc.touch(n);
        }
        setTool('select');
    }
    if (g.kind === 'path-edit') {
        normalizePath(doc.get(g.id));
    }
    if (['move', 'resize', 'rotate', 'create', 'path-edit'].includes(g.kind)) {
        if (g.originals)
            for (const [id, orig] of g.originals) {
                const n = doc.get(id);
                if (n?.sourceId) {
                    n.overrides ||= {};
                    for (const key of ['x', 'y', 'w', 'h', 'rotation', 'fontSize'])
                        if (n[key] !== orig[key])
                            n.overrides[key] = n[key];
                }
            }
        changed({ commit: true });
    }
    else
        refreshUI();
    overlay.style.cursor = state.tool === 'hand' || state.space ? 'grab' : 'default';
    invalidate();
}
function normalizePath(n) {
    if (!n?.points?.length)
        return;
    const coords = n.points.flatMap(p => [p, p.in, p.out].filter(Boolean)), minX = Math.min(...coords.map(p => p.x)), minY = Math.min(...coords.map(p => p.y)), maxX = Math.max(...coords.map(p => p.x)), maxY = Math.max(...coords.map(p => p.y));
    const sx = n.w / (n.pathW || n.w || 1), sy = n.h / (n.pathH || n.h || 1), matrix = localMatrix(n), tl = point(matrix, minX * sx, minY * sy);
    for (const p of n.points) {
        p.x = (p.x - minX) * sx;
        p.y = (p.y - minY) * sy;
        for (const key of ['in', 'out'])
            if (p[key]) {
                p[key].x = (p[key].x - minX) * sx;
                p[key].y = (p[key].y - minY) * sy;
            }
    }
    n.w = Math.max(.1, (maxX - minX) * sx);
    n.h = Math.max(.1, (maxY - minY) * sy);
    n.pathW = n.w;
    n.pathH = n.h;
    const r = n.rotation * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    n.x = tl.x - n.w / 2 + c * n.w / 2 - s * n.h / 2;
    n.y = tl.y - n.h / 2 + s * n.w / 2 + c * n.h / 2;
    doc.touch(n);
}
function finishPen(closed = false) {
    if (state.pen.length < 2) {
        state.pen = [];
        state.penHover = null;
        invalidate();
        return;
    }
    const points = structuredClone(state.pen);
    state.pen = [];
    state.penHover = null;
    transaction('Draw vector path', () => { const n = node('path', { name: 'Vector', x: 0, y: 0, w: 1, h: 1, pathW: 1, pathH: 1, points, closed, fill: closed ? '#b8a2e2' : 'none', stroke: '#9779c9', strokeWidth: 2 }); doc.add(n); normalizePath(n); select([n.id]); });
    setTool('select');
}
function startText(n, selectAll = false) {
    if (!n || n.type !== 'text')
        return;
    finishText();
    history.begin('Edit text');
    state.editing = n.id;
    renderer.skipId = n.id;
    const el = $('#text-editor');
    el.textContent = n.text;
    el.classList.remove('hidden');
    positionTextEditor();
    el.focus();
    if (selectAll) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    }
    invalidate();
}
function positionTextEditor() {
    const n = doc.get(state.editing), s = n && doc.world(n.id);
    if (!n || !s)
        return;
    const el = $('#text-editor'), z = state.camera.zoom, m = s.matrix;
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = n.w + 'px';
    el.style.minHeight = n.h + 'px';
    el.style.font = fontSpec(n);
    el.style.lineHeight = String(n.lineHeight);
    el.style.letterSpacing = n.letterSpacing + 'px';
    el.style.textAlign = n.textAlign;
    el.style.textDecoration = n.textDecoration;
    el.style.textTransform = n.textCase === 'upper' ? 'uppercase' : n.textCase === 'lower' ? 'lowercase' : n.textCase === 'title' ? 'capitalize' : 'none';
    el.style.direction = n.direction === 'auto' ? 'inherit' : n.direction;
    el.style.color = n.fill === 'none' ? '#a38bff' : n.fill;
    el.style.opacity = s.opacity;
    el.style.transform = `matrix(${m[0] * z},${m[1] * z},${m[2] * z},${m[3] * z},${m[4] * z + state.camera.x},${m[5] * z + state.camera.y})`;
}
function finishText(cancel = false) {
    if (!state.editing)
        return;
    const n = doc.get(state.editing), el = $('#text-editor');
    if (n && !cancel) {
        n.text = el.innerText.replace(/\r\n/g, '\n').replace(/\n$/, '');
        n.name = n.text.trim().slice(0, 28) || 'Text';
        n.h = Math.max(n.fontSize * n.lineHeight, layoutText(n).height);
        if (n.sourceId) {
            n.overrides ||= {};
            n.overrides.text = n.text;
            n.overrides.h = n.h;
        }
        doc.touch(n);
    }
    state.editing = null;
    renderer.skipId = null;
    el.classList.add('hidden');
    if (cancel)
        history.cancel();
    else {
        history.commit();
        saveSoon();
    }
    refreshUI();
    invalidate();
}
function closeMenu() { $('#context-menu').classList.add('hidden'); }
function showMenu(items, x, y) { const menu = $('#context-menu'); menu.innerHTML = items.map(item => item === '-' ? '<div class="menu-divider"></div>' : item.header ? `<div class="menu-header">${esc(item.header)}</div>` : `<button class="menu-item" data-menu-action="${esc(item.action)}" ${item.disabled ? 'disabled' : ''}><span>${esc(item.label)}</span><span class="shortcut">${esc(item.key || '')}</span></button>`).join(''); menu.classList.remove('hidden'); menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 10) + 'px'; menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 10) + 'px'; }
function selectionMenu(x = window.innerWidth - 295, y = 113) { showMenu([{ label: 'Copy', action: 'copy', key: '⌘C' }, { label: 'Paste', action: 'paste', key: '⌘V' }, { label: 'Duplicate', action: 'duplicate', key: '⌘D' }, '-', { label: 'Group selection', action: 'group', key: '⌘G' }, { label: 'Ungroup', action: 'ungroup', key: '⇧⌘G' }, { label: 'Frame selection', action: 'frameSelection', key: '⌥⌘G' }, { label: 'Create component', action: 'component', key: '⌥⌘K' }, '-', { label: 'Bring to front', action: 'front', key: ']' }, { label: 'Send to back', action: 'back', key: '[' }, { label: 'Distribute horizontally', action: 'distributeH' }, { label: 'Distribute vertically', action: 'distributeV' }, '-', { label: 'Rename', action: 'rename', key: '⌘R' }, { label: 'Lock / unlock', action: 'lock', key: '⇧⌘L' }, { label: 'Hide / show', action: 'visibility', key: '⇧⌘H' }, '-', { label: 'Export PNG', action: 'exportPNG' }, { label: 'Export SVG', action: 'exportSVG' }, '-', { label: 'Delete', action: 'delete', key: '⌫' }], x, y); }
function modal(content) { closeMenu(); $('#modal').innerHTML = content; $('#modal-backdrop').classList.remove('hidden'); hydrateIcons($('#modal')); $('#modal').querySelector('input,textarea,button,select')?.focus(); }
function closeModal() { $('#modal')?.classList.remove('modal-wide'); $('#modal-backdrop').classList.add('hidden'); $('#modal').innerHTML = ''; overlay.focus({ preventScroll: true }); }
function modalHeader(title, subtitle = '') { return `<div class="modal-header"><div><h2>${title}</h2>${subtitle ? `<p style="margin:0">${subtitle}</p>` : ''}</div><button class="icon-button" data-close-modal title="Close dialog" aria-label="Close dialog">${icon('close')}</button></div>`; }
function promptText(title, value, callback) {
    modal(`${modalHeader(esc(title))}<form id="prompt-form"><input class="form-input" id="prompt-value" value="${esc(value)}" required maxlength="200" autocomplete="off"><div class="modal-actions"><button type="button" class="wide-button" data-close-modal>Cancel</button><button class="wide-button primary" type="submit">Save</button></div></form>`);
    $('#prompt-form').onsubmit = e => {
        e.preventDefault();
        const v = $('#prompt-value').value.trim();
        if (v) {
            closeModal();
            callback(v);
        }
    };
    $('#prompt-value').select();
}
function renameLayer() {
    const n = activeNode();
    if (!n)
        return;
    promptText('Rename layer', n.name, name => transaction('Rename layer', () => { n.name = name; doc.touch(n); }));
}
function renameFile() { promptText('Name your design file', doc.data.name, name => transaction('Rename document', () => { doc.data.name = name; })); }
function addPage() { promptText('Add a page', 'Untitled page', name => transaction('Add page', () => { const p = { id: uid(), name, nodes: [] }; doc.data.pages.push(p); doc.data.pageId = p.id; doc.refresh(); state.selection.clear(); fit(); })); }
function editTokens() {
    modal(`${modalHeader('Design tokens', 'Your shared visual foundation, stored in this file.')}<div id="token-editor">${doc.data.tokens.colors.map((c, i) => `<div style="display:flex;gap:8px;margin-bottom:10px"><input type="color" value="${safeColor(c.value)}" data-token-color="${i}" style="width:36px;height:36px"><input class="form-input" value="${esc(c.name)}" data-token-name="${i}"></div>`).join('')}</div><p>Changing a color remaps exact matching fills and strokes throughout the document.</p><div class="modal-actions"><button class="wide-button" id="export-tokens">Export JSON</button><button class="wide-button primary" id="save-tokens">Apply tokens</button></div>`);
    $('#save-tokens').onclick = () => {
        const next = doc.data.tokens.colors.map((c, i) => ({ name: $(`[data-token-name="${i}"]`).value || c.name, value: $(`[data-token-color="${i}"]`).value }));
        closeModal();
        transaction('Update design tokens', () => {
            const replacements = new Map(doc.data.tokens.colors.map((c, i) => [c.value.toLowerCase(), next[i].value]));
            for (const page of doc.data.pages)
                for (const n of page.nodes)
                    for (const k of ['fill', 'fill2', 'stroke', 'shadowColor']) {
                        if (replacements.has(n[k]?.toLowerCase())) {
                            n[k] = replacements.get(n[k].toLowerCase());
                            n.version++;
                        }
                    }
            doc.data.tokens.colors = next;
        });
        toast('Tokens updated across all pages');
    };
    $('#export-tokens').onclick = () => download(new Blob([JSON.stringify(doc.data.tokens, null, 2)], { type: 'application/json' }), 'vellum-tokens.json');
}
function inspectCSS() {
    const n = activeNode();
    if (!n)
        return;
    let css = `/* ${n.name.replace(/\*\//g, '')} */\nposition: absolute;\nleft: ${fmt(n.x)}px;\ntop: ${fmt(n.y)}px;\nwidth: ${fmt(n.w)}px;\nheight: ${fmt(n.h)}px;`;
    if (n.rotation)
        css += `\ntransform: rotate(${fmt(n.rotation)}deg);`;
    if (n.type === 'text') {
        css += `\nfont-family: ${n.fontFamily}, sans-serif;\nfont-size: ${fmt(n.fontSize)}px;\nfont-weight: ${n.fontWeight};\nline-height: ${fmt(n.lineHeight)};\nletter-spacing: ${fmt(n.letterSpacing)}px;\ntext-align: ${n.textAlign};\ncolor: ${n.fill};`;
    }
    else {
        css += `\nbackground: ${n.fillType === 'linear' ? `linear-gradient(${n.gradientAngle + 90}deg, ${n.fill}, ${n.fill2})` : n.fill === 'none' ? 'transparent' : n.fill};`;
        if (n.radius)
            css += `\nborder-radius: ${fmt(n.radius)}px;`;
        if (n.type === 'ellipse')
            css += '\nborder-radius: 50%;';
        if (n.strokeWidth)
            css += `\nborder: ${fmt(n.strokeWidth)}px solid ${n.stroke};`;
    }
    if (n.opacity !== 1)
        css += `\nopacity: ${n.opacity};`;
    if (n.shadow)
        css += `\nbox-shadow: ${n.shadowX}px ${n.shadowY}px ${n.shadowBlur}px ${n.shadowColor}${Math.round(n.shadowOpacity * 255).toString(16).padStart(2, '0')};`;
    if (n.layout && n.layout !== 'none')
        css += `\ndisplay: flex;\nflex-direction: ${n.layout === 'horizontal' ? 'row' : 'column'};\ngap: ${n.gap ?? 16}px;\npadding: ${n.padding ?? 16}px;`;
    modal(`${modalHeader('Inspect CSS', esc(n.name))}<pre class="token-code">${esc(css)}</pre><p>Geometry and visual styles. Vector paths and text shaping remain renderer-specific.</p><div class="modal-actions"><button class="wide-button primary" id="copy-css">Copy CSS</button></div>`);
    $('#copy-css').onclick = () => navigator.clipboard.writeText(css).then(() => toast('CSS copied')).catch(() => toast('Clipboard blocked. Select the code to copy it.'));
}
function help() { modal(`${modalHeader('A few keys. Endless possibilities.', 'Your Vellum field guide.')}<h3>Tools</h3><div class="shortcut-grid">${[['Move', 'V'], ['Frame', 'F'], ['Rectangle', 'R'], ['Ellipse', 'O'], ['Line', 'L'], ['Pen', 'P'], ['Text', 'T'], ['Hand', 'H']].map(([a, b]) => `<div>${a}<kbd>${b}</kbd></div>`).join('')}</div><h3>Canvas</h3><div class="shortcut-grid">${[['Pan', 'Space + drag'], ['Zoom', '⌘/Ctrl + scroll'], ['Fit all', 'Shift + 1'], ['Fit selection', 'Shift + 2'], ['Actual size', 'Shift + 0'], ['Hide panels', 'Tab'], ['Draw square / circle', 'Shift + drag'], ['Disable snapping', '⌘/Ctrl + drag']].map(([a, b]) => `<div>${a}<kbd>${b}</kbd></div>`).join('')}</div><h3>Editing</h3><div class="shortcut-grid">${[['Undo', '⌘Z'], ['Redo', '⇧⌘Z'], ['Duplicate', '⌘D'], ['Group', '⌘G'], ['Ungroup', '⇧⌘G'], ['Commands', '⌘K'], ['Edit text / path', 'Double-click'], ['Finish path', 'Enter'], ['Nudge', 'Arrow keys'], ['Nudge 10px', 'Shift + arrows'], ['Save file', '⌘S'], ['Place image', '⇧⌘K']].map(([a, b]) => `<div>${a}<kbd>${b}</kbd></div>`).join('')}</div><p>On Windows and Linux, use Ctrl in place of ⌘. Pen: drag an anchor while drawing to create Bézier handles. Alt-drag a handle to break tangent symmetry.</p>`); }
function settings() { modal(`${modalHeader('A workspace that feels like yours.')}<div class="stack"><label class="checkbox-row"><input type="checkbox" id="settings-theme" ${options.theme === 'light' ? 'checked' : ''}>Light appearance</label><label class="checkbox-row"><input type="checkbox" data-option="grid" ${options.grid ? 'checked' : ''}>Canvas dot grid</label><label class="checkbox-row"><input type="checkbox" data-option="snap" ${options.snap ? 'checked' : ''}>Smart alignment guides</label><label class="checkbox-row"><input type="checkbox" data-option="rulers" ${options.rulers ? 'checked' : ''}>Canvas rulers</label></div><h3>Rendering</h3><pre class="token-code">Backend: ${esc(renderer.backend)}\nVisible layers: ${renderer.visibleCount}\nInstances: ${renderer.instanceCount}\nScene draw calls: ${renderer.drawCalls}\nCPU submission: ${renderer.cpuMs.toFixed(2)} ms\nDevice pixel ratio: ${renderer.dpr}\nStorage: ${storageMode}${renderer.backend !== 'WebGPU' ? `\nWebGPU status: ${esc(renderer.gpuError || 'Unavailable')}` : ''}</pre><p>Vellum draws on demand. The displayed time measures CPU scene assembly and command submission, not GPU execution or FPS. WebGPU requires a compatible browser and secure context.</p>`); $('#settings-theme').onchange = () => toggleTheme(); }
function toggleTheme() { options.theme = options.theme === 'dark' ? 'light' : 'dark'; delete options.canvasColor; $('#canvas-world').style.backgroundColor = ''; document.documentElement.dataset.theme = options.theme; saveOptions(); refreshUI(); invalidate(); }
function openExport() {
    const isDesktop = storage.isTauri;
    const saveButtonLabel = isDesktop
        ? `${icon('download')} Save to Documents/Vellum (.vellum)`
        : `${icon('download')} Download .vellum document`;
    const subtext = isDesktop
        ? `Saves directly to <code>~/Documents/Vellum/</code> as a portable <code>.vellum</code> file.`
        : `Includes every page, editable layer, component, design token, and placed image.`;

    modal(`
        ${modalHeader('Take your work with you.', 'Portable by design. No account required.')}
        <button class="wide-button primary" id="modal-save-file" style="height:43px">${saveButtonLabel}</button>
        <p>${subtext}</p>
        ${isDesktop ? `<button class="wide-button" id="modal-reveal-finder" style="margin-bottom:12px">${icon('folder', 14)} Show Documents/Vellum in Finder</button>` : ''}
        <h3>Export ${state.selection.size ? 'selection' : 'current page'}</h3>
        <div class="property-grid">
            <button class="wide-button" id="modal-png">PNG image · 2×</button>
            <button class="wide-button" id="modal-svg">SVG vector</button>
        </div>
        <h3>Already have a Vellum file?</h3>
        <button class="wide-button" id="modal-open-file">${icon('upload')} Open / Import document…</button>
        <p>Vellum files use the .vellum format containing portable JSON graphics data.</p>
    `);
    $('#modal-save-file').onclick = saveFile;
    $('#modal-reveal-finder')?.addEventListener('click', () => storage.revealInFinder());
    $('#modal-png').onclick = () => doExport('PNG', 2);
    $('#modal-svg').onclick = () => doExport('SVG');
    $('#modal-open-file').onclick = () => { $('#file-input').click(); closeModal(); };
}
function newFile() { modal(`${modalHeader('Start with a clean canvas.')}<p>Your current document will remain available in Undo. Export a .vellum copy to keep it as a separate file.</p><div class="modal-actions"><button class="wide-button" data-close-modal>Cancel</button><button class="wide-button" id="backup-new">Export current file</button><button class="wide-button primary" id="confirm-new">New document</button></div>`); $('#backup-new').onclick = saveFile; $('#confirm-new').onclick = () => { closeModal(); transaction('New document', () => { const p = { id: uid(), name: 'Page 1', nodes: [] }; doc.data.name = 'Untitled design'; doc.data.pages = [p]; doc.data.pageId = p.id; doc.refresh(); state.selection.clear(); state.pageViews.clear(); fit(); }); }; }
async function switchProject(id) {
    await save();
    const target = await storage.getProject(id);
    if (!target?.document_data) {
        toast('Could not load project data');
        return;
    }
    try {
        const parsed = DocumentModel.parse(target.document_data);
        doc.data = parsed;
        doc.refresh();
        storage.activeProjectId = id;
        state.selection.clear();
        state.pageViews.clear();
        history.undoStack.length = 0;
        history.redoStack.length = 0;
        renderer.atlas?.reset();
        refreshUI();
        fit();
        closeModal();
        toast(`Opened "${target.name}"`);
    } catch (err) {
        console.error('Failed to parse document', err);
        toast('Invalid project document format');
    }
}
async function createNewProject(name = 'Untitled project') {
    await save();
    const newDoc = new DocumentModel();
    const p = { id: uid(), name: 'Page 1', nodes: [] };
    newDoc.data.name = name;
    newDoc.data.pages = [p];
    newDoc.data.pageId = p.id;
    const newId = 'proj_' + Date.now().toString(36);
    await storage.saveProject({
        id: newId,
        name: name,
        documentData: newDoc.serialize(),
        thumbnail: null,
        pageCount: 1,
        layerCount: 0
    });
    await switchProject(newId);
}
async function openProjectsManager() {
    closeMenu();
    let projects = [];
    let docFiles = [];
    let activeTab = 'projects';

    try {
        projects = await storage.listProjects();
    } catch (e) {
        console.error('Failed to list projects', e);
    }

    if (storage.isTauri) {
        try {
            docFiles = await storage.listDocumentsFiles();
        } catch (e) {
            console.error('Failed to list Documents/Vellum files', e);
        }
    }

    function timeAgo(ts) {
        if (!ts) return '';
        const diff = Date.now() - ts;
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'Just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days}d ago`;
        return new Date(ts).toLocaleDateString();
    }

    function formatBytes(bytes) {
        if (!bytes || bytes < 1024) return `${bytes || 0} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    function renderGrid(filterText = '') {
        const query = filterText.trim().toLowerCase();
        const filtered = query
            ? projects.filter(p => (p.name || '').toLowerCase().includes(query))
            : projects;

        if (!filtered.length) {
            return `
            <div class="projects-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect></svg>
                <p style="margin-top:8px;font-size:13px">${query ? 'No projects match your search.' : 'No saved projects found in database.'}</p>
                <button class="wide-button primary" id="empty-new-project" style="margin:12px auto 0;width:auto;padding:0 20px">+ Create new project</button>
            </div>`;
        }

        return filtered.map(p => {
            const isActive = p.id === storage.activeProjectId;
            const thumbHtml = p.thumbnail
                ? `<img src="${p.thumbnail}" alt="${esc(p.name)}" loading="lazy">`
                : `<div class="thumb-placeholder"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg></div>`;

            return `
            <div class="project-card ${isActive ? 'active-project' : ''}" data-project-id="${p.id}">
                <div class="project-thumb" data-action="open" data-id="${p.id}">
                    ${thumbHtml}
                    ${isActive ? '<span class="project-active-badge">Active</span>' : ''}
                </div>
                <div class="project-details" data-action="open" data-id="${p.id}">
                    <div class="project-title" title="${esc(p.name)}">${esc(p.name)}</div>
                    <div class="project-meta">
                        <span>${p.page_count || 1} pg · ${p.layer_count || 0} layers</span>
                        <span>${timeAgo(p.updated_at)}</span>
                    </div>
                </div>
                <div class="project-actions">
                    <button data-action="open" data-id="${p.id}" title="Open project">Open</button>
                    <button data-action="duplicate" data-id="${p.id}" title="Duplicate project">Duplicate</button>
                    <button data-action="export" data-id="${p.id}" title="Export .vellum file">${storage.isTauri ? 'Save .vellum' : 'Export'}</button>
                    <button class="danger" data-action="delete" data-id="${p.id}" title="Delete project">Delete</button>
                </div>
            </div>`;
        }).join('');
    }

    function renderFilesList(filterText = '') {
        const query = filterText.trim().toLowerCase();
        const filtered = query
            ? docFiles.filter(f => (f.title || f.filename).toLowerCase().includes(query))
            : docFiles;

        if (!filtered.length) {
            return `
            <div class="projects-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                <p style="margin-top:8px;font-size:13px">${query ? 'No .vellum files match your search.' : 'No .vellum files found in ~/Documents/Vellum.'}</p>
                <div style="display:flex;gap:10px;justify-content:center;margin-top:12px">
                    <button class="wide-button primary" id="btn-save-current-to-docs" style="width:auto;padding:0 18px">Save current project to Documents/Vellum</button>
                    <button class="wide-button" id="btn-reveal-finder-empty" style="width:auto;padding:0 16px">Open folder in Finder</button>
                </div>
            </div>`;
        }

        return `
        <div class="vellum-files-list">
            ${filtered.map(f => `
                <div class="vellum-file-item">
                    <div class="vellum-file-info">
                        <div class="vellum-file-icon">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>
                        </div>
                        <div class="vellum-file-text">
                            <div class="vellum-file-name" title="${esc(f.path)}">${esc(f.title || f.filename)} <span style="font-size:11px;color:var(--muted);font-weight:normal">(${esc(f.filename)})</span></div>
                            <div class="vellum-file-meta">
                                <span>${formatBytes(f.size_bytes)}</span>
                                <span>&bull;</span>
                                <span>${timeAgo(f.modified_at)}</span>
                                ${f.page_count ? `<span>&bull;</span><span>${f.page_count} pg</span>` : ''}
                                ${f.layer_count ? `<span>&bull;</span><span>${f.layer_count} layers</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="vellum-file-actions">
                        <button class="primary" data-file-action="open" data-path="${esc(f.path)}" title="Open file in editor">Open</button>
                        <button data-file-action="reveal" data-path="${esc(f.path)}" title="Show in Finder">Finder</button>
                    </div>
                </div>
            `).join('')}
        </div>`;
    }

    const backendLabel = storage.mode === 'sqlite' ? 'SQLite Database' : 'IndexedDB Local';
    const hasTauri = storage.isTauri;

    modal(`
        <div class="modal-header">
            <div>
                <h2>Projects & Documents</h2>
                <p style="margin:0">Manage design projects &middot; <span class="projects-badge"><i></i> ${backendLabel}</span></p>
            </div>
            <button class="icon-button" data-close-modal title="Close dialog" aria-label="Close dialog">${icon('close')}</button>
        </div>
        ${hasTauri ? `
        <div class="projects-tabs">
            <button class="projects-tab active" id="tab-projects">
                <span>Database Projects</span>
                <span class="projects-tab-badge" id="badge-projects">${projects.length}</span>
            </button>
            <button class="projects-tab" id="tab-files">
                <span>Documents / Vellum</span>
                <span class="projects-tab-badge" id="badge-files">${docFiles.length}</span>
            </button>
        </div>` : ''}
        <div class="projects-header-actions">
            <div class="projects-search">
                <span data-icon="search">${icon('search')}</span>
                <input id="proj-search-input" placeholder="Search projects or files..." autocomplete="off">
            </div>
            <button class="wide-button primary" id="modal-new-project" style="width:auto;padding:0 14px;white-space:nowrap;height:36px">+ New Project</button>
            <button class="wide-button" id="modal-import-file" style="width:auto;padding:0 12px;white-space:nowrap;height:36px">${icon('upload', 13)} Import .vellum…</button>
            ${hasTauri ? `<button class="wide-button" id="modal-open-folder" title="Open ~/Documents/Vellum in Finder" style="width:auto;padding:0 12px;white-space:nowrap;height:36px">Finder</button>` : ''}
        </div>
        <div id="projects-view-container" style="margin-top:14px">
            <div class="projects-grid" id="projects-grid">
                ${renderGrid()}
            </div>
        </div>
    `);

    $('#modal')?.classList.add('modal-wide');
    const searchInput = $('#proj-search-input');
    const container = $('#projects-view-container');
    const tabProjects = $('#tab-projects');
    const tabFiles = $('#tab-files');

    function updateView() {
        const query = searchInput?.value || '';
        if (activeTab === 'projects') {
            tabProjects?.classList.add('active');
            tabFiles?.classList.remove('active');
            if (container) {
                container.innerHTML = `<div class="projects-grid" id="projects-grid">${renderGrid(query)}</div>`;
            }
        } else {
            tabFiles?.classList.add('active');
            tabProjects?.classList.remove('active');
            if (container) {
                container.innerHTML = renderFilesList(query);
            }
        }
    }

    tabProjects?.addEventListener('click', () => {
        activeTab = 'projects';
        updateView();
    });

    tabFiles?.addEventListener('click', () => {
        activeTab = 'files';
        updateView();
    });

    searchInput?.addEventListener('input', () => {
        updateView();
    });

    $('#modal').onclick = async (e) => {
        if (e.target.closest('[data-close-modal]')) {
            closeModal();
            return;
        }

        if (e.target.id === 'modal-import-file') {
            $('#file-input').click();
            closeModal();
            return;
        }

        if (e.target.id === 'modal-open-folder' || e.target.id === 'btn-reveal-finder-empty') {
            await storage.revealInFinder();
            return;
        }

        if (e.target.id === 'btn-save-current-to-docs') {
            await saveFile();
            docFiles = await storage.listDocumentsFiles();
            const badgeFiles = $('#badge-files');
            if (badgeFiles) badgeFiles.textContent = docFiles.length;
            updateView();
            return;
        }

        // Handle .vellum file actions
        const fileBtn = e.target.closest('[data-file-action]');
        if (fileBtn) {
            const action = fileBtn.dataset.fileAction;
            const filePath = fileBtn.dataset.path;
            if (action === 'open') {
                try {
                    const content = await storage.readDocumentFile(filePath);
                    const filename = filePath.split('/').pop();
                    await loadDocumentText(content, filename);
                    closeModal();
                } catch (err) {
                    toast('Failed to open file: ' + err.message);
                }
            } else if (action === 'reveal') {
                await storage.revealInFinder(filePath);
            }
            return;
        }

        const btn = e.target.closest('[data-action]');
        if (!btn) {
            if (e.target.id === 'modal-new-project' || e.target.id === 'empty-new-project') {
                await createNewProject();
            }
            return;
        }

        const action = btn.dataset.action;
        const id = btn.dataset.id;
        if (!id) return;

        if (action === 'open') {
            await switchProject(id);
        } else if (action === 'duplicate') {
            try {
                await storage.duplicateProject(id);
                projects = await storage.listProjects();
                const badgeProjects = $('#badge-projects');
                if (badgeProjects) badgeProjects.textContent = projects.length;
                updateView();
                toast('Project duplicated');
            } catch (err) {
                console.error(err);
                toast('Failed to duplicate project');
            }
        } else if (action === 'export') {
            try {
                const target = await storage.getProject(id);
                if (target?.document_data) {
                    const fileName = safeName(target.name) + '.vellum';
                    if (storage.isTauri) {
                        const res = await storage.saveToDocuments(fileName, target.document_data);
                        docFiles = await storage.listDocumentsFiles();
                        const badgeFiles = $('#badge-files');
                        if (badgeFiles) badgeFiles.textContent = docFiles.length;
                        toast(`Saved to Documents/Vellum/${res.filename || fileName}`);
                    } else {
                        const blob = new Blob([target.document_data], { type: 'application/json' });
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(blob);
                        a.download = fileName;
                        a.click();
                        URL.revokeObjectURL(a.href);
                        toast('Exported .vellum file');
                    }
                }
            } catch (err) {
                toast('Failed to export project: ' + err.message);
            }
        } else if (action === 'delete') {
            const target = projects.find(p => p.id === id);
            if (!confirm(`Are you sure you want to delete "${target?.name || 'this project'}"?`)) return;
            try {
                await storage.deleteProject(id);
                projects = await storage.listProjects();
                const badgeProjects = $('#badge-projects');
                if (badgeProjects) badgeProjects.textContent = projects.length;
                if (id === storage.activeProjectId) {
                    if (projects.length > 0) {
                        await switchProject(projects[0].id);
                    } else {
                        await createNewProject('Untitled design');
                    }
                } else {
                    updateView();
                }
                toast('Project deleted');
            } catch (err) {
                console.error(err);
                toast('Failed to delete project');
            }
        }
    };
}
function stressTest() {
    transaction('Generate rendering stress test', () => {
        const p = { id: uid(), name: 'GPU stress test · 5,000 shapes', nodes: [] };
        doc.data.pages.push(p);
        doc.data.pageId = p.id;
        doc.refresh();
        for (let i = 0; i < 5000; i++) {
            const x = (i % 100) * 30, y = Math.floor(i / 100) * 30;
            p.nodes.push(node(i % 3 === 0 ? 'ellipse' : 'rect', { x, y, w: 24, h: 24, radius: 5, fill: ['#a58ad6', '#7d6bb8', '#c6b3e2', '#d4bfde', '#9dbbb0', '#debea3'][i % 6], name: `Shape ${i + 1}` }));
        }
        doc.refresh();
        state.selection.clear();
        fit();
    });
    toast('5,000 editable GPU primitives. See Settings for measured render statistics.');
}
const actions = { undo, redo, copy: copySelection, paste: pasteSelection, duplicate, delete: removeSelection, group: () => groupSelection(), ungroup: ungroupSelection, frameSelection: () => groupSelection(true), component: makeComponent, front: () => reorder('front'), back: () => reorder('back'), forward: () => reorder('forward'), backward: () => reorder('backward'), distributeH: () => distribute(true), distributeV: () => distribute(false), rename: renameLayer, renameFile, lock: () => toggleProperty('locked'), visibility: () => toggleProperty('visible'), fit: () => fit(), fitSelection: () => fit([...state.selection]), actualSize: () => zoomAt(1 / state.camera.zoom), saveFile, openFile: () => $('#file-input').click(), revealDocuments: () => storage.revealInFinder(), newFile, projects: openProjectsManager, addPage, theme: toggleTheme, help, settings, tokens: editTokens, inspectCSS, exportPNG: () => doExport('PNG', 2), exportSVG: () => doExport('SVG'), exportSelection: () => doExport($('#export-format')?.value || 'PNG', +($('#export-scale')?.value || 2)), selectionMenu, editText: () => startText(activeNode(), true), toggleFill: () => setProperty('fill', activeNode()?.fill === 'none' ? '#b8a2e2' : 'none'), toggleStroke: () => setProperty('strokeWidth', activeNode()?.strokeWidth ? 0 : 1), toggleShadow: () => toggleProperty('shadow'), toggleLayout: () => {
        const n = activeNode();
        if (!n)
            return;
        if (!['frame', 'group'].includes(n.type)) {
            toast('Select a frame or group for auto layout.');
            return;
        }
        setProperty('layout', n.layout && n.layout !== 'none' ? 'none' : 'horizontal');
    }, present: () => present(), stressTest, grid: () => { options.grid = !options.grid; saveOptions(); invalidate(); }, rulers: () => { options.rulers = !options.rulers; saveOptions(); invalidate(); }, snap: () => { options.snap = !options.snap; saveOptions(); toast('Smart snapping ' + (options.snap ? 'on' : 'off')); }, placeImage: () => $('#image-input').click(), resetStarter: () => { transaction('Restore example file', () => { Object.assign(doc.data, makeStarter()); doc.refresh(); state.selection.clear(); renderer.atlas?.reset(); fit(); }); } };
const commands = [['Projects manager', 'projects'], ['New document', 'newFile'], ['Open .vellum document', 'openFile'], ['Save portable document', 'saveFile'], ['Undo', 'undo'], ['Redo', 'redo'], ['Fit all to view', 'fit'], ['Fit selection', 'fitSelection'], ['Zoom to 100%', 'actualSize'], ['Duplicate selection', 'duplicate'], ['Group selection', 'group'], ['Ungroup selection', 'ungroup'], ['Frame selection', 'frameSelection'], ['Create component', 'component'], ['Bring to front', 'front'], ['Send to back', 'back'], ['Distribute horizontally', 'distributeH'], ['Distribute vertically', 'distributeV'], ['Place an image', 'placeImage'], ['Export PNG', 'exportPNG'], ['Export SVG', 'exportSVG'], ['Present frames', 'present'], ['Toggle light / dark theme', 'theme'], ['Toggle canvas grid', 'grid'], ['Toggle rulers', 'rulers'], ['Toggle smart snapping', 'snap'], ['Edit design tokens', 'tokens'], ['Inspect CSS', 'inspectCSS'], ['Add a page', 'addPage'], ['Rendering settings', 'settings'], ['Keyboard shortcuts', 'help'], ['Create 5,000-shape stress test', 'stressTest'], ['Restore Forma starter document', 'resetStarter']];
function commandPalette() {
    modal(`<input class="command-search" id="command-search" placeholder="What would you like to do?" aria-label="Search commands" autocomplete="off"><div class="command-results" id="command-results"></div><p style="font-size:10px;margin-bottom:0">↑ ↓ to navigate &nbsp; · &nbsp; Enter to run &nbsp; · &nbsp; Esc to close</p>`);
    let selectedIndex = 0, filtered = [];
    const render = () => { filtered = commands.filter(([label]) => label.toLowerCase().includes($('#command-search').value.toLowerCase())); selectedIndex = Math.min(selectedIndex, Math.max(0, filtered.length - 1)); $('#command-results').innerHTML = filtered.map(([label, action], i) => `<button class="menu-item ${i === selectedIndex ? 'focused' : ''}" data-command="${action}"><span>${esc(label)}</span><span class="shortcut">↵</span></button>`).join('') || '<div class="empty-state">No matching commands.</div>'; };
    $('#command-search').oninput = () => { selectedIndex = 0; render(); };
    $('#command-search').onkeydown = e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = clamp(selectedIndex + (e.key === 'ArrowDown' ? 1 : -1), 0, filtered.length - 1);
            render();
            $('#command-results .focused')?.scrollIntoView({ block: 'nearest' });
        }
        else if (e.key === 'Enter' && filtered[selectedIndex]) {
            e.preventDefault();
            const action = filtered[selectedIndex][1];
            closeModal();
            actions[action]?.();
        }
    };
    render();
}
async function present() {
    finishText();
    state.previewFrames = doc.nodes.filter(n => n.type === 'frame' && !n.parentId && n.visible);
    if (!state.previewFrames.length) {
        toast('Create a frame to present your design.');
        return;
    }
    const active = activeNode(), ancestor = active && (active.parentId ? doc.ancestors(active).at(-1) : active);
    state.previewIndex = Math.max(0, state.previewFrames.findIndex(n => n.id === ancestor?.id));
    $('#presentation').classList.remove('hidden');
    await showPreview();
}
async function showPreview() {
    const n = state.previewFrames[state.previewIndex];
    if (!n)
        return;
    $('#presentation-title').textContent = n.name;
    $('#presentation-count').textContent = `${state.previewIndex + 1} / ${state.previewFrames.length}`;
    try {
        const canvas = await renderer.exportCanvas([n.id], Math.min(2, Math.max(1, 1000 / Math.max(n.w, n.h))));
        const target = $('#presentation-canvas');
        target.width = canvas.width;
        target.height = canvas.height;
        target.getContext('2d').drawImage(canvas, 0, 0);
        target.style.aspectRatio = `${canvas.width}/${canvas.height}`;
        const stage = $('#presentation-stage'), scale = Math.min((stage.clientWidth - 72) / canvas.width, (stage.clientHeight - 72) / canvas.height, 1);
        target.style.width = canvas.width * scale + 'px';
        target.style.height = canvas.height * scale + 'px';
    }
    catch (e) {
        toast(e.message);
    }
}
function stepPreview(delta) {
    if (!state.previewFrames.length)
        return;
    state.previewIndex = (state.previewIndex + delta + state.previewFrames.length) % state.previewFrames.length;
    showPreview();
}
function closePreview() { $('#presentation').classList.add('hidden'); overlay.focus({ preventScroll: true }); }
// Event delegation keeps the chrome inexpensive even with a large scene tree.
document.addEventListener('click', e => {
    const action = e.target.closest('[data-action]');
    if (action) {
        actions[action.dataset.action]?.();
        return;
    }
    const menu = e.target.closest('[data-menu-action]');
    if (menu) {
        const fn = actions[menu.dataset.menuAction];
        closeMenu();
        fn?.();
        return;
    }
    const command = e.target.closest('[data-command]');
    if (command) {
        const fn = actions[command.dataset.command];
        closeModal();
        fn?.();
        return;
    }
    if (e.target.closest('[data-close-modal]')) {
        closeModal();
        return;
    }
    const tool = e.target.closest('[data-tool]');
    if (tool) {
        setTool(tool.dataset.tool);
        return;
    }
    const page = e.target.closest('[data-page]');
    if (page) {
        switchPage(page.dataset.page);
        return;
    }
    const tab = e.target.closest('[data-left-tab]');
    if (tab) {
        state.leftTab = tab.dataset.leftTab;
        $$('[data-left-tab]').forEach(el => el.classList.toggle('active', el === tab));
        renderLayers();
        return;
    }
    const itab = e.target.closest('[data-inspector-tab]');
    if (itab) {
        state.inspectorTab = itab.dataset.inspectorTab;
        $$('[data-inspector-tab]').forEach(el => el.classList.toggle('active', el === itab));
        renderInspector();
        return;
    }
    const exp = e.target.closest('[data-expand]');
    if (exp) {
        const id = exp.dataset.expand;
        if (state.expanded.has(id))
            state.expanded.delete(id);
        else
            state.expanded.add(id);
        renderLayers();
        return;
    }
    const vis = e.target.closest('[data-visibility]');
    if (vis) {
        transaction('Toggle layer visibility', () => { const n = doc.get(vis.dataset.visibility); n.visible = !n.visible; doc.touch(n); });
        return;
    }
    const lock = e.target.closest('[data-lock]');
    if (lock) {
        transaction('Toggle layer lock', () => { const n = doc.get(lock.dataset.lock); n.locked = !n.locked; doc.touch(n); });
        return;
    }
    const layer = e.target.closest('[data-layer]');
    if (layer) {
        const id = layer.dataset.layer;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
            const set = new Set(state.selection);
            if (set.has(id))
                set.delete(id);
            else
                set.add(id);
            select([...set]);
        }
        else
            select([id]);
        return;
    }
    const a = e.target.closest('[data-align]');
    if (a) {
        alignSelection(a.dataset.align);
        return;
    }
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
        toggleProperty(toggle.dataset.toggle);
        return;
    }
    const textAlign = e.target.closest('[data-text-align]');
    if (textAlign) {
        setProperty('textAlign', textAlign.dataset.textAlign);
        return;
    }
    const textStyle = e.target.closest('[data-text-style]');
    if (textStyle) {
        const n = activeNode();
        if (!n)
            return;
        const s = textStyle.dataset.textStyle;
        if (s === 'bold')
            setProperty('fontWeight', n.fontWeight >= 700 ? 400 : 700);
        if (s === 'italic')
            setProperty('fontStyle', n.fontStyle === 'italic' ? 'normal' : 'italic');
        if (s === 'underline')
            setProperty('textDecoration', n.textDecoration === 'underline' ? 'none' : 'underline');
        return;
    }
    const fill = e.target.closest('[data-fill]');
    if (fill) {
        setProperty('fill', fill.dataset.fill);
        return;
    }
    const presetButton = e.target.closest('[data-preset]');
    if (presetButton) {
        preset(presetButton.dataset.preset);
        return;
    }
    const colorButton = e.target.closest('[data-insert-color]');
    if (colorButton) {
        createAtCenter('rect', { w: 120, h: 120, radius: 14, fill: colorButton.dataset.insertColor, name: 'Color swatch' });
        return;
    }
    const typeStyle = e.target.closest('[data-type-style]');
    if (typeStyle) {
        const t = doc.data.tokens.typography[+typeStyle.dataset.typeStyle];
        createAtCenter('text', { text: 'Make something meaningful.', name: t.name, fontSize: t.size, fontWeight: t.weight, lineHeight: t.lineHeight, w: 520, h: t.size * 2, fill: options.theme === 'dark' ? '#d2bfeb' : '#755890' });
        return;
    }
    const asset = e.target.closest('[data-asset]');
    if (asset) {
        insertAsset(asset.dataset.asset);
        return;
    }
});
document.addEventListener('input', e => {
    const el = e.target;
    if (el.matches('[data-prop]') && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
        let value = el.type === 'number' ? el.valueAsNumber : el.value;
        if (el.type === 'color' || el.type === 'number' && Number.isFinite(value))
            setProperty(el.dataset.prop, value, { live: true });
    }
});
document.addEventListener('change', e => {
    const el = e.target;
    if (el.matches('[data-prop]')) {
        const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? el.valueAsNumber : el.value;
        setProperty(el.dataset.prop, value);
        return;
    }
    if (el.matches('[data-hex]')) {
        let value = el.value.trim();
        if (value.toLowerCase() === 'none') {
            setProperty(el.dataset.hex, 'none');
            return;
        }
        if (!value.startsWith('#'))
            value = '#' + value;
        if (/^#[\da-f]{3}([\da-f]{3})?$/i.test(value)) {
            if (value.length === 4)
                value = '#' + value.slice(1).split('').map(c => c + c).join('');
            setProperty(el.dataset.hex, value);
        }
        else {
            toast('Enter a 3- or 6-digit hex color, or None.');
            renderInspector();
        }
        return;
    }
    if (el.matches('[data-option]')) {
        options[el.dataset.option] = el.checked;
        saveOptions();
        invalidate();
        return;
    }
    if (el.id === 'canvas-color') {
        options.canvasColor = el.value;
        $('#canvas-world').style.backgroundColor = el.value;
        saveOptions();
        invalidate();
    }
});
$('#layer-tree').addEventListener('dblclick', e => {
    const row = e.target.closest('[data-layer]');
    if (row) {
        select([row.dataset.layer]);
        renameLayer();
    }
});
$('#assets-panel').addEventListener('dblclick', e => {
    const c = e.target.closest('[data-component]');
    if (c)
        instantiate(c.dataset.component);
});
$('#page-list').addEventListener('dblclick', e => {
    const row = e.target.closest('[data-page]');
    if (row) {
        const page = doc.data.pages.find(p => p.id === row.dataset.page);
        promptText('Rename page', page.name, name => transaction('Rename page', () => page.name = name));
    }
});
$('#layer-tree').addEventListener('dragstart', e => {
    const row = e.target.closest('[data-layer]');
    if (!row)
        return;
    e.dataTransfer.setData('application/x-vellum-layer', row.dataset.layer);
    e.dataTransfer.effectAllowed = 'move';
});
$('#layer-tree').addEventListener('dragover', e => {
    if (![...e.dataTransfer.types].includes('application/x-vellum-layer'))
        return;
    const row = e.target.closest('[data-layer]');
    if (row) {
        e.preventDefault();
        $$('.drop-target').forEach(n => n.classList.remove('drop-target'));
        row.classList.add('drop-target');
    }
});
$('#layer-tree').addEventListener('dragleave', e => e.target.closest('.drop-target')?.classList.remove('drop-target'));
$('#layer-tree').addEventListener('drop', e => {
    e.preventDefault();
    $$('.drop-target').forEach(n => n.classList.remove('drop-target'));
    const id = e.dataTransfer.getData('application/x-vellum-layer'), row = e.target.closest('[data-layer]');
    if (!id || !row)
        return;
    const source = doc.get(id), target = doc.get(row.dataset.layer);
    if (!source || !target || source === target || doc.descendants(id).some(n => n.id === target.id))
        return;
    transaction('Reorder layer', () => {
        const world = doc.world(id).matrix, parentId = e.shiftKey && ['frame', 'group'].includes(target.type) ? target.id : target.parentId, parentMatrix = parentId ? doc.world(parentId).matrix : identity();
        source.parentId = parentId;
        setFromMatrix(source, multiply(inverse(parentMatrix), world));
        doc.nodes.splice(doc.nodes.indexOf(source), 1);
        doc.nodes.splice(doc.nodes.indexOf(target) + 1, 0, source);
        doc.refresh();
        if (parentId)
            state.expanded.add(parentId);
        select([id]);
    });
});
$('#main-menu').onclick = () => showMenu([
    { header: 'Vellum — make room for ideas' },
    { label: 'Projects & Documents…', action: 'projects', key: '⌘P' },
    { label: 'New document', action: 'newFile', key: '⌘N' },
    { label: 'Open document…', action: 'openFile', key: '⌘O' },
    { label: storage.isTauri ? 'Save to Documents/Vellum' : 'Save portable document', action: 'saveFile', key: '⌘S' },
    ...(storage.isTauri ? [{ label: 'Show Documents/Vellum in Finder', action: 'revealDocuments' }] : []),
    '-',
    { label: 'Undo', action: 'undo', key: '⌘Z', disabled: !history.undoStack.length },
    { label: 'Redo', action: 'redo', key: '⇧⌘Z', disabled: !history.redoStack.length },
    '-',
    { label: 'Place image…', action: 'placeImage', key: '⇧⌘K' },
    { label: 'Design tokens', action: 'tokens' },
    { label: 'Add page', action: 'addPage' },
    '-',
    { label: 'Toggle light / dark', action: 'theme' },
    { label: (options.grid ? 'Hide' : 'Show') + ' dot grid', action: 'grid' },
    { label: (options.rulers ? 'Hide' : 'Show') + ' rulers', action: 'rulers' },
    { label: 'Editor settings', action: 'settings' },
    { label: 'Keyboard shortcuts', action: 'help', key: '?' }
], 9, 46);
$('#projects-btn').onclick = () => openProjectsManager();
$('#file-name').onclick = renameFile;
$('#add-page').onclick = addPage;
$('#theme-toggle').onclick = toggleTheme;
$('#settings').onclick = settings;
$('#help').onclick = help;
$('#share').onclick = openExport;
$('#present').onclick = () => present();
$('#insert-image').onclick = () => $('#image-input').click();
$('#command-button').onclick = commandPalette;
$('#profile').onclick = () => toast('Your local workspace. No account, presence simulation, or cloud upload.');
$('#canvas-status').onclick = () => toast('Saved in this browser only. Export a .vellum copy for backup.');
$('#dismiss-tip').onclick = () => {
    $('#welcome-tip').classList.add('hidden');
    try {
        localStorage.setItem('vellum-welcomed', '1');
    }
    catch { }
};
try {
    if (localStorage.getItem('vellum-welcomed'))
        $('#welcome-tip').classList.add('hidden');
}
catch { }
$('#toggle-left').onclick = () => document.body.classList.toggle('left-hidden');
$('#collapse-all').onclick = () => { state.expanded.clear(); renderLayers(); };
$('#search-button').onclick = () => {
    $('#layer-search').classList.toggle('hidden');
    if (!$('#layer-search').classList.contains('hidden'))
        $('#search-layers').focus();
    else {
        $('#search-layers').value = '';
        renderLayers();
    }
};
$('#search-layers').oninput = renderLayers;
$('#zoom-in').onclick = () => zoomAt(1.25);
$('#zoom-out').onclick = () => zoomAt(.8);
$('#zoom-value').onclick = e => showMenu([{ label: 'Zoom to fit', action: 'fit', key: '⇧1' }, { label: 'Zoom to selection', action: 'fitSelection', key: '⇧2' }, { label: 'Zoom to 100%', action: 'actualSize', key: '⇧0' }, { label: (options.grid ? 'Hide' : 'Show') + ' dot grid', action: 'grid' }], e.clientX - 150, e.clientY - 150);
$('#file-input').onchange = e => { importDocument(e.target.files[0]); e.target.value = ''; };
$('#image-input').onchange = e => { importImage(e.target.files[0]); e.target.value = ''; };
$('#modal-backdrop').onclick = e => {
    if (e.target === $('#modal-backdrop'))
        closeModal();
};
document.addEventListener('pointerdown', e => {
    if (!e.target.closest('#context-menu,#main-menu,#zoom-value'))
        closeMenu();
});
overlay.addEventListener('pointerdown', pointerDown);
overlay.addEventListener('pointermove', pointerMove);
overlay.addEventListener('pointerup', pointerUp);
overlay.addEventListener('pointercancel', e => {
    state.pointers.delete(e.pointerId);
    state.pinch = null;
    state.gesture = null;
    state.guides = [];
    state.marquee = null;
    if (history.pending)
        history.cancel();
    refreshUI();
    invalidate();
});
overlay.addEventListener('pointerleave', () => {
    state.hover = null;
    if (!state.gesture)
        invalidate();
});
overlay.addEventListener('dblclick', e => {
    const hit = hitTest(eventWorld(e), { deep: true });
    if (state.tool === 'pen') {
        finishPen(false);
        return;
    }
    if (hit?.type === 'text') {
        select([hit.id]);
        startText(hit, true);
    }
    else if (hit?.type === 'path') {
        select([hit.id]);
        state.pathEdit = hit.id;
        state.activePathPoint = null;
        invalidate();
        toast('Vector edit mode. Drag anchors or Bézier handles. Escape to finish.');
    }
    else if (hit) {
        select([hit.id], { reveal: true });
    }
});
overlay.addEventListener('contextmenu', e => {
    e.preventDefault();
    const hit = hitTest(eventWorld(e));
    if (hit && !state.selection.has(hit.id))
        select([hit.id]);
    selectionMenu(e.clientX, e.clientY);
});
$('#layer-tree').addEventListener('contextmenu', e => {
    const row = e.target.closest('[data-layer]');
    if (row) {
        e.preventDefault();
        if (!state.selection.has(row.dataset.layer))
            select([row.dataset.layer]);
        selectionMenu(e.clientX, e.clientY);
    }
});
area.addEventListener('wheel', e => {
    if (!$('#modal-backdrop').classList.contains('hidden'))
        return;
    e.preventDefault();
    const p = eventPoint(e);
    if (e.ctrlKey || e.metaKey || e.altKey)
        zoomAt(Math.exp(-clamp(e.deltaY, -100, 100) * .012), p.x, p.y);
    else {
        state.camera.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        state.camera.y -= e.shiftKey ? 0 : e.deltaY;
        invalidate();
    }
}, { passive: false });
area.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
    }
});
area.addEventListener('drop', e => {
    if (e.dataTransfer.files.length) {
        e.preventDefault();
        const f = e.dataTransfer.files[0];
        if (/\.(vellum|json)$/i.test(f.name))
            importDocument(f);
        else
            importImage(f, eventWorld(e));
    }
});
$('#text-editor').addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finishText();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        finishText();
    }
});
$('#text-editor').addEventListener('paste', e => {
    e.preventDefault();
    const t = e.clipboardData.getData('text/plain');
    const selection = window.getSelection();
    if (!selection.rangeCount)
        return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const text = document.createTextNode(t);
    range.insertNode(text);
    range.setStartAfter(text);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
});
$('#text-editor').addEventListener('blur', () => setTimeout(() => {
    if (state.editing && !$('#text-editor').contains(document.activeElement))
        finishText();
}, 0));
$('#close-presentation').onclick = closePreview;
$('#prev-frame').onclick = () => stepPreview(-1);
$('#next-frame').onclick = () => stepPreview(1);
$('#presentation-canvas').onclick = e => {
    const frame = state.previewFrames[state.previewIndex], b = e.target.getBoundingClientRect(), box = doc.world(frame.id).box, w = { x: box.x + (e.clientX - b.left) / b.width * box.w, y: box.y + (e.clientY - b.top) / b.height * box.h };
    const hit = hitTest(w, { deep: true });
    const target = hit && [hit, ...doc.ancestors(hit)].find(n => n.prototypeTarget);
    if (target) {
        const index = state.previewFrames.findIndex(n => n.id === target.prototypeTarget);
        if (index >= 0) {
            state.previewIndex = index;
            showPreview();
        }
    }
};
document.addEventListener('keydown', e => {
    if (!$('#presentation').classList.contains('hidden')) {
        if (e.key === 'Escape')
            closePreview();
        if (e.key === 'ArrowRight')
            stepPreview(1);
        if (e.key === 'ArrowLeft')
            stepPreview(-1);
        return;
    }
    if (!$('#modal-backdrop').classList.contains('hidden')) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal();
        }
        if (e.key === 'Tab') {
            const items = [...$('#modal').querySelectorAll('button,input,select,textarea,[tabindex]')].filter(el => !el.disabled), first = items[0], last = items.at(-1);
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault();
                last?.focus();
            }
            else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault();
                first?.focus();
            }
        }
        return;
    }
    const cmd = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
    if (isInput(e.target)) {
        if (cmd && key === 's') {
            e.preventDefault();
            saveFile();
        }
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        if (state.gesture && history.pending) {
            history.cancel();
            state.gesture = null;
            state.marquee = null;
            state.guides = [];
            refreshUI();
        }
        else if (state.pen.length) {
            state.pen = [];
            state.penHover = null;
            setTool('select');
        }
        else if (state.pathEdit)
            state.pathEdit = null;
        else
            select([]);
        setTool('select');
        invalidate();
        return;
    }
    if (cmd) {
        const handled = ['z', 'y', 'c', 'v', 'x', 'd', 'a', 'g', 'k', 's', 'o', 'n', 'r', 'b', 'i', 'u', 'l', 'h'].includes(key);
        if (handled)
            e.preventDefault();
        if (key === 'z') {
            e.shiftKey ? redo() : undo();
            return;
        }
        if (key === 'y') {
            redo();
            return;
        }
        if (key === 'c') {
            copySelection();
            return;
        }
        if (key === 'v') {
            pasteSelection();
            return;
        }
        if (key === 'x') {
            copySelection();
            removeSelection();
            return;
        }
        if (key === 'd') {
            duplicate();
            return;
        }
        if (key === 'a') {
            select(doc.nodes.filter(n => !n.parentId && n.visible && !n.locked).map(n => n.id));
            return;
        }
        if (key === 'g') {
            e.shiftKey ? ungroupSelection() : groupSelection(e.altKey);
            return;
        }
        if (key === 'k') {
            e.altKey ? makeComponent() : e.shiftKey ? $('#image-input').click() : commandPalette();
            return;
        }
        if (key === 's') {
            saveFile();
            return;
        }
        if (key === 'o') {
            $('#file-input').click();
            return;
        }
        if (key === 'p') {
            openProjectsManager();
            return;
        }
        if (key === 'n') {
            newFile();
            return;
        }
        if (key === 'r') {
            state.selection.size ? renameLayer() : renameFile();
            return;
        }
        if (key === 'l' && e.shiftKey) {
            toggleProperty('locked');
            return;
        }
        if (key === 'h' && e.shiftKey) {
            toggleProperty('visible');
            return;
        }
        if (['b', 'i', 'u'].includes(key)) {
            const n = activeNode();
            if (n?.type === 'text') {
                setProperty(key === 'b' ? 'fontWeight' : key === 'i' ? 'fontStyle' : 'textDecoration', key === 'b' ? (n.fontWeight >= 700 ? 400 : 700) : key === 'i' ? (n.fontStyle === 'italic' ? 'normal' : 'italic') : (n.textDecoration === 'underline' ? 'none' : 'underline'));
            }
            return;
        }
    }
    if (e.code === 'Space') {
        e.preventDefault();
        state.space = true;
        overlay.style.cursor = 'grab';
        return;
    }
    if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        fit();
        return;
    }
    if (e.shiftKey && e.code === 'Digit2') {
        e.preventDefault();
        fit([...state.selection]);
        return;
    }
    if (e.shiftKey && e.code === 'Digit0') {
        e.preventDefault();
        zoomAt(1 / state.camera.zoom);
        return;
    }
    if (e.key === 'Tab') {
        e.preventDefault();
        document.body.classList.toggle('panels-hidden');
        return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        removeSelection();
        return;
    }
    if (e.key === 'F2') {
        e.preventDefault();
        renameLayer();
        return;
    }
    if (e.key === 'Enter') {
        if (state.pen.length)
            finishPen();
        else if (activeNode()?.type === 'text')
            startText(activeNode(), true);
        return;
    }
    if (e.key === '?' || e.key === '/') {
        e.preventDefault();
        help();
        return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        if (state.selection.size)
            transaction('Nudge layers', () => {
                const d = e.shiftKey ? 10 : 1;
                for (const n of selectedRoots()) {
                    if (n.locked)
                        continue;
                    n.x += e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
                    n.y += e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
                    doc.touch(n);
                }
            });
        return;
    }
    if (e.key === '[') {
        e.preventDefault();
        reorder(e.shiftKey ? 'back' : 'backward');
        return;
    }
    if (e.key === ']') {
        e.preventDefault();
        reorder(e.shiftKey ? 'front' : 'forward');
        return;
    }
    if ((e.key === '+' || e.key === '=') && !cmd) {
        zoomAt(1.25);
        return;
    }
    if (e.key === '-' && !cmd) {
        zoomAt(.8);
        return;
    }
    if (!cmd && !e.altKey) {
        const tools = { v: 'select', f: 'frame', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', t: 'text', h: 'hand' };
        if (tools[key]) {
            e.preventDefault();
            setTool(tools[key]);
        }
    }
});
document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
        state.space = false;
        overlay.style.cursor = state.tool === 'hand' ? 'grab' : 'default';
    }
});
window.addEventListener('blur', () => {
    state.space = false;
    if (state.gesture) {
        if (history.pending)
            history.cancel();
        state.gesture = null;
        state.pointers.clear();
        state.pinch = null;
        state.guides = [];
        state.marquee = null;
        refreshUI();
        invalidate();
    }
});
document.addEventListener('visibilitychange', () => {
    if (document.hidden && state.dirty)
        save();
});
window.addEventListener('beforeunload', e => {
    if (state.dirty) {
        e.preventDefault();
        e.returnValue = '';
    }
});
const resize = new ResizeObserver(() => { const width = area.clientWidth, height = area.clientHeight; renderer.resize(width, height); overlay.width = Math.round(width * renderer.dpr); overlay.height = Math.round(height * renderer.dpr); invalidate(); });
resize.observe(area);
// Optional user-supplied fonts. No font binaries are bundled or fetched by this application.
const fontInput = document.createElement('input');
fontInput.type = 'file';
fontInput.accept = '.ttf,.otf,.woff,.woff2';
fontInput.hidden = true;
document.body.append(fontInput);
actions.loadFont = () => fontInput.click();
commands.splice(commands.length - 3, 0, ['Load a local font…', 'loadFont']);
async function loadStoredFonts() {
    for (const [family, source] of Object.entries(doc.data.fonts || {})) {
        if (typeof source !== 'string' || !source.startsWith('data:'))
            continue;
        try {
            const face = await new FontFace(family, `url(${JSON.stringify(source)})`).load();
            document.fonts.add(face);
        }
        catch (e) {
            console.warn('Font not loaded:', family, e);
        }
    }
}
fontInput.onchange = async () => {
    const file = fontInput.files[0];
    if (!file)
        return;
    if (file.size > 15 * 1024 * 1024) {
        toast('Font file exceeds 15 MB.');
        return;
    }
    try {
        const source = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); }), family = file.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/["\\]/g, '');
        const face = await new FontFace(family, await file.arrayBuffer()).load();
        document.fonts.add(face);
        doc.data.fonts ||= {};
        doc.data.fonts[family] = source;
        if (selected().some(n => n.type === 'text'))
            setProperty('fontFamily', family);
        renderer.atlas?.reset();
        renderer.cache.clear();
        saveSoon();
        renderInspector();
        invalidate();
        toast(`${family} loaded. Import only fonts you have permission to embed.`);
    }
    catch (e) {
        toast('Could not load the font: ' + e.message);
    }
    fontInput.value = '';
};
await loadStoredFonts();
await renderer.initialize();
renderer.resize(area.clientWidth, area.clientHeight);
overlay.width = Math.round(area.clientWidth * renderer.dpr);
overlay.height = Math.round(area.clientHeight * renderer.dpr);
if (!initial) {
    const hero = doc.nodes.find(n => n.type === 'frame' && n.name === 'Your ideas. In motion.');
    if (hero) {
        state.selection.add(hero.id);
        state.expanded.add(hero.parentId);
    }
    fit();
}
else
    fit();
if (options.canvasColor)
    $('#canvas-world').style.backgroundColor = options.canvasColor;
refreshUI();
invalidate();
if (!initial)
    saveSoon();
// Explicit, inspectable automation surface. This is the same model and command path used by the UI.
window.vellum = { doc, history, state, renderer, actions, select, fit, setTool, setProperty, transaction, createAtCenter, insertAsset, instantiate, doExport, save, importDocument, importImage, exportSVG, render: invalidate, ready: true, version: '0.1.0', storage, switchProject, createNewProject, openProjectsManager };
