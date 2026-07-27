/**
 * issue #324 P0-1：sing-box FATAL 解析纯函数。
 *
 * 变异逃逸面（每条都必须有测试杀掉，非「碰巧在真数据上对」）：
 *  - 取第一条 FATAL 而非最后一条
 *  - 删 stripAnsi
 *  - 互换两个分类分支
 *  - 删 run 边界过滤（读到上次会话的残留 FATAL）
 */
import {
  stripAnsi,
  extractLastFatal,
  classifySingBoxFatal,
  sliceSinceRunStart,
} from '../singbox-fatal';

/** #324 报告者机器 singbox_startup.log 的真实字节（含 ANSI 色码）。 */
const REAL_FATAL =
  '\x1b[31mFATAL\x1b[0m[0000] start service: start inbound/tun[tun-in]: configure tun interface: set ipv4 address: The object already exists.';

describe('stripAnsi', () => {
  it('剥掉 sing-box 默认 logger 的色码', () => {
    expect(stripAnsi(REAL_FATAL)).toBe(
      'FATAL[0000] start service: start inbound/tun[tun-in]: configure tun interface: set ipv4 address: The object already exists.'
    );
  });

  it('无色码的行原样返回', () => {
    expect(stripAnsi('FATAL[0000] plain')).toBe('FATAL[0000] plain');
  });
});

describe('extractLastFatal', () => {
  it('从混着看护脚本自述行的日志里挑出 FATAL', () => {
    const text = [
      'FlowZ watchdog starting...',
      '22:08:55 [watchdog] sing-box started, PID 5704',
      '22:08:56 [watchdog] sing-box exited by itself',
      REAL_FATAL,
    ].join('\n');
    expect(extractLastFatal(text)).toContain('set ipv4 address');
  });

  it('多条 FATAL 时取最后一条（不是第一条）', () => {
    // 变异守卫：改成取第一条 → 本例失败。helper 写侧 O_APPEND 会累积多腿的 FATAL，最后一条最接近本次失败。
    const text = [
      'FATAL[0000] start service: start inbound/tun[tun-in]: configure tun interface: create adapter: old failure',
      'FATAL[0000] start service: start inbound/tun[tun-in]: configure tun interface: set ipv4 address: The object already exists.',
    ].join('\n');
    expect(extractLastFatal(text)).toContain('set ipv4 address');
    expect(extractLastFatal(text)).not.toContain('create adapter');
  });

  it('返回值已剥色码（供下游字符串匹配）', () => {
    // 变异守卫：删 stripAnsi → 返回串含 \x1b，本例失败。
    const line = extractLastFatal(REAL_FATAL);
    expect(line).not.toContain('\x1b');
    expect(line?.startsWith('FATAL')).toBe(true);
  });

  it('无 FATAL 行 → null', () => {
    expect(extractLastFatal('INFO[0000] all good\n')).toBeNull();
  });

  it('空文本 → null', () => {
    expect(extractLastFatal('')).toBeNull();
  });
});

