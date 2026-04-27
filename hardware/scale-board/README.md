# Wemos D1 Mini + 4× HX711 Carrier Board

A custom 2-layer PCB that hosts a Wemos D1 Mini (ESP8266) on female pin
sockets and breaks out four independent HX711 24-bit ADC channels to four
4-pin load cell connectors. Perfect for a 4-cell smart scale, kitchen
scale, occupancy mat, or any project that needs four parallel strain-gauge
inputs streamed over WiFi.

```
                       +-----------------+
                       |  Wemos D1 Mini  |   <- removable, in 2x1x8 sockets
                       |  (ESP8266)      |
                       +-----------------+
                            | 3V3 GND
            +---------------+----+---+----+----------------+
            |               |    |   |    |                |
        [HX711 #0]      [HX711 #1]  [HX711 #2]         [HX711 #3]
        D6 DOUT          D1 DOUT     D2 DOUT            D5 DOUT
            \                \         /                /
             +------- D7 PD_SCK shared bus ------------+
            |               |        |               |
        [JST-XH J1]    [JST-XH J2] [JST-XH J3]    [JST-XH J4]
         load cell      load cell   load cell      load cell
```

## What's in this directory

| Path                                  | What it is                                                               |
| ------------------------------------- | ------------------------------------------------------------------------ |
| `design.py`                           | The circuit-synth Python source. Edit this to change the design.         |
| `kicad/scale_carrier_board.kicad_pro` | KiCad project file. Open this in KiCad.                                  |
| `kicad/scale_carrier_board.kicad_sch` | Schematic (placed + wired).                                              |
| `kicad/scale_carrier_board.net`       | KiCad netlist (input for Quilter.ai).                                    |
| `kicad/scale_carrier_board.json`      | Canonical JSON netlist (circuit-synth source-of-truth).                  |
| `bom.csv`                             | Bill of materials with LCSC part numbers (input for JLCPCB assembly).    |
| `.venv/`                              | Python venv with circuit-synth installed (re-run `design.py` from here). |

## Pinout summary

| Wemos pin | KiCad pin # | GPIO   | Connected to                               |
| --------- | ----------- | ------ | ------------------------------------------ |
| 3V3       | 8           | —      | All HX711 power, bulk caps, LED rail       |
| GND       | 10          | —      | All grounds, RATE pins (10 SPS), BASE pins |
| D7 (MOSI) | 6           | GPIO13 | Shared `PD_SCK` to all four HX711s         |
| D6 (MISO) | 5           | GPIO12 | HX711 #0 `DOUT`                            |
| D1 (SCL)  | 14          | GPIO5  | HX711 #1 `DOUT`                            |
| D2 (SDA)  | 13          | GPIO4  | HX711 #2 `DOUT`                            |
| D5 (SCK)  | 4           | GPIO14 | HX711 #3 `DOUT`                            |

Per-channel 4-pin connector pinout (J1..J4):

| Pin | Net    | Wire color (typical) | Function                 |
| --- | ------ | -------------------- | ------------------------ |
| 1   | 3V3    | red                  | E+ (excitation positive) |
| 2   | GND    | black                | E− (excitation negative) |
| 3   | LCx_A+ | green                | A+ (signal positive)     |
| 4   | LCx_A− | white                | A− (signal negative)     |

## Important note on the HX711 pinout

The KiCad symbol `Analog_ADC:HX711` uses the **canonical Avia
Semiconductor datasheet pinout** for the SOIC-16 package (pin 1 = VSUP,
pin 11 = PD_SCK, pin 12 = DOUT, etc.). The original spec for this board
referenced different pin numbers (likely from a mirrored pinout printed
on a knock-off datasheet). The `design.py` script binds nets to HX711
pins by **name** (e.g. `hx["AVDD"] += vcc`), so the netlist is
electrically correct regardless of which pin-numbering convention the
datasheet you read happened to use.

---

# How to take this to Quilter.ai

[Quilter.ai](https://quilter.ai) is an autonomous PCB layout service —
upload a netlist (or a KiCad project with components but no placement)
and it places + routes the board for you in minutes.

## Option A — Upload the KiCad project directly (recommended)

1. **Install KiCad 8** locally if you don't have it (the project was
   generated against the KiCad 8.0 symbol/footprint libraries).

