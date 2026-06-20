/**
 * 远程实例 secret「写时合并 / 读时剥离」纯逻辑单测（零网络）。
 */
import { stripRemoteSecrets, mergeRemoteSecrets } from '../remote-instance-secrets';
import type { UserConfig, RemoteInstance } from '../../../shared/types';

function cfg(remoteInstances?: RemoteInstance[]): UserConfig {
  return { remoteInstances } as unknown as UserConfig;
}

describe('stripRemoteSecrets（CONFIG_GET：剥 secret 明文，留 hasSecret 占位）', () => {
  it('有 secret → 剥明文，hasSecret=true', () => {
    const out = stripRemoteSecrets(
      cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'topsecret' }])
    );
    const inst = out.remoteInstances![0] as RemoteInstance;
    expect(inst.secret).toBeUndefined();
    expect(inst.hasSecret).toBe(true);
  });

  it('无 secret / 空串 secret → hasSecret=false', () => {
    const out = stripRemoteSecrets(
      cfg([
        { id: 'a', name: 'A', host: 'h', port: 1 },
        { id: 'b', name: 'B', host: 'h', port: 2, secret: '' },
      ])
    );
    expect((out.remoteInstances![0] as RemoteInstance).hasSecret).toBe(false);
    expect((out.remoteInstances![1] as RemoteInstance).hasSecret).toBe(false);
  });

  it('其它字段（tls/dashboardUrl/host/port/name）保留', () => {
    const out = stripRemoteSecrets(
      cfg([
        {
          id: 'a',
          name: 'A',
          host: 'h',
          port: 9090,
          secret: 's',
          tls: { skipVerify: true },
          dashboardUrl: 'https://x/dashboard/',
        },
      ])
    );
    const inst = out.remoteInstances![0] as RemoteInstance;
    expect(inst).toMatchObject({
      id: 'a',
      name: 'A',
      host: 'h',
      port: 9090,
      tls: { skipVerify: true },
      dashboardUrl: 'https://x/dashboard/',
    });
  });

  it('无 remoteInstances → 原样返回（不爆）', () => {
    expect(stripRemoteSecrets(cfg()).remoteInstances).toBeUndefined();
    expect(stripRemoteSecrets(cfg([]).remoteInstances ? cfg([]) : cfg([])).remoteInstances).toEqual(
      []
    );
  });
});

describe('mergeRemoteSecrets（CONFIG_SAVE：渲染端未给 secret → 沿用已存，防被清零）', () => {
  it('incoming secret 空 + existing 有 → 沿用 existing secret', () => {
    const incoming = cfg([{ id: 'a', name: 'A2', host: 'h', port: 1 }]); // 改了名，没带 secret
    const existing = cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'kept' }]);
    const out = mergeRemoteSecrets(incoming, existing);
    expect(out.remoteInstances![0].secret).toBe('kept');
    expect(out.remoteInstances![0].name).toBe('A2'); // 其它字段用 incoming 新值
  });

  it('incoming 给了新 secret → 用新值（更新）', () => {
    const incoming = cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'newsecret' }]);
    const existing = cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'old' }]);
    const out = mergeRemoteSecrets(incoming, existing);
    expect(out.remoteInstances![0].secret).toBe('newsecret');
  });

  it('新增实例（existing 无此 id）→ 用 incoming secret（可空=免认证）', () => {
    const incoming = cfg([{ id: 'new', name: 'N', host: 'h', port: 1 }]);
    const out = mergeRemoteSecrets(incoming, cfg([]));
    expect(out.remoteInstances![0].secret).toBeUndefined();
  });

  it('剔除渲染端带回的 hasSecret 占位字段（不持久化）', () => {
    const incoming = cfg([
      { id: 'a', name: 'A', host: 'h', port: 1, hasSecret: true } as RemoteInstance,
    ]);
    const existing = cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'kept' }]);
    const out = mergeRemoteSecrets(incoming, existing);
    expect((out.remoteInstances![0] as RemoteInstance).hasSecret).toBeUndefined();
    expect(out.remoteInstances![0].secret).toBe('kept');
  });

  it('删除实例（incoming 不含某 id）→ 该实例随数组移除（secret 不复活）', () => {
    const incoming = cfg([{ id: 'b', name: 'B', host: 'h', port: 2 }]);
    const existing = cfg([
      { id: 'a', name: 'A', host: 'h', port: 1, secret: 'sa' },
      { id: 'b', name: 'B', host: 'h', port: 2, secret: 'sb' },
    ]);
    const out = mergeRemoteSecrets(incoming, existing);
    expect(out.remoteInstances).toHaveLength(1);
    expect(out.remoteInstances![0].id).toBe('b');
    expect(out.remoteInstances![0].secret).toBe('sb');
  });

  it('roundtrip：strip 后再 merge 回 existing → secret 完整保留（核心不变量）', () => {
    const stored = cfg([{ id: 'a', name: 'A', host: 'h', port: 1, secret: 'kept' }]);
    const forRenderer = stripRemoteSecrets(stored); // 下发给渲染端（无明文）
    // 渲染端原样回写（含 hasSecret，无 secret）
    const out = mergeRemoteSecrets(forRenderer, stored);
    expect(out.remoteInstances![0].secret).toBe('kept');
    expect((out.remoteInstances![0] as RemoteInstance).hasSecret).toBeUndefined();
  });
});
