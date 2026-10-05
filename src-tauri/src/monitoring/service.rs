use crate::adapters::system::SystemAdapter;
use crate::monitoring::store::MonitorStore;
use crate::monitoring::thresholds::{Alert, AlertLevel, Thresholds};
use chrono::Utc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct MonitoringService {
    thresholds: Arc<Mutex<Thresholds>>,
    store: Arc<Mutex<MonitorStore>>,
    running: Arc<Mutex<bool>>,
    // 性能优化：窗口收缩态可暂停轮询，降低 CPU 占用（线程保持存活，仅跳过采集）
    paused: Arc<Mutex<bool>>,
    interval_secs: u64,
}

impl MonitoringService {
    pub fn new(store: MonitorStore) -> Self {
        Self {
            thresholds: Arc::new(Mutex::new(Thresholds::default())),
            store: Arc::new(Mutex::new(store)),
            running: Arc::new(Mutex::new(false)),
            paused: Arc::new(Mutex::new(false)),
            interval_secs: 30,
        }
    }

    pub fn set_thresholds(&self, thresholds: Thresholds) {
        if let Ok(mut t) = self.thresholds.lock() {
            *t = thresholds;
        }
    }

    /// 暂停/恢复硬件监控轮询（线程保持存活，仅跳过采集与告警）
    pub fn set_paused(&self, paused: bool) {
        if let Ok(mut p) = self.paused.lock() {
            *p = paused;
        }
    }

