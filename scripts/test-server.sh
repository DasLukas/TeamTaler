#!/usr/bin/env bash

# Start a disposable full-stack development server with representative data.
set -Eeuo pipefail

readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly server_root="${project_root}/tmp/test-server"
readonly binary_dir="${server_root}/bin"
readonly local_env_file="${project_root}/.env.test-server.local"
readonly readiness_timeout_seconds="${TEAMTALER_TEST_SERVER_READY_TIMEOUT_SECONDS:-60}"
readonly test_password="TeamTaler-Test-2026!"

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
      TEAMTALER_SMTP_TLS_MODE)
        export "${name}=${value}"
        ;;
      TEAMTALER_EMAIL_TOKEN_KEY)
        if [[ -n "${value}" ]]; then
          export "${name}=${value}"
        fi
        ;;
      *)
        echo "Unsupported variable in ${local_env_file}: ${name}." >&2
        exit 1
        ;;
    esac
  done <"${local_env_file}"
}

# Wait until a child process serves its readiness URL.
#
# Arguments:
#   $1 - Human-readable process name used in diagnostics.
#   $2 - Child process ID to monitor.
#   $3 - HTTP URL that must return a successful status code.
#
# Returns:
#   0 when the URL becomes ready within the configured timeout, otherwise 1.
wait_for_server() {
  local process_name="$1"
  local process_pid="$2"
  local readiness_url="$3"
  local deadline=$((SECONDS + readiness_timeout_seconds))
  local exit_code=0

  while ((SECONDS < deadline)); do
    if ! kill -0 "${process_pid}" 2>/dev/null; then
      if wait "${process_pid}"; then
        exit_code=0
      else
        exit_code=$?
      fi
      echo "${process_name} stopped before becoming ready (exit code ${exit_code})." >&2
      return 1
    fi
    if curl --fail --silent --max-time 1 "${readiness_url}" >/dev/null; then
      return 0
    fi
    sleep 0.25
  done

  echo "${process_name} did not become ready within ${readiness_timeout_seconds} seconds." >&2
  return 1
}

# Print one Markdown-compatible access row.
#
# Arguments:
#   $1 - Group name or group-less account description.
#   $2 - Login email address.
print_access_row() {
  printf '| %s | %s | %s |\n' "$1" "$2" "${test_password}"
}

if [[ ! "${readiness_timeout_seconds}" =~ ^[1-9][0-9]*$ ]]; then
  echo "TEAMTALER_TEST_SERVER_READY_TIMEOUT_SECONDS must be a positive integer." >&2
  exit 1
fi

if [[ "${TEAMTALER_TEST_DISABLE_SMTP:-false}" == "true" ]]; then
  unset TEAMTALER_SMTP_HOST TEAMTALER_SMTP_PORT TEAMTALER_SMTP_USERNAME \
    TEAMTALER_SMTP_PASSWORD TEAMTALER_SMTP_FROM_ADDRESS TEAMTALER_SMTP_FROM_NAME \
    TEAMTALER_SMTP_TLS_MODE TEAMTALER_SMTP_TEST_RECIPIENT
  echo "Local SMTP delivery is disabled for this test run."
elif [[ -f "${local_env_file}" ]]; then
  load_local_environment
  if [[ -n "${TEAMTALER_SMTP_USERNAME:-}" && -n "${TEAMTALER_SMTP_PASSWORD:-}" ]]; then
    export TEAMTALER_SMTP_FROM_ADDRESS="${TEAMTALER_SMTP_FROM_ADDRESS:-${TEAMTALER_SMTP_USERNAME}}"
    export TEAMTALER_SMTP_TEST_RECIPIENT="${TEAMTALER_SMTP_FROM_ADDRESS}"
    echo "Local SMTP delivery is enabled for the test server."
  else
    unset TEAMTALER_SMTP_HOST TEAMTALER_SMTP_PORT TEAMTALER_SMTP_USERNAME \
      TEAMTALER_SMTP_PASSWORD TEAMTALER_SMTP_FROM_ADDRESS TEAMTALER_SMTP_FROM_NAME \
      TEAMTALER_SMTP_TLS_MODE TEAMTALER_SMTP_TEST_RECIPIENT
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

if ! wait_for_server "Backend" "${backend_pid}" "http://127.0.0.1:8080/health/ready"; then
  exit 1
fi

VITE_DEMO_MODE=false web/node_modules/.bin/vite web \
  --host 127.0.0.1 \
  --port 5173 \
  --strictPort &
frontend_pid=$!

if ! wait_for_server "Frontend" "${frontend_pid}" "http://127.0.0.1:5173/health/ready.txt"; then
  exit 1
fi

echo
echo "TeamTaler-Testserver ist bereit: http://127.0.0.1:5173"
echo "Planung ist in beiden Gruppen mit Testterminen vor, an und nach dem heutigen Tag aktiviert."
echo
printf '| Gruppe | Nutzer | Passwort |\n'
printf '|---|---|---|\n'
print_access_row "TSV Sonnenberg" "admin@example.test"
print_access_row "TSV Sonnenberg" "marie@example.test"
print_access_row "TSV Sonnenberg" "jonas@example.test"
print_access_row "TSV Sonnenberg" "lena@example.test"
print_access_row "TSV Sonnenberg" "emil@example.test"
print_access_row "Freizeitteam Wochenende" "admin@example.test"
print_access_row "Freizeitteam Wochenende" "lena@example.test"
print_access_row "Freizeitteam Wochenende" "noah@example.test"
print_access_row "Keine Gruppe (Systemverwaltung)" "systemonly@example.test"
echo
echo "Beim Beenden der Aktion wird die temporäre Datenbank gelöscht."

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
