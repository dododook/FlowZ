/**
 * dns-route-events.isDnsReconcileTriggerLine 纯函数单测（T2d）。
 * 覆盖：各 RTM_ 触发类型 → true；噪音/统计/明细/无关 RTM → false；空行/畸形/非字符串 → false（不抛）。
 * 行样本仿真实 macOS `route -n monitor` 输出（消息头 + RTM_ 行 + 缩进明细行）。
 */

import { isDnsReconcileTriggerLine } from '../dns-route-events';

describe('isDnsReconcileTriggerLine — 触发类型命中', () => {
  it.each([
    ['RTM_IFINFO: iface status change', 'RTM_IFINFO 接口 up/down'],
    ['RTM_NEWADDR: address being added to iface', 'RTM_NEWADDR 地址新增'],
    ['RTM_DELADDR: address being removed from iface', 'RTM_DELADDR 地址删除'],
    ['RTM_ADD: Add Route: len 220, route flags<UP,GATEWAY,DONE,STATIC>', 'RTM_ADD 路由新增'],
    ['RTM_DELETE: Delete Route: len 220, route flags<UP,GATEWAY,DONE>', 'RTM_DELETE 路由删除'],
  ])('「%s」(%s) → true', (line) => {
    expect(isDnsReconcileTriggerLine(line)).toBe(true);
  });

  it('带前导空白的触发行仍命中（trim 后判定）', () => {
    expect(isDnsReconcileTriggerLine('   RTM_IFINFO: iface status change')).toBe(true);
  });

  it('带数字后缀的版本变体（RTM_IFINFO2 / RTM_NEWADDR2）前缀命中', () => {
    expect(isDnsReconcileTriggerLine('RTM_IFINFO2: extended iface info')).toBe(true);
    expect(isDnsReconcileTriggerLine('RTM_NEWADDR2: extended addr info')).toBe(true);
  });
});

describe('isDnsReconcileTriggerLine — 噪音/无关 → false', () => {
  it('统计头 "got message of size" → false', () => {
    expect(isDnsReconcileTriggerLine('got message of size 240 on 2026-06-21 10:00:00')).toBe(false);
  });

  it('缩进的地址/标志明细行 → false', () => {
    expect(isDnsReconcileTriggerLine('   default            link#1             UCSg')).toBe(false);
    expect(isDnsReconcileTriggerLine('   sockaddrs: <DST,GATEWAY,NETMASK>')).toBe(false);
    expect(isDnsReconcileTriggerLine('   flags:<UP,GATEWAY,HOST,DONE,STATIC>')).toBe(false);
  });

  it('非触发类型的 RTM_ 消息（RTM_GET/RTM_LOSING/RTM_MISS/RTM_RESOLVE）→ false', () => {
    expect(isDnsReconcileTriggerLine('RTM_GET: Report Metrics: len 240')).toBe(false);
    expect(isDnsReconcileTriggerLine('RTM_LOSING: Kernel Suspects Partitioning: len 240')).toBe(
      false
    );
    expect(isDnsReconcileTriggerLine('RTM_MISS: Lookup failed on this address: len 240')).toBe(
      false
    );
    expect(isDnsReconcileTriggerLine('RTM_RESOLVE: Route created by cloning: len 240')).toBe(false);
  });

  it('RTM_ 出现在行中部（非首 token）不误命中', () => {
    expect(isDnsReconcileTriggerLine('comment mentioning RTM_ADD somewhere')).toBe(false);
  });

  it('前缀相近但非触发类型（RTM_ADDRINFO 不存在；RTM_NEWMADDR 组播地址）按规格判定', () => {
    // RTM_NEWMADDR（组播成员地址）以 RTM_NEW 起但非 RTM_NEWADDR 前缀 → 不命中。
    expect(isDnsReconcileTriggerLine('RTM_NEWMADDR: multicast group membership: len 152')).toBe(
      false
    );
    expect(isDnsReconcileTriggerLine('RTM_DELMADDR: multicast group membership: len 152')).toBe(
      false
    );
  });
});

describe('isDnsReconcileTriggerLine — 空/畸形/非字符串 → false（不抛）', () => {
  it.each([
    ['', '空字符串'],
    ['   ', '纯空白'],
    ['\n', '纯换行'],
    ['random garbage line', '无关文本'],
    [':::::', '只有分隔符'],
  ])('「%s」(%s) → false', (line) => {
    expect(isDnsReconcileTriggerLine(line)).toBe(false);
  });

  it('非字符串入参（null/undefined/number/object）→ false 且不抛', () => {
    // 防御越界（stdout 解析理论恒给 string，但纯函数须对脏输入鲁棒）。
    expect(isDnsReconcileTriggerLine(null as unknown as string)).toBe(false);
    expect(isDnsReconcileTriggerLine(undefined as unknown as string)).toBe(false);
    expect(isDnsReconcileTriggerLine(123 as unknown as string)).toBe(false);
    expect(isDnsReconcileTriggerLine({} as unknown as string)).toBe(false);
  });
});
