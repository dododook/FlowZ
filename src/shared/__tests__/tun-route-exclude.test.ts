import {
  computeUserTunExclude,
  computeWinBypassExclude,
  normalizeTunExcludeCidr,
  UserTunExcludeInput,
  WinBypassExcludeInput,
} from '../tun-route-exclude';
import { cidrOverlapsAny } from '../ip';

/** 造入参：只填关心的字段，其余给安全缺省。 */
function input(over: Partial<UserTunExcludeInput>): UserTunExcludeInput {
  return {
    platform: 'linux',
    userCidrs: [],
    meshCidrs: [],
    fakeipRanges: [],
    ownLanCidrs: [],
    ...over,
  };
}

describe('normalizeTunExcludeCidr', () => {
  it('合法 CIDR 原样返回（v4/v6）', () => {
    expect(normalizeTunExcludeCidr('10.147.0.0/16')).toBe('10.147.0.0/16');
    expect(normalizeTunExcludeCidr('  192.168.5.0/24 ')).toBe('192.168.5.0/24');
    expect(normalizeTunExcludeCidr('fd00::/8')).toBe('fd00::/8');
  });
  it('裸 IP 补掩码（v4→/32，v6→/128）——防 sing-box route_exclude FATAL no "/"', () => {
    expect(normalizeTunExcludeCidr('192.168.1.50')).toBe('192.168.1.50/32');
    expect(normalizeTunExcludeCidr('2001:db8::1')).toBe('2001:db8::1/128');
  });
  it('catch-all / 过宽前缀 → null（防排空 TUN）', () => {
    expect(normalizeTunExcludeCidr('0.0.0.0/0')).toBeNull();
    expect(normalizeTunExcludeCidr('::/0')).toBeNull();
    expect(normalizeTunExcludeCidr('0.0.0.0/1')).toBeNull(); // 半空间攻击
    expect(normalizeTunExcludeCidr('10.0.0.0/7')).toBeNull(); // v4 比 /8 更宽
    expect(normalizeTunExcludeCidr('fc00::/6')).toBeNull(); // v6 比 /7 更宽
  });
  it('边界前缀保留（v4 /8、v6 /7）', () => {
    expect(normalizeTunExcludeCidr('10.0.0.0/8')).toBe('10.0.0.0/8');
    expect(normalizeTunExcludeCidr('fc00::/7')).toBe('fc00::/7');
  });
  it('范围/形状非法 / 空 / 域名 / 非字符串 → null', () => {
    expect(normalizeTunExcludeCidr('256.1.1.1/8')).toBeNull(); // 八位组>255
    expect(normalizeTunExcludeCidr('10.0.0.0/40')).toBeNull(); // 前缀越界
    expect(normalizeTunExcludeCidr('example.com')).toBeNull();
    expect(normalizeTunExcludeCidr('')).toBeNull();
    expect(normalizeTunExcludeCidr('  ')).toBeNull();
    expect(normalizeTunExcludeCidr(123 as unknown as string)).toBeNull();
    expect(normalizeTunExcludeCidr(null as unknown as string)).toBeNull();
  });
});

