/**
 * LinuxServiceHelper 纯逻辑单测（无 systemd / 无 socket）：
 *  - 平台门控：非 linux 安全降级（supported=false / ready=false），绝不触发 pkexec/socket。
 *  - 安装/卸载脚本生成（runtime 最脆点）：systemd unit、授权 uid 写入、enable --now、卸载对称清理。
 *  - 第一性不变量：不用 setcap、无 install-core、无 token、helper 本体 root 跑（unit 无 User=）。
 *  - linux 宿主未装态：supported=true 但 installed/ready=false（不连 socket）。
 * 真机行为（pkexec、systemctl、SO_PEERCRED setuid+ambient 拉核）属 Linux 真机必验清单，不在单测范围。
 */
import { LinuxServiceHelper } from '../LinuxServiceHelper';

// 「非 Linux 安全降级」只在非 Linux 宿主可测：helper 直接读 process.platform（无注入点）。
const describeNonLinux = process.platform === 'linux' ? describe.skip : describe;
const describeLinux = process.platform === 'linux' ? describe : describe.skip;

describe('LinuxServiceHelper', () => {
  describeNonLinux('非 Linux 平台安全降级', () => {
    const helper = new LinuxServiceHelper();

    it('getStatus 返回 supported=false 的空状态', async () => {
      const s = await helper.getStatus();
      expect(s.supported).toBe(false);
      expect(s.installed).toBe(false);
      expect(s.ready).toBe(false);
      expect(s.needsRepair).toBe(false);
      expect(s.loaded).toBeNull();
    });

    it('isReady 返回 false（不尝试连接 socket）', async () => {
      await expect(helper.isReady()).resolves.toBe(false);
    });

    it('install/uninstall 在非 Linux 报「仅 Linux 支持」', async () => {
      const i = await helper.install();
      expect(i.success).toBe(false);
      expect(i.error).toContain('Linux');
      const u = await helper.uninstall();
      expect(u.success).toBe(false);
      expect(u.error).toContain('Linux');
    });
  });

  describe('systemd unit / 安装脚本生成', () => {
    const helper = new LinuxServiceHelper() as unknown as {
      buildUnit(): string;
      buildInstallScript(src: string, uid: number, bundledCore: string): string;
      buildUninstallScript(): string;
    };

    it('unit：helper root 跑（无 User=）、ExecStart 带 socket/authfile/coredir(路径锁)、cap 不在 unit 层', () => {
      const unit = helper.buildUnit();
      expect(unit).toContain('ExecStart=/usr/local/lib/flowz/flowz-helper');
      expect(unit).toContain('--coredir=/usr/local/lib/flowz/core'); // 路径锁：helper 只跑此目录内的核
      expect(unit).toContain('RuntimeDirectory=flowz');
      expect(unit).toContain('WantedBy=multi-user.target');
      expect(unit).not.toContain('User='); // root 跑（setuid 拉 child + 穿越 userData）
      expect(unit).not.toContain('AmbientCapabilities'); // child cap 由代码赋，不在 unit
    });

    it('install：拷 helper + 播种 root 受管核(仅缺时) + 授权 uid 合并追加 + enable --now', () => {
      const s = helper.buildInstallScript(
        '/pkg/resources/linux/flowz-helper-linux',
        1000,
        '/pkg/resources/linux/sing-box'
      );
      expect(s).toContain(
        "install -D -o root -g root -m 0755 '/pkg/resources/linux/flowz-helper-linux' '/usr/local/lib/flowz/flowz-helper'"
      );
      // 播种 root 受管核：仅当尚无核（重装/修复不覆盖已 install-core 更新的核）
      expect(s).toContain("if [ ! -x '/usr/local/lib/flowz/core/sing-box' ]");
      expect(s).toContain("'/pkg/resources/linux/sing-box' '/usr/local/lib/flowz/core/sing-box'");
      expect(s).toContain('libcronet.so'); // 配套随核播种
      // 授权 uid **合并追加**（不覆写 → 多用户/repair 不互抹）
      expect(s).toContain("grep -qxF '1000'");
      expect(s).toContain(">> '/var/lib/flowz/authorized-uids'");
      expect(s).toContain('systemctl enable --now flowz-helper.service');
      // 第一性不变量
      expect(s).not.toContain('setcap'); // 能力挂进程 ambient，不 setcap 二进制
      expect(s).not.toContain('/opt/FlowZ'); // 避开 electron-builder deb 应用目录
      expect(s.toLowerCase()).not.toContain('token'); // SO_PEERCRED 鉴权，无 token
    });

    it('uninstall：disable --now + 删受管安装根/状态/运行目录（对称、不碰 /opt/FlowZ）', () => {
      const s = helper.buildUninstallScript();
      expect(s).toContain('systemctl disable --now flowz-helper.service');
      expect(s).toContain('/etc/systemd/system/flowz-helper.service');
      expect(s).toContain("rm -rf '/usr/local/lib/flowz'"); // 整删受管安装根(helper+root 核)
      expect(s).toContain('/var/lib/flowz');
      expect(s).toContain('/run/flowz');
      expect(s).toContain('systemctl daemon-reload');
      expect(s).not.toContain('/opt/FlowZ');
    });
  });

  describeLinux('Linux 宿主未装态', () => {
    const helper = new LinuxServiceHelper();

    it('未装时 getStatus：supported=true、installed/ready=false、mac 专属字段默认', async () => {
      const s = await helper.getStatus();
      expect(s.supported).toBe(true);
      expect(s.installed).toBe(false);
      expect(s.ready).toBe(false);
      expect(s.backgroundDisabled).toBe(false);
      expect(s.pathMismatch).toBe(false);
      expect(s.installedSingboxPath).toBeNull();
    });

    it('isReady 返回 false（未装不连 socket）', async () => {
      await expect(helper.isReady()).resolves.toBe(false);
    });

    it('route*/restoreDefaultRoute 为 no-op（Linux 不需要）', async () => {
      await expect(helper.routeAdd('flowz-tun', ['10.0.0.0/8'])).resolves.toEqual({
        ok: false,
        error: 'unsupported',
      });
      await expect(helper.restoreDefaultRoute('1.2.3.4')).resolves.toEqual({
        ok: false,
        error: 'unsupported',
      });
    });
  });

  describe('installCore 协议（换核免密 socket）', () => {
    it('发出 [install-core, srcDir, sha256(srcDir/sing-box)] 三元组', async () => {
      const os = require('os');
      const fsSync = require('fs');
      const pathMod = require('path');
      const dir = fsSync.mkdtempSync(pathMod.join(os.tmpdir(), 'flowz-installcore-'));
      fsSync.writeFileSync(pathMod.join(dir, 'sing-box'), 'CORE-BYTES');
      const helper = new LinuxServiceHelper();
      const sent: string[][] = [];
      (
        helper as unknown as { sendCommand: (r: string[], t: number) => Promise<string> }
      ).sendCommand = async (rest: string[]) => {
        sent.push(rest);
        return 'OK installed';
      };
      const r = await helper.installCore(dir);
      expect(r).toEqual({ ok: true });
      expect(sent).toHaveLength(1);
      expect(sent[0][0]).toBe('install-core');
      expect(sent[0][1]).toBe(dir);
      expect(sent[0][2]).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
      fsSync.rmSync(dir, { recursive: true, force: true });
    });
  });
});
