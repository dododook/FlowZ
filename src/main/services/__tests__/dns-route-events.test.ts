/**
 * dns-route-events.isDnsReconcileTriggerLine 纯函数单测（T2d）。
 * 覆盖：各 RTM_ 触发类型 → true；噪音/统计/明细/无关 RTM → false；空行/畸形/非字符串 → false（不抛）。
 * 行样本仿真实 macOS `route -n monitor` 输出（消息头 + RTM_ 行 + 缩进明细行）。
 */

import {
  isDnsReconcileTriggerLine,
  isLinuxLinkChangeLine,
  resolveLinkMonitorSpec,
} from '../dns-route-events';

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

describe('isLinuxLinkChangeLine（issue #368）', () => {
  // 样本取自 netns 实测的 `ip -o monitor link addr route` 输出：link/addr/route 三类 + Deleted 前缀变体。
  const REAL_LINES = [
    '2: d0: <BROADCAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc noqueue state UNKNOWN group default \\    link/ether 62:e1:c5:bf:31:76 brd ff:ff:ff:ff:ff:ff',
    '2: d0    inet 10.9.9.2/24 scope global d0\\       valid_lft forever preferred_lft forever',
    'default via 10.9.9.1 dev d0 ',
    'Deleted default via 10.9.9.1 dev d0 ',
    'local 10.9.9.2 dev d0 table local proto kernel scope host src 10.9.9.2 ',
    'Deleted 2: d0    inet6 fe80::60e1:c5ff:febf:3176/64 scope link proto kernel_ll',
  ];

  it.each(REAL_LINES)('实测行命中：%s', (line) => {
    expect(isLinuxLinkChangeLine(line)).toBe(true);
  });

  it('空行 / 纯空白 / 非字符串 → false，且永不抛', () => {
    expect(isLinuxLinkChangeLine('')).toBe(false);
    expect(isLinuxLinkChangeLine('   \t  ')).toBe(false);
    expect(isLinuxLinkChangeLine(undefined as unknown as string)).toBe(false);
    expect(isLinuxLinkChangeLine(null as unknown as string)).toBe(false);
    expect(isLinuxLinkChangeLine(42 as unknown as string)).toBe(false);
  });

  it('macOS 的 RTM_ 判定对这批 Linux 行全部漏判（说明两套判定不可互换）', () => {
    // 反向对照：若未来有人把 Linux 分支误接成 isDnsReconcileTriggerLine，本条会红。
    for (const line of REAL_LINES) {
      expect(isDnsReconcileTriggerLine(line)).toBe(false);
    }
  });
});

describe('resolveLinkMonitorSpec — 三平台分流（issue #368）', () => {
  const noFile = (): boolean => false;
  const hasFile = (): boolean => true;

  it('darwin → route -n monitor + RTM_ 判定，不轮询', () => {
    const spec = resolveLinkMonitorSpec('darwin', noFile);
    expect(spec?.command).toEqual({ file: 'route', args: ['-n', 'monitor'] });
    expect(spec?.isTriggerLine('RTM_IFINFO: x')).toBe(true);
    expect(spec?.pollIntervalMs).toBe(0);
  });

  it('linux → ip -o monitor link addr route + 非空行判定，不轮询', () => {
    const spec = resolveLinkMonitorSpec('linux', noFile);
    expect(spec?.command?.args).toEqual(['-o', 'monitor', 'link', 'addr', 'route']);
    expect(spec?.isTriggerLine('default via 10.9.9.1 dev d0')).toBe(true);
    expect(spec?.pollIntervalMs).toBe(0);
  });

  it('linux：/usr/sbin/ip 存在时取绝对路径（Fedora 等桌面会话 PATH 未必含 /usr/sbin）', () => {
    expect(resolveLinkMonitorSpec('linux', hasFile)?.command?.file).toBe('/usr/sbin/ip');
    expect(resolveLinkMonitorSpec('linux', noFile)?.command?.file).toBe('ip');
  });

  it('win32 → 无命令、走指纹轮询（resume 覆盖不到换网/插拔，不轮询等于该平台没修）', () => {
    const spec = resolveLinkMonitorSpec('win32', noFile);
    expect(spec?.command).toBeNull();
    expect(spec?.pollIntervalMs).toBeGreaterThan(0);
  });

  it.each(['darwin', 'linux'] as const)(
    '%s：事件源死亡后有降级轮询间隔（进程被杀不得静默失效到下次核重启）',
    (platform) => {
      const spec = resolveLinkMonitorSpec(platform, noFile);
      expect(spec?.pollIntervalMs).toBe(0); // 正常态不轮询
      expect(spec?.fallbackPollIntervalMs).toBeGreaterThan(0); // 降级态才轮询
    }
  );

  it('其余平台 → null（既无事件源也无轮询价值）', () => {
    expect(resolveLinkMonitorSpec('freebsd' as NodeJS.Platform, noFile)).toBeNull();
  });

  it('两套行判定不可互换：linux 判定不会被塞进 darwin spec，反之亦然', () => {
    // 反向对照：把 Linux 分支误接成 RTM_ 判定（或反过来）时本条会红。
    const lin = resolveLinkMonitorSpec('linux', noFile);
    const mac = resolveLinkMonitorSpec('darwin', noFile);
    expect(lin?.isTriggerLine('2: d0    inet 10.9.9.2/24 scope global d0')).toBe(true);
    expect(mac?.isTriggerLine('2: d0    inet 10.9.9.2/24 scope global d0')).toBe(false);
  });
});
