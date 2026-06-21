/**
 * StatsService「流式门控」单测（§3-B：clash_api 轮询迁 sing-box 1.14 管理 API gRPC 流后）。覆盖：
 *  1) 窗口可见性谓词（isWindowVisible）：无可见窗口时收到流帧仍更新内部快照，但跳过 broadcast（onUpdate/onConnections）。
 *  2) 连接流订阅跟随 started（代理运行即订阅，不再 gate by watcher）；退订只在 stop。
 *  3) Status 帧字段映射（uplink→uploadSpeed / connectionsIn+Out→activeConnections 等，speed 由 server 直给）。
 *  4) Connections 事件流维护（reset 清空 / NEW 加 / UPDATE 累加 delta / CLOSED 删）→ trim 映射广播。
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
 * mock SingBoxApiClient：捕获订阅回调供测试 push 流帧；记录订阅/退订次数（验订阅跟随 started）。
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
    it('uplink→uploadSpeed / downlink→downloadSpeed / totals（activeConnections 改由 Connections 流维护）', () => {
      const { service, onUpdate, mock } = setup({ withVisible: true, visible: true });
      service.start();
      mock.pushStatus(STATUS);

      expect(onUpdate).toHaveBeenCalledTimes(1);
      const s = onUpdate.mock.calls[0][0];
      expect(s.uploadSpeed).toBe(500); // server 直给速率，无需本地 delta
      expect(s.downloadSpeed).toBe(1500);
      expect(s.totalUpload).toBe(1000);
      expect(s.totalDownload).toBe(2000);
      // activeConnections 不再取 Status 的 connectionsIn/Out（核 1.14 实测不填）→ 无连接帧时为 0；真值见下方用例。
      expect(s.activeConnections).toBe(0);
    });

    it('activeConnections 取自 Connections 流 connMap.size（非 Status 的 connectionsIn/Out=5）', () => {
      const { service, onUpdate, mock } = setup({ withVisible: true, visible: true });
      service.start();
      mock.pushConn({
        reset: true,
        events: [
          { type: 'NEW', id: 'conn-1', connection: RAW_CONN },
          { type: 'NEW', id: 'conn-2', connection: { ...RAW_CONN, id: 'conn-2' } },
        ],
      });
      mock.pushStatus(STATUS); // Status onUpdate 广播 snapshot，其 activeConnections 取自 connMap.size
      const last = onUpdate.mock.calls[onUpdate.mock.calls.length - 1][0];
      expect(last.activeConnections).toBe(2);
    });
  });

  describe('可见性门控（isWindowVisible）', () => {
    it('不可见时 Status 帧更新快照但不广播 onUpdate', () => {
      const { service, onUpdate, mock } = setup({ withVisible: true, visible: false });
      service.start();
      mock.pushStatus(STATUS);

      expect(onUpdate).not.toHaveBeenCalled(); // 跳过广播
      // 快照仍更新（可见后下一帧即广播最新）；activeConnections 不再来自 Status，此处只验总量。
      expect(service.getSnapshot().totalUpload).toBe(1000);
    });

    it('不可见时连接事件帧维护 map 但不广播 onConnections', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: false });
      service.start();
      mock.pushConn({ reset: true, events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });

      expect(onConnections).not.toHaveBeenCalled(); // 跳过广播
      // 不可见时只维护 connMap、跳过列表物化（省全量重建）；map 仍有该连接，可见后下一帧即物化推送。
      expect((service as any).connMap.size).toBe(1);
    });
  });

  describe('连接流订阅跟随 started（订阅 Connections 流）', () => {
    it('start 即订阅 Connections 流（跟随 started）', () => {
      const { service, mock } = setup();
      service.start();
      expect(mock.calls.subscribeConnections).toBe(1);
    });

    it('start 幂等：重复 start 不重复订阅 Connections', () => {
      const { service, mock } = setup();
      service.start();
      service.start();
      expect(mock.calls.subscribeConnections).toBe(1);
    });

    it('退订只在 stop（运行期连接流一直开着）', () => {
      const { service, mock } = setup();
      service.start();
      expect(mock.calls.subscribeConnections).toBe(1); // start 即订阅
      expect(mock.hasConnCb()).toBe(true);
      expect(mock.calls.connStop).toBe(0); // 运行期不退订
      service.stop();
      expect(mock.calls.connStop).toBe(1); // 仅 stop 退订
    });
  });

  describe('Connections 事件流维护（reset/NEW/UPDATE/CLOSED）', () => {
    it('reset+NEW 全量建表 → trim 映射广播（字段裁剪正确）', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: true });
      service.start();
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
      mock.pushConn({ events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] });
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);

      mock.pushConn({ events: [{ type: 'CLOSED', id: 'conn-1' }] });
      const calls = onConnections.mock.calls;
      const snap = calls[calls.length - 1]?.[0];
      expect(snap?.connections).toHaveLength(0);
    });

    it('UPDATE 累加 delta 到既有条目 totals（实测 UPDATE 无 connection、仅带 delta）', () => {
      const { service, onConnections, mock } = setup({ withVisible: true, visible: true });
      service.start();
      mock.pushConn({ events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }] }); // totals 12345/67890
      mock.pushConn({
        events: [{ type: 'UPDATE', id: 'conn-1', uplinkDelta: '1000', downlinkDelta: '2000' }],
      });
      const calls = onConnections.mock.calls;
      const snap = calls[calls.length - 1]?.[0];
      expect(snap?.connections[0].upload).toBe(13345); // 12345 + 1000 累加（非覆盖）
      expect(snap?.connections[0].download).toBe(69890); // 67890 + 2000
    });

    it('UPDATE 先于 NEW（漏收 NEW）：带 connection 时兜底补建条目', () => {
      const { service, mock } = setup({ withVisible: true, visible: true });
      service.start();
      mock.pushConn({ events: [{ type: 'UPDATE', id: 'conn-1', connection: RAW_CONN }] });
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);
    });

    it('reset=true 清空旧表后按本帧 events 重建', () => {
      const { service, mock } = setup({ withVisible: true, visible: true });
      service.start();
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

  // E-1：崩溃自动重启换新 api client 后，必须重订阅到新 client（否则 Status 流句柄仍指向死旧 client 冻结）。
  describe('resubscribe 重订阅到新 client（崩溃重启路径，E-1）', () => {
    /** 可切换 client 的 service：getApiClient 返回 currentRef.client，模拟 ProxyManager 崩溃重启换 client。 */
    function setupSwitchable(opts: { withVisible?: boolean; visible?: boolean } = {}) {
      const onUpdate = jest.fn<void, [TrafficStats]>();
      const onConnections = jest.fn<void, [ConnectionsSnapshot]>();
      const ref = { mock: makeMockClient() };
      const isWindowVisible = opts.withVisible ? jest.fn(() => opts.visible ?? true) : undefined;
      const service = new StatsService(
        onUpdate,
        () => ref.mock.client,
        onConnections,
        isWindowVisible
      );
      return { service, onUpdate, onConnections, ref, swap: () => (ref.mock = makeMockClient()) };
    }

    it('换 client 后 resubscribe：旧流退订、Status 重订阅到新 client（started 仍 true 时不被幂等闸门挡）', () => {
      const { service, ref, swap } = setupSwitchable();
      service.start();
      const oldMock = ref.mock;
      expect(oldMock.calls.subscribeStatus).toBe(1);
      expect(oldMock.hasStatusCb()).toBe(true);

      // 模拟崩溃重启：ProxyManager 杀旧 client 建新 client（getApiClient 此后返回新 mock）。started 仍 true（未经 stop）。
      swap();
      const newMock = ref.mock;

      service.resubscribe();
      // 旧 client 的 Status 流被退订（句柄 cancel）
      expect(oldMock.calls.statusStop).toBe(1);
      // 新 client 被重订阅 Status
      expect(newMock.calls.subscribeStatus).toBe(1);
      expect(newMock.hasStatusCb()).toBe(true);
    });

    it('start() 在 started=true 时幂等不重订阅（对照：证明必须用 resubscribe 而非 start）', () => {
      const { service, ref, swap } = setupSwitchable();
      service.start();
      const oldMock = ref.mock;
      swap();
      const newMock = ref.mock;

      service.start(); // 幂等闸门 return：不退旧、不订阅新
      expect(oldMock.calls.statusStop).toBe(0);
      expect(newMock.calls.subscribeStatus).toBe(0);
    });

    it('resubscribe 后新 client 的 Status 帧能广播（流真的活在新 client 上）', () => {
      const { service, onUpdate, ref, swap } = setupSwitchable({
        withVisible: true,
        visible: true,
      });
      service.start();
      swap();
      const newMock = ref.mock;
      service.resubscribe();
      onUpdate.mockClear();

      newMock.pushStatus(STATUS); // 新 client 推帧
      expect(onUpdate).toHaveBeenCalledTimes(1);
      // Status 帧已在新 client 上广播（验 Status-owned 字段；activeConnections 改由 Connections 流维护）
      expect(onUpdate.mock.calls[0][0].uploadSpeed).toBe(500);
    });

    it('resubscribe 始终重订阅 Connections 到新 client（跟随 started）', () => {
      const { service, ref, swap } = setupSwitchable();
      service.start();
      const oldMock = ref.mock;
      expect(oldMock.calls.subscribeConnections).toBe(1); // start 即订阅旧 Connections

      swap();
      const newMock = ref.mock;
      service.resubscribe();

      expect(oldMock.calls.connStop).toBe(1); // 旧 Connections 退订
      expect(newMock.calls.subscribeStatus).toBe(1);
      expect(newMock.calls.subscribeConnections).toBe(1); // 新 Connections 订阅
    });

    it('resubscribe 作首次启动（started=false）等效 start：订阅 Status', () => {
      const { service, ref } = setupSwitchable();
      service.resubscribe(); // 未先 start
      expect(ref.mock.calls.subscribeStatus).toBe(1);
      expect((service as any).started).toBe(true);
    });

    // F2：resubscribe 须把 snapshot 归零并广播（对齐 stop()），避免重连窗口首页计数显旧值、连接列表已空的不一致。
    it('resubscribe 归零 snapshot 并广播（onUpdate 全 0 + onConnections 空）', () => {
      const { service, onUpdate, onConnections, ref, swap } = setupSwitchable({
        withVisible: true,
        visible: true,
      });
      service.start();
      // 先灌入非零状态（速率/总量/连接数 + 一条连接）
      ref.mock.pushStatus(STATUS);
      ref.mock.pushConn({
        reset: true,
        events: [{ type: 'NEW', id: 'conn-1', connection: RAW_CONN }],
      });
      expect(service.getSnapshot().activeConnections).toBe(1); // = connMap.size（一条连接），非 Status 的 connectionsIn/Out
      expect(service.getConnectionsSnapshot().connections).toHaveLength(1);

      onUpdate.mockClear();
      onConnections.mockClear();
      swap(); // 崩溃重启换 client
      service.resubscribe();

      // snapshot 归零
      const snap = service.getSnapshot();
      expect(snap).toMatchObject({
        uploadSpeed: 0,
        downloadSpeed: 0,
        totalUpload: 0,
        totalDownload: 0,
        activeConnections: 0,
      });
      // 广播归零的 stats（重连窗口首页立即显 0，不显旧值）
      const lastStats = onUpdate.mock.calls[onUpdate.mock.calls.length - 1]?.[0];
      expect(lastStats).toMatchObject({ activeConnections: 0, totalUpload: 0 });
      // 广播空连接快照（与归零计数一致）
      const lastConns = onConnections.mock.calls[onConnections.mock.calls.length - 1]?.[0];
      expect(lastConns?.connections).toHaveLength(0);
      expect(service.getConnectionsSnapshot().connections).toHaveLength(0);
    });

    // R3-3(a)：归零广播须无条件（对齐 stop()），不受可见性门控——窗口不可见时仍广播归零帧，
    // 否则崩溃重启后隐藏窗口再恢复，首页仍残留旧值（resubscribe 走直广播，绕过 isWindowVisible 门控）。
    it('窗口不可见（isWindowVisible→false）时 resubscribe 仍无条件归零广播', () => {
      const { service, onUpdate, onConnections, ref, swap } = setupSwitchable({
        withVisible: true,
        visible: false,
      });
      service.start();
      ref.mock.pushStatus(STATUS); // 灌非零快照（不可见→pushStatus 不广播，但更新快照）
      expect(service.getSnapshot().totalUpload).toBe(1000); // 非零快照（activeConnections 改由 Connections 流，无连接帧时为 0）

      onUpdate.mockClear();
      onConnections.mockClear();
      swap();
      service.resubscribe();

      // 不可见仍广播归零帧（与 stop() 同语义，绕过可见性门控）
      const lastStats = onUpdate.mock.calls[onUpdate.mock.calls.length - 1]?.[0];
      expect(lastStats).toMatchObject({ activeConnections: 0, totalUpload: 0, downloadSpeed: 0 });
      const lastConns = onConnections.mock.calls[onConnections.mock.calls.length - 1]?.[0];
      expect(lastConns?.connections).toHaveLength(0);
    });

    // R3-3(b)：resubscribe 期间归零帧只广播一次（防未来误加多次推送 regression）。
    // mockClear 后到 resubscribe 返回（新流尚未推帧）期间，onUpdate 恰好 1 次（归零）、onConnections 恰好 1 次（空）。
    it('resubscribe 归零帧广播次数恰为 1（不多推）', () => {
      const { service, onUpdate, onConnections, ref, swap } = setupSwitchable({
        withVisible: true,
        visible: true,
      });
      service.start();
      ref.mock.pushStatus(STATUS);

      onUpdate.mockClear();
      onConnections.mockClear();
      swap();
      service.resubscribe(); // 新 client 流已订阅但尚未 pushStatus

      expect(onUpdate).toHaveBeenCalledTimes(1); // 仅归零帧
      expect(onConnections).toHaveBeenCalledTimes(1); // 仅空连接帧
    });
  });
});
