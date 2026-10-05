# ADR 0001: 引入 WindowBoundsManager 统一窗口位置管理

Status: Accepted
Date: 2026-07-21

## Context

Tauri 2 桌面助手的 pet 窗口存在 5 类 bug：启动时位置异常、展开聊天被裁切、拖动后位置失控、启动后看不到、长时间运行后消失。根因是窗口位置管理逻辑分散在 `pet-window.js` 的 4 个函数（`restorePosition`/`initCanvasInteraction`/`resizePetWindow`/`keepExpandedWindowInWorkArea`）中，每个函数各自处理边界但不共享同一份正确逻辑，导致某些路径（如启动恢复、收缩态拖拽）完全没有工作区约束。

## Decision

新增 `desktop/windowBoundsManager.js` 模块，封装 4 个职责（`validatePosition`/`clampToWorkArea`/`persistPosition`/`restorePosition`），所有窗口位置操作（启动恢复、拖拽、展开/收缩、resize）统一走该模块，确保任何路径下窗口位置都在工作区内。

## Consequences

- 正面：5 个 bug 共享同一份正确逻辑，新增路径（如未来多窗口）自动继承约束；可独立单元测试；代码量减少（消除 `keepExpandedWindowInWorkArea` 的重复边界计算）
- 负面/tradeoff：拖拽路径从同步变 async/await，可能引入卡顿 — 缓解：拖拽时用同步 `clampToWorkArea`（缓存上次 workArea），拖拽结束再 async 持久化
- 后续约束：任何新增窗口位置操作必须通过 `WindowBoundsManager`，禁止直接调用 `setPetWindowPosition`/`localStorage.setItem(POS_KEY, ...)`
