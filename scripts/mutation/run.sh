#!/usr/bin/env bash
# scripts/mutation/run.sh — Mutation-testing gate (Stryker TS + mutmut Python).
#
# Usage:
#   bash scripts/mutation/run.sh                 # full run across all TS configs AND the Python gate
#   bash scripts/mutation/run.sh --related <files...>
#       # Sampled: auto-route TS files to the matching Stryker config AND
#       # any hardware/live-shelf/server/*.py files to the Python gate.
#   bash scripts/mutation/run.sh --config <path> # run a single custom TS config (skips Python)
#   bash scripts/mutation/run.sh --skip-python   # TS only — useful when the Pi venv isn't installed
#
# Contract: VERIFY.md — "Gate: Mutation".
#   Exit 0 on pass, non-zero on fail. Writes .verify/mutation.json.
#   The Python sub-gate additionally writes .verify/mutation-python.json;
#   this aggregator merges its summary into the top-level artifact.
#
# Per-workspace TS configs (auto-detected in full mode and for --related):
#   stryker.conf.json              → extensions/**/*.ts  (root)
#   stryker.mcp-worker.conf.json   → apps/mcp-worker/src/*.ts
#   stryker.web-shared.conf.json   → apps/web/src/shared/*.ts
#
# Python targets hardware/live-shelf/server/*.py via mutmut. See
# scripts/mutation/python.sh + scripts/mutation/README.md ("Python gate").
#
# Files are routed to configs by path prefix. Add a new config =
# register it in the CONFIGS array + PREFIX_* mappings below.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# -----------------------------------------------------------------------------
# Config registry — add new configs here. Order matters only for full-mode
# output; prefix matching is exact-on-directory.
# -----------------------------------------------------------------------------
ALL_CONFIGS=(
  "stryker.conf.json"
  "stryker.mcp-worker.conf.json"
  "stryker.web-shared.conf.json"
)

