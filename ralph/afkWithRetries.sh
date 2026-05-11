#!/bin/bash
set -eo pipefail

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <plan-and-prd> <iterations>"
  exit 1
fi

# Retry configuration
MAX_RETRIES=12
BASE_DELAY=60
MAX_DELAY=18000

# jq filters
stream_text='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | gsub("\n"; "\r\n") | . + "\r\n\n"'
final_result='select(.type == "result").result // empty'
usage_stats='select(.type == "result") | {input_tokens: (.input_tokens // .usage.input_tokens // 0), output_tokens: (.output_tokens // .usage.output_tokens // 0), cost_usd: (.cost_usd // .total_cost_usd // 0)}'

# Usage accumulators
total_input_tokens=0
total_output_tokens=0

# Temp files — created once, truncated per iteration
tmpfile=$(mktemp)
errfile=$(mktemp)
trap "rm -f $tmpfile $errfile" EXIT

is_retryable_error() {
  local exit_code="$1" errfile="$2" outfile="$3"
  if [ "$exit_code" -eq 0 ]; then
    return 1
  fi
  if grep -qi "invalid key\|invalid api key\|rate limit\|429\|503\|overloaded\|capacity\|too many requests" "$errfile" 2>/dev/null; then
    return 0
  fi
  if grep -qi "invalid key\|invalid api key\|rate limit\|429\|503\|overloaded\|capacity\|too many requests" "$outfile" 2>/dev/null; then
    return 0
  fi
  # Treat unknown non-zero exits as retryable
  return 0
}

calculate_backoff() {
  local attempt="$1" base="$2" max="$3"
  local delay=$(( base * (1 << (attempt - 1)) ))
  if [ "$delay" -gt "$max" ]; then
    delay=$max
  fi
  local jitter=$(( RANDOM % (delay / 4 + 1) ))
  echo $(( delay + jitter ))
}

for ((i=1; i<=$2; i++)); do
  echo ""
  echo "=== Ralph iteration $i/$2 ==="

  commits=$(git log -n 10 --format="%H%n%ad%n%B---" --date=short 2>/dev/null || echo "No commits found")
  prompt=$(cat ralph/prompt.md)

  retry=0
  while true; do
    > "$tmpfile"
    > "$errfile"

    set +e
    sbx run claude . -- \
      --verbose \
      --print \
      --output-format stream-json \
      "Previous commits: $commits Plan and PRD: $1 $prompt" \
    2>>"$errfile" \
    | grep --line-buffered '^{' \
    | tee "$tmpfile" \
    | jq --unbuffered -rj "$stream_text"
    pipe_statuses=("${PIPESTATUS[@]}")
    set -e

    sbx_exit=${pipe_statuses[0]}

    if [ "$sbx_exit" -ne 0 ]; then
      if is_retryable_error "$sbx_exit" "$errfile" "$tmpfile"; then
        retry=$((retry + 1))
        if [ "$retry" -gt "$MAX_RETRIES" ]; then
          echo "ERROR: Max retries ($MAX_RETRIES) exceeded on iteration $i. Aborting."
          echo "Last stderr:"
          cat "$errfile"
          exit 1
        fi
        delay=$(calculate_backoff "$retry" "$BASE_DELAY" "$MAX_DELAY")
        echo ""
        echo "--- Retryable error on iteration $i (attempt $retry/$MAX_RETRIES). Waiting ${delay}s... ---"
        echo "stderr: $(cat "$errfile")"
        sleep "$delay"
        continue
      else
        echo "ERROR: sbx run claude failed with exit code $sbx_exit"
        echo "stderr:"
        cat "$errfile"
        exit 1
      fi
    fi

    break
  done

  # Extract usage stats
  iter_usage=$(jq -r "$usage_stats | \"\(.input_tokens) \(.output_tokens)\"" "$tmpfile" 2>/dev/null | tail -1)
  if [ -n "$iter_usage" ] && [ "$iter_usage" != " " ]; then
    read -r iter_in iter_out <<< "$iter_usage"
    iter_in=${iter_in:-0}
    iter_out=${iter_out:-0}
    total_input_tokens=$((total_input_tokens + iter_in))
    total_output_tokens=$((total_output_tokens + iter_out))
    echo ""
    echo "--- Iteration $i usage: input=$iter_in output=$iter_out"
    echo "--- Cumulative: input=$total_input_tokens output=$total_output_tokens"
  fi

  # Check for completion
  result=$(jq -r "$final_result" "$tmpfile")
  if [[ "$result" == *"<promise>NO MORE TASKS</promise>"* ]]; then
    echo ""
    echo "=== Ralph complete after $i iterations ==="
    echo "=== Total usage: input=$total_input_tokens output=$total_output_tokens ==="
    exit 0
  fi
done

echo ""
echo "=== Ralph finished all $2 iterations ==="
echo "=== Total usage: input=$total_input_tokens output=$total_output_tokens ==="