2. **Open the project**: double-click
   `kicad/scale_carrier_board.kicad_pro`. KiCad will open the project
   manager.

3. **Open the schematic** (Eeschema). You should see the Wemos, the four
   HX711s, all caps, the LED, the resistor, and the four connectors,
   already wired. Verify the rats-nest in `Tools → Electrical Rules
Checker` (ERC).

4. **Generate the PCB skeleton**: in the project manager open Pcbnew (or
   `File → New Board From Schematic` from Eeschema). Then `Tools →
Update PCB from Schematic` (F8). This loads every footprint into
   the PCB editor, all stacked at the origin, with net assignments
   intact. Save (`Ctrl+S`) so the `.kicad_pcb` file lands next to the
   schematic.

5. **Set the board outline**: still in Pcbnew, switch to the `Edge.Cuts`
   layer and draw a rectangle ~50 × 60 mm around the components. Quilter
   needs an outline to know where to place parts. (Or skip and let
   Quilter auto-size.)

6. **Upload to Quilter**:
   - Sign in at https://app.quilter.ai
   - Click `New Project → Upload KiCad Project`
   - Drag the entire `kicad/` folder (or zip and upload). Quilter
     accepts `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb`.
   - Pick `2-layer board`, `1 oz copper`, `JLCPCB-friendly` design rule
     preset.
   - Hit `Run Layout`. Wait 5–15 minutes.

7. **Review and download**: Quilter will show you the placed + routed
   board. Download the updated `.kicad_pcb` (and Gerbers — see next
   section).

## Option B — Upload the netlist directly

If you don't want to install KiCad, Quilter also accepts the raw
KiCad-format netlist:

1. Sign in at https://app.quilter.ai
2. `New Project → Upload Netlist`
3. Upload `kicad/scale_carrier_board.net`
4. Quilter will load the footprints from its internal KiCad library
   (every footprint we used is from the standard KiCad libraries, so
   this works).
5. Same flow as Option A from step 6 onward.

---

# How to export Gerbers from Quilter's output

Once Quilter has placed and routed the board:

1. From Quilter's project view, click `Export → Manufacturing Files`.
2. Select `JLCPCB` as the target fab — Quilter will use JLCPCB's
   preferred Gerber settings (Protel filename extensions, RS-274X,
   excellon drill files, plated/non-plated split).
3. Download the resulting `.zip` (typically named
   `scale_carrier_board_gerbers.zip`).

If you'd rather export from KiCad after pulling Quilter's `.kicad_pcb`
back locally:

1. Open `scale_carrier_board.kicad_pcb` in Pcbnew.
2. `File → Fabrication Outputs → Gerbers (.gbr)`.
3. In the dialog: leave defaults, but check "Use Protel filename
   extensions" (JLCPCB prefers them), and "Subtract soldermask from
   silkscreen". Plot.
4. Then `File → Fabrication Outputs → Drill Files (.drl)`. Defaults are
   fine; output PTH and NPTH in one file, mirrored=No, units=mm.
5. Zip the entire output directory — that's the upload to JLCPCB.

---

# How to upload to JLCPCB

JLCPCB is the bare-fab + assembly house. Two uploads are needed:

## (a) Bare PCB fabrication

1. Go to https://cart.jlcpcb.com/quote
2. Click `Add Gerber File` and upload the Gerber zip.
3. JLCPCB auto-detects the size, layer count (2), and proposes defaults.
   Accept: 1.6mm thickness, HASL (lead-free), green soldermask, white
   silkscreen.
4. Quantity: pick `5` (cheapest tier — typically $2–$5 for 5 boards of
   this size).
5. Add to cart.

## (b) PCBA (Assembly) — optional but easier than hand soldering

1. On the same quote page, toggle on `PCB Assembly`.
2. Type: `Standard` or `Economic` (Economic is fine for through-hole
   D1 Mini sockets + SOIC-16 HX711s + 0603 passives).
