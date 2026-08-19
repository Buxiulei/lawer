#!/usr/bin/env bash
# lawer 数据备份：SQLite 在线备份 + 证据文件库增量镜像 → 加密归档 → 按日期滚动
#
# 用法:
#   BACKUP_PASSPHRASE='xxx' ./backup.sh
#   BACKUP_PASSPHRASE='xxx' BACKUP_DIR=/mnt/backup RETAIN_DAYS=60 ./backup.sh
#
# 恢复:
#   openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha512 \
#     -in lawer-db-20260819-030000.db.enc -pass env:BACKUP_PASSPHRASE > lawer.db
#   openssl enc -d ...同上... -in lawer-files-20260819-030000.tar.gz.enc | tar xzf - -C /恢复目录
#
# 依赖: docker（解析数据卷路径）、sqlite3、openssl、rsync、tar
# 建议 cron: 0 3 * * *  BACKUP_PASSPHRASE=... /path/to/backup.sh >> /var/log/lawer-backup.log 2>&1

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/lawer}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
VOLUME_NAME="${LAWER_VOLUME:-deploy_lawer_data}"   # compose 默认卷名 = 项目名_卷名
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

[ -n "${BACKUP_PASSPHRASE:-}" ] || die "未设置 BACKUP_PASSPHRASE，拒绝产出未加密备份"

for cmd in sqlite3 openssl rsync tar; do
  command -v "$cmd" >/dev/null 2>&1 || die "缺少依赖命令: $cmd"
done

# 数据目录：优先用显式指定（开发/裸机），否则解析 docker 卷挂载点
if [ -n "${LAWER_DATA_DIR:-}" ]; then
  DATA_DIR="$LAWER_DATA_DIR"
else
  command -v docker >/dev/null 2>&1 || die "缺少 docker，且未设置 LAWER_DATA_DIR"
  DATA_DIR="$(docker volume inspect -f '{{ .Mountpoint }}' "$VOLUME_NAME" 2>/dev/null)" \
    || die "找不到数据卷 $VOLUME_NAME（用 LAWER_VOLUME 指定，或用 LAWER_DATA_DIR 直接给路径）"
fi
[ -d "$DATA_DIR" ] || die "数据目录不存在: $DATA_DIR"

DB_PATH="$DATA_DIR/lawer.db"
FILES_DIR="$DATA_DIR/files"

mkdir -p "$BACKUP_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ENC=(openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -md sha512 -salt -pass env:BACKUP_PASSPHRASE)

# ---- 1. SQLite 在线备份 ----
# .backup 走 SQLite 的在线备份 API：不阻塞写入，且能正确合并 WAL 中尚未 checkpoint 的事务。
# 直接 cp 数据库文件在 WAL 模式下会拿到撕裂快照，故必须用 .backup。
if [ -f "$DB_PATH" ]; then
  log "备份数据库: $DB_PATH"
  sqlite3 "$DB_PATH" ".backup '$TMP_DIR/lawer.db'" || die "sqlite3 .backup 失败"

  # 校验副本自洽：备份坏了要当场知道，而不是恢复时才发现
  CHECK="$(sqlite3 "$TMP_DIR/lawer.db" 'PRAGMA integrity_check;')"
  [ "$CHECK" = "ok" ] || die "备份副本完整性校验失败: $CHECK"

  "${ENC[@]}" -in "$TMP_DIR/lawer.db" -out "$BACKUP_DIR/lawer-db-$STAMP.db.enc"
  log "  → $BACKUP_DIR/lawer-db-$STAMP.db.enc ($(du -h "$BACKUP_DIR/lawer-db-$STAMP.db.enc" | cut -f1))"
else
  log "跳过数据库：$DB_PATH 不存在"
fi

# ---- 2. 证据文件库：先增量镜像，再整体加密归档 ----
# 文件按 SHA256 命名、写入后永不修改，故 rsync 增量只搬新增文件，日常开销恒定。
if [ -d "$FILES_DIR" ]; then
  MIRROR="$BACKUP_DIR/files-mirror"
  mkdir -p "$MIRROR"
  log "增量同步证据文件库: $FILES_DIR"
  rsync -a --delete "$FILES_DIR/" "$MIRROR/"

  log "打包加密证据文件库"
  tar czf - -C "$MIRROR" . | "${ENC[@]}" -out "$BACKUP_DIR/lawer-files-$STAMP.tar.gz.enc"
  log "  → $BACKUP_DIR/lawer-files-$STAMP.tar.gz.enc ($(du -h "$BACKUP_DIR/lawer-files-$STAMP.tar.gz.enc" | cut -f1))"
else
  log "跳过文件库：$FILES_DIR 不存在"
fi

# ---- 3. 按日期滚动 ----
log "清理 $RETAIN_DAYS 天前的归档"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'lawer-*.enc' -mtime "+$RETAIN_DAYS" -print -delete

log "备份完成: $BACKUP_DIR"
