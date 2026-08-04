#!/bin/sh
set -eu

backup_dir="${TEAMTALER_BACKUP_DIR:-./backups}"
mkdir -p "$backup_dir"

archive_name="teamtaler-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
container_archive="/var/lib/teamtaler/backups/$archive_name"

docker compose exec -T app teamtaler backup create --output "$container_archive"
if ! docker compose cp "app:$container_archive" "$backup_dir/$archive_name"; then
  echo "Backup copy failed; the archive remains available at $container_archive" >&2
  exit 1
fi
docker compose exec -T app rm -f "$container_archive"

echo "TeamTaler backup copied to $backup_dir/$archive_name"
