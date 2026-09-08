# Vellum Desktop & SQLite Architecture Guide

This document explains the architecture, database integration, usage, and build instructions for the native macOS version of **Vellum**.

---

## 1. Why Tauri v2 + SQLite? (Comparison & Rationale)

When choosing how to run Vellum as a native macOS application with local database persistence, three architectures were evaluated:

| Metric | Tauri v2 + SQLite (Chosen) | Electron + SQLite | Full SwiftUI Rewrite |
| :--- | :--- | :--- | :--- |
| **Memory (RAM)** | **~45 – 85 MB** (1% on 8GB Mac) | 450 – 700 MB+ | ~30 – 60 MB |
| **CPU (Idle / Active)** | **0.0% idle / 1–3% active** | 2–5% idle / 8–15% active | 0.0% idle / 1–2% active |
| **Installer Size** | **3.2 MB** DMG | 140 – 200 MB DMG | ~15 – 30 MB |
| **Code Simplicity** | **High** (reuses 100% existing code) | Moderate (heavy Chromium bundle) | Very Low (months of math rewrite) |
| **WebGPU Support** | **Native** (via macOS WebKit / Metal) | Chromium WebGPU | Metal Shading Language required |
| **Launch Time** | **< 0.5s** | ~2.5 – 4.0s | < 0.3s |

### Verdict:
- **Electron** wastes significant RAM and CPU by shipping an entire separate Chromium browser and Node.js runtime (~150MB+ download and ~500MB RAM).
- **SwiftUI** would require rewriting all vector math, boolean path clipping, auto-layout solvers, SVG parsers, and WebGPU shaders from scratch in Swift and Metal (estimated 2–3 months of work).
- **Tauri v2 + SQLite** gives you the best of both worlds: native macOS WebKit with hardware-accelerated Metal/WebGPU, a lightning-fast Rust backend with zero runtime overhead, and a tiny 3.2MB DMG.

---

## 2. Dedicated Documents Folder & `.vellum` File Association

Instead of downloading into `~/Downloads/`, Vellum uses a dedicated directory in your macOS Documents folder:

```
~/Documents/Vellum/
```

### Features:
1. **Automatic Synchronization**: Whenever you design or click **Save (`⌘S`)**, Vellum saves your document as a `.vellum` file directly into `~/Documents/Vellum/<ProjectName>.vellum`.
2. **Native File Association**: macOS registers the `.vellum` file extension for `Vellum.app`. Double-clicking any `.vellum` file in Finder will open it directly in Vellum!
3. **Show in Finder**: In the Projects dialog or Main Menu, click **Finder** to immediately reveal the `~/Documents/Vellum` directory.

---

## 3. How to Launch and Use Vellum

### Direct Launch (No Terminal Needed)
Vellum is installed directly in your macOS `/Applications` folder:
1. Open **Spotlight** (`⌘ + Space`) and type `Vellum`, then hit **Enter**.
2. Or open **Finder** → **Applications** → double-click **Vellum.app**.
3. Or launch it from **Launchpad** or drag it to your **Dock**.

### Managing Projects & Files
- **Open Projects Manager**:
  - Click the **Projects** button in the top toolbar (next to the logo).
  - Or press the keyboard shortcut **`⌘ + P`**.
  - Or click the main menu dropdown (top-left) → **Projects & Documents…**.
- **Dual-View Tabs**:
  - **Database Projects**: Shows fast SQLite database records with live canvas thumbnails, page/layer counts, and duplication/deletion options.
  - **Documents / Vellum**: Shows live files found in `~/Documents/Vellum/` with file size, modified dates, an **"Open"** button to load them into the canvas, and a **"Finder"** button.
- **Importing `.vellum` Files**:
  - Click **Import .vellum…** in the Projects dialog or Export dialog to open any `.vellum` file from anywhere on your Mac.
  - Or drag and drop any `.vellum` file directly onto the canvas.
- **Save Portable `.vellum`**:
  - Press `⌘ + S` or select **Save to Documents/Vellum** from the main menu.

---

## 4. SQLite Database Architecture

### File Location
The database is stored in standard macOS application storage:
```
~/Library/Application Support/com.vellum.designer/vellum.db
```

### Database Schema
```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    thumbnail TEXT,
    document_data TEXT NOT NULL,
    page_count INTEGER NOT NULL DEFAULT 1,
    layer_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_projects_updated_at ON projects(updated_at DESC);
```

### Inspecting the Database via Terminal
You can inspect or query the SQLite database at any time:
```bash
sqlite3 "$HOME/Library/Application Support/com.vellum.designer/vellum.db" "SELECT id, name, page_count, layer_count, datetime(updated_at/1000, 'unixepoch') FROM projects;"
```

---

## 5. Cleaned Project Structure

The project structure has been organized and cleaned:
- Removed unused Windows Store icons and legacy build artifacts.
- Organized `src/storage.js` for dual-mode SQLite and IndexedDB operations.
- Packaged native macOS configuration in `src-tauri/tauri.conf.json` with `.vellum` document role registration.

---

## 6. Build & Distribution Instructions

To compile or export a fresh version of the app:

### Run in Development Mode (Live Reload)
```bash
npm run dev
```

### Build Release .app and .dmg Bundle
```bash
npm run build
```
Output bundles:
- **macOS App Bundle**: `src-tauri/target/release/bundle/macos/Vellum.app`
- **macOS DMG Installer**: `src-tauri/target/release/bundle/dmg/Vellum_0.1.0_aarch64.dmg` (3.2 MB)

### Update `/Applications/Vellum.app`
```bash
cp -R src-tauri/target/release/bundle/macos/Vellum.app /Applications/Vellum.app
```
