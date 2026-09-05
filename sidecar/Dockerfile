# sidecar/Dockerfile
FROM python:3.11-slim

WORKDIR /app

# fonts-noto-cjk：《存证证明》PDF 的中文字形（缺了整片渲染成黑块）
# curl：容器健康检查
# ffmpeg：/video 抽音轨与关键帧（缺了该端点恒 503）
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-cjk curl ffmpeg \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# 业务脚本 + 信任锚 PEM（离线验签用，随镜像分发）
COPY . .

# 容器内监听全 0.0.0.0：compose 不映射宿主端口，只挂内网网络
ENV SIDECAR_HOST=0.0.0.0 \
    SIDECAR_PORT=8100

EXPOSE 8100
# 用 127.0.0.1 而非 localhost：uvicorn 绑 0.0.0.0 只监听 IPv4，而 localhost 可能先解析到
# ::1，健康检查会无谓地先吃一次连接失败。显式走 IPv4 环回，行为确定。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://127.0.0.1:8100/health || exit 1

CMD ["python", "main.py"]
