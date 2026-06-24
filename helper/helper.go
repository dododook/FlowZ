// FlowZ 提权 helper（生产版）：root LaunchDaemon，监听 token 鉴权的 unix socket，按行协议驱动 sing-box 启停。
// 装一次（osascript 一次授权）后，普通用户 app 经 socket 零提权启停 sing-box —— 切节点/停止/退出/崩溃回收均免再次授权。
//
// 安全边界：
//   - token：仅 root 可读的 helper.token(600)，app 持自身副本鉴权；socket 为 0666，故 token 是主边界。
//   - sing-box 二进制路径在安装时由 --singbox 锁定（改它需 root），客户端不可指定 → 杜绝「持 token 跑任意二进制」。
//   - 配置文件必须落在 --confdir（app 数据目录）内，拒绝越权路径。
//     残余风险：能读到 app 配置目录内 token 的同用户进程可驱动本 helper（FlowZ 未签名，无法做 SMJobBless 客户端校验）。
//     此为「未签名应用 + 免提权 helper」的固有取舍；token + 二进制锁定 + 配置目录约束为现实可行的缓解。
//
// 协议（每行以 \n 结尾，路径整行传递 → 容忍含空格的路径，如 "Application Support/FlowZ"）：
//
//	行1: <token>
//	行2: <command>           ping | version | start | stop | status
//	start 追加: 行3=<cfg> 行4=<log，可空> 行5=<fwd: 0|1> 行6=<父appPID，可选；缺失/空=不启父死看护（兼容旧客户端）>
//
// 仅依赖 Go 标准库（无第三方依赖，便于交叉编译与审计）。
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 协议版本：app 经 `version` 命令读取，与内置期望值不符则提示「修复/重装 helper」。
// v2：start 追加可选父 PID 行（父死看护）+ stop 升级 TERM→等≤5s→KILL。
// v3：main() 加 SIGTERM/SIGINT 收割器——卸载/launchctl bootout 时先收割 child sing-box 再退出，
//
//	杜绝 helper 死后 child 变 root 孤儿继续占 9090（修 root 孤儿根因）。
//
// v4：加 freeport 命令——root 侧按端口（lsof）定位 9090/指定端口的 LISTEN 持有者，是 sing-box 才 kill -9，
//
//	否则回报占用者名字。彻底摆脱 app 侧 cmdline 匹配（覆盖外部/旧路径 sing-box）。
//
// v5：加 install-core 命令——把 app 下载+预检的临时内核校验 sha256 后 root 写入锁定的受保护目录（--coredir）+
//
//	签名+清 quarantine，实现 macOS 内核持久化更新（App 升级不覆盖）。**向后兼容**：v1-v4 命令不变，装着 v4 的用户
//	TUN 启停继续可用，仅内核更新需 v5（无 v5 时 app fallback 一次 osascript）→ 非强制重装、温和提示可升级。
//
// v6：start 的 child 退出后自动 chownRuntimeDirs——把 root 跑 sing-box 留下的 tailscale state / dashboard / ui
//
//	属主归还登录用户，根治跨提权态属主冲突（root 跑写 root 600 → 登录用户跑读不了 → endpoint post-start FATAL）。
//	协议命令不变、纯行为增强；旧 v5 helper 仍可用 TUN，仅本根治需 v6 → app 据 proto 检测「可升级」温和提示重装。
const protoVersion = "6"

