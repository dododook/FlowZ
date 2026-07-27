/**
 * issue #324 P0-2：TUN 地址冲突避让纯逻辑。
 *
 * 变异逃逸面（每条都必须有测试杀掉）：
 *  - 候选池只试第一个、不迭代
 *  - 与本机网段的相交判定反向
 *  - fail-open 改成 fail-closed（探测不可用就换地址/阻断——会把杀软拦 PowerShell 的机器全部拖下水，
 *    是本模块最危险的逃逸）
 *  - 确证冲突后仍返回原地址
 */
import {
  pickTunInet4Address,
  ipv4InInterfaceMap,
  excludeOwnTunCidrs,
  TUN_INET4_CANDIDATES,
  type AddressUsage,
} from '../tun-address';

/** 按 IP → 状态表造 probe；未列出的一律 free。 */
const probeFrom =
  (table: Record<string, AddressUsage>) =>
  (ip: string): Promise<AddressUsage> =>
    Promise.resolve(table[ip] ?? 'free');

const noLan = (): string[] => [];

describe('pickTunInet4Address', () => {
  it('默认地址空闲 → 用默认，不换', () => {
    return pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({}),
      ownLanCidrs: noLan,
    }).then((pick) => {
      expect(pick.address).toBe('172.19.0.1');
      expect(pick.reason).toBe('default');
      expect(pick.skipped).toEqual([]);
    });
  });

  it('#324 现场：默认地址被占用 → 换到下一个候选', async () => {
    // 变异守卫：候选池只试第一个不迭代 → 返回 172.19.0.1，本例失败。
    //          确证冲突后仍返回原地址 → 同样失败。
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({ '172.19.0.1': 'in-use' }),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe('172.20.0.1');
    expect(pick.reason).toBe('fallback');
    expect(pick.skipped).toEqual([{ address: '172.19.0.1', cause: 'in-use' }]);
  });

  it('连撞多个 → 一直往后找', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({ '172.19.0.1': 'in-use', '172.20.0.1': 'in-use' }),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe('172.31.0.1');
    expect(pick.skipped.map((s) => s.address)).toEqual(['172.19.0.1', '172.20.0.1']);
  });

  it('候选落在本机接口网段内 → 跳过（不能把 TUN 地址放进物理 LAN 段）', async () => {
    // 变异守卫：相交判定反向 → 会跳过所有不相交的候选、选中相交的那个，本例失败。
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({}),
      ownLanCidrs: () => ['172.19.0.5/24'],
    });
    expect(pick.address).toBe('172.20.0.1');
    expect(pick.skipped).toEqual([{ address: '172.19.0.1', cause: 'own-lan' }]);
  });

  it('本机网段不相交时不误伤', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({}),
      ownLanCidrs: () => ['192.168.1.7/24', 'fe80::1/64'],
    });
    expect(pick.address).toBe('172.19.0.1');
    expect(pick.reason).toBe('default');
  });

  it('探测链路不可用（杀软拦 PowerShell）→ fail-open 沿用默认，绝不换地址', async () => {
    // 变异守卫：把 unknown 当 in-use（fail-closed）→ 会换到 172.20.0.1，本例失败。
    // 这是本模块最危险的逃逸：换地址会让用户钉着旧地址的路由/防火墙规则失效，而 unknown 根本没证据说明冲突。
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: () => Promise.resolve('unknown' as AddressUsage),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe('172.19.0.1');
    expect(pick.reason).toBe('default-unverified');
  });

  it('默认已确证冲突、备选探不了 → 继续找能确证的，不落在未知地址上', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: (ip) =>
        Promise.resolve(ip === '172.19.0.1' ? 'in-use' : ip === '172.20.0.1' ? 'unknown' : 'free'),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe('172.31.0.1');
    expect(pick.reason).toBe('fallback');
  });

  it('候选池全军覆没 → 回落默认（绝不阻断启动）', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: () => Promise.resolve('in-use' as AddressUsage),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe(TUN_INET4_CANDIDATES[0]);
    expect(pick.reason).toBe('exhausted');
    expect(pick.skipped).toHaveLength(TUN_INET4_CANDIDATES.length);
  });

  it('ownLanCidrs 抛错 → 不阻断启动，按无约束继续', async () => {
    // 变异守卫：去掉内部 try/catch → 异常穿透到 startInternal，整个代理起不来。拿诊断增强换掉代理可用性
    // 是本次改动最不可接受的回归。
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: probeFrom({}),
      ownLanCidrs: () => {
        throw new Error('boom');
      },
    });
    expect(pick.address).toBe('172.19.0.1');
    expect(pick.reason).toBe('default');
  });

  it('probe 抛错 → 按 unknown 处理（fail-open），同样不阻断', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      probe: () => Promise.reject(new Error('powershell missing')),
      ownLanCidrs: noLan,
    });
    expect(pick.address).toBe('172.19.0.1');
    expect(pick.reason).toBe('default-unverified');
  });

  it('候选池首项恒为历史默认地址（换掉它=改变所有正常机器的行为）', () => {
    expect(TUN_INET4_CANDIDATES[0]).toBe('172.19.0.1');
  });
});

