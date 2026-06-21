/**
 * Phase 2 按需登录的渲染端共享动作：节点列表「登录」入口 + 表单「立即登录」按钮共用，避免两处重复
 * api 调用 + 结果 toast 逻辑（防漂移）。
 *
 * 调 main 的 tailscale:login（拉起瞬态登录核，自动开浏览器 + 系统通知）→ 据返回 started/reason 给提示：
 *  - started=true：登录进程已起、浏览器已开 → 不额外 toast（系统通知 + 主进程推的可关闭 toast 已足够）。
 *  - alreadyLoggedIn：节点已登录 → 提示无需登录。
 *  - inMainCore：endpoint 已在运行主核里（双写防护）→ 提示已在登录/已就绪。
 *  - alreadyRunning：已有在飞登录 → 提示登录进行中。
 * 登录成功的角标/状态刷新由 EVENT_TAILSCALE_STATUS（api STATUS 流，use-native-events）统一处理，此处不重复。
 */
import { toast } from 'sonner';
import i18n from '../i18n';
import { api } from '@/ipc';
import type { ServerConfig } from '@/bridge/types';
import { openExternal } from '../bridge/api-wrapper';
import { safeHttpUrl } from '../../shared/url';

/**
 * 「需登录」角标点击的统一动作（卡片 / 列表行共用，避免两处各写 URL 取值 + 兜底逻辑）。
 * - 有缓存 AUTH_URL（store.tailscaleAuthUrls[serverId]，always-emit 全量入表）：safeHttpUrl 限定 http(s)
 *   杜绝危险 scheme 后 openExternal 直开登录页（与 use-native-events 的 tsLoginAction 同款）。
 * - 无合法 URL（未 emit / 已被登录成功清掉 / 非法 scheme）：回落 runTailscaleLogin 触发核重发 URL + 自动开浏览器。
 */
export function openTailscaleLogin(server: ServerConfig, authUrl: string | undefined): void {
  const safeUrl = authUrl ? safeHttpUrl(authUrl) : undefined;
  if (safeUrl) {
    void openExternal(safeUrl);
    return;
  }
  void runTailscaleLogin(server);
}

export async function runTailscaleLogin(server: ServerConfig): Promise<void> {
  try {
    const res = await api.server.tailscaleLogin(server);
    if (res.started) return; // 浏览器已开 + 系统通知 + 主进程推 toast，无需再 toast
    switch (res.reason) {
      case 'alreadyLoggedIn':
        toast.info(i18n.t('servers.tsLoginAlready', { name: server.name }));
        break;
      case 'inMainCore':
      case 'alreadyRunning':
        toast.info(i18n.t('servers.tsLoginInProgress', { name: server.name }));
        break;
      default:
        break;
    }
  } catch {
    toast.error(i18n.t('servers.tsLoginFailed', { name: server.name }));
  }
}
