#!/usr/bin/env bash
set -euo pipefail

files=(-f compose.yaml -f compose.integration.yaml)
project_name="${COMPOSE_PROJECT_NAME:-acm-it-${RANDOM}-$$}"

cleanup() {
  docker compose --project-name "$project_name" "${files[@]}" --profile test down -v --remove-orphans
}
trap cleanup EXIT

docker compose --project-name "$project_name" "${files[@]}" --profile test up \
  --build \
  --abort-on-container-exit \
  --exit-code-from integration-tests
