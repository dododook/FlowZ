// FlowZ Windows 提权 helper（生产版）：LocalSystem Windows 服务，监听 token 鉴权的命名管道，按行协议驱动 sing-box 启停。
// 装一次（安装期一次 UAC）后，普通用户 app 经命名管道零提权启停 sing-box —— 切节点/停止/退出/崩溃回收均免再次 UAC。
//
// 本文件在语义上精确镜像生产版 macOS helper（helper/helper.go）：行协议、token 鉴权、mutex 纪律、子进程生命周期、
// 父死看护。Windows 特异机制（命名管道传输、CTRL_BREAK 优雅停、OpenProcess 父探测、TCP 表 freeport、注册表 IP 转发、
// SCM 托管）下沉到 winproc.go / service.go / main.go，本文件只保留与 macOS 逐行对应的协议与并发骨架。
//
// 安全边界（与 macOS 同构）：
//   - token：仅 SYSTEM 可读的 helper.token，app 持自身副本鉴权；命名管道虽有 ACL（纵深防御），token 仍是主鉴权边界
//     （与 macOS 的 0666 socket + token 同理 —— ACL/SDDL 是额外纵深，不是主边界）。
//   - sing-box 二进制路径在安装时由 --singbox 锁定（改它需 SYSTEM/管理员），客户端不可指定 → 杜绝「持 token 跑任意二进制」。
//   - 配置文件必须落在 --confdir（app 数据目录）内，拒绝越权路径。
//     残余风险：能读到 app 配置目录内 token 的同用户进程可驱动本 helper（与 macOS 同构的固有取舍）。
//
// 协议（每行以 \n 结尾，路径整行传递 → 容忍含空格的路径）：
//
//	行1: <token>
//	行2: <command>          ping | version | status | start | stop | cleanup | freeport
//	start 追加: 行3=<cfg> 行4=<log，可空> 行5=<fwd: 0|1> 行6=<父appPID，可选；缺失/空=不启父死看护>
//	freeport 追加: 行3=<port>
//
// Windows 是独立谱系，protoVersion="1"，无 install-core（macOS 专属内核持久化，Windows 由 app 侧处理）。
//
//go:build windows

package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 协议版本：app 经 `version` 命令读取，与内置期望值不符则提示「修复/重装 helper」。
// Windows helper 是独立谱系（与 macOS v1-v5 不共享版本号空间）：v1 = ping/version/status/start/stop/cleanup/freeport；
// v2 = route-add/route-del（出口托管）；v3 = iface-metric（netsh，已证不可靠）；v4 = iface-metric 改 PowerShell
// Set-NetIPInterface（netsh store=active 未关 AutomaticMetric 设了不生效，真机实证）；v5 = PowerShell 全路径 +
// 两族（无 -AddressFamily，IPv6 的 ::/0 同样会抢，必须一并降权；SYSTEM 服务 PATH 可能找不到 powershell）。
// 无 install-core（macOS 专属 proto v5，与 Windows 谱系不共享）。
const protoVersion = "5"

