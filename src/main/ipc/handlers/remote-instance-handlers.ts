/**
 * 远程实例（sing-box 1.14 远程控制，P5 Phase2）IPC 处理器：
 *  - OPEN_REMOTE_DASHBOARD：打开远端实例的 /dashboard/（shell.openExternal，复用 Phase1 思路但指远端 URL）。
 *  - TEST_REMOTE_INSTANCE：用 SingBoxApiClient（TLS+Bearer）对远端发一次只读 probe 探活，返回 { ok, error? }。
 *
 * secret 取自 main 侧 config（不经渲染端往返，渲染端从不持明文）。本批仅落「配置 + 客户端 TLS + 打开远端 dashboard +
 * 连通测试」核心闭环；原生页实时镜像远端连接/日志/分组（切 activeInstanceId 后 StatsService 拉远端流）留 TODO（§2.3）。
 */
import { shell } from 'electron';
import { IPC_CHANNELS } from '../../../shared/ipc-channels';
import type { RemoteInstance } from '../../../shared/types';
import { registerIpcHandler } from '../ipc-handler';
import { ConfigManager } from '../../services/ConfigManager';
import { SingBoxApiClient } from '../../services/singbox-api-client';

/** 远端 dashboard URL：显式 dashboardUrl 优先；否则按 tls 选 https/http + host:port + /dashboard/。 */
export function deriveRemoteDashboardUrl(inst: RemoteInstance): string {
  if (typeof inst.dashboardUrl === 'string' && inst.dashboardUrl.trim() !== '') {
    return inst.dashboardUrl.trim();
  }
  const scheme = inst.tls ? 'https' : 'http';
  return `${scheme}://${inst.host}:${inst.port}/dashboard/`;
}

function findInstance(configManager: ConfigManager, id: string): RemoteInstance | undefined {
  const list = configManager.get<RemoteInstance[]>('remoteInstances') || [];
  return list.find((i) => i.id === id);
}

export function registerRemoteInstanceHandlers(configManager: ConfigManager): void {
  // 打开远端 dashboard：据 instanceId 取该实例配置，推 URL，shell.openExternal。
  registerIpcHandler<{ instanceId: string }, { ok: boolean; error?: string }>(
    IPC_CHANNELS.OPEN_REMOTE_DASHBOARD,
    async (_event, args) => {
      const inst = findInstance(configManager, args?.instanceId || '');
      if (!inst) return { ok: false, error: 'instance not found' };
      try {
        await shell.openExternal(deriveRemoteDashboardUrl(inst));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  );

  // 远端连通测试：构造 TLS+Bearer 客户端，probe 一次（只读，5s 超时），返回结果。secret 取自 main config。
  registerIpcHandler<{ instanceId: string }, { ok: boolean; error?: string }>(
    IPC_CHANNELS.TEST_REMOTE_INSTANCE,
    async (_event, args) => {
      const inst = findInstance(configManager, args?.instanceId || '');
      if (!inst) return { ok: false, error: 'instance not found' };
      const client = new SingBoxApiClient(
        { host: inst.host, port: inst.port, tls: inst.tls },
        inst.secret || ''
      );
      try {
        await client.probe();
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
  );
}