describe('computeUserTunExclude', () => {
  it('合法用户段直通（无 mesh/fakeip/lan）', () => {
    const r = computeUserTunExclude(input({ userCidrs: ['10.147.0.0/16', '192.168.50.0/24'] }));
    expect(r.extra.sort()).toEqual(['10.147.0.0/16', '192.168.50.0/24'].sort());
    expect(r.droppedInvalid).toBe(0);
    expect(r.droppedMeshOverlap).toEqual([]);
    expect(r.droppedOwnLanMac).toEqual([]);
  });

  it('裸 IP 规范化进 extra；非法/过宽计入 droppedInvalid', () => {
    const r = computeUserTunExclude(
      input({
        userCidrs: ['192.168.1.50', '0.0.0.0/0', 'not-a-cidr', 256 as unknown, '10.0.0.0/7'],
      })
    );
    expect(r.extra).toEqual(['192.168.1.50/32']); // 裸 IP → /32
    expect(r.droppedInvalid).toBe(4); // catch-all + 域名 + 非字符串 + 过宽
  });

  it('去重（裸 IP 与其 /32 视为同一）', () => {
    const r = computeUserTunExclude(
      input({ userCidrs: ['10.0.0.1', '10.0.0.1/32', ' 10.0.0.1 '] })
    );
    expect(r.extra).toEqual(['10.0.0.1/32']);
  });

  it('减组网 force-route 段（mesh 优先），相交项进 droppedMeshOverlap', () => {
    const r = computeUserTunExclude(
      input({ userCidrs: ['10.147.0.0/16', '192.168.50.0/24'], meshCidrs: ['192.168.50.0/24'] })
    );
    expect(r.extra).toEqual(['10.147.0.0/16']);
    expect(r.droppedMeshOverlap).toEqual(['192.168.50.0/24']);
  });

  it('减 fakeip 段，相交项进 droppedFakeipOverlap', () => {
    const r = computeUserTunExclude(
      input({ userCidrs: ['10.147.0.0/16', '198.18.0.0/16'], fakeipRanges: ['198.18.0.0/15'] })
    );
    expect(r.extra).toEqual(['10.147.0.0/16']);
    expect(r.droppedFakeipOverlap).toEqual(['198.18.0.0/16']);
  });

  it('macOS：减本机物理 LAN 段（NE guard），相交项进 droppedOwnLanMac', () => {
    const r = computeUserTunExclude(
      input({
        platform: 'darwin',
        userCidrs: ['10.147.0.0/16', '192.168.10.0/24'],
        ownLanCidrs: ['192.168.10.5/24'], // os.networkInterfaces 的 .cidr 含主机位
      })
    );
    expect(r.extra).toEqual(['10.147.0.0/16']);
    expect(r.droppedOwnLanMac).toEqual(['192.168.10.0/24']);
  });

  it('非 macOS（linux/win）忽略 ownLanCidrs', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const r = computeUserTunExclude(
        input({ platform, userCidrs: ['192.168.10.0/24'], ownLanCidrs: ['192.168.10.0/24'] })
      );
      expect(r.extra).toEqual(['192.168.10.0/24']);
      expect(r.droppedOwnLanMac).toEqual([]);
    }
  });

  it('组合：非法 + mesh + fakeip + macOS 物理 LAN', () => {
    const r = computeUserTunExclude(
      input({
        platform: 'darwin',
        userCidrs: [
          '10.147.0.0/16',
          '192.168.50.0/24',
          '198.18.1.0/24',
          '192.168.10.0/24',
          '0.0.0.0/0',
        ],
        meshCidrs: ['192.168.50.0/24'],
        fakeipRanges: ['198.18.0.0/15'],
        ownLanCidrs: ['192.168.10.0/24'],
      })
    );
    expect(r.extra).toEqual(['10.147.0.0/16']);
    expect(r.droppedInvalid).toBe(1); // 0.0.0.0/0
    expect(r.droppedMeshOverlap).toEqual(['192.168.50.0/24']);
    expect(r.droppedFakeipOverlap).toEqual(['198.18.1.0/24']);
    expect(r.droppedOwnLanMac).toEqual(['192.168.10.0/24']);
  });

  it('空用户段 → 空 extra，无副作用', () => {
    const r = computeUserTunExclude(input({ userCidrs: [] }));
    expect(r.extra).toEqual([]);
    expect(r.droppedInvalid).toBe(0);
    expect(r.droppedMeshOverlap).toEqual([]);
  });
});

/** 造 Windows bypassLAN carve 入参：只填关心字段，其余安全缺省。 */
function winInput(over: Partial<WinBypassExcludeInput>): WinBypassExcludeInput {
  return {
    bypassCidrs: [],
    engagedMeshCidrs: [],
    ownLanCidrs: [],
    fakeipRanges: [],
    ...over,
  };
}

