//go:build linux

// FlowZ Linux 提权 helper（生产版）：root systemd system service，监听 unix socket，按行协议驱动 sing-box 启停。
// 装一次（pkexec 一次授权）后，普通用户 app 经 socket 零提权启停 sing-box —— 切节点/停止/退出/崩溃回收/换核均免再次授权。
//
// 第一性设计（见 docs/design/flowz-linux-privileged-helper.md）：
//   - 能力挂进程不挂文件：start 时 helper 以 root fork，setuid 回**发起请求的登录用户** + AmbientCaps=CAP_NET_ADMIN
//     拉核。核仍以登录用户跑（读得到 userData 的 config/cache/log，属主天然对），cap 在进程 ambient set 上。
//   - **核二进制在 root-owned 受管目录（--coredir，安装时播种、install-core hash 校验更新）**，与 macOS 受保护目录 /
//     Windows 锁定 --singbox 一致：核不可被普通用户篡改，一份共享、版本一致。这根除了「哪个二进制可信持有 CAP_NET_ADMIN」
//     的问题——start 只跑锁定的 coreDir/sing-box，绝不跑客户端指定的任意路径。换核经 install-core 免密（socket 调用）。
//   - 鉴权 SO_PEERCRED（内核背书对端 uid）+ 授权 uid 列表，无 token。
//
// 安全边界：
//   - 只跑锁定的 coreDir/sing-box（root-owned，普通用户改不动）→ 杜绝「借 helper 给任意自有二进制赋 CAP_NET_ADMIN」。
//   - config 必须属于对端 uid（open+fstat，防读别人配置）。install-core 只写锁定的 coreDir，sha256 校验主二进制（防 TOCTOU）。
//   - 授权 uid 由 root-owned authfile 记录；freeport/cleanup 仅作用于对端 uid 自己的进程（不跨用户杀）。
//   - AmbientCaps 授 CAP_NET_ADMIN/NET_RAW/NET_BIND_SERVICE（与现役 setcap 授权一致，PlatformPrivilegeService.ts:191）。
//
// 协议（每行 \n 结尾，路径整行传递）：
//	行1: <command>   ping | version | status | start | stop | cleanup | freeport | install-core
//	start 追加: 行2=<singbox 路径，须==coreDir/sing-box> 行3=<cfg> 行4=<log，可空> 行5=<fwd:0|1> 行6=<父 app PID，可选>
//	freeport 追加: 行2=<port>
//	install-core 追加: 行2=<srcDir> 行3=<sha256(hex)>
//
// 鉴权无独立行：对端身份经 SO_PEERCRED 取得。仅依赖 Go 标准库（便于交叉编译与审计）。
package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// 协议版本。v1：root 受管核 + install-core + 路径锁 + SO_PEERCRED + 授权列表 + 父死看护 + freeport。
const protoVersion = "1"

// Linux capability 数值（<linux/capability.h>；纯标准库不引 x/sys/unix）。授权集与现役 setcap 一致（不推测削减）。
const (
	capNetBindService = 10
	capNetAdmin       = 12
	capNetRaw         = 13
)

var (
	sockPath string // 监听的 unix socket 路径
	authFile string // 授权 uid 列表文件（root 写；每行一个十进制 uid）
	coreDir  string // root-owned 受管核目录（只跑/只写此目录内的 sing-box，锁定）

	mu        sync.Mutex
	child     *exec.Cmd
	childDone chan struct{}
	reapWG    sync.WaitGroup // 在途后台收割（stop 的 terminateChild）：SIGTERM 退出前须等它们跑完，杜绝孤儿
)

// coreBin：锁定的受管核路径。start 只跑它，绝不跑客户端指定的任意二进制。
func coreBin() string { return filepath.Join(coreDir, "sing-box") }

func readLine(r *bufio.Reader) string {
	s, _ := r.ReadString('\n')
	return strings.TrimRight(s, "\r\n")
}

