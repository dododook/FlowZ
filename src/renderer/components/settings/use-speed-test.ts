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
import type { ServerConfigWithId } from './server-list-helpers';

export function useSpeedTest(servers: ServerConfigWithId[]) {
  const setLatencyMap = useAppStore((state) => state.setLatencyMap);
  const { t } = useTranslation();
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [speedProgress, setSpeedProgress] = useState<{
    tested: number;
    ok: number;
    total: number;
  } | null>(null);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());

  const handleSpeedTest = async () => {
    setIsTestingSpeed(true);
    // 订阅声明在 try 外，确保 catch/finally 路径都能 unsubscribe（防 listener 泄漏：测速失败时曾漏清）。
    const unsubscribeResult = api.server.onSpeedTestResult(({ serverId, latency }) => {
      setLatencyMap((prev) => ({ ...prev, [serverId]: latency }));
    });
    const unsubscribeProgress = api.server.onSpeedTestProgress(({ tested, ok, total }) => {
      setSpeedProgress({ tested, ok, total });
    });
    try {
      toast.info(t('servers.speedTestStart'));
      const serverIdsToTest = servers.map((s) => s.id);
      const results = await api.server.speedTest(serverIdsToTest);
      // 末尾兜底同步（确保最终结果一致，兜底事件丢失）；函数式合并保留未测节点的历史延迟。
      setLatencyMap((prev) => ({ ...prev, ...results }));
      toast.success(t('servers.speedTestDone'));
      // 不再自动排序（保留用户排序偏好，测速只更新延迟值）
    } catch (error) {
      toast.error(t('servers.speedTestFail'), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unsubscribeResult();
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
      setLatencyMap((prev) => ({ ...prev, ...results }));

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
