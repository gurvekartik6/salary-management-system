#!/usr/bin/env bash
set -Eeuo pipefail
: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
BACKUP_DIR="${BACKUP_DIR:-/app/private-backups}"
UPLOAD_DIR="${PRIVATE_UPLOAD_DIR:-/app/server/private-uploads}"
REPORT_DIR="${PRIVATE_REPORT_DIR:-/app/server/private-reports}"
ASSET_DIR="${PUBLIC_ASSET_DIR:-/app/server/public-assets}"
REFERENCE="${BACKUP_REFERENCE:-SGGS-BKP-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$BACKUP_DIR"
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
mkdir -p "$TMP_DIR/payload/uploads" "$TMP_DIR/payload/reports" "$TMP_DIR/payload/public-assets"
command -v mongodump >/dev/null || { echo "mongodump is not installed" >&2; exit 20; }
command -v node >/dev/null || { echo "node is not installed" >&2; exit 21; }
mongodump --uri="$MONGODB_URI" --archive="$TMP_DIR/payload/database.archive" --gzip
[ ! -d "$UPLOAD_DIR" ] || cp -a "$UPLOAD_DIR"/. "$TMP_DIR/payload/uploads"/
[ ! -d "$REPORT_DIR" ] || cp -a "$REPORT_DIR"/. "$TMP_DIR/payload/reports"/
[ ! -d "$ASSET_DIR" ] || cp -a "$ASSET_DIR"/. "$TMP_DIR/payload/public-assets"/
tar -czf "$TMP_DIR/payload.tar.gz" -C "$TMP_DIR/payload" .
OUTPUT="$BACKUP_DIR/$REFERENCE.sggsbackup"
node "$(dirname "$0")/encrypt-backup.mjs" encrypt "$TMP_DIR/payload.tar.gz" "$OUTPUT"
chmod 600 "$OUTPUT"
SHA256="$(sha256sum "$OUTPUT" | awk '{print $1}')"
SIZE="$(wc -c < "$OUTPUT" | tr -d ' ')"
printf 'reference=%s\ncreated_at=%s\nsha256=%s\nsize_bytes=%s\n' "$REFERENCE" "$(date -u +%FT%TZ)" "$SHA256" "$SIZE" > "$OUTPUT.meta"
chmod 600 "$OUTPUT.meta"
REMOTE_REFERENCE=''
if [ -n "${BACKUP_RCLONE_REMOTE:-}" ]; then
  command -v rclone >/dev/null || { echo 'BACKUP_RCLONE_REMOTE is configured but rclone is not installed' >&2; exit 22; }
  REMOTE_REFERENCE="${BACKUP_RCLONE_REMOTE%/}/$(basename "$OUTPUT")"
  rclone copyto "$OUTPUT" "$REMOTE_REFERENCE"
  rclone copyto "$OUTPUT.meta" "${REMOTE_REFERENCE}.meta"
  rclone check "$OUTPUT" "$REMOTE_REFERENCE" --one-way
  # The configured remote must be a dedicated backup prefix; prune only within that prefix.
  rclone delete --min-age "${BACKUP_RETENTION_DAYS:-35}d" "${BACKUP_RCLONE_REMOTE%/}"
fi
printf 'BACKUP_PATH=%s\nBACKUP_SHA256=%s\nBACKUP_SIZE=%s\nBACKUP_REMOTE_REFERENCE=%s\n' "$OUTPUT" "$SHA256" "$SIZE" "$REMOTE_REFERENCE"