// peerCred 取对端进程凭据（SO_PEERCRED）。uid/gid 内核在 connect 时锁定、不可伪造，作鉴权与 setuid 的唯一依据。
func peerCred(conn net.Conn) (*syscall.Ucred, error) {
	uc, ok := conn.(*net.UnixConn)
	if !ok {
		return nil, fmt.Errorf("not a unix conn")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return nil, err
	}
	var cred *syscall.Ucred
	var cerr error
	if err := raw.Control(func(fd uintptr) {
		cred, cerr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return nil, err
	}
	return cred, cerr
}

// isAuthorized：uid 是否在授权列表。root(0) 恒授权。
func isAuthorized(uid uint32) bool {
	if uid == 0 {
		return true
	}
	data, err := os.ReadFile(authFile)
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if n, err := strconv.Atoi(line); err == nil && n >= 0 && uint32(n) == uid {
			return true
		}
	}
	return false
}

// ownedBy：path 存在且属主 == uid（open 后对 fd fstat，杜绝 stat(path) 后被换的 TOCTOU；symlink 跟随到目标）。
func ownedBy(path string, uid uint32) (bool, error) {
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return false, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return false, fmt.Errorf("no stat_t")
	}
	return st.Uid == uid, nil
}

// supplementaryGroups：登录用户 uid 的补充组 gid 列表（纯 Go 解析 /etc/group，CGO 关不含 NSS/SSSD）。
// 用于 setuid 拉核时保留补充组——否则 Credential{Uid,Gid} 默认 setgroups(0) 会清掉补充组，使核读不到 group-only
// 资源（如 ssl-cert 组证书 / 组共享规则文件），而直起路径（保留补充组）能读，造成 mode-specific 破坏。查不到→nil
// （退化为默认 setgroups(0)，不比修前差）。
func supplementaryGroups(uid uint32) []uint32 {
	u, err := user.LookupId(strconv.FormatUint(uint64(uid), 10))
	if err != nil {
		return nil
	}
	gidStrs, err := u.GroupIds()
	if err != nil {
		return nil
	}
	gids := make([]uint32, 0, len(gidStrs))
	for _, s := range gidStrs {
		if n, e := strconv.ParseUint(s, 10, 32); e == nil {
			gids = append(gids, uint32(n))
		}
	}
	return gids
}

// procUID：/proc/<pid> 的属主 uid（进程运行者）。用于 freeport 跨用户防误杀。
func procUID(pid string) (uint32, error) {
	fi, err := os.Stat(filepath.Join("/proc", pid))
	if err != nil {
		return 0, err
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, fmt.Errorf("no stat_t")
	}
	return st.Uid, nil
}

// setForward：allowLan 时开/关 IPv4+IPv6 转发（直写 /proc/sys）。每次 start 按 fwd 显式设置、stop 复位为 0，
// 使转发态严格跟随运行中的核 —— 杜绝「开过 LAN 共享后停核/退出，主机仍全局转发到重启」的状态泄漏。best-effort。
func setForward(on bool) {
	v := []byte("0")
	if on {
		v = []byte("1")
	}
	_ = os.WriteFile("/proc/sys/net/ipv4/ip_forward", v, 0o644)
	_ = os.WriteFile("/proc/sys/net/ipv6/conf/all/forwarding", v, 0o644)
}

