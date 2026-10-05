use chrono::Utc;
use serde::Serialize;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use sysinfo::{ProcessesToUpdate, System};

#[derive(Debug, Serialize, Clone)]
pub struct DiskUsage {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub used_percentage: f64,
    pub volume: String,
    pub sampled_at: String,
}

/// GPU 状态 — 通过 nvidia-smi 采集（仅支持 NVIDIA 显卡）
/// 非 NVIDIA 显卡（Intel/AMD 集显）返回错误，前端容错处理
#[derive(Debug, Serialize, Clone)]
pub struct GpuStats {
    pub name: String,
    pub temperature_celsius: f32,
    pub utilization_percent: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub sampled_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct CpuInfo {
    pub overall_usage_percent: f32,
    pub core_count: usize,
    pub per_core: Vec<u8>,
    pub sampled_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct MemoryInfo {
    pub total_bytes: u64,
    pub available_bytes: u64,
    pub used_bytes: u64,
    pub used_percentage: f64,
    pub sampled_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct ProcessInfo {
    pub pid: u32,
    pub name: String,
    pub cpu_usage: f32,
    pub memory_bytes: u64,
    pub command: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SystemStats {
    pub cpu: CpuInfo,
    pub memory: MemoryInfo,
}

/// 单个网络接口的实时速率
#[derive(Debug, Serialize, Clone)]
pub struct NetworkInterface {
    pub name: String,
    pub received_bytes: u64,
    pub transmitted_bytes: u64,
    /// 采样窗口内计算出的下行速率（字节/秒）
    pub receive_speed_bps: u64,
    /// 上行速率（字节/秒）
    pub transmit_speed_bps: u64,
}

#[derive(Debug, Serialize, Clone)]
pub struct NetworkStats {
    pub interfaces: Vec<NetworkInterface>,
    /// 所有接口汇总下行速率（字节/秒）
    pub total_receive_speed_bps: u64,
    pub total_transmit_speed_bps: u64,
    pub sampled_at: String,
}

/// 单个温度传感器读数
#[derive(Debug, Serialize, Clone)]
pub struct TemperatureReading {
    pub label: String,
    pub temperature_celsius: f32,
    pub max_celsius: Option<f32>,
    pub critical_celsius: Option<f32>,
}

#[derive(Debug, Serialize, Clone)]
pub struct TemperatureStats {
    pub sensors: Vec<TemperatureReading>,
    pub sampled_at: String,
}

pub struct SystemAdapter {
    system: Mutex<System>,
}

impl SystemAdapter {
    pub fn new() -> Self {
        Self {
            system: Mutex::new(System::new()),
        }
    }

    pub fn get_disk_usage(&self, volume: &str) -> Result<DiskUsage, String> {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let volume_lower = volume.to_lowercase();

        for disk in disks.list() {
            let mount = disk.mount_point().to_string_lossy().to_lowercase();
            if mount.starts_with(&volume_lower) {
                let total = disk.total_space();
                let available = disk.available_space();
                let used = total.saturating_sub(available);
                let used_percentage = if total > 0 {
                    (used as f64 / total as f64) * 100.0
                } else {
                    0.0
                };
                return Ok(DiskUsage {
                    total_bytes: total,
                    available_bytes: available,
                    used_bytes: used,
                    used_percentage,
                    volume: volume.to_string(),
                    sampled_at: Utc::now().to_rfc3339(),
                });
            }
        }

        Err(format!("Disk volume '{}' not found", volume))
    }

    pub fn get_cpu_usage(&self) -> Result<CpuInfo, String> {
        let mut sys = self
            .system
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        sys.refresh_cpu_usage();
        thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_usage();

        let overall = sys.global_cpu_usage().round();
        let core_count = sys.cpus().len();
        let per_core: Vec<u8> = sys
            .cpus()
            .iter()
            .map(|c| c.cpu_usage().round() as u8)
            .collect();

        Ok(CpuInfo {
            overall_usage_percent: overall,
            core_count,
            per_core,
            sampled_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn get_memory_info(&self) -> Result<MemoryInfo, String> {
        let mut sys = self
            .system
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        sys.refresh_memory();

        let total = sys.total_memory();
        let available = sys.available_memory();
        let used = sys.used_memory();
        let used_percentage = if total > 0 {
            (used as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        Ok(MemoryInfo {
            total_bytes: total,
            available_bytes: available,
            used_bytes: used,
            used_percentage,
            sampled_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn get_system_stats(&self) -> Result<SystemStats, String> {
        let cpu = self.get_cpu_usage()?;
        let memory = self.get_memory_info()?;
        Ok(SystemStats { cpu, memory })
    }

    /// 采集网络接口实时速率。
    /// 通过两次采样（间隔 ~200ms）计算字节/秒速率。
    pub fn get_network_stats(&self) -> Result<NetworkStats, String> {
        use sysinfo::Networks;
        let mut nets = Networks::new_with_refreshed_list();
        // 第一次快照
        let snapshot1: Vec<(String, u64, u64)> = nets
            .list()
            .iter()
            .map(|(name, data)| (name.clone(), data.received(), data.transmitted()))
            .collect();
        thread::sleep(Duration::from_millis(200));
        nets.refresh();
        let elapsed = 0.2f64; // 秒

        let mut interfaces = Vec::new();
        let mut total_rx = 0u64;
        let mut total_tx = 0u64;

        for (name, data) in nets.list().iter() {
            let name = name.clone();
            let now_rx = data.received();
            let now_tx = data.transmitted();
            let prev = snapshot1.iter().find(|(n, _, _)| n == &name);
            let (rx_speed, tx_speed) = if let Some((_, p_rx, p_tx)) = prev {
                let rx_delta = now_rx.saturating_sub(*p_rx);
                let tx_delta = now_tx.saturating_sub(*p_tx);
                ((rx_delta as f64 / elapsed) as u64, (tx_delta as f64 / elapsed) as u64)
            } else {
                (0, 0)
            };
            total_rx = total_rx.saturating_add(rx_speed);
            total_tx = total_tx.saturating_add(tx_speed);
            interfaces.push(NetworkInterface {
                name,
                received_bytes: now_rx,
                transmitted_bytes: now_tx,
                receive_speed_bps: rx_speed,
                transmit_speed_bps: tx_speed,
            });
        }

        Ok(NetworkStats {
            interfaces,
            total_receive_speed_bps: total_rx,
            total_transmit_speed_bps: total_tx,
            sampled_at: Utc::now().to_rfc3339(),
        })
    }

    /// 采集温度传感器读数（CPU/主板/磁盘等）。
    pub fn get_temperature_stats(&self) -> Result<TemperatureStats, String> {
        use sysinfo::Components;
        let components = Components::new_with_refreshed_list();
        let sensors = components
            .list()
            .iter()
            .map(|c| TemperatureReading {
                label: c.label().to_string(),
                temperature_celsius: c.temperature(),
                // sysinfo 0.32: max() 返回 f32, critical() 返回 Option<f32>
                max_celsius: Some(c.max()),
                critical_celsius: c.critical(),
            })
            .collect();
        Ok(TemperatureStats {
            sensors,
            sampled_at: Utc::now().to_rfc3339(),
        })
    }

    pub fn list_processes(&self, sort_by: &str, limit: usize) -> Result<Vec<ProcessInfo>, String> {
        let mut sys = self
            .system
            .lock()
            .map_err(|e| format!("Lock error: {}", e))?;
        sys.refresh_processes(ProcessesToUpdate::All, true);

        let mut procs: Vec<ProcessInfo> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcessInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                cpu_usage: p.cpu_usage(),
                memory_bytes: p.memory(),
                command: p
                    .cmd()
                    .iter()
                    .map(|s| s.to_string_lossy().to_string())
                    .collect::<Vec<_>>()
                    .join(" "),
            })
            .collect();

        match sort_by {
            "cpu" => procs.sort_by(|a, b| {
                b.cpu_usage
                    .partial_cmp(&a.cpu_usage)
                    .unwrap_or(std::cmp::Ordering::Equal)
            }),
            _ => procs.sort_by(|a, b| b.memory_bytes.cmp(&a.memory_bytes)),
        }

        procs.truncate(limit);
        Ok(procs)
    }

    /// 查询 GPU 状态 — 通过 nvidia-smi 命令行工具采集。
    /// 仅支持 NVIDIA 显卡；非 NVIDIA 显卡（Intel/AMD 集显）返回错误，
    /// 调用方应容错处理（前端隐藏 GPU 字段、监控跳过 GPU 告警）。
    /// 输出示例: "NVIDIA GeForce RTX 3060, 45, 30, 2048, 8192"
    pub fn get_gpu_stats(&self) -> Result<GpuStats, String> {
        let output = std::process::Command::new("nvidia-smi")
            .args([
                "--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total",
                "--format=csv,noheader,nounits",
            ])
            .output()
            .map_err(|e| format!("nvidia-smi 执行失败: {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // 常见错误：非 NVIDIA 显卡、驱动未安装、nvidia-smi 不在 PATH
            let msg = stderr.trim();
            return Err(if msg.is_empty() {
                "nvidia-smi 执行失败（非 NVIDIA 显卡或驱动未安装）".to_string()
            } else {
                format!("nvidia-smi 错误: {}", msg)
            });
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.lines().next().ok_or("nvidia-smi 无输出")?;
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 5 {
            return Err(format!("nvidia-smi 输出格式异常: {}", line));
        }

        let name = parts[0].to_string();
        let temperature_celsius = parts[1].parse::<f32>()
            .map_err(|e| format!("温度解析失败: {}", e))?;
        let utilization_percent = parts[2].parse::<f32>()
            .map_err(|e| format!("利用率解析失败: {}", e))?;
        // nvidia-smi 默认以 MiB 为单位输出 memory.used/memory.total
        let mem_used_mib = parts[3].parse::<f64>()
            .map_err(|e| format!("显存已用解析失败: {}", e))?;
        let mem_total_mib = parts[4].parse::<f64>()
            .map_err(|e| format!("显存总量解析失败: {}", e))?;

        Ok(GpuStats {
            name,
            temperature_celsius,
            utilization_percent,
            memory_used_bytes: (mem_used_mib * 1024.0 * 1024.0) as u64,
            memory_total_bytes: (mem_total_mib * 1024.0 * 1024.0) as u64,
            sampled_at: Utc::now().to_rfc3339(),
        })
    }

    /// 列出系统中所有已挂载的磁盘盘符及其使用情况。
    /// 用于多盘符监控（替代旧的硬编码 "C:" 单盘符查询）。
    pub fn list_all_disks(&self) -> Result<Vec<DiskUsage>, String> {
        let disks = sysinfo::Disks::new_with_refreshed_list();
        let mut result = Vec::new();

        for disk in disks.list() {
            let total = disk.total_space();
            let available = disk.available_space();
            let used = total.saturating_sub(available);
            let used_percentage = if total > 0 {
                (used as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            // mount_point() 在 Windows 上形如 "C:\"，取首字母作为盘符展示
            let mount = disk.mount_point().to_string_lossy().to_string();
            let volume = mount
                .chars().next()
                .map(|c| c.to_string())
                .unwrap_or_else(|| mount.clone());
            result.push(DiskUsage {
                total_bytes: total,
                available_bytes: available,
                used_bytes: used,
                used_percentage,
                volume,
                sampled_at: Utc::now().to_rfc3339(),
            });
        }

        if result.is_empty() {
            return Err("未检测到任何磁盘".to_string());
        }
        Ok(result)
    }
}

impl Default for SystemAdapter {
    fn default() -> Self {
        Self::new()
    }
}
