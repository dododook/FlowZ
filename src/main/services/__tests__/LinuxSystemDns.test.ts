/**
 * LinuxSystemDns（P2：经 systemd-resolved 接管 FlowZ 自己那条 TUN 链路）单测。
 *
 * 判据分两类：
 *  ① **越权面**——接管只能落在 FlowZ 自己的 TUN 链路上。认错链路 = 改掉 OpenVPN/WireGuard/别的代理的 DNS，
 *    是本实现最严重的失败模式，故「按地址认、认不出就不接管」的每条分支都要有反向对照。
 *  ② **降级面**——无 resolvectl / 无地址 / 接口没出现 / polkit 拒绝，四条路径都必须回到「不写 marker、不动系统」，
 *    否则重演 Windows 接管那次的 stuck marker（set 失败但 marker 已写 → 每次启动反复还原失败刷错误日志）。
 *
 * 全部注入 exec / 接口枚举 / sleep，不跑 resolvectl、不碰宿主网络。marker 走真实 fs（临时目录）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let tmpUserData: string;
jest.mock('../../utils/paths', () => ({
  getUserDataPath: () => tmpUserData,
}));

import { LinuxSystemDns, SystemDnsBase } from '../SystemDnsManager';
import { CONTROLLED_TUN_DNS_IP } from '../../../shared/dns';

const CONTROLLED = CONTROLLED_TUN_DNS_IP; // '8.8.8.8'
const TUN_ADDR = '172.19.0.1';

type Iface = { address: string; family: string; internal: boolean };

/** 默认接口表：一条真实网卡 + FlowZ 的 TUN + loopback。 */
function ifaces(withTun = true): NodeJS.Dict<Iface[]> {
  const base: NodeJS.Dict<Iface[]> = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eno1: [{ address: '192.168.10.20', family: 'IPv4', internal: false }],
  };
  if (withTun) base.tun0 = [{ address: TUN_ADDR, family: 'IPv4', internal: false }];
  return base;
}

interface Harness {
  dns: LinuxSystemDns;
  calls: string[][];
  /** 假 resolved 的链路 DNS 状态：set/revert 真写它，读回也从它来（近似真实语义，避免夹具造假世界）。 */
  linkDns: Record<string, string[]>;
}

function makeDns(
  opts: {
    ifaces?: () => NodeJS.Dict<Iface[]>;
    run?: (args: string[]) => Promise<string>;
    waitRounds?: number;
    /** 预置链路状态（模拟「上次会话设好后崩溃」或「这条链路是别人的」）。 */
    linkDns?: Record<string, string[]>;
  } = {}
): Harness {
  const calls: string[][] = [];
  const linkDns: Record<string, string[]> = { ...(opts.linkDns ?? {}) };
  const impl = (args: string[]): string => {
    if (args[0] === '--version') return 'systemd 259';
    if (args[0] === 'dns' && args.length === 1) {
      const links = Object.entries(linkDns)
        .map(([n, ips], i) => `Link ${10 + i} (${n}): ${ips.join(' ')}`)
        .join('\n');
      return `Global:\nLink 2 (eno1): 192.168.10.1\n${links}\n`;
    }
    if (args[0] === 'dns' && args.length === 2)
      return `Link 9 (${args[1]}): ${(linkDns[args[1]] ?? []).join(' ')}\n`;
    if (args[0] === 'dns') {
      linkDns[args[1]] = args.slice(2);
      return '';
    }
    if (args[0] === 'revert') {
      // 与真实 revert 的偏差：真实 revert 只清**人工**配置，DHCP/.network 下发值仍在。对自建 TUN 二者等价
      // （自建接口没有系统下发值），本文件也只对 TUN 链路 revert；若将来测到物理链路，这里就是个假世界。
      delete linkDns[args[1]];
      return '';
    }
    return '';
  };
  const dns = new LinuxSystemDns({
    run: async (args) => {
      calls.push(args);
      if (opts.run) return opts.run(args);
      return impl(args);
    },
    runSync: (args) => {
      calls.push(args);
      // 注意边界：注入了自定义 run 时 runSync 恒返回 ''（同步腿不复用异步桩）。当前 sync 用例都不配
      // 自定义 run；将来若配了又断言 sync 行为，测的会是一个空世界。
      if (opts.run) return '';
      return impl(args);
    },
    networkInterfaces: opts.ifaces ?? (() => ifaces()),
    sleep: async () => {},
    waitRounds: opts.waitRounds ?? 3,
    waitIntervalMs: 0,
  });
  return { dns, calls, linkDns };
}

