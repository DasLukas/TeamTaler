#!/usr/bin/env bash

# Start a disposable full-stack development server with representative data.
set -Eeuo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly server_root="${project_root}/tmp/test-server"
readonly binary_dir="${server_root}/bin"
readonly local_env_file="${project_root}/.env.test-server.local"

backend_pid=""
frontend_pid=""
runtime_dir=""

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM

  if [[ -n "${frontend_pid}" ]]; then
    kill "${frontend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${backend_pid}" ]]; then
    kill "${backend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${frontend_pid}" ]]; then
    wait "${frontend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${backend_pid}" ]]; then
    wait "${backend_pid}" 2>/dev/null || true
  fi
  if [[ -n "${runtime_dir}" && "${runtime_dir}" == "${server_root}"/run.* ]]; then
    rm -rf "${runtime_dir}"
  fi

  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

cd "${project_root}"
umask 077
export GOCACHE="${GOCACHE:-${server_root}/go-cache}"

load_local_environment() {
  local line=""
  local name=""
  local value=""

  while IFS= read -r line || [[ -n "${line}" ]]; do
    if [[ -z "${line}" || "${line}" == \#* ]]; then
      continue
    fi
    if [[ "${line}" != *=* ]]; then
      echo "Invalid entry in ${local_env_file}: expected NAME=VALUE." >&2
      exit 1
    fi

    name="${line%%=*}"
    value="${line#*=}"
    case "${name}" in
      TEAMTALER_SMTP_HOST | TEAMTALER_SMTP_PORT | TEAMTALER_SMTP_USERNAME | \
        TEAMTALER_SMTP_PASSWORD | TEAMTALER_SMTP_FROM_ADDRESS | TEAMTALER_SMTP_FROM_NAME | \
        TEAMTALER_SMTP_TLS_MODE | TEAMTALER_EMAIL_TOKEN_KEY)
        export "${name}=${value}"
        ;;
      *)
        echo "Unsupported variable in ${local_env_file}: ${name}." >&2
        exit 1
        ;;
    esac
  done <"${local_env_file}"
}

if [[ -f "${local_env_file}" ]]; then
  load_local_environment
  if [[ -n "${TEAMTALER_SMTP_USERNAME:-}" && -n "${TEAMTALER_SMTP_PASSWORD:-}" ]]; then
    export TEAMTALER_SMTP_FROM_ADDRESS="${TEAMTALER_SMTP_FROM_ADDRESS:-${TEAMTALER_SMTP_USERNAME}}"
    echo "Local SMTP delivery is enabled for the test server."
  else
    unset TEAMTALER_SMTP_HOST TEAMTALER_SMTP_PORT TEAMTALER_SMTP_USERNAME \
      TEAMTALER_SMTP_PASSWORD TEAMTALER_SMTP_FROM_ADDRESS TEAMTALER_SMTP_FROM_NAME \
      TEAMTALER_SMTP_TLS_MODE TEAMTALER_EMAIL_TOKEN_KEY
    echo "Local SMTP delivery is disabled. Add username and password to .env.test-server.local to enable it."
  fi
fi

if ! command -v go >/dev/null 2>&1; then
  echo "Go is required. Install the version documented in README.md." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install the version documented in README.md." >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required for local readiness checks." >&2
  exit 1
fi
if [[ ! -x web/node_modules/.bin/vite ]]; then
  echo "Frontend dependencies are missing. Run 'make install' first." >&2
  exit 1
fi

mkdir -p "${binary_dir}"
runtime_dir="$(mktemp -d "${server_root}/run.XXXXXX")"
readonly data_dir="${runtime_dir}/data"

echo "Building test server binaries..."
go build -buildvcs=false -trimpath -o "${binary_dir}/teamtaler" ./cmd/teamtaler
go build -buildvcs=false -trimpath -o "${binary_dir}/teamtaler-testdata" ./cmd/teamtaler-testdata

TEAMTALER_DATA_DIR="${data_dir}" \
TEAMTALER_DATABASE_PATH="${data_dir}/teamtaler.db" \
TEAMTALER_PUBLIC_URL="http://127.0.0.1:5173" \
"${binary_dir}/teamtaler-testdata"

TEAMTALER_DATA_DIR="${data_dir}" \
TEAMTALER_DATABASE_PATH="${data_dir}/teamtaler.db" \
TEAMTALER_PUBLIC_URL="http://127.0.0.1:5173" \
TEAMTALER_LISTEN="127.0.0.1:8080" \
"${binary_dir}/teamtaler" serve &
backend_pid=$!

for _ in {1..60}; do
  if ! kill -0 "${backend_pid}" 2>/dev/null; then
    wait "${backend_pid}"
  fi
  if curl --fail --silent --max-time 1 "http://127.0.0.1:8080/health/ready" >/dev/null; then
    break
  fi
  sleep 0.25
done

if ! curl --fail --silent --max-time 1 "http://127.0.0.1:8080/health/ready" >/dev/null; then
  echo "Backend did not become ready within 15 seconds." >&2
  exit 1
fi

VITE_DEMO_MODE=false web/node_modules/.bin/vite web \
  --host 127.0.0.1 \
  --port 5173 \
  --strictPort &
frontend_pid=$!

for _ in {1..60}; do
  if ! kill -0 "${frontend_pid}" 2>/dev/null; then
    wait "${frontend_pid}"
  fi
  if curl --fail --silent --max-time 1 "http://127.0.0.1:5173/" >/dev/null; then
    break
  fi
  sleep 0.25
done

if ! curl --fail --silent --max-time 1 "http://127.0.0.1:5173/" >/dev/null; then
  echo "Frontend did not become ready within 15 seconds." >&2
  exit 1
fi

echo
echo "TeamTaler test server is ready at http://127.0.0.1:5173"
echo "Shared password: TeamTaler-Test-2026!"
echo "Accounts: admin@example.test, marie@example.test, jonas@example.test, lena@example.test"
echo "Stop the action to remove its disposable database."

while true; do
  if ! kill -0 "${backend_pid}" 2>/dev/null; then
    set +e
    wait "${backend_pid}"
    exit_code=$?
    set -e
    echo "Backend stopped unexpectedly." >&2
    exit "${exit_code}"
  fi
  if ! kill -0 "${frontend_pid}" 2>/dev/null; then
    set +e
    wait "${frontend_pid}"
    exit_code=$?
    set -e
    echo "Frontend stopped unexpectedly." >&2
    exit "${exit_code}"
  fi
  sleep 1
done
