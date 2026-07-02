import {
  computeUserTunExclude,
  normalizeTunExcludeCidr,
  UserTunExcludeInput,
} from '../tun-route-exclude';

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