var (
	singboxBin string // 安装时锁定的 sing-box 路径
	confDir    string // 允许的配置文件目录
	supportDir string // socket + token 所在目录
	coreDir    string // 安装时锁定的受保护内核目录（install-core 只写此目录，防写任意路径）

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

// installCore（proto v5）：把 app 下载+预检的临时内核 src，校验 sha256(实际读到的字节)==wantHash 后，root 写入
// 锁定的受保护目录 coreDir（整个源目录复制 + 主二进制签名 + 清 quarantine）。
//   - 只写锁定的 coreDir（filepath.Join，不接受任意路径）→ 防「持 token 写任意 root 路径」。
//   - 哈希校验主二进制 sing-box（堵 TOCTOU：读全字节进内存，校验+写同一份；攻击者读后替换无效，读前替换则 hash
//     不符被拒）。与 token（通道鉴权）互补两层。libcronet 等配套随目录复制（同一可信源 + token 保护，未逐文件 hash，
//     残余 LOW，可后续补）。
func installCore(srcDir, wantHash string) string {
	if coreDir == "" {
		return "ERR coredir-unset"
	}
	if srcDir == "" || len(wantHash) != 64 {
		return "ERR bad-args"
	}
	sbData, err := os.ReadFile(filepath.Join(srcDir, "sing-box"))
	if err != nil {
		return "ERR read-singbox " + err.Error()
	}
	sum := sha256.Sum256(sbData)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), wantHash) {
		return "ERR hash-mismatch"
	}
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return "ERR readdir " + err.Error()
	}
	if err := os.MkdirAll(coreDir, 0o755); err != nil {
		return "ERR mkdir " + err.Error()
	}
	// 整个源目录（sing-box + libcronet 等配套）逐文件 .new + rename 原子就位到受保护目录。
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		data := sbData
		if name != "sing-box" {
			data, err = os.ReadFile(filepath.Join(srcDir, name))
			if err != nil {
				return "ERR read " + name + " " + err.Error()
			}
		}
		dst := filepath.Join(coreDir, name)
		tmp := dst + ".new"
		if err := os.WriteFile(tmp, data, 0o755); err != nil {
			return "ERR write " + name + " " + err.Error()
		}
		if err := os.Rename(tmp, dst); err != nil {
			_ = os.Remove(tmp)
			return "ERR rename " + name + " " + err.Error()
		}
		_ = os.Chmod(dst, 0o755)
	}
	// A-m2：清理受保护目录多余文件（非本次 srcDir entries 的旧核残留），防 rollback 后残留陈旧配套。
	srcNames := make(map[string]bool)
	for _, e := range entries {
		if !e.IsDir() {
			srcNames[e.Name()] = true
		}
	}
	if oldEntries, err := os.ReadDir(coreDir); err == nil {
		for _, e := range oldEntries {
			if !e.IsDir() && !srcNames[e.Name()] {
				_ = os.Remove(filepath.Join(coreDir, e.Name()))
			}
		}
	}
	// macOS：清整个受保护目录 quarantine + 对主二进制 adhoc 签名（否则 Gatekeeper 对新放入未签名二进制 SIGKILL）
	sb := filepath.Join(coreDir, "sing-box")
	_ = exec.Command("/usr/bin/xattr", "-cr", coreDir).Run()
	_ = exec.Command("/usr/bin/codesign", "--force", "--deep", "-s", "-", sb).Run()
	return "OK installed"
}

// chownRuntimeDirs（proto v6 行为）：把 sing-box 运行时写入的 userData 子目录（tailscale state /
// singbox-dashboard / external_ui）属主**归还登录用户**。helper 以 root 跑 sing-box，tsnet 等会把这些文件
// 创建成 root 600 → 之后以登录用户（系统代理模式）跑 sing-box 时 open 不了 → endpoint post-start
// `permission denied` 拖垮整个启动（即便没选 tailscale 节点，它在 endpoints[] 里也会被 post-start）。
// 每次 child 退出后调用 → 属主恒为登录用户（confDir=app 数据目录、属主即登录用户），根治跨提权态属主冲突，
// 且**不丢 Tailscale 登录态**（chown 保留 state、非删除）。绝不阻断、单项失败即跳过。
func chownRuntimeDirs() {
	if confDir == "" {
		return
	}
	fi, err := os.Stat(confDir)
	if err != nil {
		return
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return
	}
	uid, gid := int(st.Uid), int(st.Gid)
	if uid == 0 {
		return // confDir 本身属 root（异常）→ 不动，避免把运行时目录误归到 root
	}
	for _, name := range []string{"tailscale", "singbox-dashboard", "ui"} {
		chownTree(filepath.Join(confDir, name), uid, gid)
	}
}

// chownTree：递归把树里**仍属 root**的条目 Lchown 到 (uid,gid)。尽力而为——目录不存在/读不了即跳过，
// 绝不返回错误中断遍历。guard：只动 uid==0 的条目（root 跑 sing-box 留下的），已是登录用户属主的不再 Lchown
// → 避免每次 TUN 起停周期对可能很大的树做无谓全量 Lchown（filepath.Walk 用 Lstat，info 即条目自身属性，不跟随符号链接）。
func chownTree(root string, uid, gid int) {
	_ = filepath.Walk(root, func(p string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return nil
		}
		// 仅 root 写入的条目才归还属主；非 root（已是登录用户）跳过，省掉无谓 Lchown。
		// 拿不到底层 Stat_t（理论上不该发生）时保守归还，维持原「确保属主稳定」语义。
		if st, ok := info.Sys().(*syscall.Stat_t); !ok || st.Uid == 0 {
			_ = os.Lchown(p, uid, gid)
		}
		return nil
	})
}

// cfg 必须位于 confDir 内（清洗后前缀匹配），防止越权指定任意路径作 root 配置。
func cfgAllowed(cfg string) bool {
	if confDir == "" {
		return true
	}
	clean := filepath.Clean(cfg)
	base := filepath.Clean(confDir) + string(os.PathSeparator)
	return strings.HasPrefix(clean, base)
}

