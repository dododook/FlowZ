# IPC handlers

[English](README.md) · [中文](README.zh-CN.md)

This directory holds the IPC handlers that service requests from the renderer. Each module exports a `registerXxxHandlers(...)` function; `index.ts` wires them up in the main process. Channel names are centralized as constants in [`src/shared/ipc-channels.ts`](../../../shared/ipc-channels.ts) (`IPC_CHANNELS.*`) — that file is the source of truth for exact channel strings.

## Handler modules

| Module | Responsibility |
|---|---|
| `config-handlers.ts` | Read/save user config, proxy mode, get/set individual values |
| `server-handlers.ts` | Parse / add / update / delete nodes, add-from-URL |
| `subscription-handlers.ts` | Import & update subscriptions, scheduling |
| `proxy-handlers.ts` | Start/stop proxy, mode switch, node hot-switch, speed test |
| `rules-handlers.ts` | Custom routing rules CRUD + ordering |
| `rule-resource-handlers.ts` | Rule-set (`.srs`) download / catalog / auto-update |
| `log-handlers.ts` | Get/clear logs, set level, live `event:logReceived` broadcast |
| `system-handlers.ts` | System integration (system proxy, paths, OS bits) |
| `helper-handlers.ts` | Privilege helper install / status |
| `core-update-handlers.ts` | sing-box core update & staging |
| `update-handlers.ts` | App auto-update |
| `version-handlers.ts` | App / core version info |
| `diagnostic-handlers.ts` | Diagnostic report collect / export |
| `ipinfo-handlers.ts` | Exit-IP / geo lookup |
| `privacy-handlers.ts` | Privacy / lightweight mode, password lock |
| `autostart-handlers.ts` | Launch on boot |
| `backup-handlers.ts` | Config backup / restore |

## Registering (main process)

Each module exposes a `registerXxxHandlers(...)`; they're imported and called from `index.ts`. For example:

```typescript
import { registerConfigHandlers, registerServerHandlers, registerLogHandlers /* … */ } from './ipc/handlers';

registerConfigHandlers(configManager);
registerServerHandlers(protocolParser, configManager);
registerLogHandlers(logManager);
// … the remaining registerXxxHandlers
```

## Calling (renderer)

```typescript
const logs = await window.ipcRenderer.invoke('logs:get', { limit: 100 });

window.ipcRenderer.on('event:logReceived', (_event, log) => {
  console.log('New log:', log);
});
```

## Event broadcast

Events (e.g. live logs) use `IpcEventEmitter` to reach every open window:

1. On window creation, `ipcEventEmitter.registerWindow(mainWindow)` registers it.
2. When a service emits (e.g. LogManager's `log` event), the handler calls `broadcastEvent()` to fan out to all windows.
3. The renderer subscribes via `ipcRenderer.on('event:logReceived', …)`.

This supports multi-window scenarios — all windows receive updates in real time. Log events are filtered by the current log level before broadcast.
