# deploy —— 部署编排

三个容器：**caddy**（唯一对外，80/443 自动 HTTPS）→ **web**（Next.js）→ **sidecar**（Python）。
web 与 sidecar 都不映射宿主端口；sidecar 只在 compose 内网经 `http://sidecar:8100` 可达。

```
公网 ──443──► caddy ──► web:3000 ──► sidecar:8100
                          │              │
                     lawer_data 卷    出网：TSA / DashScope
                   (lawer.db + files)
```

## 文件

| 文件 | 作用 |
|---|---|
| `docker-compose.yml` | 三服务编排、数据卷、内网 |
| `Caddyfile` | 反代与 HTTPS，域名走 `{$LAWER_DOMAIN}` 占位 |
| `backup.sh` | SQLite 在线备份 + 证据文件增量 + openssl 加密 + 日期滚动 |
| `.env.example` | 编排层变量样例（域名、ACME 邮箱） |

## 首次部署

```bash
cd deploy
cp .env.example .env            # 填 LAWER_DOMAIN / LAWER_ACME_EMAIL
cp ../sidecar/.env.example ../sidecar/.env   # 填 DASHSCOPE_API_KEY、SIGNING_CERT_* 等
cp ../app/.env.example ../app/.env           # 由 app 侧提供

# 凭证目录（只读挂进容器；已被 .gitignore 忽略，禁止入库）
mkdir -p secrets/sign
cp /安全的地方/lawer.pfx secrets/sign/lawer.pfx

docker compose up -d --build
docker compose ps
docker compose logs -f caddy
```

`app/.env` 与 `sidecar/.env` **必须先存在**，否则 compose 会因 `env_file` 找不到而启动失败。
这是刻意的：宁可硬失败，也不要缺密钥静默启动。

### 注意 `app/.env` 与 `app/.env.local` 的区别

开发机上的凭据装配在 `app/.env.local`（Next.js 本地约定）。但镜像的 `.dockerignore`
排除了所有 `.env*`，容器内**不存在任何 .env 文件**，运行时环境变量**全部由 compose 注入**。
所以部署前必须把 `.env.local` 里该带上生产的键值汇总进 `app/.env`，compose 只读后者。

其中 **`LAWER_DATA_KEY` 是硬依赖**：它是手机号 / 身份证 / 实名快照等字段的
AES-256-GCM 主密钥（32 字节，hex 或 base64）。缺失或长度不对时 app 侧直接抛错、
不做静默降级，等于 auth 与实名功能全线不可用。

## 数据卷

| 卷 | 内容 | 要不要备份 |
|---|---|---|
| `lawer_data` | `/data/lawer.db`（WAL）+ `/data/files`（证据文件，SHA256 去重加密） | **必须**，见 `backup.sh` |
| `caddy_data` | ACME 证书与账户密钥 | 建议（重签有速率限制） |
| `caddy_config` | Caddy 运行时配置 | 否 |

## 备份

```bash
BACKUP_PASSPHRASE='<强口令>' ./backup.sh
```

产出（默认落 `/var/backups/lawer`，`BACKUP_DIR` 可改）：

- `lawer-db-<时间戳>.db.enc` —— `sqlite3 .backup` 在线快照（不阻塞写、正确合并 WAL），
  做过 `PRAGMA integrity_check` 才加密
- `lawer-files-<时间戳>.tar.gz.enc` —— 证据文件库；先 `rsync` 增量到本地镜像再整体打包
- `files-mirror/` —— 增量镜像本体（未加密，仅作 rsync 基线；勿投递到异地）

加密用 `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha512`，口令走
`BACKUP_PASSPHRASE` 环境变量；**没给口令直接拒绝执行**，不产出明文备份。
默认保留 30 天（`RETAIN_DAYS`）。

恢复命令写在 `backup.sh` 头部注释里。**口令丢失即无法恢复**，请与备份分开保管。

### 备份数据还不够：`LAWER_DATA_KEY` 必须一起备份

库里的 `*_enc` 字段（手机号、身份证、实名快照）是用 `LAWER_DATA_KEY` 加密的，
`*_hash` 查找列也由它派生。**这个密钥一旦丢失或轮换，既有密文全部解不开、
哈希查找列全部对不上，等价于丢库** —— 哪怕 `lawer.db` 备份完好无损。

所以要备份的是**三样，缺一不可**：

1. `lawer-db-*.db.enc`（`backup.sh` 产出）
2. `lawer-files-*.tar.gz.enc`（`backup.sh` 产出）
3. `LAWER_DATA_KEY` 与 `BACKUP_PASSPHRASE`（`backup.sh` **不碰**，须人工离线保管）

第 3 项刻意不进备份脚本：把解密密钥和密文放在同一份归档里，加密就白做了。
请存在密码管理器 / 离线介质，并与归档分开存放。轮换密钥前必须先做全量数据重加密迁移，
不能直接改 env 了事。

定时任务示例：

```cron
0 3 * * * BACKUP_PASSPHRASE='...' /path/to/deploy/backup.sh >> /var/log/lawer-backup.log 2>&1
```

数据目录默认从 docker 卷 `deploy_lawer_data` 解析（compose 项目名 `deploy` + 卷名）。
项目名不同用 `LAWER_VOLUME` 指定；裸机部署用 `LAWER_DATA_DIR` 直接给路径。

## 待办

- 备份目前只落本机盘，**异地投递（对象存储/另一台机器）尚未接**，属单点风险。
  另注意 `files-mirror/` 是 rsync 基线、**未加密**，不能直接投递异地。
- `/api/health` 目前只报 Node 进程活着，不探库；待 `lib/db` 落地后会在其中加 `SELECT 1`
  （端点路径与返回形状不变，compose 无需改动）。

## 服务契约（已与 app 侧对齐并实跑校验）

compose 注入给 web 容器、app 侧按此读取：

| 变量 | 值 | 说明 |
|---|---|---|
| `DB_PATH` | `/data/lawer.db` | 镜像里已有同名默认值 |
| `FILES_DIR` | `/data/files` | 镜像里已 `mkdir -p` |
| `SIDECAR_URL` | `http://sidecar:8100` | 编排拓扑，刻意不烘进镜像 |
| `PORT` | `3000` | 配合 `HOSTNAME=0.0.0.0` |
| `LAWER_DATA_KEY` | 走 `app/.env` | 见上文，硬依赖 |

**容器内监听地址的坑**（web 与 sidecar 都已规避）：Next standalone 的 `server.js`
拿 `process.env.HOSTNAME` 当监听地址，而 Docker 会把 `HOSTNAME` 设成容器 ID，
结果只监听容器 eth0 的 IP、环回不监听，容器内健康检查必然失败。
app 镜像里已显式 `ENV HOSTNAME=0.0.0.0`；sidecar 同理由 `SIDECAR_HOST=0.0.0.0` 控制。
两边的 HEALTHCHECK 都走 `127.0.0.1` 而非 `localhost`，避开先解析到 `::1` 的问题。
