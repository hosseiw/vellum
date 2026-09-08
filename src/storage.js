/**
 * Vellum Storage Engine
 * Multi-project persistence layer supporting:
 * 1. Native macOS SQLite database (when running inside Tauri desktop app)
 * 2. High-performance IndexedDB (when running in web browser or local server)
 */

export class StorageEngine {
  constructor() {
    this.mode = 'indexeddb'; // 'sqlite' or 'indexeddb'
    this.db = null;
    this.activeProjectId = null;
    this.isTauri = false;
  }

  async init() {
    // Detect Tauri environment
    const tauri = window.__TAURI__ || window.__TAURI_INTERNALS__;
    if (tauri) {
      try {
        this.isTauri = true;
        const res = await this._invokeTauri('init_database');
        if (res && res.success) {
          this.mode = 'sqlite';
          console.info('[StorageEngine] Running with native SQLite backend');
          return;
        }
      } catch (err) {
        console.warn('[StorageEngine] Tauri SQLite init error, falling back to IndexedDB:', err);
      }
    }

    // Browser IndexedDB mode
    this.mode = 'indexeddb';
    await this._initIndexedDB();
    console.info('[StorageEngine] Running with browser IndexedDB backend');
  }

  async _invokeTauri(cmd, args = {}) {
    if (window.__TAURI__?.core?.invoke) {
      return await window.__TAURI__.core.invoke(cmd, args);
    }
    if (window.__TAURI_INTERNALS__?.invoke) {
      return await window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    throw new Error('Tauri IPC not available');
  }

  async _initIndexedDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('vellum-editor', 2);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) {
          const store = db.createObjectStore('projects', { keyPath: 'id' });
          store.createIndex('updated_at', 'updated_at', { unique: false });
        }
        if (!db.objectStoreNames.contains('documents')) {
          db.createObjectStore('documents');
        }
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * List all projects with summaries (excluding heavy document_data for performance)
   * @returns {Promise<Array<{id: string, name: string, thumbnail: string|null, page_count: number, layer_count: number, created_at: number, updated_at: number}>>}
   */
  async listProjects() {
    if (this.mode === 'sqlite') {
      return await this._invokeTauri('list_projects');
    }

    // IndexedDB implementation
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve([]);
      const tx = this.db.transaction('projects', 'readonly');
      const store = tx.objectStore('projects');
      const index = store.index('updated_at');
      const req = index.openCursor(null, 'prev'); // newest first
      const results = [];

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const item = cursor.value;
          results.push({
            id: item.id,
            name: item.name,
            thumbnail: item.thumbnail || null,
            page_count: item.page_count || 1,
            layer_count: item.layer_count || 0,
            created_at: item.created_at || item.updated_at || Date.now(),
            updated_at: item.updated_at || Date.now()
          });
          cursor.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieve a project by ID, including its full document_data JSON string
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async getProject(id) {
    if (this.mode === 'sqlite') {
      return await this._invokeTauri('get_project', { id });
    }

    return new Promise((resolve, reject) => {
      if (!this.db) return resolve(null);
      const tx = this.db.transaction('projects', 'readonly');
      const req = tx.objectStore('projects').get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Save or update a project
   */
  async saveProject({ id, name, documentData, thumbnail = null, pageCount = 1, layerCount = 0 }) {
    const now = Date.now();
    this.activeProjectId = id;

    if (this.mode === 'sqlite') {
      return await this._invokeTauri('save_project', {
        id,
        name,
        documentData,
        thumbnail,
        pageCount,
        layerCount,
        updatedAt: now
      });
    }

    // IndexedDB implementation
    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('projects', 'readwrite');
      const store = tx.objectStore('projects');
      
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        const record = {
          id,
          name,
          thumbnail: thumbnail !== null ? thumbnail : (existing?.thumbnail || null),
          document_data: documentData,
          page_count: pageCount,
          layer_count: layerCount,
          created_at: existing?.created_at || now,
          updated_at: now
        };
        const putReq = store.put(record);
        putReq.onsuccess = () => resolve(record);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  /**
   * Delete a project
   * @param {string} id
   */
  async deleteProject(id) {
    if (this.mode === 'sqlite') {
      return await this._invokeTauri('delete_project', { id });
    }

    return new Promise((resolve, reject) => {
      if (!this.db) return resolve();
      const tx = this.db.transaction('projects', 'readwrite');
      const req = tx.objectStore('projects').delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Duplicate a project
   * @param {string} id
   */
  async duplicateProject(id) {
    const original = await this.getProject(id);
    if (!original) throw new Error('Project not found to duplicate');

    const newId = 'proj_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const newName = original.name.startsWith('Copy of ') ? original.name : `Copy of ${original.name}`;

    return await this.saveProject({
      id: newId,
      name: newName,
      documentData: original.document_data,
      thumbnail: original.thumbnail,
      pageCount: original.page_count,
      layerCount: original.layer_count
    });
  }

  /**
   * Get the dedicated ~/Documents/Vellum directory path
   */
  async getDocumentsDir() {
    if (this.isTauri) {
      return await this._invokeTauri('get_documents_vellum_dir');
    }
    return 'Documents/Vellum';
  }

  /**
   * Save a .vellum document to ~/Documents/Vellum
   * @param {string} name
   * @param {string} content - JSON serialized vellum document
   * @returns {Promise<{success: boolean, filename: string, path: string}>}
   */
  async saveToDocuments(name, content) {
    if (this.isTauri) {
      return await this._invokeTauri('save_document_to_vellum_folder', { name, content });
    }
    // Web fallback
    const filename = (name.endsWith('.vellum') ? name : `${name}.vellum`).replace(/[^\w.-]/g, '_');
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return { success: true, filename, path: filename };
  }

  /**
   * List all .vellum files inside ~/Documents/Vellum
   * @returns {Promise<Array<{filename: string, path: string, size_bytes: number, modified_at: number, title: string, page_count?: number, layer_count?: number}>>}
   */
  async listDocumentsFiles() {
    if (this.isTauri) {
      return await this._invokeTauri('list_documents_vellum_files');
    }
    return [];
  }

  /**
   * Read a .vellum file from disk
   * @param {string} path
   * @returns {Promise<string>}
   */
  async readDocumentFile(path) {
    if (this.isTauri) {
      return await this._invokeTauri('read_document_file', { path });
    }
    throw new Error('Direct file system reading only available in Desktop mode');
  }

  /**
   * Reveal ~/Documents/Vellum (or a specific file) in macOS Finder
   * @param {string|null} path
   */
  async revealInFinder(path = null) {
    if (this.isTauri) {
      return await this._invokeTauri('reveal_in_finder', { path });
    }
  }

  /**
   * Check if a file was passed as argument when launching the app
   * @returns {Promise<string|null>}
   */
  async getCliFileArg() {
    if (this.isTauri) {
      try {
        return await this._invokeTauri('get_cli_file_arg');
      } catch (e) {
        return null;
      }
    }
    return null;
  }
}

export const storage = new StorageEngine();