describe('classifySingBoxFatal', () => {
  it('地址冲突：点名具体地址', () => {
    const info = classifySingBoxFatal(stripAnsi(REAL_FATAL), { tunAddress: '172.19.0.1/16' });
    expect(info.kind).toBe('tun-address-conflict');
    expect(info.message).toContain('172.19.0.1');
    // 掩码不该出现在给用户看的文案里（冲突的是地址本身）。
    expect(info.message).not.toContain('/16');
    // 必须提「已断开或隐藏的适配器」——#324 报告者正是因为设备管理器看不到而回答「没有残留」。
    expect(info.message).toContain('隐藏');
  });

  it('地址冲突：无地址上下文时仍给出正确分类', () => {
    const info = classifySingBoxFatal(
      'FATAL[0000] ... set ipv4 address: The object already exists.'
    );
    expect(info.kind).toBe('tun-address-conflict');
    expect(info.message).toContain('已被本机其它网络接口占用');
  });

  it('IPv6 地址冲突同归一类，但文案绝不点名 v4 地址', () => {
    // 变异守卫：v4/v6 不分叉 → message 会拼上 ctx.tunAddress（恒为 v4），把用户引去找占用 172.19.0.1 的
    // 网卡，方向全错。macOS 默认给 TUN 配 IPv6，这条路径是真会走到的。
    const info = classifySingBoxFatal(
      'FATAL[0000] ... set ipv6 address: The object already exists.',
      {
        tunAddress: '172.19.0.1/30',
      }
    );
    expect(info.kind).toBe('tun-address-conflict');
    expect(info.message).not.toContain('172.19.0.1');
    expect(info.message).toContain('IPv6');
  });

  it('适配器创建失败：与地址冲突分属不同类', () => {
    // 变异守卫：互换两个分类分支 → 本例与上面的地址冲突例同时失败。
    const info = classifySingBoxFatal(
      'FATAL[0000] start service: start inbound/tun[tun-in]: configure tun interface: create adapter: Access is denied.'
    );
    expect(info.kind).toBe('tun-adapter-create');
    expect(info.message).toContain('wintun');
  });

  it('open existing adapter 也归适配器类', () => {
    const info = classifySingBoxFatal('FATAL[0000] ... open existing adapter: foo');
    expect(info.kind).toBe('tun-adapter-create');
  });

  it('DNS 下发失败单独一类', () => {
    const info = classifySingBoxFatal('FATAL[0000] ... configure tun interface: set ipv4 dns: bar');
    expect(info.kind).toBe('tun-dns');
  });

  it('tun.New 窗口内的未知错误：透传原文，不编造原因', () => {
    const raw = 'FATAL[0000] ... configure tun interface: some brand new error';
    const info = classifySingBoxFatal(raw);
    expect(info.kind).toBe('tun-other');
    expect(info.message).toContain('some brand new error');
  });

  it('非 TUN 的 FATAL：归 other 且透传原文', () => {
    const raw =
      'FATAL[0000] start service: start inbound/mixed[mixed-in]: listen tcp: bind: cannot assign requested address';
    const info = classifySingBoxFatal(raw);
    expect(info.kind).toBe('other');
    expect(info.message).toContain('bind');
  });

  it('raw 恒为剥色码后的原文', () => {
    expect(classifySingBoxFatal(REAL_FATAL).raw).not.toContain('\x1b');
  });
});

describe('sliceSinceRunStart', () => {
  const prevRun = 'FATAL[0000] configure tun interface: create adapter: STALE FROM LAST MONTH\n';
  const thisRun =
    'FATAL[0000] configure tun interface: set ipv4 address: The object already exists.';

  it('追加语义（helper O_APPEND）：只取本腿写入的尾部', () => {
    // 变异守卫：删 run 边界过滤 → 会读到上个月的残留 FATAL 并当成本次原因，本例失败。
    const full = prevRun + thisRun;
    const sliced = sliceSinceRunStart(full, Buffer.byteLength(prevRun), Buffer.byteLength(full));
    expect(sliced).toContain('set ipv4 address');
    expect(sliced).not.toContain('STALE');
  });

  it('文件被截断过（UAC / macOS wrapper 写侧）→ 现有内容全部属于本次', () => {
    // sizeNow < offset ⟹ 上次记录锚点之后文件被重建，不能再按「新增字节」切，否则会切空。
    const sliced = sliceSinceRunStart(thisRun, 999999, Buffer.byteLength(thisRun));
    expect(sliced).toContain('set ipv4 address');
  });

  it('锚点为 0（文件此前不存在）→ 全文', () => {
    expect(sliceSinceRunStart(thisRun, 0, Buffer.byteLength(thisRun))).toBe(thisRun);
  });

  it('追加写侧下「本腿零写入」→ 空串（不回落到旧内容）', () => {
    // 命名刻意点出「追加写侧」：本判据对截断写侧不成立（重复失败腿写出等长内容时会被误判成零写入），
    // 见函数 doc 的适用边界。H2 若把截断写侧接进来，必须走「整文件即本次」而不是复用本函数。
    const size = Buffer.byteLength(prevRun);
    expect(sliceSinceRunStart(prevRun, size, size)).toBe('');
  });

  it('中文/多字节内容不产生乱码残行', () => {
    const head = '看护脚本自述行：核已启动\n';
    const tail =
      'FATAL[0000] configure tun interface: set ipv4 address: The object already exists.';
    const full = head + tail;
    const sliced = sliceSinceRunStart(full, Buffer.byteLength(head), Buffer.byteLength(full));
    expect(sliced).toContain('set ipv4 address');
    expect(sliced).not.toContain('�');
  });
});
