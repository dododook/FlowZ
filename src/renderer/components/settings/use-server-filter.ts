/**
 * 节点搜索/过滤/排序 hook —— 从 server-list.tsx 下沉（审计 §1 Tier-1，纯逻辑零 JSX）。
 * 封 searchQuery/filterProtocol/sortKey/sortOrder 四态 + availableProtocols/filteredServers 两个 useMemo
 * + 「当前协议筛选已不存在则回落 all」的 useEffect。memo/effect 依赖数组与原 god-component 逐字一致。
 */
import { useState, useMemo, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { getSortedProtocolOptions } from './shared/protocol-options';
import type { ServerConfigWithId, SortKey, SortOrder } from './server-list-helpers';

export function useServerFilter(servers: ServerConfigWithId[], latencyMap: Record<string, number>) {
  const { t, i18n } = useTranslation();

  // 搜索 / 过滤 / 排序
  const [searchQuery, setSearchQuery] = useState('');
  const [filterProtocol, setFilterProtocol] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

  // 过滤 + 排序
  // 协议筛选项按【当前分组实际存在的协议】动态生成：订阅组不再列 WG/WARP/Tailscale 等不可能出现的协议，
  // 自建/组网组也各只列自己有的——降低无意义选项的理解成本。顺序经 getSortedProtocolOptions 按显示名 locale 排序、custom 置末。
  const availableProtocols = useMemo(() => {
    const present = new Set(servers.map((s) => s.protocol?.toLowerCase()));
    return getSortedProtocolOptions(t, i18n.language, (v) => present.has(v));
  }, [servers, t, i18n.language]);

  // 当前筛选的协议在本组已不存在（切组/订阅更新后）→ 回落 all，避免筛出空列表。
  useEffect(() => {
    if (filterProtocol !== 'all' && !availableProtocols.some((p) => p.value === filterProtocol)) {
      setFilterProtocol('all');
    }
  }, [availableProtocols, filterProtocol]);

  const filteredServers = useMemo(() => {
    let list = servers;

    // 搜索
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.address || '').toLowerCase().includes(q) ||
          s.protocol.toLowerCase().includes(q)
      );
    }

    // 协议过滤
    if (filterProtocol !== 'all') {
      list = list.filter((s) => s.protocol.toLowerCase() === filterProtocol);
    }

    // 排序
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') {
        cmp = a.name.localeCompare(b.name);
      } else if (sortKey === 'protocol') {
        cmp = a.protocol.localeCompare(b.protocol);
      } else if (sortKey === 'address') {
        cmp = (a.address || '').localeCompare(b.address || '');
      } else if (sortKey === 'latency') {
        const getVal = (v: number | undefined) =>
          v === undefined ? Infinity : v === -1 ? Infinity - 1 : v;
        const la = getVal(latencyMap[a.id]);
        const lb = getVal(latencyMap[b.id]);
        cmp = la - lb;
      }
      return sortOrder === 'asc' ? cmp : -cmp;
    });

    return list;
  }, [servers, searchQuery, filterProtocol, sortKey, sortOrder, latencyMap]);

  return {
    searchQuery,
    setSearchQuery,
    filterProtocol,
    setFilterProtocol,
    sortKey,
    setSortKey,
    sortOrder,
    setSortOrder,
    availableProtocols,
    filteredServers,
  };
}
