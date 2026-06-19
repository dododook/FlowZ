import { deriveSpineVisual } from '../spine-state';

describe('deriveSpineVisual — 导流脊三态矩阵', () => {
  it('离线：整条灰睡，端点不提亮', () => {
    expect(deriveSpineVisual(false, false)).toEqual({
      youDotLit: false,
      leg1: 'idle',
      leg2: 'idle',
      internet: 'muted',
    });
  });

  it('离线时忽略 degraded（离线的 error 与代理路径无关）', () => {
    expect(deriveSpineVisual(false, true)).toEqual({
      youDotLit: false,
      leg1: 'idle',
      leg2: 'idle',
      internet: 'muted',
    });
  });

  it('已连健康：两段 flow，Internet 端点 success（已抵达，低强度绿）', () => {
    expect(deriveSpineVisual(true, false)).toEqual({
      youDotLit: true,
      leg1: 'flow',
      leg2: 'flow',
      internet: 'success',
    });
  });

  it('降级：leg1 仍 flow（核在）、leg2 fault、Internet 端点 warning', () => {
    expect(deriveSpineVisual(true, true)).toEqual({
      youDotLit: true,
      leg1: 'flow',
      leg2: 'fault',
      internet: 'warning',
    });
  });
});
