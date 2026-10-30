#!/usr/bin/env bash
set -Eeuo pipefail
: "${BACKUP_FILE:?Set BACKUP_FILE to the encrypted .sggsbackup file}"
: "${MONGODB_URI:?MONGODB_URI is required}"
: "${BACKUP_ENCRYPTION_PASSPHRASE:?BACKUP_ENCRYPTION_PASSPHRASE is required}"
[ "${CONFIRM_RESTORE:-}" = "YES" ] || { echo "Refusing destructive restore. Set CONFIRM_RESTORE=YES after stopping the app and verifying the backup." >&2; exit 30; }
[ -f "$BACKUP_FILE" ] || { echo "Backup file not found" >&2; exit 31; }
command -v mongorestore >/dev/null || { echo "mongorestore is not installed" >&2; exit 32; }
TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT
node "$(dirname "$0")/encrypt-backup.mjs" decrypt "$BACKUP_FILE" "$TMP_DIR/payload.tar.gz"
tar -xzf "$TMP_DIR/payload.tar.gz" -C "$TMP_DIR"
[ -f "$TMP_DIR/database.archive" ] || { echo "Database archive missing from backup" >&2; exit 33; }
echo "Restoring MongoDB with --drop. This overwrites matching collections in the target database."
mongorestore --uri="$MONGODB_URI" --archive="$TMP_DIR/database.archive" --gzip --drop
UPLOAD_DIR="${PRIVATE_UPLOAD_DIR:-/app/server/private-uploads}"
REPORT_DIR="${PRIVATE_REPORT_DIR:-/app/server/private-reports}"
ASSET_DIR="${PUBLIC_ASSET_DIR:-/app/server/public-assets}"
mkdir -p "$UPLOAD_DIR" "$REPORT_DIR" "$ASSET_DIR"
find "$UPLOAD_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find "$REPORT_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find "$ASSET_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
[ ! -d "$TMP_DIR/uploads" ] || cp -a "$TMP_DIR/uploads"/. "$UPLOAD_DIR"/
[ ! -d "$TMP_DIR/reports" ] || cp -a "$TMP_DIR/reports"/. "$REPORT_DIR"/
[ ! -d "$TMP_DIR/public-assets" ] || cp -a "$TMP_DIR/public-assets"/. "$ASSET_DIR"/
echo "Restore completed. Reconcile queued campaigns and verify application health before reopening traffic."
