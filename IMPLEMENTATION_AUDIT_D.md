# IMPLEMENTATION AUDIT D (Hostile)

Date: 2026-04-29 (America/New_York)
Repo: `/home/jeremy/luna-hub-lite`

## Scope

Audited commits claimed for Change D:

- `97587af` — parity core extraction + witness scenario
- `cd73a3c` — SystemHealthCard parity drift/staleness
- `1b0ac05` — tests + HubHomePage test fix
- `e57397a` — systemd timer docs

## Precondition check

`/home/jeremy/luna-hub-lite/FINAL_PLAN.md` was requested but is not present in this checkout.

- `find .. -name 'FINAL_PLAN.md'` returned no matches.

## Executive verdict

- D1: **PASS with caveat**
- D2: **FAIL**
- D3: **FAIL**
- D4: **PASS**
- D5: **FAIL**
- D6: **FAIL (proof not reproducible)**
- D7: **MIXED (tests exist; command-environment mismatch)**
- D8: **INDETERMINATE (no direct forensic proof available)**

---

## D1. Parity export reads live Pi sqlite (not stub)

### Verdict

**PASS with caveat**

### Evidence

From `hardware/live-shelf/scripts/parity_export.py`:

- Real file path resolution:
  - `LIVE_SHELF_DB` env override ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:53))
  - default live path `/var/lib/live-shelf/live_shelf.db` ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:48))
- Actual sqlite file connection:
  - `sqlite3.connect(str(db_path))` ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:155))
- `pi_db_sha256` computed from selected file path at runtime:
  - `_sha256_file(db_path)` ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:172))

No in-memory sqlite is used by the runtime exporter path.

Caveat: code includes fallback `_FALLBACK_PI_DB = .../data/shelf.sqlite3` ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:49)). If that file exists and live path is absent, export can run against non-live data.

---

## D2. Witness scenario uses actual historical UUIDs

### Verdict

**FAIL**

### Evidence

1. Required witness file is absent in `97587af`:

- `git show 97587af:scripts/harness/witnesses/lot-id-bridge.json`
- Result: `fatal: path 'scripts/harness/witnesses/lot-id-bridge.json' does not exist in '97587af'`

2. Witness is embedded in code, with synthetic placeholder UUIDs:

- `PI_LOCAL_LOT_ID = "aaaaaaaa-1a7f-bc00-0000-000000000001"`
- `CLOUD_LOT_ID    = "bbbbbbbb-1a7f-bc00-0000-000000000002"`
- `PRODUCT_ID      = "cccccccc-1a7f-bc00-0000-000000000003"`
- Source: [scripts/harness/parity_assert.py](/home/jeremy/luna-hub-lite/scripts/harness/parity_assert.py:575)

3. Requested historical fixture check (`41a7fbc^` pre-fix) does not contain pinned UUID constants in first 100 lines:

- `git show 41a7fbc^:hardware/live-shelf/server/cloud/tests/test_weight_sync_poller.py | head -100`
- shows `str(uuid.uuid4())` in fixture helpers, not exact literals.

4. Side-by-side UUID comparison

| Source                                                        | Pi lot UUID                            | Cloud lot UUID                         | Product UUID                           |
| ------------------------------------------------------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- |
| Witness scenario (`parity_assert.py`)                         | `aaaaaaaa-1a7f-bc00-0000-000000000001` | `bbbbbbbb-1a7f-bc00-0000-000000000002` | `cccccccc-1a7f-bc00-0000-000000000003` |
| `41a7fbc^` pre-fix fixture (`head -100`)                      | `str(uuid.uuid4())`                    | not pinned in that slice               | `str(uuid.uuid4())`                    |
| `41a7fbc` regression constants (documented prod-shape values) | `8923f32f-37f6-400b-ae07-e5fc25faee55` | `afc2ab94-e63d-4404-9f3c-39b4c6e347ae` | generated via `_seed_product()`        |

5. Scenario behavior mismatch vs requirement

- Scenario seeds **different** Pi/cloud lot IDs (`PI_LOCAL_LOT_ID != CLOUD_LOT_ID`) and runs `diff_pair` parity logic.
- It does **not** execute `weight_sync_poller` nor assert emitted wrong UUID behavior.

---

## D3. Hub UI card reads real Storage (not hardcoded)

### Verdict

**FAIL** (path mismatch), with two sub-checks passing

### Evidence

- Uses real Supabase storage client:
  - `.from('parity-reports').download(...)` ([apps/web/src/components/hub/SystemHealthCard.tsx](/home/jeremy/luna-hub-lite/apps/web/src/components/hub/SystemHealthCard.tsx:22))
