# IPC 处理器

[English](README.md) · [中文](README.zh-CN.md)

本目录包含所有 IPC 处理器，用于处理渲染进程发来的请求。每个模块导出一个 `registerXxxHandlers(...)` 函数，由 `index.ts` 在主进程统一装配。通道名集中定义为常量 [`src/shared/ipc-channels.ts`](../../../shared/ipc-channels.ts)（`IPC_CHANNELS.*`）——该文件是精确通道字符串的单一真值。

## 处理器模块

| 模块 | 职责 |
|---|---|
| `config-handlers.ts` | 读/存用户配置、代理模式、单项值的 get/set |
| `server-handlers.ts` | 节点解析 / 增 / 改 / 删、从 URL 添加 |
| `subscription-handlers.ts` | 订阅导入与更新、调度 |
| `proxy-handlers.ts` | 启停代理、模式切换、节点热切、测速 |
| `rules-handlers.ts` | 自定义路由规则 CRUD + 排序 |
| `rule-resource-handlers.ts` | 规则集（`.srs`）下载 / catalog / 自动更新 |
| `log-handlers.ts` | 获取/清空日志、设级别、实时 `event:logReceived` 广播 |
| `system-handlers.ts` | 系统集成（系统代理、路径、OS 相关） |
| `helper-handlers.ts` | 提权 helper 安装 / 状态 |
| `core-update-handlers.ts` | sing-box 内核更新与暂存 |
| `update-handlers.ts` | 应用自动更新 |
| `version-handlers.ts` | 应用 / 内核版本信息 |
| `diagnostic-handlers.ts` | 诊断报告采集 / 导出 |
| `ipinfo-handlers.ts` | 出口 IP / geo 查询 |
| `privacy-handlers.ts` | 隐私 / 轻量模式、密码锁 |
| `autostart-handlers.ts` | 开机自启 |
| `backup-handlers.ts` | 配置备份 / 恢复 |

## 注册（主进程）

每个模块导出 `registerXxxHandlers(...)`，在 `index.ts` 统一 import 并调用。示例：

```typescript
import { registerConfigHandlers, registerServerHandlers, registerLogHandlers /* … */ } from './ipc/handlers';

registerConfigHandlers(configManager);
registerServerHandlers(protocolParser, configManager);
registerLogHandlers(logManager);
// … 其余 registerXxxHandlers
```

## 调用（渲染进程）

```typescript
const logs = await window.ipcRenderer.invoke('logs:get', { limit: 100 });

window.ipcRenderer.on('event:logReceived', (_event, log) => {
  console.log('New log:', log);
});
```

## 事件广播机制

事件（如实时日志）使用 `IpcEventEmitter` 广播到每个打开的窗口：

1. 窗口创建时，通过 `ipcEventEmitter.registerWindow(mainWindow)` 注册。
2. 服务触发事件时（如 LogManager 的 `log` 事件），处理器调用 `broadcastEvent()` 扇出到所有窗口。
3. 渲染进程通过 `ipcRenderer.on('event:logReceived', …)` 订阅。

支持多窗口场景，所有窗口实时收到更新。日志事件广播前会按当前日志级别过滤。
