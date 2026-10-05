use chrono::Utc;
use rusqlite::Connection;
use std::sync::Mutex;

pub struct MonitorStore {
    db: Mutex<Connection>,
}

impl MonitorStore {
    pub fn new(data_dir: &std::path::Path) -> Result<Self, String> {
        // Ensure the directory exists
        std::fs::create_dir_all(data_dir).ok();

        let db_path = data_dir.join("monitoring.db");

        // Try opening at the target path first; fall back to temp dir / in-memory DB
        // if the path contains non-ASCII chars that bundled SQLite may reject on Windows.
        let conn = match Connection::open(&db_path) {
            Ok(c) => c,
            Err(e) => {
                // Fallback 1: system temp directory (avoids Tauri dev file-watcher loop)
                let temp_dir = std::env::temp_dir().join("rag-pet");
                std::fs::create_dir_all(&temp_dir).ok();
                if let Ok(c) = Connection::open(temp_dir.join("monitoring.db")) {
                    c
                } else {
                    // Fallback 2: in-memory database (metrics won't persist across restarts)
                    eprintln!("[rag] Failed to open monitoring DB at {:?}: {}, using in-memory DB", db_path, e);
                    Connection::open_in_memory()
                        .map_err(|e2| format!("Failed to open monitoring DB (all fallbacks failed): {}", e2))?
                }
            }
        };

        Self::init_with_conn(conn)
    }

    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Failed to open in-memory DB: {}", e))?;
        Self::init_with_conn(conn)
    }

    fn init_with_conn(conn: Connection) -> Result<Self, String> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS metrics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                cpu_usage REAL,
                memory_usage REAL,
                memory_available INTEGER,
                disk_usage REAL,
                disk_volume TEXT
            );
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                level TEXT NOT NULL,
                category TEXT NOT NULL,
                message TEXT NOT NULL,
                value REAL,
                threshold REAL
            );
            CREATE INDEX IF NOT EXISTS idx_metrics_timestamp ON metrics(timestamp);
            CREATE INDEX IF NOT EXISTS idx_alerts_timestamp ON alerts(timestamp);
            ",
        )
        .map_err(|e| format!("Failed to init monitoring DB: {}", e))?;

        let cutoff = (Utc::now() - chrono::Duration::hours(24)).to_rfc3339();
        conn.execute(
            "DELETE FROM metrics WHERE timestamp < ?1",
            rusqlite::params![cutoff],
        )
        .map_err(|e| format!("Cleanup metrics: {}", e))?;
        conn.execute(
            "DELETE FROM alerts WHERE timestamp < ?1",
            rusqlite::params![cutoff],
        )
        .map_err(|e| format!("Cleanup alerts: {}", e))?;

        Ok(Self {
            db: Mutex::new(conn),
        })
    }

    pub fn record_metric(
        &self,
        cpu: f32,
        memory_used_pct: f32,
        memory_available: u64,
        disk_used_pct: f32,
        disk_volume: &str,
    ) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        db.execute(
            "INSERT INTO metrics (timestamp, cpu_usage, memory_usage, memory_available, disk_usage, disk_volume) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                Utc::now().to_rfc3339(),
                cpu,
                memory_used_pct,
                memory_available as i64,
                disk_used_pct,
                disk_volume
            ],
        )
        .map_err(|e| format!("Insert metric: {}", e))?;
        Ok(())
    }

    pub fn record_alert(&self, alert: &crate::monitoring::thresholds::Alert) -> Result<(), String> {
        let db = self.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        let level_str = match alert.level {
            crate::monitoring::thresholds::AlertLevel::Warning => "warning",
            crate::monitoring::thresholds::AlertLevel::Critical => "critical",
        };
        db.execute(
            "INSERT INTO alerts (timestamp, level, category, message, value, threshold) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![
                alert.timestamp,
                level_str,
                alert.category,
                alert.message,
                alert.value,
                alert.threshold
            ],
        )
        .map_err(|e| format!("Insert alert: {}", e))?;
        Ok(())
    }

    pub fn get_metrics_history(&self, hours: u32) -> Result<Vec<serde_json::Value>, String> {
        let db = self.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        let cutoff = (Utc::now() - chrono::Duration::hours(hours as i64)).to_rfc3339();
        let mut stmt = db
            .prepare(
                "SELECT timestamp, cpu_usage, memory_usage, memory_available, disk_usage, disk_volume 
             FROM metrics WHERE timestamp > ?1 
             ORDER BY timestamp ASC",
            )
            .map_err(|e| format!("Query: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![cutoff], |row| {
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "cpu_usage": row.get::<_, f64>(1)?,
                    "memory_usage": row.get::<_, f64>(2)?,
                    "memory_available": row.get::<_, i64>(3)?,
                    "disk_usage": row.get::<_, f64>(4)?,
                    "disk_volume": row.get::<_, String>(5)?,
                }))
            })
            .map_err(|e| format!("Query map: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(results)
    }

    pub fn get_recent_alerts(&self, limit: u32) -> Result<Vec<serde_json::Value>, String> {
        let db = self.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        let mut stmt = db
            .prepare(
                "SELECT timestamp, level, category, message, value, threshold 
             FROM alerts ORDER BY timestamp DESC LIMIT ?1",
            )
            .map_err(|e| format!("Query: {}", e))?;

        let rows = stmt
            .query_map(rusqlite::params![limit], |row| {
                Ok(serde_json::json!({
                    "timestamp": row.get::<_, String>(0)?,
                    "level": row.get::<_, String>(1)?,
                    "category": row.get::<_, String>(2)?,
                    "message": row.get::<_, String>(3)?,
                    "value": row.get::<_, f64>(4)?,
                    "threshold": row.get::<_, f64>(5)?,
                }))
            })
            .map_err(|e| format!("Query map: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Row: {}", e))?);
        }
        Ok(results)
    }
}