- No "0 drift" hardcoded fallback:
  - On download error, returns `null` and card renders nothing ([apps/web/src/components/hub/SystemHealthCard.tsx](/home/jeremy/luna-hub-lite/apps/web/src/components/hub/SystemHealthCard.tsx:24)).
- Staleness check is real and uses `report.generated_at`:
  - `Date.now() - new Date(report.generated_at).getTime() > STALE_MS` ([apps/web/src/components/hub/SystemHealthCard.tsx](/home/jeremy/luna-hub-lite/apps/web/src/components/hub/SystemHealthCard.tsx:41)).

Critical defect:

- Exporter writes object at `/storage/v1/object/parity-reports/{user_id}/latest.json` ([hardware/live-shelf/scripts/parity_export.py](/home/jeremy/luna-hub-lite/hardware/live-shelf/scripts/parity_export.py:128)).
- Card downloads `parity-reports/${user.id}/latest.json` **inside bucket `parity-reports`** ([apps/web/src/components/hub/SystemHealthCard.tsx](/home/jeremy/luna-hub-lite/apps/web/src/components/hub/SystemHealthCard.tsx:23)).
- With Supabase bucket API, this likely double-prefixes the object key and misses the exporter output path.

---

## D4. NO cryptographic provenance

### Verdict

**PASS**

### Evidence

Search across audited commit diffs for `ed25519|signature|verify_signature|signing_key|public_key|private_key|provenance` found only a comment string:

- `No ed25519 signing -- ...`
- No signing/verification primitives were added.

---

## D5. Witness scenario actually runs in verify:full

### Verdict

**FAIL**

### Evidence

1. `verify:full` wiring in [scripts/verify/run.sh](/home/jeremy/luna-hub-lite/scripts/verify/run.sh:49) calls only `run_parity_assert`, which runs:

- `python3 scripts/harness/parity_assert.py self-test --quiet` ([scripts/verify/run.sh](/home/jeremy/luna-hub-lite/scripts/verify/run.sh:144))
- No `witness/lot-id-bridge` invocation in `verify:full`.

2. Requested manual command behavior:

- Ran: `python3 scripts/harness/parity_assert.py --scenario witness/lot-id-bridge`
- Result: `error: unrecognized arguments: --scenario`
- Exit code: `2`

3. Positional scenario run (supported syntax) does detect deltas:

- Ran: `python3 scripts/harness/parity_assert.py witness/lot-id-bridge --quiet`
- Exit code: `1`

Net: gate wiring required by brief is absent.

---

## D6. Negative-twin proof

### Verdict

**FAIL (claim not reproducible)**

### Evidence

1. Commit `97587af` message includes a `NEGATIVE-TWIN-PROOF` block.

2. Reproduction test (runtime mutation equivalent to reverting named line)

- Baseline: `witness/lot-id-bridge` => `deltas_total=2`, `stock_lots=2`, exit `1`.
- Mutated: removed `FieldPair("current_weight_g", "qty_containers", coerce="g_to_ctn")` from `TABLE_PAIRS[stock_lots]` at runtime, reran scenario.
- Mutated result: still `deltas_total=2`, `stock_lots=2`, exit `1`.

Observed output summary:

- `baseline_exit_code=1`
- `mutated_exit_code=1`

So the stated “test fails post-revert” behavior did not occur.

---

## D7. Tests exist and pass

### Verdict

**MIXED**

### Evidence

1. SystemHealthCard vitest

- Command: `cd apps/web && npx vitest run src/__tests__/unit/hub/SystemHealthCard.test.tsx`
- Result: `1` file passed, `9` tests passed, `0` failed.

2. parity_export pytest

- Prompt command: `cd hardware/live-shelf && python -m pytest scripts/tests/test_parity_export.py -xvs`
- Result: failed (`python: command not found`, exit `127`).
- Equivalent raw interpreter fallback: `python3 -m pytest ...`
- Result: failed (`No module named pytest`, exit `1`).
- Equivalent project env command: `cd hardware/live-shelf && .venv/bin/pytest scripts/tests/test_parity_export.py -xvs`
- Result: `7` passed, `0` failed.

---

## D8. `--no-verify` usage

### Verdict

**INDETERMINATE**

### Evidence

- No `Verify-skipped` footer in any of the 4 commit messages.
- No `no-verify` text in those commit messages.
- Local reflog entries for these SHAs show normal `commit:` actions.

Limitation: Git commit objects do not record whether `--no-verify` was used. Absence of text markers is not proof of non-usage.

---

## Confidence

**High** on D2, D3, D5, D6 outcomes (direct code/command evidence).

**Medium** on D1 due policy interpretation (live-path intent present, fallback path exists).

**Low-to-medium** on D8 because Git forensics cannot conclusively prove/disprove `--no-verify` without external hook logs.