// route-add/route-del 安全约束：仅允许 FlowZ 自己的内核接口名（flowz-ts/flowz-wg/flowz-tun0…），杜绝任意接口注入。
func ifaceAllowed(s string) bool {
	if !strings.HasPrefix(s, "flowz-") || len(s) > 24 {
		return false
	}
	for _, c := range s[len("flowz-"):] {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

var (
	singboxBin string // 安装时锁定的 sing-box 路径
	confDir    string // 允许的配置文件目录
	supportDir string // 命名管道 token 所在目录（SYSTEM 侧）
	// coreDir：Windows 上接受并忽略（镜像 macOS flag 形态，便于 TS 侧统一安装脚本；Windows 无 install-core）。
	coreDir string

	mu        sync.Mutex
	child     *exec.Cmd
	childDone chan struct{} // 与 child 同生命周期：start 时创建，c.Wait() 收割后 close；摘除 child 时同步置 nil
)

func tokenValue() string {
	b, _ := os.ReadFile(filepath.Join(supportDir, "helper.token"))
	return strings.TrimSpace(string(b))
}

func readLine(r *bufio.Reader) string {
	s, _ := r.ReadString('\n')
	return strings.TrimRight(s, "\r\n")
}

// cfg 必须位于 confDir 内（清洗后前缀匹配），防止越权指定任意路径作 SYSTEM 配置。
// Windows 路径大小写不敏感 → 用 EqualFold 等价的小写前缀比较，避免 "C:\Foo" vs "c:\foo" 绕过。
func cfgAllowed(cfg string) bool {
	if confDir == "" {
		return true
	}
	clean := filepath.Clean(cfg)
	base := filepath.Clean(confDir) + string(os.PathSeparator)
	return strings.HasPrefix(strings.ToLower(clean), strings.ToLower(base))
}

// terminateChild：优雅停（CTRL_BREAK→等≤2s→TerminateProcess）收割 child sing-box。镜像 macOS terminateChild
// （SIGTERM→等≤5s→SIGKILL）的纪律：
//   - 必须不持 mu 调用（最长阻塞 ~2s，持锁会饿死所有管道命令）。
//   - 调用方须先在持锁状态把 child 摘成 nil（收割权独占）。
//   - 经 c.Process / done channel 做 PID 复用安全：Wait() 收割后再发信号天然无害（进程句柄已 release）。
//
// Windows delta：无 SIGTERM。优雅路径 = GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid)（要求 child 以
// CREATE_NEW_PROCESS_GROUP 启动，见 startSingbox）；硬路径 = TerminateProcess（c.Process.Kill）。
//
// 关键现实（H1）：CTRL_BREAK 在**服务模式是 no-op** —— GenerateConsoleCtrlEvent 只投递给与调用者共享 console
// 的进程，而本 helper 是 session 0 无 console 的 LocalSystem 服务（见 sendCtrlBreak）。故服务模式下优雅路径
// 永远不生效，硬杀（TerminateProcess）是**预期**收割手段。仅 --console dev 模式有 console，CTRL_BREAK 才有效。
// 因此把等待窗口从 5s 缩到 2s：服务模式 5s 纯属空等（信号根本没投出去），2s 给 dev 模式 console 下 sing-box
// 优雅拆栈留余量即可。
// 残留风险：硬杀可能残留 wintun 适配器/路由（真机必验项，sing-box 硬杀是否自清适配器）；但 Job Object
// （KILL_ON_JOB_CLOSE，见 winproc.go）+ Wait 收割保证不留**孤儿进程**——即使硬杀也无 root 进程残留占 9090/TUN。
func terminateChild(c *exec.Cmd, done <-chan struct{}) {
	if c == nil || c.Process == nil {
		return
	}
	// 优雅信号：向 child 进程组发 CTRL_BREAK（仅 --console dev 模式有效；服务模式 no-op，由下方硬杀兜底）。
	// 失败（进程已退出/服务模式无 console）无害，由后续超时/done 兜底。
	_ = sendCtrlBreak(c.Process.Pid)
	select {
	case <-done: // 已被 Wait 收割（dev 模式优雅退出），免硬杀
	case <-time.After(2 * time.Second):
		_ = c.Process.Kill() // TerminateProcess（服务模式的预期收割手段）；若恰已退出则 ErrProcessDone，无害
	}
}

// 父死看护：托管 child 期间每秒探测父 app 进程，父消失（GUI 崩溃/taskkill/强退 —— 管道 stop 够不到的场景）
// → CTRL_BREAK→硬杀收割 child。对齐 macOS watchParent「父进程死亡→不留孤儿」不变量。
// 退出条件（防 goroutine 泄漏）：child 正常退出（done 关闭）/ 被 stop·cleanup·新 start 摘除（child != c）/ 父死收割完成。
//
// Windows delta：用 OpenProcess + GetExitCodeProcess==STILL_ACTIVE 判父存活，替代 macOS kill(ppid,0)。
// 宁漏勿误：探测出错（句柄打不开等非「确定已死」情形）按存活处理。
func watchParent(ppid int, c *exec.Cmd, done <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return // child 已退出，看护使命结束
		case <-t.C:
		}
		mu.Lock()
		current := child == c
		mu.Unlock()
		if !current {
			return // 已被 stop/cleanup 摘除或被新 start 替换，收割责任已转移
		}
		// processAlive：仅在「确定父已死」时返回 false；句柄打开失败/查询失败等不确定情形宁可按存活处理（宁漏勿误）。
		if !processAlive(ppid) {
			mu.Lock()
			if child != c { // 与 stop 竞态：他人已摘除则由他收割
				mu.Unlock()
				return
			}
			child, childDone = nil, nil
			mu.Unlock()
			terminateChild(c, done)
			return
		}
	}
}

