package main

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

const hostMemInfoPath = "/proc/meminfo"

// checkStartMemory checks configured Linux host limits before creating a child.
func (h *Hub) checkStartMemory(instanceMin *int) error {
	minAvailable := h.cfg.MinAvailableMemoryMb
	maxSwap := h.cfg.MaxSwapUsedPercent
	if minAvailable < 0 || (maxSwap != nil && (*maxSwap < 0 || *maxSwap > 100)) {
		return newUserError("INSTANCE_MEMORY_UNAVAILABLE", "主机内存守卫配置无效")
	}
	if minAvailable > 0 && instanceMin != nil {
		minAvailable = *instanceMin
	}
	if minAvailable == 0 && maxSwap == nil {
		return nil
	}

	read := h.readHostMemInfo
	if read == nil {
		read = func() ([]byte, error) { return os.ReadFile(hostMemInfoPath) }
	}
	data, err := read()
	if err != nil {
		return newUserError("INSTANCE_MEMORY_UNAVAILABLE", "无法读取 /proc/meminfo，无法检查主机内存守卫")
	}
	mem := parseHostMemInfo(data)
	if minAvailable > 0 {
		available, ok := mem["MemAvailable"]
		if !ok {
			return newUserError("INSTANCE_MEMORY_UNAVAILABLE", "/proc/meminfo 缺少有效的 MemAvailable")
		}
		if available/1024 < uint64(minAvailable) {
			return newUserError("INSTANCE_MEMORY_LOW", fmt.Sprintf("可用内存 %d MiB，低于启动要求的 %d MiB", available/1024, minAvailable))
		}
	}
	if maxSwap != nil {
		total, totalOK := mem["SwapTotal"]
		free, freeOK := mem["SwapFree"]
		if !totalOK || (total > 0 && (!freeOK || free > total)) {
			return newUserError("INSTANCE_MEMORY_UNAVAILABLE", "/proc/meminfo 缺少有效的交换空间数据")
		}
		if total > 0 {
			used := 100 * float64(total-free) / float64(total)
			if used > float64(*maxSwap) {
				return newUserError("INSTANCE_MEMORY_LOW", fmt.Sprintf("交换空间使用率 %.2f%%，超过启动上限 %d%%", used, *maxSwap))
			}
		}
	}
	return nil
}

func parseHostMemInfo(data []byte) map[string]uint64 {
	values := make(map[string]uint64)
	for line := range strings.SplitSeq(string(data), "\n") {
		key, value, ok := strings.Cut(line, ":")
		if !ok || (key != "MemAvailable" && key != "SwapTotal" && key != "SwapFree") {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) != 2 || fields[1] != "kB" {
			continue
		}
		n, err := strconv.ParseUint(fields[0], 10, 64)
		if err == nil {
			values[key] = n
		}
	}
	return values
}
