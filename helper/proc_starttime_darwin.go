//go:build darwin

package main

import (
	"encoding/binary"
	"fmt"
	"syscall"
)

// procStartTimeOS 经 sysctl kern.proc.pid 取进程启动时间（微秒精度），零子进程、零锁外命令。
// kinfo_proc 首字段为 extern_proc，其 p_un union 首成员即 __p_starttime (struct timeval)：
// 64 位 darwin 上 tv_sec=int64(偏移0)、tv_usec=int32(偏移8)，与架构无关（arm64/amd64 同布局）。
// 相比 `ps -o lstart=`（秒级）：微秒身份把「同秒 PID 复用」的假阴性窗口从 1s 收到 1µs，
// 且不受 ps 输出本地化/格式漂移影响。失败返回 ""，调用方回退 ps lstart（跨平台兜底）。
func procStartTimeOS(pid int) string {
	raw, err := syscall.SysctlRaw("kern.proc.pid", pid)
	if err != nil || len(raw) < 16 {
		return ""
	}
	sec := int64(binary.LittleEndian.Uint64(raw[0:8]))
	usec := int32(binary.LittleEndian.Uint32(raw[8:12]))
	// sec<=0 或 usec 越出 [0,999999]：内核未填充/解析错位/数据损坏 → 按取不到处理（调用方保守不判死），
	// 不产出 "123.-00001" 这类畸形身份串。
	if sec <= 0 || usec < 0 || usec > 999999 {
		return ""
	}
	return fmt.Sprintf("%d.%06d", sec, usec)
}
