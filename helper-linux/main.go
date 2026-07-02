//go:build linux

package main

import (
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

func main() {
	var console bool
	flag.StringVar(&sockPath, "socket", "/run/flowz/helper.sock", "unix socket path")
	flag.StringVar(&authFile, "authfile", "/var/lib/flowz/authorized-uids", "authorized uid list file (one decimal uid per line)")
	flag.StringVar(&coreDir, "coredir", "/usr/local/lib/flowz/core", "locked root-owned managed core dir (only sing-box here is run; install-core writes only here)")
	flag.BoolVar(&console, "console", false, "run in foreground for dev/test (systemd not required)")
	flag.Parse()

	// socket 目录必须 0755 可被任意登录用户穿越 → app 才能连；socket 本身 0666 + SO_PEERCRED + 授权列表把关。
	sockDir := filepath.Dir(sockPath)
	if err := os.MkdirAll(sockDir, 0o755); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = os.Chmod(sockDir, 0o755)
	_ = os.Remove(sockPath)

	l, err := net.Listen("unix", sockPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	_ = os.Chmod(sockPath, 0o666)

	// SIGTERM/SIGINT 收割器：systemctl stop / 卸载时先发 SIGTERM，退出前先收割 child sing-box 并**等待在途后台收割**
	// （stop 的 terminateChild 跑在 goroutine，若此处直接 os.Exit 会杀掉它、留下带 CAP_NET_ADMIN 的孤儿核）。
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-sigCh
		mu.Lock()
		c, done := child, childDone
		child, childDone = nil, nil
		mu.Unlock()
		if c != nil && c.Process != nil {
			terminateChild(c, done) // 同步收割当前 child（TERM→≤5s→KILL）
		}
		// 等在途后台收割（stop 刚摘除 child + go terminateChild 的窗口）跑完 KILL 升级，再退出——杜绝孤儿。
		waitReaps(6 * time.Second)
		setForward(false) // 退出兜底：不留全局转发态
		_ = l.Close()
		os.Exit(0)
	}()

	if console {
		fmt.Printf("FlowZ linux helper (console) listening on %s, coredir=%s, proto v%s\n", sockPath, coreDir, protoVersion)
	}
	for {
		conn, err := l.Accept()
		if err != nil {
			continue
		}
		go handle(conn)
	}
}

// waitReaps：等 reapWG（在途后台 terminateChild）完成，最多 timeout（终不阻死退出）。
func waitReaps(timeout time.Duration) {
	doneCh := make(chan struct{})
	go func() { reapWG.Wait(); close(doneCh) }()
	select {
	case <-doneCh:
	case <-time.After(timeout):
	}
}
