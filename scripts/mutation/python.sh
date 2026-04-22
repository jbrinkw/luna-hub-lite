#!/usr/bin/env bash
# scripts/mutation/python.sh — Python mutation-testing gate (mutmut).
#
# Usage:
#   bash scripts/mutation/python.sh
#       # full run against the contract surface declared in
#       # hardware/live-shelf/setup.cfg → [mutmut] paths_to_mutate.
#       # Slow — nightly scope.
#
#   bash scripts/mutation/python.sh --related <files...>
#       # sampled mode: mutate only the given Python file(s). Each file
#       # must live under hardware/live-shelf/server/. Paths may be
#       # absolute, repo-relative (hardware/live-shelf/server/...) or
#       # already relative to hardware/live-shelf (server/...). The
#       # script normalizes them to what mutmut wants.
#
#   bash scripts/mutation/python.sh --skip-on-missing-venv
#       # soft-skip (exit 0, artifact ok:true with skip marker) if the
#       # live-shelf venv is missing. Used by the TS+Python orchestrator
#       # so contributors who don't touch the Pi code aren't forced to
#       # install the Pi toolchain.
#
# Contract: VERIFY.md — "Gate: Mutation" (mutmut branch of the gate).
# Exit 0 on pass, non-zero on fail. Writes .verify/mutation-python.json.
#
# Thresholds (hardcoded below, mirror Stryker's stryker.conf.json):
#   break = 40   — below this, exit 1 and mark the gate failed.
#   high  = 60   — informational; reported in the artifact.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHELF_DIR="$REPO_ROOT/hardware/live-shelf"
VENV="$SHELF_DIR/.venv"
MUTMUT="$VENV/bin/mutmut"
SETUP_CFG="$SHELF_DIR/setup.cfg"

BREAK_THRESHOLD=40
HIGH_THRESHOLD=60

