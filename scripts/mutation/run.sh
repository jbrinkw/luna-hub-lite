#!/usr/bin/env bash
# scripts/mutation/run.sh — Mutation-testing gate (Stryker, TS).
#
# Usage:
#   bash scripts/mutation/run.sh                 # full run (slow; nightly)
#   bash scripts/mutation/run.sh --related <files...>
#       # sampled: mutate only the given files. Used by PR CI.
#   bash scripts/mutation/run.sh --config <path> # use a custom stryker config
#
# Contract: VERIFY.md — "Gate: Mutation".
#   Exit 0 on pass, non-zero on fail. Writes .verify/mutation.json.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# Arg parsing
# -----------------------------------------------------------------------------
RELATED_FILES=()
CONFIG_FILE="stryker.conf.json"
RELATED_MODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --related)
      RELATED_MODE=1
      shift
      # Gather file args until the next flag or end-of-args
      while [[ $# -gt 0 && "${1:0:2}" != "--" ]]; do
        RELATED_FILES+=("$1")
        shift
      done
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
STRYKER_BIN="$REPO_ROOT/node_modules/.bin/stryker"
if [[ ! -x "$STRYKER_BIN" ]]; then
  echo "Stryker not installed. Run: pnpm install" >&2
  exit 2
fi

mkdir -p "$REPO_ROOT/.verify"
mkdir -p "$REPO_ROOT/reports/mutation"

START_MS=$(date +%s%3N)
RAN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
LOG_FILE="$REPO_ROOT/.verify/mutation.log"

# -----------------------------------------------------------------------------
# Build Stryker command
# -----------------------------------------------------------------------------
STRYKER_ARGS=(run "$CONFIG_FILE")

if [[ "$RELATED_MODE" -eq 1 ]]; then
  if [[ "${#RELATED_FILES[@]}" -eq 0 ]]; then
    echo "--related requires at least one file argument" >&2
    exit 2
  fi
  # Comma-joined list for --mutate
  MUTATE_LIST=$(IFS=, ; echo "${RELATED_FILES[*]}")
  STRYKER_ARGS+=(--mutate "$MUTATE_LIST")
  echo "[mutation] sampled mode: mutating only $MUTATE_LIST" >&2
else
  echo "[mutation] full mode: using config mutate[] from $CONFIG_FILE" >&2
fi

# Non-zero exit from Stryker = threshold broken OR runtime error.
# We capture its exit code, still write our artifact, then propagate.
set +e
"$STRYKER_BIN" "${STRYKER_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
STRYKER_EXIT=${PIPESTATUS[0]}
set -e 2>/dev/null || true

END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

# -----------------------------------------------------------------------------
# Parse Stryker JSON report and emit .verify/mutation.json
# -----------------------------------------------------------------------------
REPORT_JSON="$REPO_ROOT/reports/mutation/mutation.json"
ARTIFACT="$REPO_ROOT/.verify/mutation.json"

node --input-type=module - <<'NODE' "$REPORT_JSON" "$ARTIFACT" "$STRYKER_EXIT" "$RAN_AT" "$DURATION_MS" "$RELATED_MODE"
import fs from 'node:fs';
const [reportPath, artifactPath, exitRaw, ranAt, durMs, relatedRaw] = process.argv.slice(2);
const exitCode = Number(exitRaw);
const related = relatedRaw === '1';

let report = null;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (e) {
  // No report — Stryker failed to produce output
}

const checks = [];
const failures = [];
const perFile = [];

let totalKilled = 0, totalSurvived = 0, totalTimeout = 0, totalNoCov = 0, totalRuntime = 0, totalIgnored = 0, totalCompileErr = 0, totalPending = 0;

if (report && report.files) {
  for (const [fname, fdata] of Object.entries(report.files)) {
    let killed = 0, survived = 0, timeout = 0, noCov = 0, runtime = 0, ignored = 0, compileErr = 0, pending = 0;
    for (const m of fdata.mutants ?? []) {
      switch (m.status) {
        case 'Killed': killed++; break;
        case 'Survived': survived++; break;
        case 'Timeout': timeout++; break;
        case 'NoCoverage': noCov++; break;
        case 'RuntimeError': runtime++; break;
        case 'Ignored': ignored++; break;
        case 'CompileError': compileErr++; break;
        case 'Pending': pending++; break;
      }
    }
    totalKilled += killed; totalSurvived += survived; totalTimeout += timeout;
    totalNoCov += noCov; totalRuntime += runtime; totalIgnored += ignored;
    totalCompileErr += compileErr; totalPending += pending;

    const detected = killed + timeout;
    const undetected = survived + noCov;
    const valid = detected + undetected;
    const score = valid > 0 ? (detected / valid) * 100 : null;
    perFile.push({
      file: fname,
      score_pct: score === null ? null : Number(score.toFixed(2)),
      killed, survived, timeout, noCovered: noCov,
      runtimeError: runtime, ignored, compileError: compileErr, pending,
    });
  }
}

const detectedAll = totalKilled + totalTimeout;
const undetectedAll = totalSurvived + totalNoCov;
const validAll = detectedAll + undetectedAll;
const overallScore = validAll > 0 ? Number(((detectedAll / validAll) * 100).toFixed(2)) : null;

checks.push({
  name: 'stryker-ran',
  ok: report !== null,
  evidence: report !== null
    ? `Stryker produced JSON report at ${reportPath} with ${Object.keys(report.files || {}).length} files mutated`
    : 'Stryker did not produce a JSON report — check .verify/mutation.log',
});
if (report === null) {
  failures.push({
    check: 'stryker-ran',
    message: 'Stryker produced no JSON report',
    detail: `See ${reportPath} — may indicate configuration failure`,
  });
}

checks.push({
  name: 'threshold-break',
  ok: exitCode === 0,
  evidence: exitCode === 0
    ? `Stryker exit=0 (mutation score ${overallScore ?? 'n/a'}% >= break threshold)`
    : `Stryker exit=${exitCode} — may indicate threshold break or runtime error (score ${overallScore ?? 'n/a'}%)`,
});
if (exitCode !== 0) {
  failures.push({
    check: 'threshold-break',
    message: `Stryker exited non-zero (${exitCode})`,
    detail: `Mutation score ${overallScore ?? 'n/a'}%. See .verify/mutation.log`,
  });
}

const artifact = {
  gate: 'mutation',
  ok: exitCode === 0 && report !== null,
  ran_at: ranAt,
  duration_ms: Number(durMs),
  mode: related ? 'sampled' : 'full',
  summary: {
    overall_score_pct: overallScore,
    killed: totalKilled,
    survived: totalSurvived,
    timeout: totalTimeout,
    no_coverage: totalNoCov,
    runtime_error: totalRuntime,
    ignored: totalIgnored,
    compile_error: totalCompileErr,
    pending: totalPending,
  },
  files: perFile,
  checks,
  failures,
};

fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.error(`[mutation] wrote ${artifactPath} (score=${overallScore ?? 'n/a'}%, files=${perFile.length})`);
NODE

exit "$STRYKER_EXIT"