func handle(conn net.Conn) {
	defer conn.Close()
	// 读超时：防止无 token 进程连上后不发数据耗尽句柄/goroutine，或持 token 客户端发一半卡死、
	// 在 mu.Lock() 之后阻塞读 → 永久持锁拖垮整个 helper。镜像 macOS 5s deadline。
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	r := bufio.NewReader(conn)
	tok := readLine(r)
	cmd := readLine(r)
	if tok == "" || tok != tokenValue() {
		fmt.Fprintln(conn, "ERR auth")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	switch cmd {
	case "ping":
		// Windows os.Getuid() 返回 -1 会破坏客户端 `uid=\d+` 正则 —— 固定发非负整数 0。
		fmt.Fprintf(conn, "OK pong uid=0 v%s\n", protoVersion)
	case "version":
		fmt.Fprintf(conn, "OK %s\n", protoVersion)
	case "status":
		if child != nil && child.Process != nil {
			fmt.Fprintf(conn, "OK running %d\n", child.Process.Pid)
		} else {
			fmt.Fprintln(conn, "OK stopped")
		}
	case "stop":
		if child != nil && child.Process != nil {
			pid := child.Process.Pid
			c, done := child, childDone
			child, childDone = nil, nil
			// 收割放后台：本 handle 持着 mu，同步等待（最长 5s）会饿死并发 ping/status，且客户端 stop 超时仅 3s。
			// 摘除 child 后由该 goroutine 独占收割权（watchParent 见 child!=c 即退）。镜像 macOS stop。
			go terminateChild(c, done)
			fmt.Fprintf(conn, "OK stopped %d\n", pid)
		} else {
			fmt.Fprintln(conn, "OK notrunning")
		}
	case "cleanup":
		// 先摘自家 child 并精准收割（与 stop/uninstall 单一收割权模型一致），再 killAllSingbox 兜底外部孤儿。
		// 按锁定二进制完整路径匹配映像，避免误杀无关进程（镜像 macOS `singboxBin+" run"` 意图）。
		if child != nil && child.Process != nil {
			c, done := child, childDone
			child, childDone = nil, nil
			go terminateChild(c, done) // 不持 mu 收割（见 stop 注释）
		}
		n := killAllSingbox(singboxBin)
		_ = n
		fmt.Fprintln(conn, "OK cleaned")
	case "route-add", "route-del":
		// proto v2：出口托管在 System 内核接口装/清拆半默认路由（netsh，store=active 非持久、重启自清）。
		// 约束：iface 白名单（flowz-*）+ net.ParseCIDR 校验。幂等 best-effort，最终由 app 侧校验。
		// Windows 无 ifscope；靠 per-interface 路由 + 内核 metric 选路（与主 TUN 的冲突属真机验证项 #3858）。
		iface := strings.TrimSpace(readLine(r))
		cidrsLine := strings.TrimSpace(readLine(r))
		if !ifaceAllowed(iface) {
			fmt.Fprintln(conn, "ERR iface-denied")
			break
		}
		op := "add"
		if cmd == "route-del" {
			op = "delete"
		}
		for _, c := range strings.Split(cidrsLine, ",") {
			c = strings.TrimSpace(c)
			if c == "" {
				continue
			}
			if _, _, err := net.ParseCIDR(c); err != nil {
				continue
			}
			fam := "ipv4"
			if strings.Contains(c, ":") {
				fam = "ipv6"
			}
			_ = exec.Command("netsh", "interface", fam, op, "route",
				"prefix="+c, "interface="+iface, "store=active").Run()
		}
		fmt.Fprintln(conn, "OK route")
	case "iface-metric":
		// proto v3：把 FlowZ 内核接口的接口 metric 设高 —— Windows 根治 System TS 出口劫持。
		// 根因（真机实证）：tsnet 给 flowz-ts 装的 exit 0/0 metric=0，抢过物理网卡 → 把直连/bootstrap DNS
		// （1.12.12.12/223.5.5.5）灌进 TS 出口、源 IP 变 tailnet → SERVFAIL → 解析不出代理节点 → 全网瘫。
		// Windows 无 macOS 的 ifscope 作用域，等价手段是降权该接口：metric 设高 → 其 0/0 输给以太网、直连回物理；
		// tailnet /32 仍按最长前缀命中、出口经 sing-box selector 内部转发给 TS outbound 不依赖这条 OS 0/0。
		// store=active：非持久（接口每次起核重建、app 侧重新下发），不污染持久配置。约束：iface 白名单 + metric∈[0,65535]。
		iface := strings.TrimSpace(readLine(r))
		metricLine := strings.TrimSpace(readLine(r))
		if !ifaceAllowed(iface) {
			fmt.Fprintln(conn, "ERR iface-denied")
			break
		}
		metric, err := strconv.Atoi(metricLine)
		if err != nil || metric < 0 || metric > 65535 {
			fmt.Fprintln(conn, "ERR bad-metric")
			break
		}
		// 真机实证：`netsh ... set interface metric=N store=active` 不可靠（AutomaticMetric 未关→设了不生效）。改用
		// PowerShell `Set-NetIPInterface`（用户实证有效，自动关 AutomaticMetric 并持久）。两处加固：
		//   ① 全路径调 powershell —— SYSTEM 服务 PATH 可能找不到 `powershell`（exec 直接报 not found→设不上）。
		//   ② 不带 -AddressFamily —— 同时设 IPv4 + IPv6 两族（flowz-ts 若有 ::/0 全隧道出口，IPv6 也会被抢，必须一并降权）。
		// iface 已过 ifaceAllowed 白名单（flowz- + [a-z0-9-]）→ 单引号字符串无注入；metric 为整数。
		psExe := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
		psCmd := fmt.Sprintf(
			"Set-NetIPInterface -InterfaceAlias '%s' -InterfaceMetric %d -ErrorAction Stop",
			iface, metric)
		if err := exec.Command(psExe, "-NoProfile", "-NonInteractive", "-Command", psCmd).Run(); err != nil {
			fmt.Fprintln(conn, "ERR set-metric "+err.Error())
			break
		}
		fmt.Fprintln(conn, "OK iface-metric")
	case "uninstall":
		// 自卸载（app 卸载/更新时调用）：收割 child → 派生脱离本进程的 SYSTEM 旁路（停删 FlowZHelper 服务 +
		// 删 supportDir，含外置的 helper.exe 自身 + helper.token）→ 回 OK → 自退。
		// 镜像 macOS HelperManager 卸载语义（bootout + rm plist/helper/support），但 Windows 须借旁路进程完成
		// 两件本进程无法自完成的事：① 自删「正在运行因而被锁定」的 helper.exe；② 停删「自身所属」的 SCM 服务
		// （sc delete 要服务先停，而本进程正是服务主进程）。详见 winproc.go spawnSelfUninstall。
		if child != nil && child.Process != nil {
			c, done := child, childDone
			child, childDone = nil, nil
			go terminateChild(c, done) // 不持 mu 收割（见 stop 注释）
		}
		_ = killAllSingbox(singboxBin) // 兜底清外部孤儿 sing-box（占 9090/TUN），与 cleanup 对齐
		spawnSelfUninstall()
		fmt.Fprintln(conn, "OK uninstalling")
		// 给回复 flush + 旁路 ping 延迟留窗口后自退；os.Exit 使服务进程消失 → SCM 标记停止 → 旁路 sc delete 生效。
		go func() {
			time.Sleep(800 * time.Millisecond)
			os.Exit(0)
		}()
	case "freeport":
		// 按端口（GetExtendedTcpTable）定位 LISTEN 持有者：是锁定 sing-box 才 TerminateProcess，否则回报占用者名字（不杀）。
		// 镜像 macOS v4「不杀无辜」：覆盖外部 / 旧路径 / 改过 singboxBin 路径的端口占用者。
		port := strings.TrimSpace(readLine(r))
		if port == "" || strings.IndexFunc(port, func(c rune) bool { return c < '0' || c > '9' }) >= 0 {
			fmt.Fprintln(conn, "ERR bad-port")
			return
		}
		pnum, _ := strconv.Atoi(port)
		if pnum <= 0 || pnum > 65535 {
			fmt.Fprintln(conn, "ERR bad-port")
			return
		}
		pids, err := listenPidsForPort(uint16(pnum))
		if err != nil {
			fmt.Fprintf(conn, "ERR enum %v\n", err)
			return
		}
		if len(pids) == 0 {
			fmt.Fprintln(conn, "OK free")
			return
		}
		var killed, foreign []string
		for _, p := range pids {
			img := processImageName(p) // 仅可执行映像全路径（不含参数）→ 避免「参数里碰巧含 sing-box」被误杀
			if isLockedSingbox(img, singboxBin) {
				_ = terminatePid(p)
				killed = append(killed, strconv.Itoa(int(p)))
			} else {
				name := filepath.Base(img)
				if name == "" || name == "." {
					name = "pid:" + strconv.Itoa(int(p))
				}
				foreign = append(foreign, name)
			}
		}
		// 混合占用（sing-box+foreign 同端口，极罕见）回 foreign：诚实告知 app 端口仍被外部占——sing-box 虽已
		// terminatePid，但 foreign 残留→app 重试绑定仍失败，回 foreign 让 app 知端口未真正释放（与 macOS helper 一致）。
		if len(foreign) > 0 {
			fmt.Fprintf(conn, "OK foreign %s\n", strings.Join(foreign, " | "))
		} else {
			fmt.Fprintf(conn, "OK killed %s\n", strings.Join(killed, ","))
		}
	case "start":
		cfg := readLine(r)
		logPath := readLine(r)
		fwd := readLine(r)
		// 行6（可选）：父 app PID。旧客户端只发 5 行后即 FIN，此处读到 ""（EOF 不阻塞）→ ppid=0 → 不启看护。
		// 恶意 ppid 无安全增量：看护只会提前杀自家 child，与持 token 者本就有的 stop 权能等价。
		ppid, _ := strconv.Atoi(readLine(r))
		if child != nil && child.Process != nil {
			fmt.Fprintf(conn, "OK already %d\n", child.Process.Pid)
			return
		}
		if cfg == "" {
			fmt.Fprintln(conn, "ERR no-config")
			return
		}
		if !cfgAllowed(cfg) {
			fmt.Fprintln(conn, "ERR config-path-denied")
			return
		}
		// allowLan：开启 IP 转发。Windows 是真平台特异（HKLM\...\Tcpip\Parameters\IPEnableRouter=1）。
		// 最小实现 + 不阻塞 start：失败/未生效不影响 sing-box 启动。真机必验项（注册表生效需重启 Routing/RAS 服务或重启）。
		if fwd == "1" {
			enableIPForwarding() // best-effort，不阻塞、不影响返回
		}
		c, logFile, err := startSingbox(singboxBin, cfg, logPath)
		if err != nil {
			if logFile != nil {
				logFile.Close()
			}
			fmt.Fprintf(conn, "ERR start %v\n", err)
			return
		}
		// 子进程已在 Start 时继承该句柄；父进程（常驻服务）立即关副本，避免每次启停泄漏句柄。
		if logFile != nil {
			logFile.Close()
		}
		child = c
		done := make(chan struct{})
		childDone = done
		go func() {
			_ = c.Wait()
			close(done) // 广播子进程已被收割：terminateChild 据此免硬杀、watchParent 据此退出
			mu.Lock()
			if child == c {
				child, childDone = nil, nil
			}
			mu.Unlock()
		}()
		// 父死看护：覆盖 GUI 崩溃/taskkill 后管道 stop 够不到的孤儿场景。
		if ppid > 0 {
			go watchParent(ppid, c, done)
		}
		fmt.Fprintf(conn, "OK started %d\n", c.Process.Pid)
	default:
		fmt.Fprintln(conn, "ERR unknown")
	}
}

// reapChildOnExit：服务停止/关机时调用，先收割 child sing-box 再退出，杜绝孤儿。
// 镜像 macOS main() 的 SIGTERM 收割器（proto v3）：持锁摘除 child → 不持锁 terminateChild；
// child==nil 时兜一发全量 killAllSingbox（覆盖「停止恰落在某次 stop 的后台收割窗口内」——那个收割 goroutine
// 会随本进程退出而消失，其 5s 硬杀升级丢失 → 残留孤儿）。供 service.go（SCM stop/shutdown）与 main.go（--console Ctrl+C）共用。
func reapChildOnExit() {
	mu.Lock()
	c, done := child, childDone
	child, childDone = nil, nil
	mu.Unlock()
	if c != nil && c.Process != nil {
		terminateChild(c, done)
	} else {
		_ = killAllSingbox(singboxBin)
	}
}
