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
  };

  const handleSpeedTest = async () => {
    // 排除不可测节点（Tailscale / 自定义 endpoint / reverseMesh）：与 ⚡ 禁用、后端 null 分支同口径
    // （isSpeedTestable 单一真值）。全为不可测则不空跑（toast 提示）。
    const serverIdsToTest = servers.filter(isSpeedTestable).map((s) => s.id);
    if (serverIdsToTest.length === 0) {
      toast.info(t('servers.noTestableNodes'));
      return;
    }
    setIsTestingSpeed(true);
    // 进度/结果移交聚合 toast 协调器（订 result 事件、去重并集节点进度）；按钮仅「测速中」，不再各自弹 toast。
    beginAggSpeedTest(serverIdsToTest, aggLabels);
    try {
      const results = await api.server.speedTest(serverIdsToTest);
      // 末尾兜底同步（确保最终结果一致，兜底事件丢失）；函数式合并保留未测节点的历史延迟。
      applyLatencyResults(results);
      endAggSpeedTest(false);
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
      const results = await api.server.speedTest([serverId]);
      // Update only this specific node's latency in the store（函数式合并，避免 stale 覆盖）
      applyLatencyResults(results);
      endAggSpeedTest(false);
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
