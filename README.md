# Vellum 🪶

<p align="center">
  <img src="src-tauri/icons/128x128.png" width="96" height="96" alt="Vellum Logo" />
</p>

<p align="center">
  <strong>The Local-First Vector Design Tool for macOS.</strong><br>
  Built with WebGPU hardware acceleration, embedded SQLite persistence, and native macOS integration.
</p>

<p align="center">
  <a href="https://github.com/hosseiw/vellum/releases/latest"><img src="https://img.shields.io/badge/Release-v0.1.0%20(DMG)-8b6cff?style=flat-square&logo=apple" alt="Release v0.1.0"></a>
  <a href="https://hosseiw.github.io/vellum/"><img src="https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-4ade80?style=flat-square&logo=github" alt="Live Demo"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/RAM-87%20MB-success?style=flat-square" alt="Memory">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon-black?style=flat-square&logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Storage-SQLite%203-blue?style=flat-square&logo=sqlite" alt="SQLite">
</p>

---

## ⚡ What is Vellum?

**Vellum** is a high-performance, local-first vector design editor designed specifically for macOS. Unlike cloud-locked SaaS editors and bloated Electron wrappers, Vellum is built from the ground up to respect your machine's resources, privacy, and workflow:

- **Ultra-lightweight**: Runs on only **~87 MB RAM** (1.0% of system memory) and **0% idle CPU**.
- **Instant Launch**: Starts in **< 0.4 seconds** with a tiny **3.2 MB DMG** installer.
- **Hardware-Accelerated WebGPU**: Renders 5,000+ vector shapes smoothly at 60 FPS using instanced GPU quads and analytical signed-distance field (SDF) shaders.
- **Native Embedded SQLite**: Saves projects in a local relational SQLite database (`~/Library/Application Support/com.vellum.designer/vellum.db`) with indexed queries.
- **Dedicated Documents Sync**: Automatically syncs projects to `~/Documents/Vellum/<ProjectName>.vellum`.
- **System File Association**: The `.vellum` format is registered with macOS Finder as a default document type.
- **Zero Cloud & Zero Telemetry**: 100% offline. No accounts, no subscriptions, no tracking.

### Site analytics