// TERM→等≤5s→KILL 收割 child：先给 sing-box 优雅窗口（拆 utun/路由/DNS），超时未退则强杀。
// 必须不持 mu 调用（最长阻塞 5s，持锁会饿死所有 socket 命令），且调用方须先在持锁状态把 child 摘成 nil（收割权独占）。
// 实际信号只经 c.Process 发出：Wait() 收割后 Signal/Kill 返回 ErrProcessDone 不发信号 → 天然防 PID 复用误杀。
func terminateChild(c *exec.Cmd, done <-chan struct{}) {
	if c == nil || c.Process == nil {
		return
	}
	_ = c.Process.Signal(syscall.SIGTERM)
	select {
	case <-done: // 已被 Wait 收割（优雅退出），免 KILL
	case <-time.After(5 * time.Second):
		_ = c.Process.Kill() // SIGKILL；若恰已退出则 ErrProcessDone，无害
	}
}

// 父死看护：托管 child 期间每秒探测父 app 进程，父消失（GUI 崩溃/kill -9/强退 —— socket stop 够不到的场景）
// → TERM→KILL 收割 child。对齐旧 osascript 看护脚本「父进程死亡→不留孤儿」不变量（修复设计根因 B）。
// 退出条件（防 goroutine 泄漏）：child 正常退出（done 关闭）/ 被 stop·cleanup·新 start 摘除（child != c）/ 父死收割完成。
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
		// kill(ppid,0) 只判存活不发信号：ESRCH=父已死。其余错误（root 不应见 EPERM）按存活处理，宁漏勿误。
		if err := syscall.Kill(ppid, 0); err == syscall.ESRCH {
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
	// 读超时：防止无 token 进程连上后不发数据耗尽 fd/goroutine，或持 token 客户端发一半卡死、
	// 在 mu.Lock() 之后阻塞读 → 永久持锁拖垮整个 helper。
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
		fmt.Fprintf(conn, "OK pong uid=%d v%s\n", os.Getuid(), protoVersion)
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
			// TERM→等≤5s→KILL 放后台：本 handle 持着 mu，同步等待会饿死并发 ping/status，
			// 且客户端 stop 超时仅 3-5s。摘除 child 后由该 goroutine 独占收割权（watchParent 见 child!=c 即退）。
			go terminateChild(c, done)
			fmt.Fprintf(conn, "OK stopped %d\n", pid)
		} else {
			fmt.Fprintln(conn, "OK notrunning")
		}
	case "cleanup":
		// 以 root 杀掉所有「<锁定的 singbox> run …」进程，含外部 osascript 路径遗留的孤儿，让 app 免 osascript 清理。
		// pattern 含 " run"：只匹配真正运行的 sing-box，不会误杀 argv 为「--singbox <path>」的本 daemon。
		_ = exec.Command("/usr/bin/pkill", "-9", "-f", singboxBin+" run").Run()
		child, childDone = nil, nil
		fmt.Fprintln(conn, "OK cleaned")
	case "freeport":
		// 按端口（root lsof）定位 LISTEN 持有者：是 sing-box 才 kill -9，否则回报占用者名字（不杀）。
		// 彻底摆脱 app 侧 cmdline 匹配，覆盖「外部 / 旧 app 路径 / 改过 singboxBin 路径」的 9090 占用者（L2）。
		port := strings.TrimSpace(readLine(r))
		if port == "" || strings.IndexFunc(port, func(c rune) bool { return c < '0' || c > '9' }) >= 0 {
			fmt.Fprintln(conn, "ERR bad-port")
			return
		}
		out, _ := exec.Command("/usr/sbin/lsof", "-ti", "tcp:"+port, "-sTCP:LISTEN").Output()
		pids := strings.Fields(strings.TrimSpace(string(out)))
		if len(pids) == 0 {
			fmt.Fprintln(conn, "OK free")
			return
		}
		var killed, foreign []string
		for _, p := range pids {
			// ps -o comm=（仅可执行名，不含参数）：避免「参数里碰巧含 sing-box」的进程被 root 误杀（M2）。
			commOut, _ := exec.Command("/bin/ps", "-o", "comm=", "-p", p).Output()
			comm := strings.TrimSpace(string(commOut))
			if strings.Contains(comm, "sing-box") {
				_ = exec.Command("/bin/kill", "-9", p).Run()
				killed = append(killed, p)
			} else {
				name := comm
				if name == "" {
					name = "pid:" + p
				}
				foreign = append(foreign, name)
			}
		}
		if len(foreign) > 0 {
			// 占用者非 sing-box → 不杀、回报名字（app 据此给「9090 被 X 占用」的诚实终态）
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
		// allowLan：开启 IP 转发（macOS 键名，与 Linux 不同）
		if fwd == "1" {
			_ = exec.Command("/usr/sbin/sysctl", "-w", "net.inet.ip.forwarding=1").Run()
			_ = exec.Command("/usr/sbin/sysctl", "-w", "net.inet6.ip6.forwarding=1").Run()
		}
		c := exec.Command(singboxBin, "run", "-c", cfg)
		// sing-box 早期 stdout/stderr 重定向到 app 日志文件（与 osascript 看护脚本一致），便于诊断启动问题。
		var logFile *os.File
		if logPath != "" {
			if lf, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
				logFile = lf
				c.Stdout = lf
				c.Stderr = lf
			}
		}
		if err := c.Start(); err != nil {
			if logFile != nil {
				logFile.Close()
			}
			fmt.Fprintf(conn, "ERR start %v\n", err)
			return
		}
		// 子进程已在 Start 时 dup 该 fd；父进程（常驻 daemon）立即关副本，避免每次启停泄漏 fd。
		if logFile != nil {
			logFile.Close()
		}
		child = c
		done := make(chan struct{})
		childDone = done
		go func() {
			_ = c.Wait()
			close(done) // 广播子进程已被收割：terminateChild 据此免 KILL、watchParent 据此退出
			// proto v6：root 跑的 sing-box 退出后，把运行时目录（tailscale state / dashboard / ui）属主归还
			// 登录用户 → 下次以登录用户（系统代理模式）跑能直接读、不再 FATAL，且不丢 Tailscale 登录态。
			// 放 Wait() 之后确保文件已不被 sing-box 占用、属主稳定。
			chownRuntimeDirs()
			mu.Lock()
			if child == c {
				child, childDone = nil, nil
			}
			mu.Unlock()
		}()
		// 父死看护（proto v2）：覆盖 GUI 崩溃/kill -9 后 stopCore 够不到的孤儿场景。
		if ppid > 0 {
			go watchParent(ppid, c, done)
		}
		fmt.Fprintf(conn, "OK started %d\n", c.Process.Pid)
	case "install-core":
		// 行3=临时内核源路径（app 下载+预检后，用户可写区）；行4=期望 sha256（hex）。helper 校验哈希后 root 写锁定
		// 的受保护目录。与 child/TUN 进程无关，仅文件写入。
		src := readLine(r)
		wantHash := strings.TrimSpace(readLine(r))
		fmt.Fprintln(conn, installCore(src, wantHash))
	default:
		fmt.Fprintln(conn, "ERR unknown")
	}
}

