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
import { useAppStore } from '@/store/app-store';
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
    // 点「需登录」角标开缓存 URL = 用户显式发起登录 → 标记 initiated，卡片才进「连接中」态（回落分支已内置）。
    useAppStore.getState().setTailscaleLoginInitiated(server.id, true);
    void openExternal(safeUrl);
    return;
  }
  void runTailscaleLogin(server);
}

export async function runTailscaleLogin(server: ServerConfig): Promise<void> {
  // 用户显式发起登录（连接/需登录角标/表单立即登录共用此入口）→ 标记 initiated，卡片状态机才据此进「连接中」，
  // 与主核 always-emit 的 AUTH_URL（非用户发起）区分开。
  useAppStore.getState().setTailscaleLoginInitiated(server.id, true);
  try {
    const res = await api.server.tailscaleLogin(server);
    if (res.started) return; // 浏览器已开 + 系统通知 + 主进程推 toast，无需再 toast
    switch (res.reason) {
      case 'alreadyLoggedIn':
        toast.info(i18n.t('servers.tsLoginAlready', { name: server.name }));
        break;
      case 'inMainCore':
      case 'alreadyRunning': {
        // endpoint 已在运行主核（always-emit）或有在飞瞬态核 → 点「登录」应【重新打开】授权页，而非只弹"进行中"死路。
        // 关键（真机实测 §F.3）：核每会话只生成一份 auth URL、不轮换，STATUS 事件驱动无 ticker → 取消清了 store URL 后
        // 没有帧回填、空窗【无限期】。故优先用 main 回传的 live authURL（取自主核 STATUS 末帧缓存，取消也仍在），回落
        // store 缓存。有则开浏览器 + 回填 store（角标恢复 + 卡片凭 hasAuthUrl 回「连接中」）；无（核刚起首帧未到）才提示。
        const cachedUrl = useAppStore.getState().tailscaleAuthUrls[server.id];
        const url = res.authUrl ?? cachedUrl;
        const safe = url ? safeHttpUrl(url) : undefined;
        if (safe) {
          useAppStore.getState().setTailscaleAuthUrl(server.id, safe);
          void openExternal(safe);
        } else {
          toast.info(i18n.t('servers.tsLoginInProgress', { name: server.name }));
        }
        break;
      }
      default:
        break;
    }
  } catch {
    // F3：登录发起失败 → 回收 initiated，否则残留 initiated=true 会让后续主核 NeedsLogin 帧（缺陷4 填 URL）把卡片
    // 无端推进「连接中」（浏览器从未打开）。非选中节点同样受影响（initiated 不依赖 isSelectedExit）。
    useAppStore.getState().setTailscaleLoginInitiated(server.id, false);
    toast.error(i18n.t('servers.tsLoginFailed', { name: server.name }));
  }
}