The public site exposes an [Analytics dashboard](https://hosseiw.github.io/vellum/analytics.html) populated by GitHub Actions. It reports cumulative GitHub release-asset downloads and GitHub Pages repository views from the last 14 days; the editor remains local-first and does not send telemetry.

To enable page-view collection, add a repository secret named `ANALYTICS_TOKEN` with a fine-grained token that can read repository traffic. The scheduled Pages workflow refreshes the generated `analytics.json` before deployment.

---

## 🚀 Quick Start

### 1. Download Native macOS App (Recommended)
Download the pre-built installer for macOS (Apple Silicon):

📥 **[Download Vellum v0.1.0 (.dmg)](https://github.com/hosseiw/vellum/releases/download/v0.1.0/Vellum_0.1.0_aarch64.dmg)** (3.2 MB)

1. Open the downloaded `Vellum_0.1.0_aarch64.dmg`.
2. Drag **Vellum.app** into your **/Applications** folder.
3. Open Vellum from **Spotlight** (`⌘ + Space` → `Vellum`), **Launchpad**, or your **Dock**.

### 2. Try the Web Version in Your Browser
No installation needed! Vellum runs directly in any modern browser with WebGPU / Canvas 2D fallback:

🌐 **[Launch Vellum Web Editor](https://hosseiw.github.io/vellum/editor.html)**

---

## 📊 Benchmark Comparison

| Metric | Vellum (Tauri v2 + SQLite) | Typical Electron App | Cloud SaaS (Figma) |
| :--- | :--- | :--- | :--- |
| **RAM Usage** | **~87 MB** | 450 MB – 800 MB | 600 MB – 1.5 GB |
| **Idle CPU** | **0.0% – 0.2%** | 2.0% – 5.0% | 1.5% – 4.0% |
| **Installer Size** | **3.2 MB DMG** | 160 MB – 220 MB | N/A (Web browser) |
| **Launch Time** | **< 0.4s** | 2.5 – 4.0s | 3.0 – 6.0s (network) |
| **Storage Engine** | **SQLite + ~/Documents** | Local JSON | Proprietary Cloud |
| **User Accounts** | **Zero / Anonymous** | Optional | Mandatory Login |
| **Offline First** | **100% Native Offline** | Partial | Limited / Read-only |

---

## 🛠️ Features

### Vector Design Tools
- **Bézier Pen Tool (`P`)**: Draw anchor points, manipulate tangent handles, break angle symmetry with `Alt`, and edit paths in real time.
- **Auto Layout Flexbox Engine**: Horizontal/vertical auto layout, configurable item gaps, and uniform/independent padding.
- **Reusable Components & Instances**: Create primary components (`⌘⌥K`) and spawn linked instances that receive source updates while preserving local property overrides.
- **Typography & Semantic Design Tokens**: Full Unicode multiline text editor, font weight, style, alignment, letter spacing, and line height bindings.
- **Live CSS & Code Inspector**: Instant geometry, fill, border-radius, and flexbox CSS generation.
- **Export Formats**: Export crisp PNGs (1x, 2x, 3x) and production-ready SVG vectors with clean hierarchy.

### Storage & Project Management
- **Projects Manager (`⌘P`)**: Visual project switcher modal with canvas thumbnail previews, page counts, layer counts, and real-time search.
- **Dual-View Browser**:
  - **Database Projects**: Fast SQLite query records with duplicate and delete controls.
  - **Documents / Vellum**: Live directory browser of `~/Documents/Vellum/` with one-click "Open in Editor" and "Reveal in Finder".
- **Dual-Mode Engine**: Talks to native SQLite via IPC on desktop and automatically falls back to IndexedDB in web browsers.

---

## 📁 The `.vellum` File Format

Vellum saves your documents as pure, open JSON with the `.vellum` file extension:

```json
{
  "format": "vellum",
  "version": 1,
  "name": "Forma · Product design",
  "pageId": "c9035628-adcb-4bc7-bb40-fe399a6c43de",
  "pages": [ ... ],
  "tokens": { ... },
  "assets": { ... }
}
```

Files are automatically stored in:
```
~/Documents/Vellum/<ProjectName>.vellum
```
Double-clicking any `.vellum` file in Finder immediately opens it in Vellum.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| `V` / `F` / `R` / `O` / `L` / `P` / `T` | Select Move, Frame, Rectangle, Ellipse, Line, Pen, or Text tool |
| `⌘ + P` | Open Projects & Documents Manager |
| `⌘ + S` | Save to `~/Documents/Vellum` |
| `⌘ + O` | Open / Import `.vellum` document |
| `⌘ + Z` / `⇧ + ⌘ + Z` | Undo / Redo |
| `⌘ + D` | Duplicate selection |
| `⌘ + G` / `⇧ + ⌘ + G` | Group / Ungroup selection |
| `⌘ + K` | Command palette |
| `Space + Drag` | Pan canvas |
| `⌘ + Scroll` | Smooth hardware zoom |
| `Shift + 1` / `Shift + 2` | Fit all / Fit selection |

---

## 🏗️ Building from Source

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Rust & Cargo](https://rustup.rs/) (v1.77+)
- macOS Xcode Command Line Tools (`xcode-select --install`)

### Development Mode (with Live Reload)
```bash
# Clone the repository
git clone https://github.com/hosseiw/vellum.git
cd vellum

# Run Tauri development server
npm run dev
```

### Build Production macOS App and DMG
```bash
# Compiles optimized Rust binary and bundles Vellum.app and Vellum.dmg
npm run build
```
Output artifacts:
- **App**: `src-tauri/target/release/bundle/macos/Vellum.app`
- **DMG**: `src-tauri/target/release/bundle/dmg/Vellum_0.1.0_aarch64.dmg`

---

## 📜 License

Vellum is open-source software released under the [MIT License](LICENSE).