// installCore：把 app 下载+预检的临时核 srcDir，校验 sha256(srcDir/sing-box)==wantHash 后，root 写入锁定的 coreDir
// （整目录 sing-box + libcronet.so 等配套，逐文件 .new+rename 原子就位 + 清陈旧残留）。只写 coreDir、不接受任意路径。
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
	srcNames := map[string]bool{}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		srcNames[name] = true
		data := sbData
		if name != "sing-box" {
			if data, err = os.ReadFile(filepath.Join(srcDir, name)); err != nil {
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
	// 清 coreDir 里非本次 srcDir 的旧残留（rollback 后陈旧配套），但保留 helper 自身二进制与非核文件不误删——
	// 仅删曾由 install-core 放入的核配套：保守起见只清 .new 临时件 + 与 sing-box 同类的库残留由 srcNames 判定。
	if old, err := os.ReadDir(coreDir); err == nil {
		for _, e := range old {
			n := e.Name()
			if e.IsDir() || srcNames[n] || strings.HasSuffix(n, ".new") {
				continue
			}
			// 只清核配套（sing-box / lib*.so*），不碰其它（防误删同目录 helper 二进制等）。
			if n == "sing-box" || strings.HasPrefix(n, "lib") {
				_ = os.Remove(filepath.Join(coreDir, n))
			}
		}
	}
	return "OK installed"
}

func terminateChild(c *exec.Cmd, done <-chan struct{}) {
	if c == nil || c.Process == nil {
		return
	}
	_ = c.Process.Signal(syscall.SIGTERM)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		_ = c.Process.Kill()
	}
}

