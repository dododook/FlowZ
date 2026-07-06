//go:build darwin

package main

import (
	"encoding/binary"
	"fmt"
	"syscall"
	"unsafe"
)

// procStartTimeOS 经 sysctl kern.proc.pid 取进程启动时间（微秒精度），零子进程、零锁外命令。
// Go 1.24 的 darwin syscall 包没有 SysctlRaw（在 x/sys/unix），helper 保持纯 stdlib —— 用固定数字 MIB
// {CTL_KERN=1, KERN_PROC=14, KERN_PROC_PID=1, pid} 直呼 SYS___SYSCTL（MIB 编号是 darwin ABI 稳定常量）。
// kinfo_proc 首字段为 extern_proc，其 p_un union 首成员即 __p_starttime (struct timeval)：
// 64 位 darwin 上 tv_sec=int64(偏移0)、tv_usec=int32(偏移8)，arm64/amd64 同布局。
// 相比 `ps -o lstart=`（秒级）：微秒身份把「同秒 PID 复用」的假阴性窗口从 1s 收到 1µs，
// 且不受 ps 输出本地化/格式漂移影响。失败返回 ""，调用方回退 ps lstart（跨平台兜底）。
func procStartTimeOS(pid int) string {
	mib := [4]int32{1, 14, 1, int32(pid)}
	// kinfo_proc 在 64 位 darwin 为 648 字节；给足缓冲，内核经 n 回写实际长度。
	var kp [1024]byte
	n := uintptr(len(kp))
	_, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])),
		uintptr(len(mib)),
		uintptr(unsafe.Pointer(&kp[0])),
		uintptr(unsafe.Pointer(&n)),
		0,
		0,
	)
	if errno != 0 || n < 16 {
		return ""
	}
	sec := int64(binary.LittleEndian.Uint64(kp[0:8]))
	usec := int32(binary.LittleEndian.Uint32(kp[8:12]))
	// sec<=0 或 usec 越出 [0,999999]：内核未填充/解析错位/数据损坏 → 按取不到处理（调用方保守不判死），
	// 不产出 "123.-00001" 这类畸形身份串。
	if sec <= 0 || usec < 0 || usec > 999999 {
		return ""
	}
	return fmt.Sprintf("%d.%06d", sec, usec)
}
