import { color, clamp, intersects, point } from './document.js';
const FONT_STACK = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';
export function fontSpec(n) { return `${n.fontStyle || 'normal'} ${n.fontWeight || 400} ${n.fontSize || 16}px ${n.fontFamily === 'Inter' ? FONT_STACK : `"${String(n.fontFamily).replace(/["\\]/g, '')}", sans-serif`}`; }
export function displayText(n) {
    let t = n.text || '';
    if (n.textCase === 'upper')
        t = t.toLocaleUpperCase();
    if (n.textCase === 'lower')
        t = t.toLocaleLowerCase();
    if (n.textCase === 'title')
        t = t.replace(/\p{L}[\p{L}\p{M}]*/gu, s => s[0].toLocaleUpperCase() + s.slice(1).toLocaleLowerCase());
    return t;
}
const measureCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export function layoutText(n, ctx = measureCanvas.getContext('2d')) {
    ctx.font = fontSpec(n);
    ctx.letterSpacing = `${n.letterSpacing || 0}px`;
    const max = Math.max(1, n.w), lines = [];
    for (const paragraph of displayText(n).split('\n')) {
        if (!paragraph) {
            lines.push('');
            continue;
        }
        const words = paragraph.match(/\s+|\S+/gu) || [];
        let line = '';
        for (let word of words) {
            if (ctx.measureText(line + word).width <= max) {
                line += word;
                continue;
            }
            if (line.trim()) {
                lines.push(line.trimEnd());
                line = '';
            }
            word = word.trimStart();
            if (ctx.measureText(word).width <= max) {
                line = word;
                continue;
            }
            const segments = globalThis.Intl?.Segmenter ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(word)].map(s => s.segment) : Array.from(word);
            for (const ch of segments) {
                if (line && ctx.measureText(line + ch).width > max) {
                    lines.push(line);
                    line = '';
                }
                line += ch;
            }
        }
        lines.push(line.trimEnd());
    }
    const lh = (n.fontSize || 16) * (n.lineHeight || 1.35), ascent = (n.fontSize || 16) * .82;
    return { lines, lineHeight: lh, height: Math.max(lh, lines.length * lh), baseline: (lh - (n.fontSize || 16)) / 2 + ascent };
}
export function paintText(ctx, n) {
    const l = layoutText(n, ctx);
    ctx.font = fontSpec(n);
    ctx.letterSpacing = `${n.letterSpacing || 0}px`;
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = n.textAlign || 'left';
    ctx.direction = n.direction === 'rtl' ? 'rtl' : n.direction === 'ltr' ? 'ltr' : 'inherit';
    ctx.fillStyle = fillStyle(ctx, n);
    ctx.globalAlpha *= n.fillOpacity ?? 1;
    const x = n.textAlign === 'center' ? n.w / 2 : n.textAlign === 'right' ? n.w : 0;
    for (let i = 0; i < l.lines.length; i++) {
        const y = l.baseline + i * l.lineHeight;
        if (y - l.lineHeight > n.h)
            break;
        ctx.fillText(l.lines[i], x, y);
        if (n.textDecoration === 'underline' || n.textDecoration === 'line-through') {
            const width = ctx.measureText(l.lines[i]).width, start = x - (n.textAlign === 'center' ? width / 2 : n.textAlign === 'right' ? width : 0);
            ctx.fillRect(start, y + (n.textDecoration === 'underline' ? n.fontSize * .12 : -n.fontSize * .3), width, Math.max(1, n.fontSize * .055));
        }
    }
    return l;
}
export function pathFor(n) {
    const p = new Path2D();
    if (n.type === 'ellipse')
        p.ellipse(n.w / 2, n.h / 2, Math.max(.001, n.w / 2), Math.max(.001, n.h / 2), 0, 0, Math.PI * 2);
    else if (n.type === 'line') {
        p.moveTo(0, 0);
        p.lineTo(n.w, n.h);
    }
    else if (n.type === 'path') {
        const pts = n.points || [];
        if (!pts.length)
            return p;
        const sx = n.w / (n.pathW || n.w || 1), sy = n.h / (n.pathH || n.h || 1);
        p.moveTo(pts[0].x * sx, pts[0].y * sy);
        for (let i = 1; i < pts.length; i++) {
            const a = pts[i - 1], b = pts[i];
            if (a.out || b.in)
                p.bezierCurveTo((a.out?.x ?? a.x) * sx, (a.out?.y ?? a.y) * sy, (b.in?.x ?? b.x) * sx, (b.in?.y ?? b.y) * sy, b.x * sx, b.y * sy);
            else
                p.lineTo(b.x * sx, b.y * sy);
        }
        if (n.closed) {
            const a = pts.at(-1), b = pts[0];
            if (a.out || b.in)
                p.bezierCurveTo((a.out?.x ?? a.x) * sx, (a.out?.y ?? a.y) * sy, (b.in?.x ?? b.x) * sx, (b.in?.y ?? b.y) * sy, b.x * sx, b.y * sy);
            p.closePath();
        }
    }
    else
        p.roundRect(0, 0, Math.max(0, n.w), Math.max(0, n.h), Math.max(0, Math.min(n.radius || 0, n.w / 2, n.h / 2)));
    return p;
}
export function fillStyle(ctx, n) {
    if (!n.fill || n.fill === 'none')
        return 'transparent';
    if (n.fillType !== 'linear')
        return n.fill === 'none' ? 'transparent' : n.fill;
    const r = n.gradientAngle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), len = Math.abs(n.w * c) + Math.abs(n.h * s);
    const g = ctx.createLinearGradient(n.w / 2 - c * len / 2, n.h / 2 - s * len / 2, n.w / 2 + c * len / 2, n.h / 2 + s * len / 2);
    g.addColorStop(0, n.fill);
    g.addColorStop(1, n.fill2);
    return g;
}
function imageFit(img, w, h) { const scale = Math.max(w / img.width, h / img.height), dw = img.width * scale, dh = img.height * scale; return [(w - dw) / 2, (h - dh) / 2, dw, dh]; }
export class ImageStore {
    constructor(doc, invalidate) { this.doc = doc; this.invalidate = invalidate; this.images = new Map(); this.pending = new Map(); }
    get(id) {
        if (this.images.has(id))
            return this.images.get(id);
        const src = this.doc.data.assets[id];
        if (src && !this.pending.has(id)) {
            const p = new Promise(resolve => { const img = new Image(); img.onload = () => { this.images.set(id, img); this.invalidate(); resolve(img); }; img.onerror = () => resolve(null); img.src = src; });
            this.pending.set(id, p);
        }
        return null;
    }
    async ready() {
        for (const id of Object.keys(this.doc.data.assets))
            this.get(id);
        await Promise.all(this.pending.values());
    }
}
const WGSL = /* wgsl */ `
struct Globals { viewport: vec4<f32>, camera: vec4<f32> }
struct Instance { matrix: vec4<f32>, box: vec4<f32>, fill: vec4<f32>, stroke: vec4<f32>, props: vec4<f32>, uv: vec4<f32>, fill2: vec4<f32>, params: vec4<f32> }
struct Clip { matrix: vec4<f32>, box: vec4<f32>, info: vec4<f32> }
@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var<storage,read> instances: array<Instance>;
@group(0) @binding(2) var atlas: texture_2d_array<f32>;
@group(0) @binding(3) var atlasSampler: sampler;
@group(0) @binding(4) var<storage,read> clips: array<Clip>;
struct VertexOutput { @builtin(position) position: vec4<f32>, @location(0) local: vec2<f32>, @location(1) world: vec2<f32>, @location(2) @interpolate(flat) index: u32 }
@vertex fn vs(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VertexOutput {
 var corners=array<vec2<f32>,6>(vec2(0.,0.),vec2(1.,0.),vec2(0.,1.),vec2(0.,1.),vec2(1.,0.),vec2(1.,1.));
 let item=instances[ii]; let pad=select(max(item.props.y*.5+1.5/globals.viewport.z,item.params.y*2.),0.,item.props.z==2.);
 let local=corners[vi]*(item.box.zw+vec2(pad*2.))-vec2(pad);
 let world=vec2(item.matrix.x*local.x+item.matrix.z*local.y,item.matrix.y*local.x+item.matrix.w*local.y)+item.box.xy;
 let screen=world*globals.viewport.z+globals.camera.xy;
 var o:VertexOutput;o.position=vec4(screen.x/globals.viewport.x*2.-1.,1.-screen.y/globals.viewport.y*2.,0.,1.);o.local=local;o.world=world;o.index=ii;return o;
}
fn sdRound(p:vec2<f32>,size:vec2<f32>,radius:f32)->f32 {let r=min(radius,min(size.x,size.y)*.5);let q=abs(p-size*.5)-size*.5+vec2(r);return length(max(q,vec2(0.)))+min(max(q.x,q.y),0.)-r;}
@fragment fn fs(v:VertexOutput)->@location(0) vec4<f32> {
 let item=instances[v.index];let aa=.75/globals.viewport.z;var clipAlpha=1.;var clipId=i32(item.params.z);
 for(var count=0;count<100;count++){if(clipId<0){break;}let clip=clips[u32(clipId)];let cp=vec2(clip.matrix.x*v.world.x+clip.matrix.z*v.world.y,clip.matrix.y*v.world.x+clip.matrix.w*v.world.y)+clip.box.xy;clipAlpha*=1.-smoothstep(-aa,aa,sdRound(cp,clip.box.zw,clip.info.x));clipId=i32(clip.info.y);}
 if(clipAlpha<.001){discard;}
 if(item.props.z==2.){let uv=item.uv.xy+v.local/item.box.zw*item.uv.zw;let sample=textureSampleLevel(atlas,atlasSampler,uv,i32(item.params.w),0.);return sample*item.props.w*clipAlpha;}
 var d=sdRound(v.local,item.box.zw,item.props.x);
 if(item.props.z==1.) {let radii=max(item.box.zw*.5,vec2(.001));let p=(v.local-radii)/radii;let k0=length(p);let k1=length(p/radii);d=select(-min(radii.x,radii.y),k0*(k0-1.)/max(k1,.00001),k1>.00001);}
 let edge=max(aa,item.params.y);let coverage=1.-smoothstep(-edge,edge,d);
 var fill=item.fill;
 if(item.params.x> -999.){let axis=vec2(cos(item.params.x),sin(item.params.x));let len=max(dot(abs(axis),item.box.zw),.001);let t=clamp(dot(v.local-item.box.zw*.5,axis)/len+.5,0.,1.);fill=mix(fill,item.fill2,t);}
 var alpha=fill.a*coverage;var rgb=fill.rgb*alpha;
 if(item.props.y>0.){let sc=1.-smoothstep(-aa,aa,abs(d)-item.props.y*.5);let sa=item.stroke.a*sc;rgb=item.stroke.rgb*sa+rgb*(1.-sa);alpha=sa+alpha*(1.-sa);}
 return vec4(rgb,alpha)*item.props.w*clipAlpha;
}`;
class Atlas {
    constructor(device, invalidate) { this.device = device; this.invalidate = invalidate; this.size = Math.min(2048, device.limits.maxTextureDimension2D); this.layers = 4; this.texture = device.createTexture({ label: 'Vellum raster atlas', size: [this.size, this.size, this.layers], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }); this.entries = new Map(); this.shelves = [{ x: 1, y: 1, h: 0 }]; this.epoch = 0; this.canvas = document.createElement('canvas'); }
    reset() { this.entries.clear(); this.shelves = [{ x: 1, y: 1, h: 0 }]; this.epoch++; }
    get(n, res, images) {
        const key = `${n.id}:${n.version}:${res}`;
        if (this.entries.has(key))
            return this.entries.get(key);
        if (n.type === 'image' && !images.get(n.assetId))
            return null;
        // Raster-only paths carry stroke padding; the geometry stays editable in the document.
        const padding = n.type === 'path' || n.type === 'line' ? (n.strokeWidth || 0) / 2 + 1 : 0;
        const width = n.w + padding * 2, height = n.h + padding * 2;
        const scale = Math.min(res, (this.size - 4) / Math.max(width, 1), (this.size - 4) / Math.max(height, 1));
        const w = Math.max(1, Math.ceil(width * scale)), h = Math.max(1, Math.ceil(height * scale));
        let page = this.shelves.length - 1, shelf = this.shelves[page];
        if (shelf.x + w + 2 > this.size) {
            shelf.x = 1;
            shelf.y += shelf.h + 2;
            shelf.h = 0;
        }
        if (shelf.y + h + 2 > this.size) {
            if (this.shelves.length === this.layers)
                throw new Error('ATLAS_FULL');
            page++;
            shelf = { x: 1, y: 1, h: 0 };
            this.shelves.push(shelf);
        }
        this.canvas.width = w;
        this.canvas.height = h;
        const ctx = this.canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.translate(padding, padding);
        if (n.type === 'text') {
            ctx.beginPath();
            ctx.rect(0, 0, n.w, n.h);
            ctx.clip();
            paintText(ctx, n);
        }
        else if (n.type === 'image') {
            const img = images.get(n.assetId);
            ctx.save();
            ctx.clip(pathFor(n));
            ctx.drawImage(img, ...imageFit(img, n.w, n.h));
            ctx.restore();
            if (n.strokeWidth) {
                ctx.lineWidth = n.strokeWidth;
                ctx.strokeStyle = n.stroke === 'none' ? 'transparent' : n.stroke;
                ctx.stroke(pathFor(n));
            }
        }
        else {
            const path = pathFor(n);
            ctx.fillStyle = fillStyle(ctx, n);
            ctx.globalAlpha = n.fillOpacity ?? 1;
            if (n.fill !== 'none')
                ctx.fill(path);
            ctx.globalAlpha = 1;
            if (n.strokeWidth) {
                ctx.lineWidth = n.strokeWidth;
                ctx.strokeStyle = n.stroke === 'none' ? 'transparent' : n.stroke;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.stroke(path);
            }
        }
        this.device.queue.copyExternalImageToTexture({ source: this.canvas }, { texture: this.texture, origin: [shelf.x, shelf.y, page], premultipliedAlpha: true }, [w, h]);
        const entry = { u: shelf.x / this.size, v: shelf.y / this.size, du: w / this.size, dv: h / this.size, page, padding, w: width, h: height };
        shelf.x += w + 2;
        shelf.h = Math.max(shelf.h, h);
        this.entries.set(key, entry);
        return entry;
    }
    destroy() { this.texture.destroy(); }
}
export class Renderer {
    constructor(canvas, doc, onStatus, invalidate) { this.canvas = canvas; this.doc = doc; this.onStatus = onStatus; this.invalidate = invalidate; this.backend = 'Starting'; this.ready = false; this.skipId = null; this.images = new ImageStore(doc, invalidate); this.width = 1; this.height = 1; this.dpr = 1; this.cpuMs = 0; this.visibleCount = 0; this.instanceCount = 0; this.drawCalls = 0; this.capacity = 0; this.clipCapacity = 0; this.device = null; this.cache = new Map(); this.gpuError = null; }
    async initialize() {
        try {
            if (!navigator.gpu || new URLSearchParams(location.search).has('canvas'))
                throw new Error('WebGPU unavailable');
            const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
            if (!adapter)
                throw new Error('No WebGPU adapter');
            this.device = await adapter.requestDevice();
            this.device.addEventListener('uncapturederror', e => { this.gpuError = e.error.message; console.error('WebGPU validation:', e.error.message); this.onStatus('WebGPU validation error'); });
            this.context = this.canvas.getContext('webgpu');
            if (!this.context)
                throw new Error('WebGPU canvas unavailable');
            this.format = navigator.gpu.getPreferredCanvasFormat();
            this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
            const module = this.device.createShaderModule({ label: 'Vellum analytical primitives', code: WGSL });
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter(m => m.type === 'error');
            if (errors.length)
                throw new Error(errors.map(m => m.message).join('\n'));
            this.pipeline = await this.device.createRenderPipelineAsync({ label: 'Vellum instanced scene', layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }] }, primitive: { topology: 'triangle-list' } });
            this.uniform = this.device.createBuffer({ label: 'Vellum camera', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
            this.sampler = this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
            this.atlas = new Atlas(this.device, this.invalidate);
            this.ensureBuffers(256, 64);
            this.backend = 'WebGPU';
            this.adapterInfo = adapter.info ? `${adapter.info.vendor || ''} ${adapter.info.architecture || ''}`.trim() : '';
            this.device.lost.then(info => {
                if (info.reason !== 'destroyed') {
                    this.gpuError = info.message;
                    this.fallback();
                    this.invalidate();
                }
            });
        }
        catch (e) {
            this.gpuError = e.message;
            this.fallback();
        }
        this.ready = true;
        this.onStatus(this.backend);
        return this.backend;
    }
    fallback() {
        if (this.backend === 'Canvas 2D')
            return; // A canvas cannot switch context modes once initialized.
        if (this.context || this.canvas.getContext('2d') === null) {
            const old = this.canvas, next = old.cloneNode();
            old.replaceWith(next);
            this.canvas = next;
        }
        this.ctx = this.canvas.getContext('2d');
        this.backend = 'Canvas 2D';
        this.onStatus(this.backend);
        this.resize(this.width, this.height, this.dpr);
    }
    ensureBuffers(count, clips) {
        let dirty = false;
        if (count > this.capacity) {
            this.instanceBuffer?.destroy();
            this.capacity = 2 ** Math.ceil(Math.log2(Math.max(256, count)));
            this.instanceData = new Float32Array(this.capacity * 32);
            this.instanceBuffer = this.device.createBuffer({ label: 'Vellum instance stream', size: this.capacity * 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            dirty = true;
        }
        if (clips > this.clipCapacity) {
            this.clipBuffer?.destroy();
            this.clipCapacity = 2 ** Math.ceil(Math.log2(Math.max(64, clips)));
            this.clipData = new Float32Array(this.clipCapacity * 12);
            this.clipBuffer = this.device.createBuffer({ label: 'Vellum clip chains', size: this.clipCapacity * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            dirty = true;
        }
        if (dirty)
            this.bindGroup = this.device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.instanceBuffer } }, { binding: 2, resource: this.atlas.texture.createView({ dimension: '2d-array' }) }, { binding: 3, resource: this.sampler }, { binding: 4, resource: { buffer: this.clipBuffer } }] });
    }
    resize(w, h, dpr = window.devicePixelRatio || 1) {
        this.width = Math.max(1, w);
        this.height = Math.max(1, h);
        this.dpr = Math.min(dpr, 3);
        const bw = Math.round(this.width * this.dpr), bh = Math.round(this.height * this.dpr);
        if (this.canvas.width !== bw)
            this.canvas.width = bw;
        if (this.canvas.height !== bh)
            this.canvas.height = bh;
    }
    render(camera) {
        if (!this.ready)
            return;
        const start = performance.now();
        const viewport = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, w: this.width / camera.zoom, h: this.height / camera.zoom };
        const scene = this.doc.scene().filter(s => s.node.id !== this.skipId && s.node.type !== 'group' && intersects({ ...s.box, x: s.box.x - 100, y: s.box.y - 100, w: s.box.w + 200, h: s.box.h + 200 }, viewport));
        this.visibleCount = scene.length;
        if (this.backend === 'WebGPU') {
            try {
                this.renderGPU(scene, camera);
            }
            catch (e) {
                if (e.message === 'ATLAS_FULL') {
                    this.atlas.reset();
                    try {
                        this.renderGPU(scene, camera, .5);
                    }
                    catch (err) {
                        this.gpuError = 'Raster working set exceeded atlas capacity; using Canvas 2D.';
                        this.fallback();
                        this.renderCanvas(scene, camera);
                    }
                }
                else {
                    console.error(e);
                    this.gpuError = e.message;
                    this.fallback();
                    this.renderCanvas(scene, camera);
                }
            }
        }
        else
            this.renderCanvas(scene, camera);
        this.cpuMs = performance.now() - start;
    }
    renderGPU(scene, camera, quality = 1) {
        const originX = -camera.x / camera.zoom, originY = -camera.y / camera.zoom;
        const clipCount = scene.reduce((sum, s) => sum + s.clips.length, 0);
        this.ensureBuffers(scene.length * 2 + 1, clipCount + 1);
        let count = 0, clipN = 0;
        const resolution = clamp(2 ** Math.ceil(Math.log2(camera.zoom * this.dpr)), .5, 4) * quality;
        const push = (s, n, clipId, shadow = false) => {
            const base = count++ * 32, d = this.instanceData, m = s.matrix;
            d.set([m[0], m[1], m[2], m[3], m[4] - originX, m[5] - originY, n.w, n.h], base);
            d.set(color(n.fill, n.fillOpacity), base + 8);
            d.set(color(n.stroke), base + 12);
            d.set([n.radius || 0, n.strokeWidth || 0, n.type === 'ellipse' ? 1 : 0, s.opacity], base + 16);
            d.set([0, 0, 0, 0], base + 20);
            d.set(color(n.fill2, n.fillOpacity), base + 24);
            d.set([n.fillType === 'linear' && n.fill !== 'none' ? n.gradientAngle * Math.PI / 180 : -1000, 0, clipId, 0], base + 28);
            if (shadow) {
                d[base + 4] += n.shadowX || 0;
                d[base + 5] += n.shadowY || 0;
                d.set(color(n.shadowColor || '#000000', n.shadowOpacity ?? .16), base + 8);
                d[base + 17] = 0;
                d[base + 28] = -1000;
                d[base + 29] = (n.shadowBlur || 20) * .5;
                return;
            }
            if (['text', 'path', 'line', 'image'].includes(n.type)) {
                const entry = this.atlas.get(n, resolution, this.images);
                if (!entry) {
                    count--;
                    return;
                }
                d[base + 4] -= (m[0] + m[2]) * entry.padding;
                d[base + 5] -= (m[1] + m[3]) * entry.padding;
                d[base + 6] = entry.w;
                d[base + 7] = entry.h;
                d[base + 18] = 2;
                d.set([entry.u, entry.v, entry.du, entry.dv], base + 20);
                d[base + 31] = entry.page;
            }
        };
        for (const s of scene) {
            let clipId = -1;
            for (const clip of s.clips) {
                const i = clipN++ * 12, m = clip.inverse;
                this.clipData.set([m[0], m[1], m[2], m[3], m[4] + m[0] * originX + m[2] * originY, m[5] + m[1] * originX + m[3] * originY, clip.w, clip.h, clip.radius || 0, clipId, 0, 0], i);
                clipId = clipN - 1;
            }
            if (s.node.shadow && !['text', 'path', 'line'].includes(s.node.type))
                push(s, s.node, clipId, true);
            push(s, s.node, clipId);
        }
        this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([this.width, this.height, camera.zoom, this.dpr, 0, 0, 0, 0]));
        if (count)
            this.device.queue.writeBuffer(this.instanceBuffer, 0, this.instanceData.buffer, 0, count * 128);
        if (clipN)
            this.device.queue.writeBuffer(this.clipBuffer, 0, this.clipData.buffer, 0, clipN * 48);
        const encoder = this.device.createCommandEncoder({ label: 'Vellum frame' });
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] });
        pass.setPipeline(this.pipeline);
        pass.setBindGroup(0, this.bindGroup);
        if (count)
            pass.draw(6, count);
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        this.instanceCount = count;
        this.drawCalls = count ? 1 : 0;
    }
    renderCanvas(scene, camera, target = this.ctx, width = this.canvas.width, height = this.canvas.height, dpr = this.dpr) { const ctx = target; ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, width, height); ctx.setTransform(dpr * camera.zoom, 0, 0, dpr * camera.zoom, camera.x * dpr, camera.y * dpr); this.paintScene(ctx, scene); this.instanceCount = scene.length; this.drawCalls = scene.length; }
    paintScene(ctx, scene) {
        for (const s of scene) {
            const n = s.node;
            if (n.type === 'group' || s.hidden || n.id === this.skipId)
                continue;
            ctx.save();
            for (const c of s.clips) {
                ctx.save();
                ctx.transform(...c.matrix);
                const path = new Path2D();
                path.roundRect(0, 0, c.w, c.h, Math.min(c.radius || 0, c.w / 2, c.h / 2)); // Transform the clip path rather than discarding its clip state.
                ctx.restore();
                const transformed = new Path2D();
                transformed.addPath(path, new DOMMatrix(c.matrix));
                ctx.clip(transformed);
            }
            ctx.transform(...s.matrix);
            ctx.globalAlpha = s.opacity;
            const path = pathFor(n);
            if (n.type === 'text') {
                const tr = ctx.getTransform(), desired = clamp(2 ** Math.ceil(Math.log2(Math.hypot(tr.a, tr.b))), .5, 4), scale = Math.min(desired, 4096 / Math.max(n.w, n.h, 1)), key = n.id + ':' + scale;
                let entry = this.cache.get(key);
                if (!entry || entry.version !== n.version) {
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.ceil(n.w * scale));
                    canvas.height = Math.max(1, Math.ceil(n.h * scale));
                    const tc = canvas.getContext('2d');
                    tc.scale(scale, scale);
                    tc.beginPath();
                    tc.rect(0, 0, n.w, n.h);
                    tc.clip();
                    paintText(tc, n);
                    entry = { version: n.version, canvas };
                    if (this.cache.size >= 512)
                        this.cache.delete(this.cache.keys().next().value);
                    this.cache.set(key, entry);
                }
                ctx.drawImage(entry.canvas, 0, 0, n.w, n.h);
            }
            else if (n.type === 'image') {
                const image = this.images.get(n.assetId);
                if (image) {
                    ctx.save();
                    ctx.clip(path);
                    ctx.drawImage(image, ...imageFit(image, n.w, n.h));
                    ctx.restore();
                }
                if (n.strokeWidth) {
                    ctx.strokeStyle = n.stroke === 'none' ? 'transparent' : n.stroke;
                    ctx.lineWidth = n.strokeWidth;
                    ctx.stroke(path);
                }
            }
            else {
                if (n.shadow) {
                    const col = color(n.shadowColor || '#000000', n.shadowOpacity ?? .16);
                    ctx.shadowColor = `rgba(${Math.round(col[0] * 255)},${Math.round(col[1] * 255)},${Math.round(col[2] * 255)},${col[3]})`;
                    const st = ctx.getTransform(), ss = Math.hypot(st.a, st.b);
                    ctx.shadowBlur = (n.shadowBlur || 20) * ss;
                    ctx.shadowOffsetX = (n.shadowX || 0) * ss;
                    ctx.shadowOffsetY = (n.shadowY || 0) * ss;
                }
                ctx.fillStyle = fillStyle(ctx, n);
                ctx.globalAlpha = s.opacity * (n.fillOpacity ?? 1);
                if (n.fill !== 'none')
                    ctx.fill(path);
                ctx.shadowColor = 'transparent';
                ctx.globalAlpha = s.opacity;
                if (n.strokeWidth) {
                    ctx.strokeStyle = n.stroke === 'none' ? 'transparent' : n.stroke;
                    ctx.lineWidth = n.strokeWidth;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';
                    ctx.stroke(path);
                }
            }
            ctx.restore();
        }
    }
    async exportCanvas(ids, scale = 2) {
        await this.images.ready();
        const included = new Set();
        for (const id of ids) {
            included.add(id);
            for (const n of this.doc.descendants(id))
                included.add(n.id);
        }
        const box = this.doc.bounds(ids);
        if (!box)
            throw new Error('Nothing to export.');
        const maxDimension = 16384;
        if (box.w * scale > maxDimension || box.h * scale > maxDimension || box.w * box.h * scale * scale > 64e6)
            throw new Error('Export exceeds 64 megapixels or 16,384 pixels per side. Choose a lower scale.');
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(box.w * scale));
        canvas.height = Math.max(1, Math.ceil(box.h * scale));
        const ctx = canvas.getContext('2d');
        ctx.scale(scale, scale);
        ctx.translate(-box.x, -box.y);
        this.paintScene(ctx, this.doc.scene().filter(s => included.has(s.node.id)));
        return canvas;
    }
    destroy() { this.atlas?.destroy(); this.instanceBuffer?.destroy(); this.clipBuffer?.destroy(); this.uniform?.destroy(); this.device?.destroy(); }
}