func main() {
	flag.StringVar(&singboxBin, "singbox", "", "path to sing-box binary (locked at install time)")
	flag.StringVar(&confDir, "confdir", "", "allowed config directory")
	flag.StringVar(&supportDir, "support", "/Library/Application Support/FlowZ", "dir holding helper.sock + helper.token")
	flag.StringVar(&coreDir, "coredir", "", "locked protected core dir for install-core (proto v5)")
	flag.Parse()

	if err := os.MkdirAll(supportDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// 纵深防御：MkdirAll 对已存在目录不改权限；确保 supportDir 可被普通用户穿越（否则 app 连 socket EACCES）。
	_ = os.Chmod(supportDir, 0o755)
	sockPath := filepath.Join(supportDir, "helper.sock")
	_ = os.Remove(sockPath)
	l, err := net.Listen("unix", sockPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = os.Chmod(sockPath, 0o666) // token 为安全边界

	// SIGTERM/SIGINT 收割器（proto v3）：卸载 / launchctl bootout 时 launchd 先发 SIGTERM（默认 ~20s 后才 SIGKILL），
	// 此处在退出前先收割 child sing-box（TERM→等≤5s→KILL），杜绝 helper 死后 child 变 root 孤儿继续占 9090/utun
	// （修 root 孤儿根因——原 main 无信号处理，bootout 直接退出留下 child）。5s 收割窗口 < launchd 20s 宽限，安全。
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		mu.Lock()
		c, done := child, childDone
		child, childDone = nil, nil
		mu.Unlock()
		if c != nil && c.Process != nil {
			terminateChild(c, done)
		} else {
			// child==nil 也兜一发 pkill：可能 SIGTERM 恰落在某次 stop 命令「摘除 child + 后台 go terminateChild」
			// 的窗口内——那个收割 goroutine 会随本进程 os.Exit 一起消失，其 5s KILL 升级丢失 → 残留 root 孤儿。
			// `-U 0` 限定 root 进程：helper child 与 osascript-TUN 的 sing-box 均为 root，而 systemProxy 模式由
			// app 直接 spawn 的是用户态 sing-box（同一二进制路径）→ 卸载/重装 helper 时不会误杀活跃用户会话（M-B）。
			_ = exec.Command("/usr/bin/pkill", "-9", "-U", "0", "-f", singboxBin+" run").Run()
		}
		os.Exit(0)
	}()

	for {
		conn, err := l.Accept()
		if err != nil {
			continue
		}
		go handle(conn)
	}
}