describe('ipv4InInterfaceMap', () => {
  it("Node ≥18 的 family='IPv4' 能命中", () => {
    expect(
      ipv4InInterfaceMap('172.19.0.1', { eth0: [{ family: 'IPv4', address: '172.19.0.1' }] })
    ).toBe(true);
  });

  it('旧版 Node 的 family=4 同样能命中', () => {
    // 变异守卫：只认其中一种 → 换运行时后探测恒返回「未占用」，冲突预检静默变成摆设（不报错、不生效）。
    expect(ipv4InInterfaceMap('172.19.0.1', { eth0: [{ family: 4, address: '172.19.0.1' }] })).toBe(
      true
    );
  });

  it('IPv6 同串不误命中', () => {
    expect(
      ipv4InInterfaceMap('172.19.0.1', { eth0: [{ family: 'IPv6', address: '172.19.0.1' }] })
    ).toBe(false);
  });

  it('地址不同 → false；空表 → false；undefined 项不炸', () => {
    expect(
      ipv4InInterfaceMap('172.19.0.1', { eth0: [{ family: 'IPv4', address: '10.0.0.5' }] })
    ).toBe(false);
    expect(ipv4InInterfaceMap('172.19.0.1', {})).toBe(false);
    expect(ipv4InInterfaceMap('172.19.0.1', { lo: undefined })).toBe(false);
  });
});

describe('excludeOwnTunCidrs（H1：自家 TUN 不算冲突源）', () => {
  it('剔除主机地址等于候选的条目（= 自家上一轮未释放的 TUN）', () => {
    // 变异守卫：不剔 → 重启时 own-lan 命中自家残留 → 换地址；下次释放后换回，地址乒乓漂移。
    expect(excludeOwnTunCidrs(['172.19.0.1/16', '192.168.1.7/24'], TUN_INET4_CANDIDATES)).toEqual([
      '192.168.1.7/24',
    ]);
  });

  it('候选池里每个地址都被认作自家（不只默认那个）', () => {
    // 上一轮已避让到 172.20.0.1 时，本轮同样不能把它当成别人占用。
    expect(excludeOwnTunCidrs(['172.20.0.1/16'], TUN_INET4_CANDIDATES)).toEqual([]);
    expect(excludeOwnTunCidrs(['10.255.255.1/16'], TUN_INET4_CANDIDATES)).toEqual([]);
  });

  it('同网段但主机地址不同 → 保留（那是真的物理 LAN，不是自家 TUN）', () => {
    expect(excludeOwnTunCidrs(['172.19.0.55/16'], TUN_INET4_CANDIDATES)).toEqual([
      '172.19.0.55/16',
    ]);
  });

  it('IPv6 与空表不受影响', () => {
    expect(excludeOwnTunCidrs(['fe80::1/64'], TUN_INET4_CANDIDATES)).toEqual(['fe80::1/64']);
    expect(excludeOwnTunCidrs([], TUN_INET4_CANDIDATES)).toEqual([]);
  });

  it('端到端：自家 TUN 在场时仍选默认地址，不漂移', async () => {
    const pick = await pickTunInet4Address(TUN_INET4_CANDIDATES, {
      // probe 已在 Windows 侧按 InterfaceAlias 排除自家适配器 → 这里返回 free。
      probe: probeFrom({}),
      ownLanCidrs: () =>
        excludeOwnTunCidrs(['172.19.0.1/16', '192.168.1.7/24'], TUN_INET4_CANDIDATES),
    });
    expect(pick.address).toBe('172.19.0.1');
    expect(pick.reason).toBe('default');
  });
});

describe('skipped.cause=unverified（N2：exhausted 日志要能区分「确证冲突」与「探不了」）', () => {
  it('后续候选探不了时记 unverified，不冒充 in-use', async () => {
    const pick = await pickTunInet4Address(['172.19.0.1', '172.20.0.1'], {
      probe: (ip) => Promise.resolve(ip === '172.19.0.1' ? 'in-use' : 'unknown'),
      ownLanCidrs: noLan,
    });
    expect(pick.reason).toBe('exhausted');
    expect(pick.skipped).toEqual([
      { address: '172.19.0.1', cause: 'in-use' },
      { address: '172.20.0.1', cause: 'unverified' },
    ]);
  });
});