    pub fn start(&self, app: AppHandle) {
        let running = self.running.clone();
        let thresholds = self.thresholds.clone();
        let store = self.store.clone();
        let paused = self.paused.clone();
        let interval = self.interval_secs;

        {
            let r = running.lock().unwrap();
            if *r {
                return;
            }
        }

        {
            let mut r = running.lock().unwrap();
            *r = true;
        }

        thread::spawn(move || {
            let system = SystemAdapter::new();
            let mut last_alert_time: std::collections::HashMap<
                String,
                chrono::DateTime<chrono::Utc>,
            > = std::collections::HashMap::new();
            let alert_cooldown = chrono::Duration::minutes(5);

            while *running.lock().unwrap() {
                // 性能优化：窗口收缩态暂停采集与告警，线程保持存活仅睡眠
                let is_paused = paused.lock().map(|p| *p).unwrap_or(false);
                if is_paused {
                    thread::sleep(Duration::from_secs(interval));
                    continue;
                }

                let cpu = system.get_cpu_usage().ok();
                let memory = system.get_memory_info().ok();
                // 多盘符监控：采集所有已挂载盘符的使用情况
                let disks = system.list_all_disks().ok().unwrap_or_default();
                // 贾维斯拓展：网络速率、温度、GPU 采集（与 CPU/内存/磁盘同周期）
                let network = system.get_network_stats().ok();
                let temperature = system.get_temperature_stats().ok();
                let gpu = system.get_gpu_stats().ok();

                let cpu_pct = cpu
                    .as_ref()
                    .map(|c| c.overall_usage_percent as f32)
                    .unwrap_or(0.0);
                let mem_pct = memory
                    .as_ref()
                    .map(|m| m.used_percentage as f32)
                    .unwrap_or(0.0);
                let mem_avail = memory.as_ref().map(|m| m.available_bytes).unwrap_or(0);
                // 选取使用率最高的盘符作为代表指标记录历史
                let (disk_pct, disk_volume) = disks
                    .iter()
                    .max_by(|a, b| {
                        a.used_percentage
                            .partial_cmp(&b.used_percentage)
                            .unwrap_or(std::cmp::Ordering::Equal)
                    })
                    .map(|d| (d.used_percentage as f32, d.volume.clone()))
                    .unwrap_or((0.0, "C".to_string()));

                // 网络汇总速率（bytes/s → MB/s）
                let net_total_bps = network
                    .as_ref()
                    .map(|n| n.total_receive_speed_bps.saturating_add(n.total_transmit_speed_bps))
                    .unwrap_or(0);
                let net_mbps = (net_total_bps as f64) / (1024.0 * 1024.0);

                // 最高温度传感器读数（°C）
                let max_temp = temperature
                    .as_ref()
                    .and_then(|t| {
                        t.sensors
                            .iter()
                            .map(|s| s.temperature_celsius)
                            .filter(|v| v.is_finite() && *v > 0.0)
                            .fold(None::<f32>, |acc, v| {
                                Some(acc.map_or(v, |m: f32| m.max(v)))
                            })
                    })
                    .unwrap_or(0.0);

                // GPU 状态（仅 NVIDIA 显卡可用）
                let gpu_temp = gpu.as_ref().map(|g| g.temperature_celsius).unwrap_or(0.0);
                let gpu_util = gpu.as_ref().map(|g| g.utilization_percent).unwrap_or(0.0);

                if let Ok(s) = store.lock() {
                    let _ = s.record_metric(cpu_pct, mem_pct, mem_avail, disk_pct, &disk_volume);
                }

                let thresholds = thresholds.lock().unwrap().clone();
                let now = Utc::now();

                if cpu_pct >= thresholds.cpu_critical {
                    if Self::should_alert(&mut last_alert_time, "cpu_critical", now, alert_cooldown)
                    {
                        let alert = Alert {
                            level: AlertLevel::Critical,
                            category: "cpu".into(),
                            message: format!("CPU 使用率严重过高: {:.0}%", cpu_pct),
                            value: cpu_pct,
                            threshold: thresholds.cpu_critical,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                } else if cpu_pct >= thresholds.cpu_warning {
                    if Self::should_alert(&mut last_alert_time, "cpu_warning", now, alert_cooldown)
                    {
                        let alert = Alert {
                            level: AlertLevel::Warning,
                            category: "cpu".into(),
                            message: format!("CPU 使用率较高: {:.0}%", cpu_pct),
                            value: cpu_pct,
                            threshold: thresholds.cpu_warning,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                }

                if mem_pct >= thresholds.memory_critical {
                    if Self::should_alert(&mut last_alert_time, "mem_critical", now, alert_cooldown)
                    {
                        let alert = Alert {
                            level: AlertLevel::Critical,
                            category: "memory".into(),
                            message: format!("内存使用率严重过高: {:.0}%", mem_pct),
                            value: mem_pct,
                            threshold: thresholds.memory_critical,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                } else if mem_pct >= thresholds.memory_warning {
                    if Self::should_alert(&mut last_alert_time, "mem_warning", now, alert_cooldown)
                    {
                        let alert = Alert {
                            level: AlertLevel::Warning,
                            category: "memory".into(),
                            message: format!("内存使用率较高: {:.0}%", mem_pct),
                            value: mem_pct,
                            threshold: thresholds.memory_warning,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                }

                // 多盘符告警：遍历所有盘符，任一盘符超阈值即告警（冷却按盘符独立）
                for disk in &disks {
                    let vol = disk.volume.as_str();
                    let d_pct = disk.used_percentage as f32;
                    if d_pct >= thresholds.disk_critical {
                        let key = format!("disk_critical_{}", vol);
                        if Self::should_alert(&mut last_alert_time, &key, now, alert_cooldown) {
                            let alert = Alert {
                                level: AlertLevel::Critical,
                                category: "disk".into(),
                                message: format!("{} 盘空间严重不足: 已用 {:.0}%", vol, d_pct),
                                value: d_pct,
                                threshold: thresholds.disk_critical,
                                timestamp: now.to_rfc3339(),
                            };
                            Self::emit_alert(&app, &store, &alert);
                        }
                    } else if d_pct >= thresholds.disk_warning {
                        let key = format!("disk_warning_{}", vol);
                        if Self::should_alert(&mut last_alert_time, &key, now, alert_cooldown) {
                            let alert = Alert {
                                level: AlertLevel::Warning,
                                category: "disk".into(),
                                message: format!("{} 盘空间不足: 已用 {:.0}%", vol, d_pct),
                                value: d_pct,
                                threshold: thresholds.disk_warning,
                                timestamp: now.to_rfc3339(),
                            };
                            Self::emit_alert(&app, &store, &alert);
                        }
                    }
                }

                // 温度告警（最高传感器读数对比阈值）
                if max_temp > 0.0 && max_temp >= thresholds.temperature_critical {
                    if Self::should_alert(
                        &mut last_alert_time,
                        "temp_critical",
                        now,
                        alert_cooldown,
                    ) {
                        let alert = Alert {
                            level: AlertLevel::Critical,
                            category: "temperature".into(),
                            message: format!("温度严重过高: {:.1}°C", max_temp),
                            value: max_temp,
                            threshold: thresholds.temperature_critical,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                } else if max_temp > 0.0 && max_temp >= thresholds.temperature_warning {
                    if Self::should_alert(
                        &mut last_alert_time,
                        "temp_warning",
                        now,
                        alert_cooldown,
                    ) {
                        let alert = Alert {
                            level: AlertLevel::Warning,
                            category: "temperature".into(),
                            message: format!("温度较高: {:.1}°C", max_temp),
                            value: max_temp,
                            threshold: thresholds.temperature_warning,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                }

                // 网络持续高吞吐告警（MB/s）
                if net_mbps >= thresholds.network_critical as f64 {
                    if Self::should_alert(
                        &mut last_alert_time,
                        "net_critical",
                        now,
                        alert_cooldown,
                    ) {
                        let alert = Alert {
                            level: AlertLevel::Critical,
                            category: "network".into(),
                            message: format!("网络持续高吞吐: {:.1} MB/s", net_mbps),
                            value: net_mbps as f32,
                            threshold: thresholds.network_critical,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                } else if net_mbps >= thresholds.network_warning as f64 {
                    if Self::should_alert(
                        &mut last_alert_time,
                        "net_warning",
                        now,
                        alert_cooldown,
                    ) {
                        let alert = Alert {
                            level: AlertLevel::Warning,
                            category: "network".into(),
                            message: format!("网络吞吐较高: {:.1} MB/s", net_mbps),
                            value: net_mbps as f32,
                            threshold: thresholds.network_warning,
                            timestamp: now.to_rfc3339(),
                        };
                        Self::emit_alert(&app, &store, &alert);
                    }
                }

                // GPU 告警（仅 NVIDIA 显卡；非 NVIDIA 显卡时 gpu 为 None，跳过告警）
                if let Some(gpu_info) = &gpu {
                    if gpu_temp >= thresholds.gpu_temperature_critical {
                        if Self::should_alert(
                            &mut last_alert_time,
                            "gpu_temp_critical",
                            now,
                            alert_cooldown,
                        ) {
                            let alert = Alert {
                                level: AlertLevel::Critical,
                                category: "gpu_temperature".into(),
                                message: format!(
                                    "GPU 温度严重过高: {:.0}°C ({})",
                                    gpu_temp, gpu_info.name
                                ),
                                value: gpu_temp,
                                threshold: thresholds.gpu_temperature_critical,
                                timestamp: now.to_rfc3339(),
                            };
                            Self::emit_alert(&app, &store, &alert);
                        }
                    } else if gpu_temp >= thresholds.gpu_temperature_warning {
                        if Self::should_alert(
                            &mut last_alert_time,
                            "gpu_temp_warning",
                            now,
                            alert_cooldown,
                        ) {
                            let alert = Alert {
                                level: AlertLevel::Warning,
                                category: "gpu_temperature".into(),
                                message: format!(
                                    "GPU 温度较高: {:.0}°C ({})",
                                    gpu_temp, gpu_info.name
                                ),
                                value: gpu_temp,
                                threshold: thresholds.gpu_temperature_warning,
                                timestamp: now.to_rfc3339(),
                            };
                            Self::emit_alert(&app, &store, &alert);
                        }
                    }

                    if gpu_util >= thresholds.gpu_utilization_critical {
                        if Self::should_alert(
                            &mut last_alert_time,
                            "gpu_util_critical",
                            now,
                            alert_cooldown,
                        ) {
                            let alert = Alert {
                                level: AlertLevel::Critical,
                                category: "gpu_utilization".into(),
                                message: format!(
                                    "GPU 利用率严重过高: {:.0}% ({})",
                                    gpu_util, gpu_info.name
                                ),
                                value: gpu_util,
                                threshold: thresholds.gpu_utilization_critical,
                                timestamp: now.to_rfc3339(),
                            };
                            Self::emit_alert(&app, &store, &alert);
                        }
                    }
                }

                thread::sleep(Duration::from_secs(interval));
            }
        });
    }

    pub fn stop(&self) {
        if let Ok(mut r) = self.running.lock() {
            *r = false;
        }
    }

    fn should_alert(
        last_alert_time: &mut std::collections::HashMap<String, chrono::DateTime<chrono::Utc>>,
        key: &str,
        now: chrono::DateTime<chrono::Utc>,
        cooldown: chrono::Duration,
    ) -> bool {
        if let Some(last) = last_alert_time.get(key) {
            if now - *last < cooldown {
                return false;
            }
        }
        last_alert_time.insert(key.to_string(), now);
        true
    }

    fn emit_alert(app: &AppHandle, store: &Arc<Mutex<MonitorStore>>, alert: &Alert) {
        if let Ok(s) = store.lock() {
            let _ = s.record_alert(alert);
        }
        let _ = app.emit("monitor-alert", alert);
    }
}