# ------------------------------------------------------------------
# Arg parsing
# ------------------------------------------------------------------
RELATED_FILES=()
RELATED_MODE=0
SKIP_ON_MISSING_VENV=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --related)
      RELATED_MODE=1
      shift
      while [[ $# -gt 0 && "${1:0:2}" != "--" ]]; do
        RELATED_FILES+=("$1")
        shift
      done
      ;;
    --skip-on-missing-venv)
      SKIP_ON_MISSING_VENV=1
      shift
      ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "[mutation/python] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$REPO_ROOT/.verify" "$REPO_ROOT/reports/mutation"
ARTIFACT="$REPO_ROOT/.verify/mutation-python.json"
LOG_FILE="$REPO_ROOT/.verify/mutation-python.log"

START_MS=$(date +%s%3N)
RAN_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# ------------------------------------------------------------------
# Preflight
# ------------------------------------------------------------------
write_skip_artifact() {
  local reason="$1"
  local end_ms
  end_ms=$(date +%s%3N)
  local dur=$((end_ms - START_MS))
  cat > "$ARTIFACT" <<JSON
{
  "gate": "mutation",
  "runtime": "python",
  "ok": true,
  "skipped": true,
  "skip_reason": "$reason",
  "ran_at": "$RAN_AT",
  "duration_ms": $dur,
  "mode": "$( [[ $RELATED_MODE -eq 1 ]] && echo sampled || echo full )",
  "summary": null,
  "files": [],
  "checks": [
    { "name": "preflight", "ok": true, "evidence": "$reason" }
  ],
  "failures": []
}
JSON
  echo "[mutation/python] SKIP: $reason" >&2
  exit 0
}

if [[ ! -x "$MUTMUT" ]]; then
  if [[ "$SKIP_ON_MISSING_VENV" -eq 1 ]]; then
    write_skip_artifact "mutmut binary not found at $MUTMUT (venv absent)"
  fi
  echo "[mutation/python] mutmut not installed. Expected at: $MUTMUT" >&2
  echo "[mutation/python] Create the Pi venv: python3 -m venv $VENV && $VENV/bin/pip install -r $SHELF_DIR/server/requirements.txt mutmut" >&2
  exit 2
fi

if [[ ! -f "$SETUP_CFG" ]]; then
  echo "[mutation/python] missing $SETUP_CFG (mutmut config)" >&2
  exit 2
fi

# ------------------------------------------------------------------
# --related → temporary override of paths_to_mutate.
# We back up setup.cfg, splice in the filtered list, run mutmut, and
# always restore the original on exit. This is cleaner than spawning
# a side-by-side config file because mutmut's loader is hardcoded to
# `setup.cfg` / `pyproject.toml` at CWD.
# ------------------------------------------------------------------
normalize_target() {
  # Emit a single mutmut-friendly path (server/...) or empty on reject.
  local in="$1"
  local abs
  if [[ "$in" = /* ]]; then
    abs="$in"
  else
    # Resolve relative to CWD of whoever invoked the script.
    abs="$(cd "$(pwd)" && readlink -f "$in" 2>/dev/null || echo "")"
  fi
  if [[ -z "$abs" ]]; then
    return 1
  fi
  case "$abs" in
    "$SHELF_DIR"/server/*.py|"$SHELF_DIR"/server/*/*.py|"$SHELF_DIR"/server/*/*/*.py)
      # Strip the shelf-dir prefix.
      echo "${abs#$SHELF_DIR/}"
      return 0
      ;;
  esac
  return 1
}

BACKUP_CFG=""
restore_cfg() {
  if [[ -n "$BACKUP_CFG" && -f "$BACKUP_CFG" ]]; then
    mv "$BACKUP_CFG" "$SETUP_CFG"
  fi
}
trap restore_cfg EXIT

if [[ "$RELATED_MODE" -eq 1 ]]; then
  if [[ "${#RELATED_FILES[@]}" -eq 0 ]]; then
    echo "[mutation/python] --related requires at least one file" >&2
    exit 2
  fi
  NORMALIZED=()
  for f in "${RELATED_FILES[@]}"; do
    n="$(normalize_target "$f")" || {
      echo "[mutation/python] skipping (not under hardware/live-shelf/server/): $f" >&2
      continue
    }
    NORMALIZED+=("$n")
  done
  if [[ "${#NORMALIZED[@]}" -eq 0 ]]; then
    echo "[mutation/python] --related produced no targets under server/. Nothing to mutate." >&2
    write_skip_artifact "no --related files matched hardware/live-shelf/server/"
  fi
  echo "[mutation/python] sampled mode: mutating ${NORMALIZED[*]}" >&2

  BACKUP_CFG="$SETUP_CFG.bak.$$"
  cp "$SETUP_CFG" "$BACKUP_CFG"

  python3 - "$SETUP_CFG" "${NORMALIZED[@]}" <<'PY'
import configparser, sys
cfg_path = sys.argv[1]
targets = sys.argv[2:]
cp = configparser.ConfigParser()
cp.read(cfg_path)
if not cp.has_section('mutmut'):
    cp.add_section('mutmut')
cp.set('mutmut', 'paths_to_mutate', '\n' + '\n'.join(targets))
with open(cfg_path, 'w') as f:
    cp.write(f)
PY
else
  echo "[mutation/python] full mode: using paths_to_mutate from $SETUP_CFG" >&2
fi

# ------------------------------------------------------------------
# Run mutmut. We always let it complete so per-file meta files are
# written; then we derive the score ourselves and decide pass/fail
# against the break threshold. (mutmut 3.x itself doesn't enforce a
# mutation-score floor — it just runs and exports stats.)
# ------------------------------------------------------------------
cd "$SHELF_DIR"

# Fresh mutant state each run — per-file meta gets stale quickly when
# source code changes between invocations, and sampled mode must not
# see survivors from a previous full run bleed into the artifact.
rm -rf "$SHELF_DIR/mutants" "$SHELF_DIR/.mutmut-cache"

set +e
"$MUTMUT" run 2>&1 | tee "$LOG_FILE"
MUTMUT_EXIT=${PIPESTATUS[0]}

# Export the per-run cicd stats even if mutmut returned non-zero — we
# still want the artifact to describe what we saw.
"$MUTMUT" export-cicd-stats >> "$LOG_FILE" 2>&1
set -e 2>/dev/null || true

END_MS=$(date +%s%3N)
DURATION_MS=$((END_MS - START_MS))

# ------------------------------------------------------------------
# Parse per-file meta files + the summary JSON, write the artifact.
# ------------------------------------------------------------------
CICD_STATS="$SHELF_DIR/mutants/mutmut-cicd-stats.json"
RAW_REPORT="$REPO_ROOT/reports/mutation/mutation-python.json"

python3 - <<PY "$SHELF_DIR" "$CICD_STATS" "$ARTIFACT" "$RAW_REPORT" "$MUTMUT_EXIT" "$RAN_AT" "$DURATION_MS" "$RELATED_MODE" "$BREAK_THRESHOLD" "$HIGH_THRESHOLD"
import json, os, sys
from pathlib import Path

(shelf_dir, cicd_path, artifact_path, raw_report_path,
 mutmut_exit, ran_at, dur_ms, related_raw,
 break_thr, high_thr) = sys.argv[1:]

shelf_dir = Path(shelf_dir)
mutmut_exit = int(mutmut_exit)
dur_ms = int(dur_ms)
related = related_raw == '1'
break_thr = int(break_thr)
high_thr = int(high_thr)

# mutmut's exit-code -> human status map, copied from mutmut.__main__
STATUS_BY_EXIT = {
    1: 'killed', 3: 'killed', -24: 'timeout', 24: 'timeout', 152: 'timeout',
    255: 'timeout', 0: 'survived', 5: 'no_tests', 33: 'no_tests',
    34: 'skipped', 35: 'suspicious', 36: 'timeout', 37: 'caught_by_typecheck',
    -11: 'segfault', -9: 'segfault', 2: 'interrupted',
}

summary = None
try:
    with open(cicd_path) as f:
        summary = json.load(f)
except FileNotFoundError:
    pass
except json.JSONDecodeError:
    pass

per_file = []
mutants_root = shelf_dir / 'mutants'
if mutants_root.exists():
    for meta in sorted(mutants_root.rglob('*.py.meta')):
        rel = meta.relative_to(mutants_root)
        # rel is e.g. 'server/shelves.py.meta' -> source path 'server/shelves.py'
        src = str(rel)[:-len('.meta')]
        try:
            data = json.loads(meta.read_text())
        except json.JSONDecodeError:
            continue
        counts = {k: 0 for k in (
            'killed', 'survived', 'timeout', 'no_tests',
            'skipped', 'suspicious', 'caught_by_typecheck',
            'segfault', 'interrupted', 'not_checked'
        )}
        exit_map = data.get('exit_code_by_key', {})
        for _, ec in exit_map.items():
            status = STATUS_BY_EXIT.get(ec, 'suspicious') if ec is not None else 'not_checked'
            counts[status] = counts.get(status, 0) + 1
        killed = counts['killed'] + counts['timeout']
        undetected = counts['survived'] + counts['no_tests']
        valid = killed + undetected
        score = round((killed / valid) * 100, 2) if valid > 0 else None
        per_file.append({
            'file': f"hardware/live-shelf/{src}",
            'score_pct': score,
            'killed': counts['killed'],
            'survived': counts['survived'],
            'timeout': counts['timeout'],
            'no_tests': counts['no_tests'],
            'skipped': counts['skipped'],
            'suspicious': counts['suspicious'],
            'caught_by_typecheck': counts['caught_by_typecheck'],
            'segfault': counts['segfault'],
            'not_checked': counts['not_checked'],
        })

# Overall score: prefer the cicd summary (it matches mutmut's own counts);
# fall back to the per-file aggregate if the summary is missing.
if summary:
    killed = summary.get('killed', 0) + summary.get('timeout', 0)
    survived = summary.get('survived', 0)
    no_tests = summary.get('no_tests', 0)
    undetected = survived + no_tests
    valid = killed + undetected
    overall = round((killed / valid) * 100, 2) if valid > 0 else None
    overall_summary = {
        'overall_score_pct': overall,
        'killed': summary.get('killed', 0),
        'survived': survived,
        'timeout': summary.get('timeout', 0),
        'no_tests': no_tests,
        'skipped': summary.get('skipped', 0),
        'suspicious': summary.get('suspicious', 0),
        'segfault': summary.get('segfault', 0),
        'total': summary.get('total', 0),
    }
else:
    k = sum(f['killed'] for f in per_file)
    t = sum(f['timeout'] for f in per_file)
    s = sum(f['survived'] for f in per_file)
    n = sum(f['no_tests'] for f in per_file)
    killed = k + t
    valid = killed + s + n
    overall = round((killed / valid) * 100, 2) if valid > 0 else None
    overall_summary = {
        'overall_score_pct': overall,
        'killed': k, 'survived': s, 'timeout': t, 'no_tests': n,
        'skipped': 0, 'suspicious': 0, 'segfault': 0,
        'total': sum(f['killed'] + f['survived'] + f['timeout'] + f['no_tests'] for f in per_file),
    }
    overall = overall_summary['overall_score_pct']

# Raw report: the mutmut-cicd-stats plus per-file breakdown.
Path(raw_report_path).parent.mkdir(parents=True, exist_ok=True)
with open(raw_report_path, 'w') as f:
    json.dump({'cicd_summary': summary, 'per_file': per_file}, f, indent=2)

checks = []
failures = []

mutmut_ran = summary is not None or per_file
checks.append({
    'name': 'mutmut-ran',
    'ok': bool(mutmut_ran),
    'evidence': (
        f"mutmut produced {len(per_file)} per-file meta records; summary={summary is not None}"
        if mutmut_ran
        else f"mutmut produced no artifacts — see {os.path.basename(sys.argv[1])}/mutants/"
    ),
})
if not mutmut_ran:
    failures.append({
        'check': 'mutmut-ran',
        'message': 'mutmut produced no per-file meta files or cicd stats',
        'detail': 'See .verify/mutation-python.log',
    })

score_for_gate = overall_summary['overall_score_pct']
below_break = (score_for_gate is not None) and (score_for_gate < break_thr)

checks.append({
    'name': 'score-threshold',
    'ok': not below_break,
    'evidence': (
        f"overall score {score_for_gate}% vs break threshold {break_thr}%"
        if score_for_gate is not None
        else "no valid mutants produced (score=null)"
    ),
})
if below_break:
    failures.append({
        'check': 'score-threshold',
        'message': f'mutation score {score_for_gate}% below break threshold {break_thr}%',
        'detail': 'Tests are not killing enough mutants — look for tautological or coverage-only tests.',
    })

checks.append({
    'name': 'high-watermark',
    'ok': score_for_gate is None or score_for_gate >= high_thr,
    'evidence': (
        f"overall score {score_for_gate}% vs high threshold {high_thr}% (informational)"
        if score_for_gate is not None
        else 'n/a — no valid mutants'
    ),
})

artifact = {
    'gate': 'mutation',
    'runtime': 'python',
    'ok': (not below_break) and bool(mutmut_ran),
    'skipped': False,
    'ran_at': ran_at,
    'duration_ms': dur_ms,
    'mode': 'sampled' if related else 'full',
    'thresholds': {'break': break_thr, 'high': high_thr},
    'summary': overall_summary,
    'files': per_file,
    'checks': checks,
    'failures': failures,
}
with open(artifact_path, 'w') as f:
    json.dump(artifact, f, indent=2)

print(f"[mutation/python] wrote {artifact_path} (score={overall_summary['overall_score_pct']}%, files={len(per_file)})", file=sys.stderr)
# Exit this helper with an indicator code the outer shell uses to
# decide its own exit, keeping the artifact as source of truth.
sys.exit(0 if (not below_break) and mutmut_ran else 1)
PY
PARSE_EXIT=$?

# ------------------------------------------------------------------
# Exit logic:
#   - parser returned 1 → gate failed (threshold break or missing data)
#   - mutmut returned non-zero but parser returned 0 → still-failed
#     mutmut probably hit a runtime error even though some data landed.
#     Propagate mutmut's exit.
# ------------------------------------------------------------------
if [[ "$PARSE_EXIT" -ne 0 ]]; then
  exit 1
fi
if [[ "$MUTMUT_EXIT" -ne 0 ]]; then
  echo "[mutation/python] mutmut exit=$MUTMUT_EXIT but score passed — treating as failure (likely runtime error)" >&2
  exit "$MUTMUT_EXIT"
fi
exit 0
