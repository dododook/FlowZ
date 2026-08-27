import { parseMacRouteInterface } from '../mac-route-interface';

describe('parseMacRouteInterface', () => {
  it('读取 OpenVPN 拆半默认路由选出的 utun 接口', () => {
    expect(
      parseMacRouteInterface(`
   route to: 113.20.7.104
destination: default
    gateway: 10.8.0.1
  interface: utun4
`)
    ).toBe('utun4');
  });

  it('读取普通物理接口', () => {
    expect(parseMacRouteInterface('  interface: en0\n')).toBe('en0');
  });

  it('缺字段或异常接口名时返回 null', () => {
    expect(parseMacRouteInterface('gateway: 10.8.0.1')).toBeNull();
    expect(parseMacRouteInterface('interface: en0;rm')).toBeNull();
  });
});