/** 「真正下发接管」的调用（探针的 revert 不算）。 */
const applyCalls = (calls: string[][]): string[][] =>
  calls
    .filter((c) => c[0] === 'dns' && c.length > 2)
    .concat(calls.filter((c) => c[0] === 'domain'));

const reverts = (calls: string[][]): string[][] => calls.filter((c) => c[0] === 'revert');

/** 直接造一个 marker 文件，模拟「上次会话崩溃留下的残留」。 */
function seedMarker(original: Record<string, string[]>, tunInet4Address?: string): void {
  fs.writeFileSync(
    path.join(tmpUserData, 'system-dns.marker.json'),
    JSON.stringify({
      controlledIp: CONTROLLED,
      original,
      at: Date.now(),
      ...(tunInet4Address ? { tunInet4Address } : {}),
    })
  );
}

beforeEach(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-linuxdns-'));
});
afterEach(() => {
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('LinuxSystemDns — 接管目标只能是自己的 TUN 链路', () => {
  it('happy path：设受控 DNS + 全域路由域 ~.，并写 marker', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });

    expect(h.calls).toContainEqual(['dns', 'tun0', CONTROLLED]);
    expect(h.calls).toContainEqual(['domain', 'tun0', '~.']);
    expect(h.dns.hasMarker()).toBe(true);
  });

  it('~. 不可省：只设 dns 不设 domain，未匹配搜索域的查询仍走原链路上游', async () => {
    // 反向对照：删掉 resolvectlDomainArgs 那一步时本条转红。
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    const domainCall = h.calls.find((c) => c[0] === 'domain');
    expect(domainCall).toEqual(['domain', 'tun0', '~.']);
  });

  it('地址带 CIDR 后缀同样认得出（配置里常是 172.19.0.1/16）', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: `${TUN_ADDR}/16` });
    expect(h.calls).toContainEqual(['dns', 'tun0', CONTROLLED]);
  });

  it('同名 tun0 但地址不是我们的 → 不接管（认错就是改掉 OpenVPN/WireGuard 的 DNS）', async () => {
    const foreign: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => foreign });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });

    expect(applyCalls(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('接口名与我们无关但地址对得上 → 照样接管（判据是地址不是名字）', async () => {
    const renamed: NodeJS.Dict<Iface[]> = {
      flowz9: [{ address: TUN_ADDR, family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => renamed });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.calls).toContainEqual(['dns', 'flowz9', CONTROLLED]);
  });
});

