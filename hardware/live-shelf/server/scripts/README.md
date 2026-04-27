# Live Shelf Demo — Product Seed Pipeline (Bundle I)

Interactive scripts that drive the running Live Shelf server's intake HTTP
API to create the 6 demo products, attach 3 reference photos per product
(captured live from the camera), and open an initial on-shelf lot.

## What's in here

| Path                                | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `seed_product.py`                   | Seed one product from a profile JSON.                                     |
| `seed_all_demo.py`                  | Iterate all profiles in order with between-product prompts.               |
| `demo_seeds/<barcode>.json`         | Pre-built product profile (OFF data + best-guess fields).                 |
| `demo_seeds/off_raw/<barcode>.json` | Raw OpenFoodFacts v2 JSON cached at profile build time (reproducibility). |

## Demo products (6)

| Barcode        | Product                                                 | OFF status | Notes on guessed fields                                                                                                       |
| -------------- | ------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `021000616886` | Philadelphia Cream Cheese (single-serve cup, 31 g)      | found      | Brand renamed from "Kraft Heinz" to "Philadelphia" for display. Container normalized to `jar` (closest canonical enum value). |
| `022655306306` | Butterball Turkey Breakfast Sausage Patties (8 oz)      | found      | OFF provided net + serving weight. Container guessed as `tray`.                                                               |
| `031142523850` | BelGioioso Parmesan Wedge                               | found      | OFF reports `product_quantity=28 g`, but that's the serving — package is 5 oz (141.7 g). Override in profile.                 |
| `073410003435` | Arnold Country Style Sourdough Bread                    | found      | OFF omits package weight. Assumed 24 oz loaf (680 g).                                                                         |
| `078742062570` | Great Value Extra Sharp Cheddar Cheese                  | found      | OFF omits package weight. Assumed standard 8 oz block (226.8 g).                                                              |
| `078742363127` | Walmart (Great Value) Pulled Rotisserie Chicken (16 oz) | found      | OFF brand "Walmart" → display brand "Great Value". Container guessed as `tray`.                                               |

Anywhere a field is a guess, the profile records `_notes.*_source` =
`"guess:..."` and sets `_notes.confidence = "low"` or `"medium"`. Profiles
that need the most human review have `_notes.needs_manual_review: true`.

## Prerequisites

1.  The Pi is running the Live Shelf server (defaults to `http://192.168.0.181:8000`).
2.  The ESP8266 scale node is posting heartbeats so `/api/state` returns a
    fresh `last_scale_weight_g`.
3.  The USB camera is running and exposing the MJPEG feed (the scripts rely
    on the camera capture route succeeding).
4.  Your workstation has Python 3.10+ and `httpx` installed:
    ```bash
    python -m pip install httpx
    ```

## End-to-end run (happy path)

From anywhere (laptop, Pi, a CI runner — wherever is convenient):

```bash
cd hardware/live-shelf/server/scripts

# 1) Sanity-check which products will be seeded
python seed_all_demo.py --host http://192.168.0.181:8000 --list

# 2) Start seeding. You'll be prompted before each product and before each
#    of the 3 reference captures. Between products, the script pauses so
#    you can remove the previous item.
python seed_all_demo.py --host http://192.168.0.181:8000
```

The script walks each product through:

1.  `GET /api/state` — verifies the server is reachable and records the
    baseline weight.
2.  `POST /api/intake/lookup` — re-verifies OpenFoodFacts still resolves the
    barcode (skip with `--skip-lookup` if OFF is down).
3.  Prompt: _"Place <name> on the shelf. Press Enter when stable."_
4.  `GET /api/state` again — captures `gross_weight_g` from the live scale
    reading.
5.  Three `POST /api/intake/capture-ref` calls, 1s apart, each generating
    one reference image in `data/refs/<temp_id>/<index>.jpg`. The operator
    is prompted before each capture in case they want to nudge the angle.
6.  `POST /api/intake/save` — creates the product, reference-image rows, and
    the initial `lots` row with `status='on_shelf'`.

On success the script prints the new `product_id` and `lot_id`.

## One-off / single product

```bash
python seed_product.py demo_seeds/021000616886.json --host http://192.168.0.181:8000
```

## Flags

| Flag                 | Applies to         | Purpose                                                                                            |
| -------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `--host <url>`       | both               | Override server base URL (default `http://192.168.0.181:8000`).                                    |
| `--skip-lookup`      | both               | Skip the `/api/intake/lookup` sanity POST (OFF outage).                                            |
| `--timeout <sec>`    | both               | Per-request HTTP timeout (default 10s).                                                            |
| `--yes`              | both               | Auto-accept all "press Enter" prompts. **Dry-run only** — there will be no real item on the shelf. |
| `--only <bc,bc,...>` | `seed_all_demo.py` | Seed only the listed barcodes.                                                                     |
| `--list`             | `seed_all_demo.py` | Show what would be seeded and exit.                                                                |
| `--dir <path>`       | `seed_all_demo.py` | Override the `demo_seeds/` directory.                                                              |

## Error handling

Any non-2xx response from the intake API prints the status + response body
preview and exits non-zero — no partial writes are swallowed. A camera
failure shows up as an HTTP 503 on `capture-ref`; fix the camera, and
re-run the same profile (the script mints a new `temp_id` each run, so
reruns don't collide).

## When something goes wrong

- **`capture-ref` 503 / "camera unavailable"** — The Pi's camera daemon is
  not yielding frames. Check the MJPEG stream and the daemon logs.
- **`save` 400 / "gross_weight_g < net_weight_g"** — The scale reading is
  lower than the label net weight. Either the product isn't fully on the
  scale or the profile's `net_weight_g` guess is wrong. Bump it down in
  the profile or fix the placement.
- **`lookup` 400 / "barcode must be 6-14 digits"** — Only happens if a
  profile's `barcode` is malformed. Shouldn't happen for the 6 bundled
  profiles; check the JSON if you added a new one.

## Reproducibility

`demo_seeds/off_raw/<barcode>.json` contains the exact OpenFoodFacts v2
payload the profiles were built from. If OFF drifts or the profile needs
rebuilding, inspect the raw JSON rather than re-fetching from scratch.
