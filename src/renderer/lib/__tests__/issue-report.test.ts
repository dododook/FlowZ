import {
  formatSystemInfo,
  formatProxyMode,
  buildBugReportBody,
  buildBugReportUrl,
} from '../issue-report';

describe('issue-report', () => {
  describe('formatSystemInfo', () => {
    it('maps platform to friendly name + arch + release', () => {
      expect(formatSystemInfo({ platform: 'darwin', arch: 'arm64', osVersion: '24.5.0' })).toBe(
        'macOS arm64 (24.5.0)'
      );
      expect(formatSystemInfo({ platform: 'win32', arch: 'x64', osVersion: '10.0.22631' })).toBe(
        'Windows x64 (10.0.22631)'
      );
    });

    it('omits missing parts and passes through unknown platform', () => {
      expect(formatSystemInfo({ platform: 'win32', arch: 'x64' })).toBe('Windows x64');
      expect(formatSystemInfo({ platform: 'freebsd', arch: 'x64' })).toBe('freebsd x64');
      expect(formatSystemInfo({})).toBe('');
    });
  });

  describe('formatProxyMode', () => {
    it('maps known modes to Chinese labels', () => {
      expect(formatProxyMode({ proxyModeType: 'systemProxy' })).toBe('系统代理');
      expect(formatProxyMode({ proxyModeType: 'tun' })).toBe('TUN');
    });
    it('returns empty for missing and passes through unknown', () => {
      expect(formatProxyMode({})).toBe('');
      expect(formatProxyMode({ proxyModeType: 'mixed' })).toBe('mixed');
    });
  });

  describe('buildBugReportBody', () => {
    it('fills env values and keeps the section scaffold', () => {
      const body = buildBugReportBody({
        appVersion: '4.0.1',
        platform: 'darwin',
        arch: 'arm64',
        osVersion: '24.5.0',
        singBoxVersion: '1.10.0',
        proxyModeType: 'tun',
      });
      expect(body).toContain('- FlowZ 版本：4.0.1');
      expect(body).toContain('- 系统 + 架构：macOS arm64 (24.5.0)');
      expect(body).toContain('- sing-box 内核版本：1.10.0');
      expect(body).toContain('- 代理模式：TUN');
      expect(body).toContain('## 问题描述');
      expect(body).toContain('## 原始日志（最关键）');
      expect(body).toContain('## 旁证（选填，但往往是定位关键）');
    });

    it('tolerates fully missing env (manual-fill placeholders)', () => {
      const body = buildBugReportBody({});
      expect(body).toContain('- FlowZ 版本：');
      expect(body).toContain('- 系统 + 架构：');
      expect(body).toContain('- 代理模式：');
    });
  });

  describe('buildBugReportUrl', () => {
    it('builds a new-issue URL with title/labels/body and trims trailing slashes', () => {
      const url = buildBugReportUrl('https://github.com/dododook/FlowZ/', { appVersion: '4.0.1' });
      expect(url.startsWith('https://github.com/dododook/FlowZ/issues/new?')).toBe(true);
      const qs = new URLSearchParams(url.split('?')[1]);
      expect(qs.get('title')).toBe('[Bug] ');
      expect(qs.get('labels')).toBe('bug');
      expect(qs.get('body')).toContain('- FlowZ 版本：4.0.1');
    });
  });
});