describe('LinuxSystemDns — 每条降级路径都必须「不写 marker、不动系统」', () => {
  it('未取得 TUN 地址 → fail-closed，不猜接口', async () => {
    const h = makeDns();
    await h.dns.setDns({});
    expect(h.calls).toHaveLength(0); // 连 --version 探测都不做
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('无 resolvectl（非 systemd-resolved 发行版）→ 只探测一次，不接管', async () => {
    const h = makeDns({
      run: async () => {
        throw new Error('spawn resolvectl ENOENT');
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(applyCalls(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);

    // 第二次不再重复探测（探测结果缓存，避免每次启动都刷同一条告警）。
    const before = h.calls.length;
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.calls.length).toBe(before);
  });

  it('等待上界内 TUN 接口始终没出现 → 不接管（等待有界，不拖死启动）', async () => {
    const h = makeDns({ ifaces: () => ifaces(false), waitRounds: 3 });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(applyCalls(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('TUN 接口迟到但在上界内出现 → 正常接管（核就绪与网卡可见之间有窗口）', async () => {
    let round = 0;
    const h = makeDns({
      ifaces: () => (++round >= 3 ? ifaces(true) : ifaces(false)),
      waitRounds: 5,
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.calls).toContainEqual(['dns', 'tun0', CONTROLLED]);
  });

  it('polkit 拒绝（写类全拒，含 revert）→ 写 marker 之前就降级，不留 stuck marker', async () => {
    // 现实形态：polkit 规则要么全放行要么全拒，`resolvectl dns` / `domain` / `revert` 同属
    // org.freedesktop.resolve1.*。此前这条测试的夹具只拒 set 却放行 revert，造了个不存在的世界——
    // 于是「回滚能成功、marker 被清掉」看起来成立，而真实场景里回滚同样被拒、marker 卡死。
    const h = makeDns({
      run: async (args) => {
        if (args[0] === 'dns' && args.length === 1) return `Link 2 (eno1): 192.168.10.1\n`; // 只读放行
        throw new Error('Interactive authentication required.');
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });

    expect(h.dns.hasMarker()).toBe(false); // Windows 接管那次就是栽在这里
    expect(applyCalls(h.calls)).toHaveLength(0); // 探针失败即止，不该已经改过系统
  });

  it('resolvectl 在但 systemd-resolved 没跑 → 不接管（探活探服务不探二进制）', async () => {
    // 装了 resolvectl 却没启用 resolved 的发行版不少（Arch 默认、部分 Debian、NM 自管 DNS）。
    // 探活若只跑 `--version`，这些机器会一路走到「marker 已写、apply 失败」。
    const h = makeDns({
      run: async (args) => {
        if (args[0] === '--version') return 'systemd 259'; // 二进制在
        throw new Error('Failed to connect to bus: No such file or directory');
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(applyCalls(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('同一地址落在两个接口上 → fail-closed 不接管（无法确定哪个是自己的）', async () => {
    const dup: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: TUN_ADDR, family: 'IPv4', internal: false }],
      tun1: [{ address: TUN_ADDR, family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => dup });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(applyCalls(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });
});

describe('LinuxSystemDns — 还原与重灌', () => {
  it('还原走 resolvectl revert（连 ~. 路由域一起清掉），并清 marker', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.dns.hasMarker()).toBe(true);
    const beforeReverts = reverts(h.calls).length; // 接管前的写权限探针也发过一次 revert

    await h.dns.restoreDns();
    expect(reverts(h.calls).length).toBe(beforeReverts + 1); // 还原确实又发了一次，不是数到探针那次
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('无 marker 时还原不碰系统（只清 marker 文件）', async () => {
    const h = makeDns();
    await h.dns.restoreDns();
    expect(h.calls.filter((c) => c[0] === 'revert')).toHaveLength(0);
  });

  it('链路已被外部清掉（resolved 重启）→ reconcile 重新设回受控值', async () => {
    let linkDns: string[] = [];
    const h = makeDns({
      run: async (args) => {
        if (args[0] === '--version') return 'systemd 259';
        if (args[0] === 'dns' && args.length > 2) {
          linkDns = args.slice(2);
          return '';
        }
        if (args[0] === 'dns') return `Link 9 (tun0): ${linkDns.join(' ')}\n`;
        return '';
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(linkDns).toEqual([CONTROLLED]);

    linkDns = []; // 外部清掉
    await h.dns.reconcileDns();
    expect(linkDns).toEqual([CONTROLLED]);
  });

  it('链路已受控 → reconcile 幂等 no-op（不重复下发）', async () => {
    const h = makeDns({
      run: async (args) => {
        if (args[0] === '--version') return 'systemd 259';
        if (args[0] === 'dns' && args.length === 2) return `Link 9 (tun0): ${CONTROLLED}\n`;
        return '';
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    const before = h.calls.filter((c) => c[0] === 'dns' && c.length > 2).length;
    await h.dns.reconcileDns();
    expect(h.calls.filter((c) => c[0] === 'dns' && c.length > 2).length).toBe(before);
  });
});

describe('LinuxSystemDns — 方案B LAN 解析器', () => {
  it('读各链路 DNS 并排除 TUN 自身（TUN 上是我们设的受控 IP，不是 LAN 解析器）', async () => {
    const h = makeDns({
      run: async (args) => {
        if (args[0] === '--version') return 'systemd 259';
        if (args[0] === 'dns' && args.length === 1)
          return `Global:\nLink 2 (eno1): 192.168.10.1\nLink 9 (tun0): ${CONTROLLED}\n`;
        return `Link 9 (tun0):\n`;
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    // marker 在 → 基类改读 marker.original（接管前真实值）；此处验证的是 readEffectiveResolvers 的取材面。
    const lan = await h.dns.getLanResolverForDns();
    expect(lan === null || lan === '192.168.10.1').toBe(true);
  });

  it('未接管时读到的是真实 LAN 解析器（私网 IPv4，排除受控 IP）', async () => {
    const h = makeDns({
      run: async (args) => {
        if (args[0] === '--version') return 'systemd 259';
        return `Global:\nLink 2 (eno1): 192.168.10.1 240e:37a::1\n`;
      },
    });
    expect(await h.dns.getLanResolverForDns()).toBe('192.168.10.1');
  });

  it('无 resolvectl → 返回 null，调用方退回 dns-local', async () => {
    const h = makeDns({
      run: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(await h.dns.getLanResolverForDns()).toBeNull();
  });
});

describe('LinuxSystemDns — 与基类 marker 契约', () => {
  it('marker 里记的原始值是 TUN 链路接管前的值（空 = 新建接口无显式 DNS）', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    const marker = SystemDnsBase.readMarker();
    expect(marker?.controlledIp).toBe(CONTROLLED);
    expect(marker?.original).toEqual({ tun0: [] });
  });
});

describe('LinuxSystemDns — 跨会话还原只认地址，绝不按名字盲发', () => {
  it('上次崩溃留下 marker，而现在的 tun0 是别人的（地址对不上）→ 一个 revert 都不发', async () => {
    // 失败输入（reviewer 用探针实证过的形态）：TUN 会话中 FlowZ 崩溃 → 用户连 OpenVPN 占了 tun0 →
    // 再启 FlowZ → 启动恢复若按 marker 键名 revert tun0，改掉的是 OpenVPN 的链路 DNS。
    seedMarker({ tun0: [] }, TUN_ADDR);
    const foreign: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => foreign });

    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false); // 接口已不在 = 我们的配置随它消失，marker 该清
  });

  it('接口已消失（核崩溃、TUN 随之消失）→ 视作已还原并清 marker，不制造还原失败循环', async () => {
    // 不这么判就会：revert 报 No such device → allOk=false → marker 永久滞留 →
    // 每次启动刷一轮「检测到残留、还原失败」，正是 Windows 接管被移除的第二条根因。
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({ ifaces: () => ifaces(false) });

    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('旧版本 marker（不记地址）或跨平台拷进来的 Mac/Win marker → 只清 marker，不动系统', async () => {
    seedMarker({ 'Wi-Fi': ['192.168.1.1'] }); // 没有 tunInet4Address
    const h = makeDns();

    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('地址对得上且链路上确实是我们的受控 IP → revert 并清 marker（新实例、无内存态）', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({ linkDns: { tun0: [CONTROLLED] } });

    await h.dns.restoreDns();
    expect(h.calls).toContainEqual(['revert', 'tun0']);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('revert 失败（瞬态）→ 保留 marker 交下次重试', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({
      run: async (args) => {
        if (args[0] === 'revert') throw new Error('Failed to revert: transient');
        if (args[0] === 'dns' && args.length === 2) return `Link 9 (tun0): ${CONTROLLED}\n`;
        return '';
      },
    });
    await h.dns.restoreDns();
    expect(h.dns.hasMarker()).toBe(true);
  });

  it('同步还原（退出/关机）同一判据：地址对不上不发命令', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const foreign: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => foreign });
    h.dns.restoreDnsSync();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('同步还原：地址对得上且链路是我们的 → revert 并清 marker', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({ linkDns: { tun0: [CONTROLLED] } });
    h.dns.restoreDnsSync();
    expect(h.calls).toContainEqual(['revert', 'tun0']);
    expect(h.dns.hasMarker()).toBe(false);
  });
});

describe('LinuxSystemDns — 方案B 不因 marker 在而退化', () => {
  it('接管中（marker 在）仍读得到物理链路的 LAN 解析器', async () => {
    // 基类在 marker 在时改读 marker.original，而 Linux 的 original 是 TUN 接管前的值（恒空）→
    // 切节点/切模式重启时 LAN 解析器会恒为 null，内网域名重定向只在冷启动有效。Linux 覆写掉这条。
    const h = makeDns({
      run: async (args) => {
        if (args[0] === 'dns' && args.length === 1)
          return `Global:\nLink 2 (eno1): 192.168.10.1\nLink 9 (tun0): ${CONTROLLED}\n`;
        return `Link 9 (tun0):\n`;
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.dns.hasMarker()).toBe(true);
    expect(await h.dns.getLanResolverForDns()).toBe('192.168.10.1');
  });
});

describe('LinuxSystemDns — revert 前的身份核验（地址在崩溃后不再等价于属主）', () => {
  it('同址接口存在但链路上不是我们的受控 IP → 只清 marker，一个 revert 都不发', async () => {
    // 失败输入：FlowZ 崩溃 → 另一个 sing-box 系客户端用同一默认地址 172.19.0.1 起了 TUN 且配了 resolved →
    // 按地址单命中到它（同址双接口的 fail-closed 挡不住「现在只剩它一个」）。
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({ linkDns: { tun0: ['10.0.0.53'] } });

    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('读链路 DNS 失败 → 按「不是我们的」处理（漏还原的代价远小于误改别人链路）', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({
      run: async (args) => {
        if (args[0] === 'dns' && args.length === 2) throw new Error('bus error');
        return '';
      },
    });
    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
  });

  it('同步还原同一判据：链路不是我们的就不发命令', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const h = makeDns({ linkDns: { tun0: ['10.0.0.53'] } });
    h.dns.restoreDnsSync();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('marker 写失败（磁盘满）但内存里有地址 → 仍按地址还原，不让自家链路残留受控 DNS', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.linkDns.tun0).toEqual([CONTROLLED]);
    fs.rmSync(path.join(tmpUserData, 'system-dns.marker.json'), { force: true }); // 模拟 marker 丢失

    await h.dns.restoreDns();
    expect(h.linkDns.tun0).toBeUndefined(); // 确实 revert 掉了
  });
});

describe('LinuxSystemDns — 补齐三处无牙面', () => {
  it('listTargets 每次按地址重解析：接口被别人顶替后 reconcile 不再往缓存名上打', async () => {
    const current: { v: NodeJS.Dict<Iface[]> } = { v: ifaces(true) };
    const h = makeDns({ ifaces: () => current.v });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(h.dns.hasMarker()).toBe(true);

    // 核死、别的客户端占了 tun0（同名、异址），且它自己配了 DNS —— 这一步是关键：
    // 链路上若仍留着我们的受控 IP，用缓存名也会因「已受控」而 no-op，测不出缓存的害处。
    current.v = { tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }] };
    h.linkDns.tun0 = ['10.0.0.53'];
    const before = applyCalls(h.calls).length;
    await h.dns.reconcileDns();
    expect(applyCalls(h.calls).length).toBe(before); // 一条都不该再下发到别人的链路上
  });

  it('非 ENOENT 的探活失败不永久缓存：resolved 中途起来后仍能接管', async () => {
    let firstCall = true;
    const h = makeDns({
      run: async (args) => {
        if (args[0] === 'dns' && args.length === 1 && firstCall) {
          firstCall = false;
          // 必须用这条真实文案：它**含 "not found"**，正是宽判据会误吞成「二进制不存在」的那种。
          // 换成 'No such file or directory' 之类，判据写宽了也测不出来。
          throw new Error('Unit dbus-org.freedesktop.resolve1.service not found.');
        }
        if (args[0] === 'dns' && args.length === 1) return `Link 2 (eno1): 192.168.10.1\n`;
        if (args[0] === 'dns' && args.length === 2) return `Link 9 (tun0):\n`;
        return '';
      },
    });
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(applyCalls(h.calls)).toHaveLength(0);

    await h.dns.setDns({ tunInet4Address: TUN_ADDR }); // resolved 起来了
    expect(applyCalls(h.calls).length).toBeGreaterThan(0);
  });

  it('marker 写侧确实带上了 TUN 地址（还原全靠它，丢了就退回按名字猜）', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    expect(SystemDnsBase.readMarker()?.tunInet4Address).toBe(TUN_ADDR);
  });
});

describe('LinuxSystemDns — 地址门是身份核验被巧合骗过时的唯一防线', () => {
  it('外来链路恰好也配了 8.8.8.8（Google DNS 极常见）→ 地址对不上就仍然不 revert', async () => {
    // 身份核验（链路上有受控 IP）在这种巧合下会被骗过，此刻只剩「地址必须对得上」这一道门。
    // 反向对照：把地址门弱化成 `?? 'tun0'` 之类的名字回退时，本条转红。
    seedMarker({ tun0: [] }, TUN_ADDR);
    const foreign: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => foreign, linkDns: { tun0: [CONTROLLED] } });

    await h.dns.restoreDns();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.linkDns.tun0).toEqual([CONTROLLED]); // 别人的配置一字未动
    expect(h.dns.hasMarker()).toBe(false);
  });

  it('同步还原同一场景同一结论', async () => {
    seedMarker({ tun0: [] }, TUN_ADDR);
    const foreign: NodeJS.Dict<Iface[]> = {
      tun0: [{ address: '10.8.0.6', family: 'IPv4', internal: false }],
    };
    const h = makeDns({ ifaces: () => foreign, linkDns: { tun0: [CONTROLLED] } });

    h.dns.restoreDnsSync();
    expect(reverts(h.calls)).toHaveLength(0);
    expect(h.linkDns.tun0).toEqual([CONTROLLED]);
  });

  it('同步还原也吃内存地址兜底（marker 丢失时）', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    fs.rmSync(path.join(tmpUserData, 'system-dns.marker.json'), { force: true });

    h.dns.restoreDnsSync();
    expect(h.linkDns.tun0).toBeUndefined();
  });

  it('还原后清掉内存地址：下一次 restore 不拿陈旧地址去匹配', async () => {
    const h = makeDns();
    await h.dns.setDns({ tunInet4Address: TUN_ADDR });
    await h.dns.restoreDns();
    expect(h.linkDns.tun0).toBeUndefined();

    // 陈旧地址若留着，这一次会再匹配到同址接口并（在链上恰有受控 IP 时）误 revert。
    h.linkDns.tun0 = [CONTROLLED];
    await h.dns.restoreDns();
    expect(h.linkDns.tun0).toEqual([CONTROLLED]);
  });
});
