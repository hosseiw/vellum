use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

pub struct DbState(pub Mutex<Option<Connection>>);

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub thumbnail: Option<String>,
    pub page_count: i64,
    pub layer_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ProjectDetail {
    pub id: String,
    pub name: String,
    pub thumbnail: Option<String>,
    pub document_data: String,
    pub page_count: i64,
    pub layer_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct InitResponse {
    pub success: bool,
    pub db_path: String,
}

fn get_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("Failed to create app data dir: {}", e))?;
    }
    Ok(app_dir.join("vellum.db"))
}

#[tauri::command]
fn init_database(app: AppHandle, state: State<'_, DbState>) -> Result<InitResponse, String> {
    let db_path = get_db_path(&app)?;
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open SQLite database at {:?}: {}", db_path, e))?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY NOT NULL,
            name TEXT NOT NULL,
            thumbnail TEXT,
            document_data TEXT NOT NULL,
            page_count INTEGER NOT NULL DEFAULT 1,
            layer_count INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC);
        ",
    )
    .map_err(|e| format!("Failed to initialize SQLite tables: {}", e))?;

    let mut lock = state.0.lock().map_err(|e| e.to_string())?;
    *lock = Some(conn);

    // Ensure dedicated ~/Documents/Vellum directory exists
    let _ = get_vellum_documents_dir(&app);

    Ok(InitResponse {
        success: true,
        db_path: db_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn list_projects(state: State<'_, DbState>) -> Result<Vec<ProjectSummary>, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn
        .prepare("SELECT id, name, thumbnail, page_count, layer_count, created_at, updated_at FROM projects ORDER BY updated_at DESC")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                thumbnail: row.get(2)?,
                page_count: row.get(3)?,
                layer_count: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut list = Vec::new();
    for r in rows {
        list.push(r.map_err(|e| e.to_string())?);
    }
    Ok(list)
}

#[tauri::command]
fn get_project(id: String, state: State<'_, DbState>) -> Result<Option<ProjectDetail>, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("Database not initialized")?;

    let mut stmt = conn
        .prepare("SELECT id, name, thumbnail, document_data, page_count, layer_count, created_at, updated_at FROM projects WHERE id = ?1")
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query_map(params![id], |row| {
            Ok(ProjectDetail {
                id: row.get(0)?,
                name: row.get(1)?,
                thumbnail: row.get(2)?,
                document_data: row.get(3)?,
                page_count: row.get(4)?,
                layer_count: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    match rows.next() {
        Some(Ok(proj)) => Ok(Some(proj)),
        Some(Err(e)) => Err(e.to_string()),
        None => Ok(None),
    }
}

#[tauri::command]
fn save_project(
    id: String,
    name: String,
    document_data: String,
    thumbnail: Option<String>,
    page_count: i64,
    layer_count: i64,
    updated_at: i64,
    state: State<'_, DbState>,
) -> Result<bool, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("Database not initialized")?;

    conn.execute(
        "
        INSERT INTO projects (id, name, thumbnail, document_data, page_count, layer_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            thumbnail = COALESCE(excluded.thumbnail, projects.thumbnail),
            document_data = excluded.document_data,
            page_count = excluded.page_count,
            layer_count = excluded.layer_count,
            updated_at = excluded.updated_at
        ",
        params![id, name, thumbnail, document_data, page_count, layer_count, updated_at, updated_at],
    )
    .map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
fn delete_project(id: String, state: State<'_, DbState>) -> Result<bool, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("Database not initialized")?;

    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
fn duplicate_project(id: String, state: State<'_, DbState>) -> Result<ProjectSummary, String> {
    let lock = state.0.lock().map_err(|e| e.to_string())?;
    let conn = lock.as_ref().ok_or("Database not initialized")?;

    let orig = {
        let mut stmt = conn
            .prepare("SELECT name, thumbnail, document_data, page_count, layer_count FROM projects WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt
            .query_map(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.next().ok_or("Project not found")?.map_err(|e| e.to_string())?
    };

    let new_id = format!(
        "vproj_{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let new_name = if orig.0.starts_with("Copy of ") {
        orig.0.clone()
    } else {
        format!("Copy of {}", orig.0)
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    conn.execute(
        "
        INSERT INTO projects (id, name, thumbnail, document_data, page_count, layer_count, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ",
        params![new_id, new_name, orig.1, orig.2, orig.3, orig.4, now, now],
    )
    .map_err(|e| e.to_string())?;

    Ok(ProjectSummary {
        id: new_id,
        name: new_name,
        thumbnail: orig.1,
        page_count: orig.3,
        layer_count: orig.4,
        created_at: now,
        updated_at: now,
    })
}

#[derive(Serialize, Deserialize, Debug)]
pub struct VellumSaveResult {
    pub success: bool,
    pub filename: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct VellumFileItem {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified_at: u64,
    pub title: String,
    pub page_count: Option<i64>,
    pub layer_count: Option<i64>,
}

fn get_vellum_documents_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let doc_dir = app
        .path()
        .document_dir()
        .or_else(|_| {
            std::env::var("HOME")
                .map(|h| PathBuf::from(h).join("Documents"))
                .map_err(|e| tauri::Error::from(std::io::Error::new(std::io::ErrorKind::NotFound, e.to_string())))
        })
        .map_err(|e| format!("Failed to get Documents directory: {}", e))?;
    let vellum_dir = doc_dir.join("Vellum");
    if !vellum_dir.exists() {
        fs::create_dir_all(&vellum_dir)
            .map_err(|e| format!("Failed to create ~/Documents/Vellum directory: {}", e))?;
    }
    Ok(vellum_dir)
}

#[tauri::command]
fn get_documents_vellum_dir(app: AppHandle) -> Result<String, String> {
    let dir = get_vellum_documents_dir(&app)?;
    Ok(dir.to_string_lossy().to_string())
}

#[tauri::command]
fn save_document_to_vellum_folder(
    name: String,
    content: String,
    app: AppHandle,
) -> Result<VellumSaveResult, String> {
    let dir = get_vellum_documents_dir(&app)?;
    let safe_base: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '·' { c } else { '_' })
        .collect();
    let safe_base = safe_base.trim();
    let base_name = if safe_base.is_empty() { "Untitled" } else { safe_base };
    let filename = if base_name.ends_with(".vellum") {
        base_name.to_string()
    } else {
        format!("{}.vellum", base_name)
    };
    let file_path = dir.join(&filename);
    fs::write(&file_path, content)
        .map_err(|e| format!("Failed to write file to {:?}: {}", file_path, e))?;

    Ok(VellumSaveResult {
        success: true,
        filename,
        path: file_path.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn list_documents_vellum_files(app: AppHandle) -> Result<Vec<VellumFileItem>, String> {
    let dir = get_vellum_documents_dir(&app)?;
    let mut files = Vec::new();

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension() {
                    if ext == "vellum" {
                        let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                        let meta = entry.metadata().ok();
                        let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
                        let modified_at = meta
                            .as_ref()
                            .and_then(|m| m.modified().ok())
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);

                        let mut title = filename.strip_suffix(".vellum").unwrap_or(&filename).to_string();
                        let mut page_count = None;
                        let mut layer_count = None;

                        // Try to parse basic document attributes if small enough
                        if size_bytes < 30 * 1024 * 1024 {
                            if let Ok(text) = fs::read_to_string(&path) {
                                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                                    if let Some(n) = val.get("name").and_then(|v| v.as_str()) {
                                        if !n.is_empty() {
                                            title = n.to_string();
                                        }
                                    }
                                    if let Some(pages) = val.get("pages").and_then(|v| v.as_array()) {
                                        page_count = Some(pages.len() as i64);
                                    }
                                    if let Some(layers) = val.get("layers").and_then(|v| v.as_array()) {
                                        layer_count = Some(layers.len() as i64);
                                    }
                                }
                            }
                        }

                        files.push(VellumFileItem {
                            filename,
                            path: path.to_string_lossy().to_string(),
                            size_bytes,
                            modified_at,
                            title,
                            page_count,
                            layer_count,
                        });
                    }
                }
            }
        }
    }

    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    Ok(files)
}

#[tauri::command]
fn read_document_file(path: String) -> Result<String, String> {
    let path_buf = PathBuf::from(&path);
    fs::read_to_string(&path_buf)
        .map_err(|e| format!("Failed to read file at {:?}: {}", path, e))
}

#[tauri::command]
fn reveal_in_finder(path: Option<String>, app: AppHandle) -> Result<bool, String> {
    let target = match path {
        Some(p) => PathBuf::from(p),
        None => get_vellum_documents_dir(&app)?,
    };

    let mut cmd = std::process::Command::new("open");
    if target.is_file() {
        cmd.arg("-R");
    }
    cmd.arg(target);
    cmd.spawn().map_err(|e| format!("Failed to open Finder: {}", e))?;
    Ok(true)
}

#[tauri::command]
fn get_cli_file_arg() -> Result<Option<String>, String> {
    for arg in std::env::args().skip(1) {
        if arg.ends_with(".vellum") {
            let p = PathBuf::from(&arg);
            if p.is_file() {
                if let Ok(content) = fs::read_to_string(&p) {
                    return Ok(Some(content));
                }
            }
        }
    }
    Ok(None)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(DbState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            init_database,
            list_projects,
            get_project,
            save_project,
            delete_project,
            duplicate_project,
            get_documents_vellum_dir,
            save_document_to_vellum_folder,
            list_documents_vellum_files,
            read_document_file,
            reveal_in_finder,
            get_cli_file_arg
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Vellum desktop application");
}