describe('computeWinBypassExclude — Windows bypassLAN 对 engaged mesh 段 carve', () => {
  it('tailnet 100.64/10 被 carve → 不再排除（修 Windows+TS 组网不可达零门槛缺口）', () => {
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['10.0.0.0/8', '100.64.0.0/10', '192.168.0.0/16'],
        engagedMeshCidrs: ['100.64.0.0/10'],
      })
    );
    expect(r.carvedMeshCidrs).toEqual(['100.64.0.0/10']);
    expect(r.meshSkippedOwnLan).toEqual([]);
    expect(cidrOverlapsAny('100.64.1.2/32', r.exclude)).toBe(false); // tailnet 进 TUN → 组网可达
    expect(cidrOverlapsAny('10.5.5.5/32', r.exclude)).toBe(true); // 其余 bypass 仍排除
    expect(cidrOverlapsAny('192.168.1.1/32', r.exclude)).toBe(true);
  });

  it('WG allowedIPs 私网段被 carve，其余宽段仍排除', () => {
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['10.0.0.0/8', '192.168.0.0/16'],
        engagedMeshCidrs: ['10.20.0.0/16'],
      })
    );
    expect(r.carvedMeshCidrs).toEqual(['10.20.0.0/16']);
    expect(cidrOverlapsAny('10.20.5.5/32', r.exclude)).toBe(false); // mesh 段开洞
    expect(cidrOverlapsAny('10.21.5.5/32', r.exclude)).toBe(true); // 其余 10/8 仍排除（含网关）
    expect(cidrOverlapsAny('192.168.1.1/32', r.exclude)).toBe(true);
  });

  it('own-LAN guard：mesh 段与本机物理子网重叠 → 不 carve，保网关排除 + 计入 meshSkippedOwnLan', () => {
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['192.168.0.0/16'],
        engagedMeshCidrs: ['192.168.50.0/24'],
        ownLanCidrs: ['192.168.50.10/24'], // 本机物理子网 == mesh 段
      })
    );
    expect(r.carvedMeshCidrs).toEqual([]);
    expect(r.meshSkippedOwnLan).toEqual(['192.168.50.0/24']);
    expect(cidrOverlapsAny('192.168.50.5/32', r.exclude)).toBe(true); // 仍被排除（网关保护优先）
  });

  it('fakeip 段先整条剔除（保持现状语义）', () => {
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['10.0.0.0/8', '198.18.0.0/16'],
        fakeipRanges: ['198.18.0.0/15'],
      })
    );
    expect(r.exclude).toEqual(['10.0.0.0/8']); // 198.18 剔除；无 mesh → 无 carve、原样
    expect(r.carvedMeshCidrs).toEqual([]);
  });

  it('无 engaged mesh → 原样返回（与旧行为字节等价，无组网时 Windows 排除表零变化）', () => {
    const bypass = ['10.0.0.0/8', '100.64.0.0/10', '192.168.0.0/16', 'fc00::/7'];
    const r = computeWinBypassExclude(winInput({ bypassCidrs: bypass, engagedMeshCidrs: [] }));
    expect(r.exclude).toEqual(bypass); // 未经 subtractCidrs 重格式化，逐字节等价
    expect(r.carvedMeshCidrs).toEqual([]);
    expect(r.meshSkippedOwnLan).toEqual([]);
  });

  it('v6：ULA fc00::/7 内的 mesh /64 被 carve', () => {
    const r = computeWinBypassExclude(
      winInput({ bypassCidrs: ['fc00::/7'], engagedMeshCidrs: ['fd00::/64'] })
    );
    expect(r.carvedMeshCidrs).toEqual(['fd00::/64']);
    expect(cidrOverlapsAny('fd00::1/128', r.exclude)).toBe(false);
    expect(cidrOverlapsAny('fc00::1/128', r.exclude)).toBe(true);
  });

  it('公网 mesh 段（不在任何 bypass 条目内）→ 不计入 carve、字节等价（L1：无假「已开洞」/无谓重格式化）', () => {
    const bypass = ['10.0.0.0/8', '192.168.0.0/16'];
    const r = computeWinBypassExclude(
      winInput({ bypassCidrs: bypass, engagedMeshCidrs: ['203.0.113.0/24'] }) // TEST-NET-3，公网、不在 bypass
    );
    expect(r.carvedMeshCidrs).toEqual([]);
    expect(r.exclude).toEqual(bypass); // 未 carve → 原样、不重格式化
  });

  it('回环 guard：半隧道 mesh 0.0.0.0/1 覆盖 127/8 → 不 carve，回环仍排除（L2：与 mac/Linux 恒排回环对齐）', () => {
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['10.0.0.0/8', '127.0.0.0/8', '100.64.0.0/10'],
        engagedMeshCidrs: ['0.0.0.0/1'], // wg-quick 半隧道写法，stripCatchAll 不剥离 → 可能进 engaged
      })
    );
    expect(r.carvedMeshCidrs).toEqual([]); // 覆盖回环 → 不 carve
    expect(r.meshSkippedOwnLan).toEqual(['0.0.0.0/1']);
    expect(cidrOverlapsAny('127.0.0.1/32', r.exclude)).toBe(true); // 回环仍排除
    expect(cidrOverlapsAny('10.5.5.5/32', r.exclude)).toBe(true);
  });

  it('特殊用途 guard：链路本地/多播段不被 mesh carve（OBS：隧道承载无意义，防破坏本地发现/DHCP 广播）', () => {
    // mesh 精确命中多播段（或超宽半隧道覆盖它）→ guard 拦下、仍排除
    const r = computeWinBypassExclude(
      winInput({
        bypassCidrs: ['10.0.0.0/8', '169.254.0.0/16', '224.0.0.0/4'],
        engagedMeshCidrs: ['224.0.0.0/4', '169.254.0.0/16'],
      })
    );
    expect(r.carvedMeshCidrs).toEqual([]); // 多播/链路本地 → 不 carve
    expect(cidrOverlapsAny('224.0.0.1/32', r.exclude)).toBe(true); // 多播仍排除
    expect(cidrOverlapsAny('169.254.1.1/32', r.exclude)).toBe(true); // 链路本地仍排除
    // 正常私网 mesh 段不受 guard 影响，仍正常 carve
    const r2 = computeWinBypassExclude(
      winInput({ bypassCidrs: ['10.0.0.0/8'], engagedMeshCidrs: ['10.20.0.0/16'] })
    );
    expect(r2.carvedMeshCidrs).toEqual(['10.20.0.0/16']);
    expect(cidrOverlapsAny('10.20.5.5/32', r2.exclude)).toBe(false);
  });
});
