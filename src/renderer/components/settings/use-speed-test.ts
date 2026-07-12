/**
 * 节点测速 hook —— 从 server-list.tsx 下沉（审计 §1 Tier-1，纯逻辑零 JSX）。
 * 封 isTestingSpeed/testingServerIds 两态 + 全量/单节点两个 handler。进度/结果 toast 移交
 * speed-test-toast 聚合协调器（跨入口/多组去重并集节点进度、单一 toast），按钮仅显「测速中」二态。
 */
import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { api } from '@/ipc/api-client';
import { useAppStore } from '@/store/app-store';
import { isSpeedTestable } from '../../../shared/endpoint-routes';
import { beginAggSpeedTest, endAggSpeedTest } from './speed-test-toast';
import type { ServerConfigWithId } from './server-list-helpers';

export function useSpeedTest(servers: ServerConfigWithId[]) {
  const applyLatencyResults = useAppStore((state) => state.applyLatencyResults);
  const markSpeedTestAttempted = useAppStore((state) => state.markSpeedTestAttempted);
  // §16.1 path-aware：主核池可用（代理运行）才纳入 TS-exit。后端 filter 兜真值——renderer 高估时缺席该 TS，不产假值。
  const proxyRunning = useAppStore((state) => state.connectionStatus?.proxyCore?.running ?? false);
  const { t } = useTranslation();
  const [isTestingSpeed, setIsTestingSpeed] = useState(false);
  const [testingServerIds, setTestingServerIds] = useState<Set<string>>(new Set());

  // 聚合 toast 文案（进度由 speed-test-toast 协调器按已测/并集节点数动态渲染）。
  const aggLabels = {
    running: (tested: number, total: number) =>
      t('servers.speedTestingNodes', {
        tested,
        total,
        defaultValue: '测速中 · {{tested}}/{{total}} 节点',
      }),
    done: t('servers.speedTestDone'),
    fail: t('servers.speedTestFail'),
    interrupted: t('servers.speedTestInterrupted', { defaultValue: '测速中断' }),
    skippedSummary: (n: number) =>
      t('servers.speedTestSkippedSummary', { count: n, defaultValue: '{{count}} 个节点待入池（重启内核后可测）' }),
    interruptedSummary: (tested: number, total: number) =>
      t('servers.speedTestInterruptedSummary', {
        tested,
        total,
        defaultValue: '已完成 {{tested}}/{{total}} 节点，其余保留原值',
      }),
  };

  const handleSpeedTest = async () => {
    // 排除不可测节点（reverseMesh / 自定义 endpoint / 无 exitNode 或未登录 TS）：与 ⚡ 禁用、后端口径同（isSpeedTestable
    // path-aware 单一真值）。TS-exit 仅代理运行（主核池可用）时纳入。全为不可测则不空跑（toast 提示）。
    const serverIdsToTest = servers
      .filter((s) => isSpeedTestable(s, { mainCorePool: proxyRunning }))
      .map((s) => s.id);
    if (serverIdsToTest.length === 0) {
      toast.info(t('servers.noTestableNodes'));
      return;
    }
    // 全量测速发生 → 标记本会话「已尝试测速」：此后不可测节点徽标从「—」转「不支持测速」（解释「为什么它没值」）。
    markSpeedTestAttempted();
    setIsTestingSpeed(true);
    // 进度/结果移交聚合 toast 协调器（订 result 事件、去重并集节点进度）；按钮仅「测速中」，不再各自弹 toast。
    beginAggSpeedTest(serverIdsToTest, aggLabels);
    try {
      const runResult = await api.server.speedTest(serverIdsToTest);
      // 末尾兜底同步（确保最终结果一致，兜底事件丢失）；函数式合并保留未测节点的历史延迟。notInPool 更新徽标信号。
      applyLatencyResults(runResult.results, runResult.notInPool);
      endAggSpeedTest(false, undefined, runResult.outcome, [
        ...runResult.notInPool,
        ...runResult.tsNotReady,
      ]);
      // 不再自动排序（保留用户排序偏好，测速只更新延迟值）
    } catch (error) {
      endAggSpeedTest(true, error instanceof Error ? error.message : String(error));
    } finally {
      setIsTestingSpeed(false);
    }
  };

  const handleSingleSpeedTest = async (serverId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTestingServerIds((prev) => {
      const s = new Set(prev);
      s.add(serverId);
      return s;
    });
    // 单节点也并入聚合 toast（连点多个节点不堆叠终端 toast）；行内 spinner 仍由 testingServerIds 驱动。
    beginAggSpeedTest([serverId], aggLabels);
    try {
      const runResult = await api.server.speedTest([serverId]);
      // Update only this specific node's latency in the store（函数式合并，避免 stale 覆盖）
      applyLatencyResults(runResult.results, runResult.notInPool);
      endAggSpeedTest(false, undefined, runResult.outcome, [
        ...runResult.notInPool,
        ...runResult.tsNotReady,
      ]);
    } catch (error) {
      endAggSpeedTest(true, error instanceof Error ? error.message : String(error));
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
    testingServerIds,
    handleSpeedTest,
    handleSingleSpeedTest,
  };
}
