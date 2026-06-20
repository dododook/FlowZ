/**
 * StatsService「流式门控」单测（§3-B：clash_api 轮询迁 sing-box 1.14 管理 API gRPC 流后）。覆盖：
 *  1) 窗口可见性谓词（isWindowVisible）：无可见窗口时收到流帧仍更新内部快照，但跳过 broadcast（onUpdate/onConnections）。
 *  2) 连接页 watcher 引用计数：仅 connectionsWatchers>0 时才订阅 Connections 流（0→1 订阅、→0 退订 stop）。
 *  3) Status 帧字段映射（uplink→uploadSpeed / connectionsIn+Out→activeConnections 等，speed 由 server 直给）。
 *  4) Connections 事件流维护（reset 清空 / NEW 加 / UPDATE 改 / CLOSED 删）→ trim 映射广播。
 * 经 mock SingBoxApiClient 捕获 subscribeStatus/subscribeConnections 的回调，测试同步 push 流帧驱动（无 fake timer）。
 */
import { StatsService } from '../StatsService';
import type { TrafficStats, ConnectionsSnapshot } from '../../../shared/types';
import type {
  SingBoxApiClient,
  SingBoxStatus,
  SingBoxConnectionEvents,
} from '../singbox-api-client';

/**
 * mock SingBoxApiClient：捕获订阅回调供测试 push 流帧；记录订阅/退订次数（验 watcher 门控）。
 * subscribe* 返回 stop 句柄；调用后回调置 null + statusStopCount/connStopCount++。
 */
function makeMockClient() {
  let statusCb: ((s: SingBoxStatus) => void) | null = null;
  let connCb: ((e: SingBoxConnectionEvents) => void) | null = null;
  const calls = {
    subscribeStatus: 0,
    subscribeConnections: 0,
    statusStop: 0,
    connStop: 0,
  };
  const client = {
    subscribeStatus: jest.fn((_ns: number, cb: (s: SingBoxStatus) => void) => {
      calls.subscribeStatus++;
      statusCb = cb;
      return () => {
        calls.statusStop++;
        statusCb = null;
      };
    }),
    subscribeConnections: jest.fn((_ns: number, cb: (e: SingBoxConnectionEvents) => void) => {
      calls.subscribeConnections++;
      connCb = cb;
      return () => {
        calls.connStop++;
        connCb = null;
      };
    }),
  };
  return {
    client: client as unknown as SingBoxApiClient,
    calls,
    pushStatus: (s: SingBoxStatus) => statusCb?.(s),
    pushConn: (e: SingBoxConnectionEvents) => connCb?.(e),
    hasStatusCb: () => statusCb !== null,
    hasConnCb: () => connCb !== null,
  };
}

/** 一条 gRPC Connection（含隐私/扩展字段，验 trim 字段裁剪）。 */
const RAW_CONN = {
  id: 'conn-1',
  inboundType: 'Tun',
  network: 'tcp',
  source: '192.168.1.10:54321',
  destination: '93.184.216.34:443',
  domain: 'example.com',
  rule: 'rule_set=>proxy',
  chainList: ['proxy-selector', 'hk-node'],
  uplinkTotal: '12345',
  downlinkTotal: '67890',
  processInfo: { processPath: '/usr/bin/curl' },
};

const STATUS: SingBoxStatus = {
  uplink: '500',
  downlink: '1500',
  uplinkTotal: '1000',
  downlinkTotal: '2000',
  connectionsIn: 3,
  connectionsOut: 2,
};

function setup(opts: { withVisible?: boolean; visible?: boolean } = {}) {
  const onUpdate = jest.fn<void, [TrafficStats]>();
  const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
  const mock = makeMockClient();
  const isWindowVisible = opts.withVisible ? jest.fn(() => opts.visible ?? true) : undefined;
  const service = new StatsService(onUpdate, () => mock.client, onConnections, isWindowVisible);
  return { service, onUpdate, onConnections, mock, isWindowVisible };
}

