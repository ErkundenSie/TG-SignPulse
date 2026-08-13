#!/bin/sh
set -eu

PORT_VALUE="${PORT:-8080}"
AUTO_FIX_PERMS="${APP_AUTO_FIX_DATA_PERMS:-1}"

# Default runtime identity (kept for compatibility with existing images).
DEFAULT_UID="${APP_UID:-10001}"
DEFAULT_GID="${APP_GID:-10001}"
TARGET_UID="$DEFAULT_UID"
TARGET_GID="$DEFAULT_GID"

# If /data is mounted, prefer running as its owner/group to avoid chmod 777.
if [ -d /data ]; then
  DATA_UID="$(stat -c '%u' /data 2>/dev/null || true)"
  DATA_GID="$(stat -c '%g' /data 2>/dev/null || true)"
  if [ -n "${DATA_UID}" ] && [ -n "${DATA_GID}" ]; then
    TARGET_UID="${DATA_UID}"
    TARGET_GID="${DATA_GID}"
  fi
fi

# A full-system restore is staged by the API and intentionally applied only
# during process startup, before SQLite and background services are opened.
if [ -d /data/.restore-pending/payload/system ]; then
  echo "INFO: applying staged TG-FlowPulse system restore ..."
  for p in /data/.restore-pending/payload/system/*; do
    [ -e "${p}" ] || continue
    name="$(basename "${p}")"
    rm -rf "/data/${name}"
    cp -a "${p}" "/data/${name}"
  done
  rm -rf /data/.restore-pending
fi

# The restored file is generated from a fixed allow-list of environment keys.
# Do not source it: values may contain shell metacharacters.
if [ -f /data/.runtime.env ]; then
  while IFS='=' read -r key value; do
    case "${key}" in
      APP_SECRET_KEY|APP_CORS_ORIGINS|APP_TOTP_VALID_WINDOW|TG_API_ID|TG_API_HASH|TG_SESSION_MODE|TG_SESSION_NO_UPDATES|TG_NO_UPDATES|TZ)
        export "${key}=${value}"
        ;;
    esac
  done < /data/.runtime.env
fi

if [ "$(id -u)" -eq 0 ]; then
  if [ "${AUTO_FIX_PERMS}" != "0" ] && [ -d /data ]; then
    echo "INFO: fixing /data permissions for ${TARGET_UID}:${TARGET_GID} ..."
    # Ensure core paths exist first.
    mkdir -p /data/.signer /data/sessions /data/logs || true

    # Repair ownership and write bits for existing historical files.
    # This avoids readonly sqlite and permission denied after image upgrades.
    for p in /data /data/.signer /data/sessions /data/logs /data/.restore-pending /data/db.sqlite /data/.tg_flowpulse_data_dir /data/.tg_signpulse_data_dir; do
      if [ -e "${p}" ]; then
        chown -R "${TARGET_UID}:${TARGET_GID}" "${p}" 2>/dev/null || true
        chmod -R u+rwX "${p}" 2>/dev/null || true
        chmod -R g+rwX "${p}" 2>/dev/null || true
      fi
    done
  fi

  # If mounted volume is root-owned, keep root to preserve writability.
  if [ "${TARGET_UID}" = "0" ] || [ "${TARGET_GID}" = "0" ]; then
    exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT_VALUE}"
  fi
  exec gosu "${TARGET_UID}:${TARGET_GID}" uvicorn backend.main:app --host 0.0.0.0 --port "${PORT_VALUE}"
fi

exec uvicorn backend.main:app --host 0.0.0.0 --port "${PORT_VALUE}"
