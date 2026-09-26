# Dockerfile — Go 版 audio.cpp-hub 通用镜像（CPU / Vulkan）。
# AMD GPU 用户请改用 Dockerfile.amd（内置 Mesa RADV，见 compose.amd.yaml）。
#
# 多阶段构建：golang 构建静态二进制 → slim 运行镜像。
# 运行镜像只包含 hub 自身依赖；audiocpp_server 及其 ggml 共享库由宿主只读挂载。
FROM golang:1.27 AS builder

WORKDIR /src

# 先拉依赖，利用镜像层缓存
COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
        -trimpath -ldflags="-s -w -X main.version=${VERSION}" \
        -o /out/audio.cpp-hub .


FROM debian:bookworm-slim AS runtime

# ca-certificates/curl：HTTPS 下载与健康检查；python3：start-instance.sh 解析实例 JSON；
# libvulkan1 + libgomp1：Vulkan 载入器与 OpenMP 运行库（audiocpp_server 依赖）。
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         ca-certificates curl python3 \
         libvulkan1 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Go 二进制（hub 静态单文件）
COPY --from=builder /out/audio.cpp-hub /usr/local/bin/audio.cpp-hub

# hub 从磁盘读取的资源：web/ 静态页面、hub.config.json、executables.json。
# models.json / model-packages.json 已在二进制内 go:embed，无需复制。
COPY web ./web
COPY hub.config.json ./hub.config.json
COPY docker/executables.json ./executables.json

# 容器入口脚本
COPY docker/start-hub.sh /usr/local/bin/start-hub.sh
COPY docker/start-instance.sh /usr/local/bin/start-instance.sh
RUN chmod 0755 /usr/local/bin/audio.cpp-hub \
             /usr/local/bin/start-hub.sh \
             /usr/local/bin/start-instance.sh

EXPOSE 18080

ENTRYPOINT ["/usr/local/bin/start-hub.sh"]