3. Upload:
   - **BOM**: `bom.csv` from this directory. JLCPCB reads the
     `reference`, `value`, and `lcsc` columns.
   - **CPL (Centroid / pick-and-place)**: KiCad can export this via
     `File → Fabrication Outputs → Component Placement (.pos)` after
     Quilter has placed the components. Save it as a CSV with the
     header row JLCPCB expects (`Designator,Mid X,Mid Y,Layer,
Rotation`).
4. Review the parts match: every line with an LCSC like `C24951` should
   resolve to a real JLCPCB part. Lines without LCSC (the Wemos itself,
   and the female pin sockets if you choose to mount them yourself)
   should be marked **Do Not Place** in the JLCPCB review UI — you'll
   solder those by hand.
5. Place the order.

---

# Estimated cost (April 2026 prices, ballpark)

| Line item                                                  |               Qty |               Cost |
| ---------------------------------------------------------- | ----------------: | -----------------: |
| 5× bare PCB, ~50×60 mm, 2-layer, HASL, green               |                 5 |        **$2 – $5** |
| PCBA setup fee (one-time per order)                        |                 1 |             **$8** |
| HX711 SOIC-16 (LCSC C24951)                                | 4 × 5 boards = 20 | **$8** (~$0.40/ea) |
| 100nF 0603 (C14663)                                        |                20 |          **$0.20** |
| 10µF radial electrolytic (C68116)                          |                20 |             **$3** |
| 100µF radial electrolytic (C16133)                         |                 5 |             **$1** |
| 1k 0603 (C21190)                                           |                 5 |          **$0.10** |
| LED 0603 green (C72043)                                    |                 5 |          **$0.40** |
| JST-XH 4-pin connector (C144394)                           |                20 |             **$2** |
| **Subtotal (PCB + PCBA)**                                  |                   |           **~$25** |
| Shipping to US (DHL Express, ~5 days)                      |                   |      **$15 – $25** |
| **Wemos D1 Mini × 5** (Amazon / AliExpress, user-supplied) |                 5 |      **$15 – $20** |
| **Female pin sockets, 1×8 2.54mm × 10** (user-supplied)    |                10 |        **$3 – $5** |
| **Total all-in for 5 fully populated boards**              |                   |     **~$60 – $75** |

If you skip PCBA and hand-solder everything, drop ~$8 setup + ~$15 in
parts → **~$10–$15 for 5 bare boards + your time**. The 0603 SMD
passives are easy with a fine iron and tweezers; the SOIC-16 HX711 is
tractable with drag-soldering.

---

# Re-generating the project

If you want to tweak the design (different connector, more channels,
different decoupling values):

```bash
cd /home/jeremy/luna-hub-lite/hardware/scale-board

# circuit-synth needs KiCad 8.0 symbol/footprint libraries on disk.
# The first generation cloned them to /tmp; if they're gone, re-clone:
git clone --depth 1 --branch 8.0.7 https://gitlab.com/kicad/libraries/kicad-symbols.git /tmp/kicad-symbols
git clone --depth 1 --branch 8.0.7 https://gitlab.com/kicad/libraries/kicad-footprints.git /tmp/kicad-footprints

# Edit design.py, then:
.venv/bin/python design.py
```

The script always overwrites `kicad/` and `bom.csv`.

# Caveats

- **PCB generation is paywalled in circuit-synth open source.** This
  project ships a schematic + KiCad netlist; the `.kicad_pcb` file is
  produced by KiCad itself (`Update PCB from Schematic`) or by Quilter.
- **No ERC was run automatically** because `kicad-cli` isn't installed
  in the build environment. Run `kicad-cli sch erc kicad/scale_carrier_board.kicad_sch`
  yourself (or use the GUI ERC) before sending to fab.
- **Footprint choices are conservative**: 0603 passives, SOIC-16 (not
  TSSOP) for the HX711, JST-XH (not screw-terminal) for load cells.
  Swap to your preference by editing the `FP_*` constants at the top of
  `design.py` and re-running.
- **The Wemos D1 Mini is intentionally not on the BOM as a JLCPCB part**
  — buy it from Amazon/AliExpress and plug it into the female sockets.