describe('StatsService 流式门控（gRPC streams）', () => {
  describe('start/stop 订阅 Status 流', () => {
    it('start 订阅 Status 流；stop 退订并清零广播', () => {
      const { service, onUpdate, mock } = setup();
      service.start();
      expect(mock.calls.subscribeStatus).toBe(1);
      expect(mock.hasStatusCb()).toBe(true);

      service.stop();
      expect(mock.calls.statusStop).toBe(1);
      // stop 清零广播一次（全 0）
      const calls = onUpdate.mock.calls;
      const last = calls[calls.length - 1]?.[0];
      expect(last).toMatchObject({
        uploadSpeed: 0,
        downloadSpeed: 0,
        totalUpload: 0,
        totalDownload: 0,
      });
    });

    it('start 幂等：重复 start 不重复订阅', () => {
      const { service, mock } = setup();
      service.start();
      service.start();
      expect(mock.calls.subscribeStatus).toBe(1);
    });
  });

  describe('Status 帧字段映射', () => {
    it('uplink→uploadSpeed / downlink→downloadSpeed / totals / connectionsIn+Out→activeConnections', () => {
      const { service, onUpdate, mock } = setup({ withVisible: true, visible: true });
      service.start();
      mock.pushStatus(STATUS);

      expect(onUpdate).toHaveBeenCalledTimes(1);
      const s = onUpdate.mock.calls[0][0];
      expect(s.uploadSpeed).toBe(500); // server 直给速率，无需本地 delta
      expect(s.downloadSpeed).toBe(1500);
      expect(s.totalUpload).toBe(1000);
      expect(s.totalDownload).toBe(2000);
      expect(s.activeConnections).toBe(5); // connectionsIn(3)+connectionsOut(2)
    });
  });

  describe('可见性门控（isWindowVisible）', () => {
    it('不可见时 Status 帧更新快照但不广播 onUpdate', () => {
      const { service, onUpdate, mock } = setup({ withVisible: true, visible: false });
      service.start();
      mock.pushStatus(STATUS);

      expect(onUpdate).not.toHaveBeenCalled(); // 跳过广播
      // 快照仍更新（可见后下一帧即广播最新）
      expect(service.getSnapshot().activeConnections).toBe(5);
      expect(service.getSnapshot().totalUpload).toBe(1000);
    });

    it('不可见时连接事件帧维护 map 但不广播 onConnections', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: false });
      service.start();
      service.addConnectionsWatcher();
      mock.pushConn({ reset: true, events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });

      expect(onConnections).not.toHaveBeenCalled(); // 跳过广播
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1); // map 仍维护
    });
  });

  describe('连接 watcher 门控（订阅 Connections 流）', () => {
    it('start 后无 watcher：不订阅 Connections 流', () => {
      const { service, mock } = setup();
      service.start();
      expect(mock.calls.subscribeConnections).toBe(0);
    });

    it('addConnectionsWatcher 0→1：订阅 Connections 流；→0：退订 stop', () => {
      const { service, mock } = setup();
      service.start();
      service.addConnectionsWatcher();
      expect(mock.calls.subscribeConnections).toBe(1);
      expect(mock.hasConnCb()).toBe(true);

      service.removeConnectionsWatcher();
      expect(mock.calls.connStop).toBe(1);
      expect(mock.hasConnCb()).toBe(false);
    });

    it('多 watcher：仅首个订阅、仅末个退订（引用计数）', () => {
      const { service, mock } = setup();
      service.start();
      service.addConnectionsWatcher(); // 0→1 订阅
      service.addConnectionsWatcher(); // 1→2 不重订
      expect(mock.calls.subscribeConnections).toBe(1);

      service.removeConnectionsWatcher(); // 2→1 不退订
      expect(mock.calls.connStop).toBe(0);
      service.removeConnectionsWatcher(); // 1→0 退订
      expect(mock.calls.connStop).toBe(1);
    });

    it('start 前 add watcher：start 时一并订阅 Connections 流（重启后仍 mount 场景）', () => {
      const { service, mock } = setup();
      service.addConnectionsWatcher(); // 未 start，仅计数
      expect(mock.calls.subscribeConnections).toBe(0);
      service.start();
      expect(mock.calls.subscribeConnections).toBe(1);
    });
  });

  describe('Connections 事件流维护（reset/NEW/UPDATE/CLOSED）', () => {
    it('reset+NEW 全量建表 → trim 映射广播（字段裁剪正确）', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: true });
      service.start();
      service.addConnectionsWatcher();
      mock.pushConn({ reset: true, events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });

      expect(onConnections).toHaveBeenCalledTimes(1);
      const snap = onConnections.mock.calls[0][0];
      expect(snap.connections).toHaveLength(1);
      const e = snap.connections[0];
      expect(e.id).toBe('conn-1');
      expect(e.metadata?.host).toBe('example.com'); // ← domain
      expect(e.metadata?.destinationIP).toBe('93.184.216.34'); // ← 拆 destination
      expect(e.metadata?.sourceIP).toBe('192.168.1.10'); // ← 拆 source
      expect(e.metadata?.processPath).toBe('/usr/bin/curl');
      expect(e.upload).toBe(12345);
      expect(e.download).toBe(67890);
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);
    });

    it('CLOSED 删除连接', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: true });
      service.start();
      service.addConnectionsWatcher();
      mock.pushConn({ events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);

      mock.pushConn({ events: [{ type: 'CLOSED', id: 'conn-1' }] });
      const calls = onConnections.mock.calls;
      const snap = calls[calls.length - 1]?.[0];
      expect(snap?.connections).toHaveLength(0);
    });

    it('UPDATE 改字段（同 id 覆盖）', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: true });
      service.start();
      service.addConnectionsWatcher();
      mock.pushConn({ events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });
      mock.pushConn({
        events: [
          {
            type: 'UPDATE',
            id: 'conn-1',
            connection: { ...RAW_CONN, uplinkTotal: '99999' },
          },
        ],
      });
      const calls = onConnections.mock.calls;
      const snap = calls[calls.length - 1]?.[0];
      expect(snap?.connections[0].upload).toBe(99999);
    });

    it('reset=true 清空旧表后按本帧 events 重建', () => {
      const { service, mock } = setup({ withVisible: true, visible: true });
      service.start();
      service.addConnectionsWatcher();
      mock.pushConn({ events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });
      mock.pushConn({
        reset: true,
        events: [{ type: 'NEW', id: 'conn-2', connection: { ...RAW_CONN, id: 'conn-2' } }],
      });
      const conns = service.getConnectionsSnapshot().connections;
      expect(conns).toHaveLength(1);
      expect(conns[0].id).toBe('conn-2');
    });
  });

  describe('计数钳制（removeConnectionsWatcher）', () => {
    it('计数为 0 时 remove 后仍为 0（不变负）', () => {
      const { service } = setup();
      service.start();
      service.removeConnectionsWatcher();
      service.removeConnectionsWatcher();
      expect((service as any).connectionsWatchers).toBe(0);
    });
  });

  describe('缺省行为（未注入 isWindowVisible）', () => {
    it('缺省（无谓词）：Status 帧直接广播（不门控）', () => {
      const onUpdate = jest.fn<void, [TrafficStats]>();
      const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
      const mock = makeMockClient();
      const service = new StatsService(onUpdate, () => mock.client, onConnections); // 无第 4 参
      service.start();
      mock.pushStatus(STATUS);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    });
  });
});