# Path prefix → config. The first matching prefix wins. Keep in sync with the
# `mutate[]` blocks in each stryker config.
config_for_file() {
  local f="$1"
  case "$f" in
    extensions/*) echo "stryker.conf.json" ;;
    apps/mcp-worker/src/*) echo "stryker.mcp-worker.conf.json" ;;
    apps/web/src/shared/*) echo "stryker.web-shared.conf.json" ;;
    *) echo "" ;;  # unroutable — caller handles
  esac
}

# -----------------------------------------------------------------------------
# Arg parsing
# -----------------------------------------------------------------------------
RELATED_FILES=()
RELATED_MODE=0
EXPLICIT_CONFIG=""
SKIP_PYTHON=0

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
      EXPLICIT_CONFIG="$2"
      shift 2
      ;;
    --skip-python)
      SKIP_PYTHON=1
      shift
      ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# --config forces a single-TS-config run; Python gate is out of scope there.
if [[ -n "$EXPLICIT_CONFIG" ]]; then
  SKIP_PYTHON=1
fi

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
: > "$LOG_FILE"  # truncate

# -----------------------------------------------------------------------------
# Build the (config → files-to-mutate) plan
# -----------------------------------------------------------------------------
# Each element: "<config-path>|<comma-separated files or empty for full>"
PLAN=()
SKIPPED_FILES=()
PYTHON_FILES=()

# Separate Python files (routed to python.sh) from TS files (routed to Stryker).
# A file under hardware/live-shelf/server/ is Python; everything else tries the
# TS config registry and is marked skipped if unroutable.
is_python_target() {
  case "$1" in
    hardware/live-shelf/server/*.py) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ -n "$EXPLICIT_CONFIG" ]]; then
  # --config override: single config, apply --related files as-is if provided.
  if [[ "$RELATED_MODE" -eq 1 ]]; then
    if [[ "${#RELATED_FILES[@]}" -eq 0 ]]; then
      echo "--related requires at least one file argument" >&2
      exit 2
    fi
    PLAN+=("$EXPLICIT_CONFIG|$(IFS=,; echo "${RELATED_FILES[*]}")")
  else
    PLAN+=("$EXPLICIT_CONFIG|")
  fi
elif [[ "$RELATED_MODE" -eq 1 ]]; then
  if [[ "${#RELATED_FILES[@]}" -eq 0 ]]; then
    echo "--related requires at least one file argument" >&2
    exit 2
  fi
  # Bucket each file by matching config
  declare -A BUCKET=()
  for f in "${RELATED_FILES[@]}"; do
    if is_python_target "$f"; then
      PYTHON_FILES+=("$f")
      continue
    fi
    cfg=$(config_for_file "$f")
    if [[ -z "$cfg" ]]; then
      SKIPPED_FILES+=("$f")
      continue
    fi
    if [[ -n "${BUCKET[$cfg]:-}" ]]; then
      BUCKET[$cfg]="${BUCKET[$cfg]},$f"
    else
      BUCKET[$cfg]="$f"
    fi
  done
  # Preserve the canonical config order
  for cfg in "${ALL_CONFIGS[@]}"; do
    if [[ -n "${BUCKET[$cfg]:-}" ]]; then
      PLAN+=("$cfg|${BUCKET[$cfg]}")
    fi
  done
else
  # Full mode: iterate every registered config using its own mutate[].
  for cfg in "${ALL_CONFIGS[@]}"; do
    PLAN+=("$cfg|")
  done
fi

if [[ "${#SKIPPED_FILES[@]}" -gt 0 ]]; then
  echo "[mutation] skipping files not in any known workspace scope:" >&2
  for f in "${SKIPPED_FILES[@]}"; do echo "  - $f" >&2; done
fi

# Only short-circuit if BOTH the TS plan and the Python plan are empty.
# Python-only runs (all --related files are Py) still need to invoke the
# Python gate below.
if [[ "${#PLAN[@]}" -eq 0 && "${#PYTHON_FILES[@]}" -eq 0 ]]; then
  echo "[mutation] nothing to run (all related files outside known scopes)" >&2
  # Still emit an artifact so downstream tooling sees a valid no-op.
  ARTIFACT="$REPO_ROOT/.verify/mutation.json"
  END_MS=$(date +%s%3N)
  DURATION_MS=$((END_MS - START_MS))
  node --input-type=module - <<NODE "$ARTIFACT" "$RAN_AT" "$DURATION_MS" "${SKIPPED_FILES[*]}"
import fs from 'node:fs';
const [artifactPath, ranAt, durMs, skippedRaw] = process.argv.slice(2);
const skipped = (skippedRaw || '').split(' ').filter(Boolean);
const artifact = {
  gate: 'mutation',
  ok: true,
  ran_at: ranAt,
  duration_ms: Number(durMs),
  mode: 'sampled',
  summary: {
    overall_score_pct: null,
    killed: 0, survived: 0, timeout: 0, no_coverage: 0,
    runtime_error: 0, ignored: 0, compile_error: 0, pending: 0,
  },
  files: [],
  checks: [{
    name: 'no-op',
    ok: true,
    evidence: \`No provided files matched any configured scope. Skipped: \${skipped.join(', ') || '(none)'}\`,
  }],
  failures: [],
};
fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.error(\`[mutation] wrote \${artifactPath} (no-op)\`);
NODE
  exit 0
fi

# -----------------------------------------------------------------------------
# Execute plan — one Stryker invocation per config, tee output to mutation.log
# -----------------------------------------------------------------------------
OVERALL_EXIT=0
REPORT_PATHS=()

for entry in "${PLAN[@]}"; do
  CONFIG_FILE="${entry%%|*}"
  FILES="${entry#*|}"

  STRYKER_ARGS=(run "$CONFIG_FILE")
  if [[ -n "$FILES" ]]; then
    STRYKER_ARGS+=(--mutate "$FILES")
    echo "[mutation] $CONFIG_FILE — sampled: mutating $FILES" >&2 | tee -a "$LOG_FILE" >/dev/null
    echo "[mutation] $CONFIG_FILE — sampled: mutating $FILES" >> "$LOG_FILE"
  else
    echo "[mutation] $CONFIG_FILE — full mode (config mutate[])" >&2
    echo "[mutation] $CONFIG_FILE — full mode (config mutate[])" >> "$LOG_FILE"
  fi

  set +e
  "$STRYKER_BIN" "${STRYKER_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"
  EXIT=${PIPESTATUS[0]}
  set -e 2>/dev/null || true

  if [[ "$EXIT" -ne 0 ]]; then
    OVERALL_EXIT="$EXIT"
  fi

  # Each config declares its own jsonReporter path; dig it out so we can merge.
  REPORT_JSON=$(node --input-type=module - "$CONFIG_FILE" <<'NODE'
import fs from 'node:fs';
const p = process.argv[2];
try {
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  process.stdout.write(cfg.jsonReporter?.fileName || '');
} catch {
  process.stdout.write('');
}
NODE
  )
  if [[ -n "$REPORT_JSON" ]]; then
    REPORT_PATHS+=("$CONFIG_FILE=$REPORT_JSON")
  fi
done

# -----------------------------------------------------------------------------
# Python sub-gate (mutmut). Invoked unless --skip-python or --config was
# supplied. In --related mode we forward only the Python files we bucketed
# above; in full mode we let python.sh use its setup.cfg defaults.
# Artifact: .verify/mutation-python.json (schema mirrors mutation.json).
# -----------------------------------------------------------------------------
PYTHON_RAN=0
PYTHON_EXIT=0
PYTHON_ARTIFACT="$REPO_ROOT/.verify/mutation-python.json"

if [[ "$SKIP_PYTHON" -ne 1 ]]; then
  PY_SCRIPT="$REPO_ROOT/scripts/mutation/python.sh"
  if [[ ! -x "$PY_SCRIPT" ]]; then
    echo "[mutation] python.sh missing or not executable — skipping Python gate" >&2
  elif [[ "$RELATED_MODE" -eq 1 && "${#PYTHON_FILES[@]}" -eq 0 ]]; then
    echo "[mutation] no Python files in --related set — skipping Python gate" >&2
  else
    PY_ARGS=("--skip-on-missing-venv")
    if [[ "$RELATED_MODE" -eq 1 && "${#PYTHON_FILES[@]}" -gt 0 ]]; then
      PY_ARGS+=(--related "${PYTHON_FILES[@]}")
    fi
    echo "[mutation] invoking Python gate: bash $PY_SCRIPT ${PY_ARGS[*]}" >&2
    set +e
    bash "$PY_SCRIPT" "${PY_ARGS[@]}" 2>&1 | tee -a "$LOG_FILE"
    PYTHON_EXIT=${PIPESTATUS[0]}
    set -e 2>/dev/null || true
    PYTHON_RAN=1
    if [[ "$PYTHON_EXIT" -ne 0 ]]; then
      OVERALL_EXIT="$PYTHON_EXIT"
    fi
  fi
fi

END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

# -----------------------------------------------------------------------------
# Aggregate Stryker JSON reports into a single .verify/mutation.json artifact
# -----------------------------------------------------------------------------
ARTIFACT="$REPO_ROOT/.verify/mutation.json"
MODE="full"
if [[ "$RELATED_MODE" -eq 1 ]]; then MODE="sampled"; fi
if [[ -n "$EXPLICIT_CONFIG" ]]; then MODE="custom"; fi

node --input-type=module - <<'NODE' "$ARTIFACT" "$OVERALL_EXIT" "$RAN_AT" "$DURATION_MS" "$MODE" "$PYTHON_RAN" "$PYTHON_ARTIFACT" "${REPORT_PATHS[@]}"
import fs from 'node:fs';
const [artifactPath, exitRaw, ranAt, durMs, mode, pythonRanRaw, pythonArtifactPath, ...reportEntries] = process.argv.slice(2);
const exitCode = Number(exitRaw);
const pythonRan = pythonRanRaw === '1';

const checks = [];
const failures = [];
const perFile = [];

let totals = {
  killed: 0, survived: 0, timeout: 0, noCov: 0,
  runtime: 0, ignored: 0, compileErr: 0, pending: 0,
};

for (const entry of reportEntries) {
  const [cfg, reportPath] = entry.split('=');
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  } catch {
    checks.push({
      name: `stryker-ran:${cfg}`,
      ok: false,
      evidence: `Missing Stryker report at ${reportPath}`,
    });
    failures.push({
      check: `stryker-ran:${cfg}`,
      message: `Stryker produced no JSON report for ${cfg}`,
      detail: `Expected at ${reportPath}. See .verify/mutation.log`,
    });
    continue;
  }

  let configKilled = 0, configSurvived = 0, configTimeout = 0, configNoCov = 0,
      configRuntime = 0, configIgnored = 0, configCompileErr = 0, configPending = 0;

  for (const [fname, fdata] of Object.entries(report.files ?? {})) {
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
    configKilled += killed; configSurvived += survived; configTimeout += timeout;
    configNoCov += noCov; configRuntime += runtime; configIgnored += ignored;
    configCompileErr += compileErr; configPending += pending;

    const detected = killed + timeout;
    const undetected = survived + noCov;
    const valid = detected + undetected;
    const score = valid > 0 ? Number(((detected / valid) * 100).toFixed(2)) : null;
    perFile.push({
      config: cfg,
      file: fname,
      score_pct: score,
      killed, survived, timeout, noCovered: noCov,
      runtimeError: runtime, ignored, compileError: compileErr, pending,
    });
  }

  const detected = configKilled + configTimeout;
  const undetected = configSurvived + configNoCov;
  const valid = detected + undetected;
  const configScore = valid > 0 ? Number(((detected / valid) * 100).toFixed(2)) : null;

  checks.push({
    name: `stryker-ran:${cfg}`,
    ok: true,
    evidence: `${cfg} → ${Object.keys(report.files || {}).length} file(s), score ${configScore ?? 'n/a'}% (killed=${configKilled} survived=${configSurvived})`,
  });

  totals.killed += configKilled;
  totals.survived += configSurvived;
  totals.timeout += configTimeout;
  totals.noCov += configNoCov;
  totals.runtime += configRuntime;
  totals.ignored += configIgnored;
  totals.compileErr += configCompileErr;
  totals.pending += configPending;
}

// ---- Python sub-gate merge --------------------------------------------
// Load .verify/mutation-python.json (written by python.sh) and fold its
// per-file scores + summary into the aggregate artifact so a single
// reviewer read covers both runtimes.
let pythonArtifact = null;
if (pythonRan) {
  try {
    pythonArtifact = JSON.parse(fs.readFileSync(pythonArtifactPath, 'utf8'));
  } catch (e) {
    checks.push({
      name: 'python-gate-ran',
      ok: false,
      evidence: `Python gate ran but ${pythonArtifactPath} is unreadable: ${e.message}`,
    });
    failures.push({
      check: 'python-gate-ran',
      message: 'Python mutation artifact missing or invalid',
      detail: `Expected at ${pythonArtifactPath}. See .verify/mutation-python.log`,
    });
  }
}

if (pythonArtifact) {
  checks.push({
    name: 'python-gate-ran',
    ok: pythonArtifact.ok === true,
    evidence: pythonArtifact.skipped
      ? `Python gate skipped: ${pythonArtifact.skip_reason || 'no reason provided'}`
      : `Python gate ran: score ${pythonArtifact.summary?.overall_score_pct ?? 'n/a'}% across ${pythonArtifact.files?.length ?? 0} file(s)`,
  });
  if (pythonArtifact.failures && pythonArtifact.failures.length) {
    for (const f of pythonArtifact.failures) {
      failures.push({
        check: `python:${f.check}`,
        message: f.message,
        detail: f.detail,
      });
    }
  }
  if (!pythonArtifact.skipped) {
    for (const f of pythonArtifact.files || []) {
      perFile.push({
        runtime: 'python',
        config: 'hardware/live-shelf/setup.cfg',
        file: f.file,
        score_pct: f.score_pct,
        killed: f.killed,
        survived: f.survived,
        timeout: f.timeout,
        noCovered: f.no_tests,
        runtimeError: 0,
        ignored: f.skipped ?? 0,
        compileError: 0,
        pending: 0,
      });
    }
    const ps = pythonArtifact.summary || {};
    totals.killed += (ps.killed || 0);
    totals.survived += (ps.survived || 0);
    totals.timeout += (ps.timeout || 0);
    totals.noCov += (ps.no_tests || 0);
    totals.ignored += (ps.skipped || 0);
  }
}

const detectedAll = totals.killed + totals.timeout;
const undetectedAll = totals.survived + totals.noCov;
const validAll = detectedAll + undetectedAll;
const overallScore = validAll > 0 ? Number(((detectedAll / validAll) * 100).toFixed(2)) : null;

checks.push({
  name: 'threshold-break',
  ok: exitCode === 0,
  evidence: exitCode === 0
    ? `All configs passed their break threshold (overall ${overallScore ?? 'n/a'}%)`
    : `At least one config exited non-zero (${exitCode}). Overall score ${overallScore ?? 'n/a'}%`,
});
if (exitCode !== 0) {
  failures.push({
    check: 'threshold-break',
    message: `Stryker or mutmut exited non-zero (${exitCode})`,
    detail: `Overall score ${overallScore ?? 'n/a'}%. See .verify/mutation.log`,
  });
}

const artifact = {
  gate: 'mutation',
  ok: exitCode === 0 && failures.length === 0,
  ran_at: ranAt,
  duration_ms: Number(durMs),
  mode,
  runtimes: {
    typescript: { configs: reportEntries.length },
    python: pythonRan
      ? {
          ran: true,
          skipped: pythonArtifact?.skipped === true,
          artifact: pythonArtifactPath,
          score_pct: pythonArtifact?.summary?.overall_score_pct ?? null,
          files: pythonArtifact?.files?.length ?? 0,
        }
      : { ran: false },
  },
  summary: {
    overall_score_pct: overallScore,
    killed: totals.killed,
    survived: totals.survived,
    timeout: totals.timeout,
    no_coverage: totals.noCov,
    runtime_error: totals.runtime,
    ignored: totals.ignored,
    compile_error: totals.compileErr,
    pending: totals.pending,
  },
  files: perFile,
  checks,
  failures,
};

fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.error(`[mutation] wrote ${artifactPath} (score=${overallScore ?? 'n/a'}%, files=${perFile.length}, configs=${reportEntries.length})`);
NODE

exit "$OVERALL_EXIT"
