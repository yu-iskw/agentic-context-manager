#!/usr/bin/env bash
set -euo pipefail

files=(-f compose.yaml -f compose.integration.yaml)
project_name="${COMPOSE_PROJECT_NAME:-acm-it-${RANDOM}-$$}"

cleanup() {
  status=$?
  if (( status != 0 )); then
    echo "Compose integration failed; dumping service logs" >&2
    docker compose --project-name "$project_name" "${files[@]}" --profile test logs --no-color >&2 || true
  fi
  docker compose --project-name "$project_name" "${files[@]}" --profile test down -v --remove-orphans
  return "$status"
}
trap cleanup EXIT

docker compose --project-name "$project_name" "${files[@]}" --profile test up \
  --build \
  --abort-on-container-exit \
  --exit-code-from integration-tests
