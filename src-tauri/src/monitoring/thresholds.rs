use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Thresholds {
    pub cpu_warning: f32,
    pub cpu_critical: f32,
    pub memory_warning: f32,
    pub memory_critical: f32,
    pub disk_warning: f32,
    pub disk_critical: f32,
    /// 温度告警阈值（摄氏度）
    pub temperature_warning: f32,
    pub temperature_critical: f32,
    /// 网络速率告警阈值（MB/s，汇总上下行）
    pub network_warning: f32,
    pub network_critical: f32,
    /// GPU 温度告警阈值（摄氏度）— 仅 NVIDIA 显卡有效
    pub gpu_temperature_warning: f32,
    pub gpu_temperature_critical: f32,
    /// GPU 利用率告警阈值（百分比）
    pub gpu_utilization_critical: f32,
}

impl Default for Thresholds {
    fn default() -> Self {
        Self {
            cpu_warning: 70.0,
            cpu_critical: 90.0,
            memory_warning: 75.0,
            memory_critical: 90.0,
            disk_warning: 85.0,
            disk_critical: 95.0,
            // 典型 CPU 高温阈值
            temperature_warning: 70.0,
            temperature_critical: 85.0,
            // 网络持续高吞吐告警（MB/s）
            network_warning: 50.0,
            network_critical: 200.0,
            // GPU 高温告警（典型 NVIDIA 显卡阈值）
            gpu_temperature_warning: 75.0,
            gpu_temperature_critical: 90.0,
            // GPU 持续高利用率告警
            gpu_utilization_critical: 95.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub level: AlertLevel,
    pub category: String,
    pub message: String,
    pub value: f32,
    pub threshold: f32,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AlertLevel {
    Warning,
    Critical,
}
