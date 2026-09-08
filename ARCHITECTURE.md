# Vellum implementation notes

## 1. Document space and ownership

A document has a versioned `vellum` envelope, page collection, active page, tokens, embedded image assets and optional user-loaded fonts. Each page stores a flat, painter-ordered node array. `parentId` supplies hierarchy without serializing parent pointers or cyclic object graphs. Node coordinates are local to the parent; rotations occur around the node center.

`DocumentModel.scene()` groups by parent and recursively composes affine matrices. The cached output includes forward/inverse transforms, world AABBs, inherited opacity, inherited locking and ancestor clipping descriptions. A revision invalidates that cache after a model mutation; camera-only changes reuse it. The supported affine model exposes translation and rotation; resize changes node dimensions, rather than storing arbitrary skew/scale matrices.

Grouping calculates a common-parent-space bounding rectangle and converts children through the new parent's inverse transform. Ungrouping performs the inverse conversion. Reparenting uses the old world transform and new parent's inverse, avoiding visible jumps. A group resize scales its descendants; frame resizing uses each child's constraints.

The parser checks format version, page/node limits, numeric geometry, recognized node types, ID syntax, missing parents, duplicate node IDs, cycles, hierarchy depth, vector coordinates, text size and accepted embedded-image schemes. Import is data parsing, never script evaluation. User-facing names and text are escaped before insertion into UI markup.

## 2. Transactions and history

Pointer-down begins a transform transaction. Pointer movements mutate the active scene and invalidate drawing, but do not create separate undo entries. Pointer-up applies layout/component synchronization and commits once. Cancellation restores the pre-gesture state.

History retains up to 80 metadata snapshots. Asset/font maps are shallow-copied separately so immutable data-URL strings can be retained without repeating them in every geometry JSON snapshot. This also makes opening a new document reversible without losing the previous document's embedded images. Undo/redo reset raster caches that might otherwise contain a different asset under the same ID.

This is intentionally a snapshot history, not an operation log or CRDT. A future collaboration engine should introduce stable operations, inverse operations, conflict policy and source-of-truth ownership rather than synchronizing snapshots indiscriminately.

## 3. GPU instance ABI

Every instance occupies eight `vec4<f32>` values, 128 bytes total:

| Vector | Payload |
| --- | --- |
| 0 | Affine linear part: a, b, c, d |
| 1 | Camera-relative translation x/y and local width/height |
| 2 | Primary fill RGBA |
| 3 | Stroke RGBA |
| 4 | Radius, stroke width, primitive kind, inherited opacity |
| 5 | Atlas UV origin and extent |
| 6 | Secondary gradient fill RGBA |
| 7 | Gradient angle/sentinel, shadow blur, clip-chain index, atlas layer |

The vertex shader generates six vertices per instance without a vertex buffer. It expands analytical shape quads for antialias/stroke/shadow support and maps camera-relative coordinates into clip space. The fragment shader evaluates rounded-rectangle or approximate ellipse coverage, combines stroke/fill, evaluates a linear gradient where requested and outputs premultiplied color. Raster instances sample premultiplied atlas pixels at explicit LOD zero.

A clip record is three vec4s (48 bytes): the inverse linear transform, inverse translation plus extents, and radius/parent index. Clip transforms are adjusted on the CPU for the camera-relative coordinate system. Fragments multiply coverage through their ancestor chain, with a defensive 100-ancestor bound. This preserves nested rotated rounded-frame clips without per-node render passes or a stencil stack.

Buffers grow geometrically. Rendering preserves document paint order, including shadow instances, in one storage-buffer instance stream. There is one scene pipeline, one atlas binding and one scene draw call per nonempty GPU frame. This does not count browser composition or the separate selection overlay.

## 4. Raster working set

The GPU raster atlas is a four-layer RGBA8 texture, up to 2048 × 2048 per layer: 64 MiB at that size. Shelf packing reserves padding between entries. Keys include node identity, node version and a quantized render scale. The scale is derived from camera zoom and device pixel ratio, bounded by raster dimensions and a quality ceiling.

Text layers are shaped and painted by Canvas 2D. Paths retain editable anchors and Bézier handles in the document, but their GPU representation is rasterized. Images retain original embedded data; rendering uses cover placement inside their dimensions. Image decoding is asynchronous and invalidates the scene when available.

Atlas exhaustion triggers a reset and a reduced-resolution retry. An oversized working set that still cannot fit falls back to Canvas rather than silently dropping content. This is a correctness-first policy; a production-scale extension should add eviction, independent atlas-page batches or tiled rasters, and then measure upload costs and GPU execution.

## 5. Text model and editing bridge

`layoutText` preserves explicit paragraph breaks, wraps to node width, and uses grapheme segmentation for breaking a word that cannot fit on a line. Canvas performs font selection and shaping. Letter spacing, weight, italic, line height, alignment, direction and decoration are layer-level properties.

A transformed `contenteditable` overlay handles text input and caret/selection behavior during editing. The corresponding raster node is temporarily omitted from rendering, avoiding doubled text. Commit writes plain text into the document, recomputes height, increments the node version and returns ownership to the renderer.

This is not a rich-text engine. Browser DOM selection and raster layout can differ at difficult line-breaking, bidirectional, font-fallback and font-metric boundaries. A future full typography implementation should share explicit line/run layouts with the input overlay, use a richer paragraph model, support composition events and per-run formatting, and define supported OpenType/variable-font features. Arbitrary Unicode input is retained, but glyph availability depends on fonts.

## 6. Editing state machines

The controller separates pan, create, move, resize, rotate, marquee, pen-handle and path-edit gestures. Pointer capture keeps an active drag associated with the canvas. Escape/cancel restores a pending transaction. Touch pointers support camera pinch gestures; dense editing remains optimized for mouse and keyboard.

Hit testing maps the world pointer through each candidate inverse transform and checks inherited clipping. Shape/path containment uses analytical checks or Canvas path tests. Groups/components can act as selection containers; Ctrl/Cmd enables deeper picking. Smart guides compare selected bounds with eligible sibling edges and centers. These algorithms currently scan the scene; an R-tree/BVH and a separate snapping index are logical next steps for very large documents.

The inspector writes through the same model mutation path as commands. Auto layout positions immediate children using direction/gap/padding/cross-axis alignment. Component synchronization copies existing-node properties from source IDs while retaining instance overrides; it is not a structural diff/patch engine.

## 7. Persistence and interchange

Saving is debounced to IndexedDB and falls back to localStorage where needed. Save failures are visible; there is no silent claim of successful cloud synchronization. Native `.vellum` files contain all pages and embedded assets. Browser-local persistence is origin-specific and cannot replace portable backups.

PNG export paints the relevant scene into a guarded offscreen Canvas at the requested scale. SVG export emits transformed geometry, clip paths, gradients, text spans and embedded images. Text remains text, with family references. SVG shadow filters and analytical GPU shadows are not promised to be pixel-identical.

## 8. Validation and performance interpretation

The included report is an actual Chromium integration run with 36 passing checks. Its opaque origin forced Canvas 2D, so neither WebGPU execution nor persistent browser storage was verified in that environment. The WGSL source and backend are delivered, but there is no claimed hardware benchmark.

`cpuMs` measures synchronous scene work and API submission, not GPU completion. The UI intentionally avoids inventing FPS. Future benchmarking should separately report input-to-frame latency, CPU scene assembly, shaping/rasterization, texture upload bytes/time, GPU timestamps when available, memory residency and cold/warm cache behavior. Use `?canvas` to obtain a deliberate fallback baseline on the same device.
