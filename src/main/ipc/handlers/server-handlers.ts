/**
 * 服务器管理 IPC 处理器
 * 处理服务器配置相关的 IPC 请求
 */

import { IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { ServerConfig } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ProtocolParser } from '../../services/ProtocolParser';
import { ConfigManager } from '../../services/ConfigManager';
import { WarpService, type WarpWireGuardDraft } from '../../services/WarpService';
import { getUserDataPath } from '../../utils/paths';

/**
 * 注册服务器管理相关的 IPC 处理器
 */
export function registerServerHandlers(
  protocolParser: ProtocolParser,
  configManager: ConfigManager
): void {
  // 解析协议 URL
  registerIpcHandler<{ url: string }, ServerConfig>(
    IPC_CHANNELS.SERVER_PARSE_URL,
    async (_event: IpcMainInvokeEvent, args: { url: string }) => {
      return protocolParser.parseUrl(args.url);
    }
  );

  // 生成分享 URL
  registerIpcHandler<{ server: ServerConfig }, string>(
    IPC_CHANNELS.SERVER_GENERATE_URL,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      return protocolParser.generateUrl(args.server);
    }
  );

  // 从 URL 添加服务器
  registerIpcHandler<{ url: string; name?: string }, ServerConfig>(
    IPC_CHANNELS.SERVER_ADD_FROM_URL,
    async (_event: IpcMainInvokeEvent, args: { url: string; name?: string }) => {
      // 解析 URL
      const serverConfig = protocolParser.parseUrl(args.url);

      // 如果传入了自定义名称，使用自定义名称
      if (args.name) {
        serverConfig.name = args.name;
      }

      // 设置创建时间和更新时间
      const now = new Date().toISOString();
      serverConfig.createdAt = now;
      serverConfig.updatedAt = now;

      // 加载当前配置
      const config = await configManager.loadConfig();

      // 添加服务器到配置
      config.servers.push(serverConfig);

      // 保存配置
      await configManager.saveConfig(config);

      return serverConfig;
    }
  );

  // 添加服务器
  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_ADD,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      config.servers.push(args.server);
      await configManager.saveConfig(config);
    }
  );

  // 更新服务器
  registerIpcHandler<{ server: ServerConfig }, void>(
    IPC_CHANNELS.SERVER_UPDATE,
    async (_event: IpcMainInvokeEvent, args: { server: ServerConfig }) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.server.id);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.server.id}`);
      }

      config.servers[index] = args.server;
      await configManager.saveConfig(config);
    }
  );

  // 删除服务器
  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.SERVER_DELETE,
    async (_event: IpcMainInvokeEvent, args: { serverId: string }) => {
      const config = await configManager.loadConfig();
      const index = config.servers.findIndex((s) => s.id === args.serverId);

      if (index === -1) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      const removed = config.servers[index];
      config.servers.splice(index, 1);

      // 如果删除的是当前选中的服务器，清除选中状态
      if (config.selectedServerId === args.serverId) {
        config.selectedServerId = null;
      }

      await configManager.saveConfig(config);

      // Tailscale 节点删除 → 清其持久 state 目录 <userData>/tailscale/<id>（best-effort，不阻断删除）。
      if (removed?.protocol?.toLowerCase() === 'tailscale') {
        const stateDir = path.join(getUserDataPath(), 'tailscale', args.serverId);
        await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  );

  // 获取所有服务器
  registerIpcHandler<void, ServerConfig[]>(
    IPC_CHANNELS.SERVER_GET_ALL,
    async (_event: IpcMainInvokeEvent) => {
      const config = await configManager.loadConfig();
      return config.servers;
    }
  );

  // 切换服务器
  registerIpcHandler<{ serverId: string }, void>(
    IPC_CHANNELS.SERVER_SWITCH,
    async (_event: IpcMainInvokeEvent, args: { serverId: string }) => {
      const config = await configManager.loadConfig();
      const server = config.servers.find((s) => s.id === args.serverId);

      if (!server) {
        throw new Error(`服务器不存在: ${args.serverId}`);
      }

      config.selectedServerId = args.serverId;
      await configManager.saveConfig(config);
    }
  );

  // Cloudflare WARP：注册匿名设备 → 返回 WireGuard 草稿（渲染端填表、用户确认后按普通 WG 节点保存）。
  // 不落盘、不存 token；网络/TLS 细节见 WarpService。
  registerIpcHandler<{ licenseKey?: string }, WarpWireGuardDraft>(
    IPC_CHANNELS.WARP_REGISTER,
    async (_event: IpcMainInvokeEvent, args: { licenseKey?: string }) => {
      return new WarpService().register({ licenseKey: args?.licenseKey });
    }
  );
}
