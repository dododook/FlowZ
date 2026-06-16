import { parseTailscaleAuthLine } from '../tailscale';

describe('parseTailscaleAuthLine', () => {
  it('抓实证格式的登录 URL + tag', () => {
    const line =
      '+0800 2026-06-16 10:42:11 INFO endpoint/tailscale[ts]: Waiting for authentication: https://login.tailscale.com/a/aad87df01719a';
    expect(parseTailscaleAuthLine(line)).toEqual({
      nodeName: 'ts',
      url: 'https://login.tailscale.com/a/aad87df01719a',
    });
  });

  it('tag 含空格/中文（节点名作 tag）', () => {
    const line = 'endpoint/tailscale[我的 TS]: Waiting for authentication: https://example.com/x';
    expect(parseTailscaleAuthLine(line)).toEqual({
      nodeName: '我的 TS',
      url: 'https://example.com/x',
    });
  });

  it('非登录行 → null', () => {
    expect(
      parseTailscaleAuthLine('endpoint/tailscale[ts]: output connection to 1.2.3.4:443')
    ).toBeNull();
    expect(
      parseTailscaleAuthLine('endpoint/wireguard[wg]: received handshake response')
    ).toBeNull();
    expect(parseTailscaleAuthLine('')).toBeNull();
  });
});
