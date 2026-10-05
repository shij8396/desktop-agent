use chrono::{DateTime, FixedOffset, Utc};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use walkdir::WalkDir;

#[derive(Debug, Serialize, Clone)]
pub struct FileInfo {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub modified_at: Option<String>,
    pub file_type: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SearchResult {
    pub results: Vec<FileInfo>,
    pub total_found: usize,
    pub truncated: bool,
}

pub struct FilesystemAdapter;

impl FilesystemAdapter {
    pub fn new() -> Self {
        Self
    }

    fn resolve_scope(scope: &str) -> Option<PathBuf> {
        match scope.to_lowercase().as_str() {
            "desktop" => dirs::desktop_dir(),
            "documents" => dirs::document_dir(),
            "downloads" => dirs::download_dir(),
            "home" => dirs::home_dir(),
            _ => {
                let p = PathBuf::from(scope);
                if p.is_absolute() {
                    Some(p)
                } else {
                    None
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn search(
        &self,
        scope: Vec<String>,
        query: Option<String>,
        modified_after: Option<String>,
        modified_before: Option<String>,
        file_types: Vec<String>,
        max_results: usize,
    ) -> Result<SearchResult, String> {
        let after: Option<DateTime<FixedOffset>> = modified_after
            .as_deref()
            .map(|s| {
                DateTime::parse_from_rfc3339(s)
                    .map_err(|e| format!("Invalid modified_after '{}': {}", s, e))
            })
            .transpose()?;
        let before: Option<DateTime<FixedOffset>> = modified_before
            .as_deref()
            .map(|s| {
                DateTime::parse_from_rfc3339(s)
                    .map_err(|e| format!("Invalid modified_before '{}': {}", s, e))
            })
            .transpose()?;
        let query_lower = query.as_deref().map(|q| q.to_lowercase());
        let file_types_lower: Vec<String> = file_types.iter().map(|t| t.to_lowercase()).collect();
        let file_type_filter_active = !file_types_lower.is_empty();

        let mut results: Vec<FileInfo> = Vec::new();

        for scope_name in &scope {
            let scope_path = match Self::resolve_scope(scope_name) {
                Some(p) => p,
                None => continue,
            };
            if !scope_path.exists() {
                continue;
            }

            for entry in WalkDir::new(&scope_path)
                .max_depth(10)
                .follow_links(false)
                .into_iter()
                .filter_entry(|e| !e.file_name().to_string_lossy().starts_with('.'))
            {
                let entry = match entry {
                    Ok(e) => e,
                    Err(_) => continue,
                };

                let metadata = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                if !metadata.is_file() {
                    continue;
                }

                let path = entry.path();
                let name = entry.file_name().to_string_lossy().to_string();
                let name_lower = name.to_lowercase();

                if let Some(q) = &query_lower {
                    if !name_lower.contains(q) {
                        continue;
                    }
                }

                let ext = path
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_default();
                if file_type_filter_active && !file_types_lower.contains(&ext) {
                    continue;
                }

                let modified_opt = metadata.modified().ok();
                let modified_dt: Option<DateTime<Utc>> = modified_opt.map(|t| t.into());

                if let (Some(dt), Some(after)) = (modified_dt, after) {
                    if dt < after.with_timezone(&Utc) {
                        continue;
                    }
                }
                if let (Some(dt), Some(before)) = (modified_dt, before) {
                    if dt > before.with_timezone(&Utc) {
                        continue;
                    }
                }

                let modified_at = modified_dt.map(|dt| dt.to_rfc3339());
                let size = metadata.len();

                results.push(FileInfo {
                    path: path.to_string_lossy().to_string(),
                    name,
                    size_bytes: size,
                    modified_at,
                    file_type: ext,
                });

                if results.len() >= max_results {
                    break;
                }
            }
        }

        let total_found = results.len();
        let truncated = total_found >= max_results && total_found > 0;
        Ok(SearchResult {
            results,
            total_found,
            truncated,
        })
    }

    pub fn list_recent_files(
        &self,
        scope: Vec<String>,
        hours: u32,
    ) -> Result<Vec<FileInfo>, String> {
        let now = Utc::now();
        let cutoff = now - chrono::Duration::hours(hours as i64);
        let cutoff_str = cutoff.to_rfc3339();
        let res = self.search(scope, None, Some(cutoff_str), None, Vec::new(), 50)?;
        Ok(res.results)
    }

    pub fn list_directory(&self, path: String) -> Result<Vec<FileInfo>, String> {
        let path_buf = PathBuf::from(&path);
        let mut results = Vec::new();

        let entries = fs::read_dir(&path_buf)
            .map_err(|e| format!("Failed to read directory '{}': {}", path, e))?;

        for entry in entries {
            let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
            let metadata = entry
                .metadata()
                .map_err(|e| format!("Failed to read metadata: {}", e))?;
            let file_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let size = metadata.len();
            let modified_at = metadata.modified().ok().map(|t| {
                let dt: DateTime<Utc> = t.into();
                dt.to_rfc3339()
            });
            let file_type = file_path
                .extension()
                .map(|e| e.to_string_lossy().to_lowercase())
                .unwrap_or_default();

            results.push(FileInfo {
                path: file_path.to_string_lossy().to_string(),
                name,
                size_bytes: size,
                modified_at,
                file_type,
            });
        }

        Ok(results)
    }
}

impl Default for FilesystemAdapter {
    fn default() -> Self {
        Self::new()
    }
}