func watchParent(ppid int, c *exec.Cmd, done <-chan struct{}) {
	t := time.NewTicker(time.Second)
	defer t.Stop()
	for {
		select {
		case <-done:
			return
		case <-t.C:
		}
		mu.Lock()
		current := child == c
		mu.Unlock()
		if !current {
			return
		}
		if err := syscall.Kill(ppid, 0); err == syscall.ESRCH {
			mu.Lock()
			if child != c {
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

var ssPidRe = regexp.MustCompile(`pid=(\d+)`)

// freePort：按端口找 LISTEN 持有者。**仅作用于对端 uid 自己的进程**（procUID==cred.Uid），是 sing-box 才 kill，
// 否则回报占用者名（不跨用户杀、不杀无辜）。ss 缺失/无占用 → OK free。
func freePort(port string, callerUID uint32) string {
	out, err := exec.Command("ss", "-H", "-ltnp", "sport = :"+port).Output()
	if err != nil {
		return "OK free"
	}
	pids := map[string]bool{}
	for _, m := range ssPidRe.FindAllStringSubmatch(string(out), -1) {
		pids[m[1]] = true
	}
	if len(pids) == 0 {
		return "OK free"
	}
	var killed, foreign []string
	for p := range pids {
		// 跨用户防误杀：非对端 uid 的进程一律不动，回报为 foreign。
		if uid, e := procUID(p); e != nil || uid != callerUID {
			foreign = append(foreign, "pid:"+p)
			continue
		}
		comm := ""
		if b, e := os.ReadFile(filepath.Join("/proc", p, "comm")); e == nil {
			comm = strings.TrimSpace(string(b))
		}
		if strings.Contains(comm, "sing-box") {
			if n, e := strconv.Atoi(p); e == nil {
				_ = syscall.Kill(n, syscall.SIGKILL)
			}
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
		return "OK foreign " + strings.Join(foreign, " | ")
	}
	return "OK killed " + strings.Join(killed, ",")
}

func handle(conn net.Conn) {
	defer conn.Close()
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	cred, err := peerCred(conn)
	if err != nil || cred == nil {
		fmt.Fprintln(conn, "ERR peercred")
		return
	}
	r := bufio.NewReader(conn)
	cmd := readLine(r)

	switch cmd {
	case "ping":
		fmt.Fprintf(conn, "OK pong uid=%d v%s\n", os.Getuid(), protoVersion)
		return
	case "version":
		fmt.Fprintf(conn, "OK %s\n", protoVersion)
		return
	}

	if !isAuthorized(cred.Uid) {
		fmt.Fprintln(conn, "ERR unauthorized")
		return
	}

	mu.Lock()
	defer mu.Unlock()

	switch cmd {
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
			setForward(false) // 停核复位转发态（跟随运行中的核）
			reapWG.Add(1)
			go func() { defer reapWG.Done(); terminateChild(c, done) }()
			fmt.Fprintf(conn, "OK stopped %d\n", pid)
		} else {
			fmt.Fprintln(conn, "OK notrunning")
		}
	case "cleanup":
		if child != nil && child.Process != nil {
			_ = child.Process.Kill()
		}
		child, childDone = nil, nil
		setForward(false)
		_ = exec.Command("pkill", "-9", "-U", strconv.Itoa(int(cred.Uid)), "-f", "sing-box run").Run()
		fmt.Fprintln(conn, "OK cleaned")
	case "freeport":
		port := strings.TrimSpace(readLine(r))
		if port == "" || strings.IndexFunc(port, func(c rune) bool { return c < '0' || c > '9' }) >= 0 {
			fmt.Fprintln(conn, "ERR bad-port")
			return
		}
		fmt.Fprintln(conn, freePort(port, cred.Uid))
	case "install-core":
		src := readLine(r)
		wantHash := strings.TrimSpace(readLine(r))
		fmt.Fprintln(conn, installCore(src, wantHash))
	case "start":
		singbox := strings.TrimSpace(readLine(r))
		cfg := readLine(r)
		logPath := readLine(r)
		fwd := readLine(r)
		ppid, _ := strconv.Atoi(readLine(r))

		if child != nil && child.Process != nil {
			fmt.Fprintf(conn, "OK already %d\n", child.Process.Pid)
			return
		}
		if cfg == "" {
			fmt.Fprintln(conn, "ERR bad-args")
			return
		}
		// 核路径锁：只跑锁定的 root-owned coreDir/sing-box。客户端传的 singbox 必须与之一致（否则拒绝，杜绝
		// 「让 helper 以特权跑任意自有二进制」）。config 必须属于对端 uid（防读别人配置）。
		if filepath.Clean(singbox) != coreBin() {
			fmt.Fprintf(conn, "ERR core-path-denied (want %s)\n", coreBin())
			return
		}
		if _, err := os.Stat(coreBin()); err != nil {
			fmt.Fprintf(conn, "ERR core-missing %v\n", err)
			return
		}
		if ok, e := ownedBy(cfg, cred.Uid); !ok {
			fmt.Fprintf(conn, "ERR config-not-owned %v\n", e)
			return
		}
		setForward(fwd == "1") // 显式跟随本次会话（fwd=0 亦复位）

		c := exec.Command(coreBin(), "run", "-c", cfg)
		// 降权拉核：setuid/setgid 回对端登录用户 + AmbientCaps 保留 CAP_NET_ADMIN/RAW/BIND_SERVICE 建 TUN/改路由。
		// Go runtime 在 fork 后、execve 前编排 keep-caps→setuid→raise ambient（Go≥1.19；真机验证 ambient 继承，见设计 §13）。
		c.SysProcAttr = &syscall.SysProcAttr{
			// Groups 显式填登录用户补充组：否则默认 setgroups(0) 清掉补充组，核读不到 group-only 资源（见 supplementaryGroups）。
			Credential: &syscall.Credential{
				Uid:    cred.Uid,
				Gid:    cred.Gid,
				Groups: supplementaryGroups(cred.Uid),
			},
			AmbientCaps: []uintptr{capNetAdmin, capNetRaw, capNetBindService},
		}
		var logFile *os.File
		if logPath != "" {
			if lf, e := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); e == nil {
				_ = lf.Chown(int(cred.Uid), int(cred.Gid))
				logFile = lf
				c.Stdout = lf
				c.Stderr = lf
			}
		}
		if err := c.Start(); err != nil {
			if logFile != nil {
				logFile.Close()
			}
			setForward(false)
			fmt.Fprintf(conn, "ERR start %v\n", err)
			return
		}
		if logFile != nil {
			logFile.Close()
		}
		child = c
		done := make(chan struct{})
		childDone = done
		go func() {
			_ = c.Wait()
			close(done)
			mu.Lock()
			if child == c {
				child, childDone = nil, nil
			}
			mu.Unlock()
		}()
		if ppid > 0 {
			go watchParent(ppid, c, done)
		}
		fmt.Fprintf(conn, "OK started %d\n", c.Process.Pid)
	default:
		fmt.Fprintln(conn, "ERR unknown")
	}
}
