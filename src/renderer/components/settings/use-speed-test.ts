/**
 * 节点测速 hook —— 从 server-list.tsx 下沉（审计 §1 Tier-1，纯逻辑零 JSX）。
 * 封 isTestingSpeed/speedProgress/testingServerIds 三态 + 全量/单节点两个 handler。
 * 测速事件订阅在 handleSpeedTest 内声明（try 外），catch/finally 路径均 unsubscribe（防 listener 泄漏，
 * 与原 god-component 行为逐字一致——无独立 useEffect 生命周期，订阅随 handler 起止）。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { isSpeedTestable } from '../../../shared/endpoint-routes';
import type { ServerConfigWithId } from './server-list-helpers';

export function useSpeedTest(servers: ServerConfigWithId[]) {
  const applyLatencyResults = useAppStore((state) => state.applyLatencyResults);
  const { t } = useTranslation();
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [speedProgress, setSpeedProgress] = useState<{
    tested: number;
    ok: number;
    total: number;
  } | null>(null);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());

  const handleSpeedTest = async () => {
    // 排除不可测节点（Tailscale / 自定义 endpoint / reverseMesh）：与 ⚡ 禁用、后端 null 分支同口径
    // （isSpeedTestable 单一真值）。全为不可测则不空跑（toast 提示）。
    const serverIdsToTest = servers.filter(isSpeedTestable).map((s) => s.id);
    if (serverIdsToTest.length === 0) {
      toast.info(t('servers.noTestableNodes'));
      return;
    }
    setIsTestingSpeed(true);
    // per-node 结果监听已上移到 use-native-events 顶层持久 hook（托盘/UI 两入口共用，写全局 latencyMap，跨页不丢）；
    // 此处仅订阅进度（页面局部进度条）+ 末尾兜底同步。订阅声明在 try 外，确保 catch/finally 都能 unsubscribe。
    const unsubscribeProgress = api.server.onSpeedTestProgress(({ tested, ok, total }) => {
      setSpeedProgress({ tested, ok, total });
    });
    // 进度 toast 捕获 id：完成/失败原地替换「开始测速」（声明在 try 外供 catch 引用）。
    const speedToastId = toast.loading(t('servers.speedTestStart'));
    try {
      const results = await api.server.speedTest(serverIdsToTest);
      // 末尾兜底同步（确保最终结果一致，兜底事件丢失）；函数式合并保留未测节点的历史延迟。
      applyLatencyResults(results);
      toast.success(t('servers.speedTestDone'), { id: speedToastId });
      // 不再自动排序（保留用户排序偏好，测速只更新延迟值）
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        id: speedToastId,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unsubscribeProgress();
      setIsTestingSpeed(false);
      setSpeedProgress(null);
    }
  };

  const handleSingleSpeedTest = async (serverId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingServerIds((prev) => {
      const s = new Set(prev);
      s.add(serverId);
      return s;
    });
    try {
      const results = await api.server.speedTest([serverId]);

      // Update only this specific node's latency in the store（函数式合并，避免 stale 覆盖）
      applyLatencyResults(results);

      if (results[serverId] !== undefined) {
        toast.success(t('servers.speedTestDone'));
      }
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setTestingServerIds((prev) => {
        const s = new Set(prev);
        s.delete(serverId);
        return s;
      });
    }
  };

  return {
    isTestingSpeed,
    speedProgress,
    testingServerIds,
    handleSpeedTest,
    handleSingleSpeedTest,
  };
}
