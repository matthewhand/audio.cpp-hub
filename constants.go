package main

import "time"

// 行为常量集中定义，避免魔法数字散落在各文件里、含义漂移。
// 注意：即使数值相同，语义不同的常量也各自命名，不合并复用。

const (
	// 任务队列：单实例排队上限、已完成任务内存保留条数、文本预览截断字数。
	taskQueueSize      = 100
	finishedKeep       = 100
	taskTextPreviewMax = 100

	// 实例：事件日志缓冲上限、日志尾部读取字节数与保留行数。
	instanceEventCap = 20
	logTailBytes     = 64 << 10
	logTailLines     = 10

	// 内部（非代理）HTTP 错误响应体读取上限，防止异常大响应撑爆内存。
	maxErrorBodyBytes = 1 << 20

	// 静态资源缓存时长（秒）：web/ 无构建步骤、文件名不带内容 hash，
	// 没法用 immutable 长缓存，故取有界的 1 小时；HTML 入口强制 no-cache 每次回源。
	staticAssetMaxAge = 3600

	// 下载：单分段最小字节数，小于该值不分段。
	dlSegmentMin = 32 * 1024 * 1024

	// 内存采样（memory.go）：实例有 RUNNING 任务时 ~1s、空闲时 ~10s 一采，
	// 基础心跳 1s（决定 pass 的最大粒度，也用于发现新实例）；
	// nvidia-smi 单次查询超时与失败后的退避时长（缺二进制不再每秒拉进程）。
	memSampleBusyInterval = 1 * time.Second
	memSampleIdleInterval = 10 * time.Second
	memSamplerTick        = 1 * time.Second
	nvidiaQueryTimeout    = 2 * time.Second
	nvidiaBackoff         = 5 * time.Minute

	// 内存采样环形缓冲（memory.go）：GET /api/instances 的 memory 对象里
	// ramSeries / vramSeries 最多回带多少个历史采样点（旧→新）。前端画
	// 迷你折线图用；少于此数的序列整体省略（<2 个点画不出线）。
	memSeriesCap = 60

	// SSE（events.go）：连接后心跳注释间隔与每订阅者事件缓冲上限
	// （慢订阅者缓冲满即丢事件，绝不阻塞任务执行路径）。
	ssePingInterval = 15 * time.Second
	eventBusBuffer  = 64
)
