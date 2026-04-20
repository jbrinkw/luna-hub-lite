"""
Wemos D1 Mini + 4× HX711 Load Cell Carrier Board
=================================================

Custom 2-layer PCB carrier that hosts a Wemos D1 Mini (ESP8266) module on
female pin sockets and connects four HX711 24-bit ADCs to four 4-pin load
cell connectors. All HX711s share a common PD_SCK clock line; each HX711
has its own DOUT pin so the host MCU can read them in parallel.

Net summary
-----------
3V3                  : Wemos 3V3 pin -> all HX711 AVDD/DVDD/VSUP, decoupling caps, optional power LED
GND                  : Wemos GND pin -> all HX711 AGND, all RATE pins (10 SPS), connector return, decoupling
HX_SCK               : shared clock, Wemos D7 (MOSI/D7, pin 6) -> all four HX711 PD_SCK
HX0_DOUT..HX3_DOUT   : per-HX711 data lines, mapped to D6/D1/D2/D5
LC0_E+ .. LC3_A-     : per-load-cell connector nets (E+, E-, A+, A-)

Notes on HX711 pinout (KiCad symbol "Analog_ADC:HX711", SOIC-16)
----------------------------------------------------------------
The KiCad symbol uses the canonical Avia Semiconductor datasheet pinout:
    1  VSUP   2  BASE   3  AVDD   4  VFB    5  AGND   6  VBG    7  INA-   8  INA+
    9  INB-  10  INB+  11  PD_SCK 12  DOUT 13  XO    14  XI    15  RATE  16  DVDD

The original board spec referenced different pin numbers (likely from a
mirrored or rebranded variant), but the *electrical intent* is unambiguous
because nets are named by signal (AVDD, DVDD, AGND, etc). All connections
below bind nets to pins by *name*, matching the canonical datasheet, so
the resulting netlist is correct regardless of the spec's pin-number drift.

Load cell wiring (single channel A — the standard 4-wire config)
----------------------------------------------------------------
LCx_E+  -> AVDD  (excitation +, regulated by HX711's onboard regulator)
LCx_E-  -> AGND  (excitation -)
LCx_A+  -> INA+  (signal +)
LCx_A-  -> INA-  (signal -)

This matches the wiring on every common HX711 breakout (SparkFun, AVIA
reference design, etc) when used with a 4-wire bridge load cell.
"""

import os

# Point circuit-synth at the KiCad 8 symbol/footprint libraries we cloned.
# (Set BEFORE importing circuit_synth.)
LIB_ROOT = os.environ.get("KICAD_LIB_ROOT", "/tmp")
os.environ.setdefault("KICAD_SYMBOL_DIR", f"{LIB_ROOT}/kicad-symbols")
os.environ.setdefault("KICAD8_SYMBOL_DIR", f"{LIB_ROOT}/kicad-symbols")
os.environ.setdefault("KICAD8_FOOTPRINT_DIR", f"{LIB_ROOT}/kicad-footprints")

import circuit_synth as cs


# ---------------------------------------------------------------------------
# Footprint + symbol constants
# ---------------------------------------------------------------------------

# WEMOS D1 Mini lands on the canonical KiCad through-hole footprint;
# user solders 2x 1x8 female pin sockets into those holes so the module is
# removable.
SYM_WEMOS = "RF_Module:WEMOS_D1_mini"
FP_WEMOS = "RF_Module:WEMOS_D1_mini_light"

SYM_HX711 = "Analog_ADC:HX711"
FP_HX711 = "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm"

# Load cell connector: 4-pin JST-XH vertical (matches what most HX711
# scale projects use; can be swapped for a screw terminal post-layout).
SYM_CONN_4 = "Connector_Generic:Conn_01x04"
FP_CONN_4 = "Connector_JST:JST_XH_B4B-XH-A_1x04_P2.50mm_Vertical"

SYM_CAP = "Device:C"
SYM_CAP_POL = "Device:C_Polarized"
SYM_R = "Device:R"
SYM_LED = "Device:LED"

FP_CAP_0603 = "Capacitor_SMD:C_0603_1608Metric"
FP_CAP_ELEC_D5 = "Capacitor_THT:CP_Radial_D5.0mm_P2.00mm"   # 10uF electrolytic
FP_CAP_ELEC_D6 = "Capacitor_THT:CP_Radial_D6.3mm_P2.50mm"   # 100uF bulk
FP_R_0603 = "Resistor_SMD:R_0603_1608Metric"
FP_LED_0603 = "LED_SMD:LED_0603_1608Metric"


# ---------------------------------------------------------------------------
# Sub-circuit: one HX711 channel + its decoupling + its load cell connector
# ---------------------------------------------------------------------------

def hx711_channel(idx: int, vcc, gnd, sck, dout):
    """
    Build one HX711 + decoupling + load cell connector and connect it to
    the supplied power/clock/data nets.

    idx   -> 0..3, used for reference designators and connector net names
    vcc   -> 3V3 net
    gnd   -> GND net
    sck   -> shared HX_SCK net
    dout  -> per-channel HXx_DOUT net
    """
    hx = cs.Component(
        symbol=SYM_HX711,
        ref=f"U{idx + 2}",  # U2..U5 (U1 reserved for the Wemos)
        value="HX711",
        footprint=FP_HX711,
        description="24-bit ADC for weigh scales",
        mfg_part_num="HX711",
        manufacturer="Avia Semiconductor",
        lcsc="C24951",
    )

    # --- Power pins (bound by NAME, not number — see header docstring) ---
    hx["AVDD"] += vcc
    hx["DVDD"] += vcc
    hx["VSUP"] += vcc
    hx["AGND"] += gnd
    # The "BASE" pin (regulator base drive) is tied to AGND when the
    # internal regulator path is unused — common practice on every cheap
    # HX711 breakout. Leave VFB and VBG floating; XI/XO floating uses the
    # internal oscillator.
    hx["BASE"] += gnd
    hx["RATE"] += gnd  # tie low for 10 SPS

    # --- Digital interface ---
    hx["PD_SCK"] += sck
    hx["DOUT"] += dout

    # --- Channel A inputs (load cell signal) ---
    # Per-channel signal nets — these stay separate per HX711.
    a_plus = cs.Net(f"LC{idx}_A+")
    a_minus = cs.Net(f"LC{idx}_A-")
    hx["INA+"] += a_plus
    hx["INA-"] += a_minus

    # --- Load cell connector (4-pin JST-XH) ---
    # NOTE: connector E+/E- ride the global 3V3/GND rails — wire them
    # directly to vcc/gnd (not via a per-channel local Net) to avoid
    # circuit-synth's net-merging picking the local name and orphaning
    # other power-pin connections from the global rail.
    j = cs.Component(
        symbol=SYM_CONN_4,
        ref=f"J{idx + 1}",  # J1..J4
        value=f"LoadCell{idx}",
        footprint=FP_CONN_4,
        description="4-pin JST-XH connector to load cell",
        lcsc="C144394",  # B4B-XH-A equivalent (changeable)
    )
    j[1] += vcc       # E+  (red)   -> 3V3 rail
    j[2] += gnd       # E-  (black) -> GND rail
    j[3] += a_plus    # A+  (green)
    j[4] += a_minus   # A-  (white)

    # --- Decoupling caps next to each HX711 ---
    c_dec = cs.Component(
        symbol=SYM_CAP,
        ref=f"C{2 * idx + 10}",  # C10, C12, C14, C16
        value="100nF",
        footprint=FP_CAP_0603,
        description="HX711 AVDD/DVDD ceramic decoupling",
        lcsc="C14663",  # 100nF X7R 0603 50V
    )
    c_dec[1] += vcc
    c_dec[2] += gnd

    c_bulk = cs.Component(
        symbol=SYM_CAP_POL,
        ref=f"C{2 * idx + 11}",  # C11, C13, C15, C17
        value="10uF",
        footprint=FP_CAP_ELEC_D5,
        description="HX711 AVDD electrolytic decoupling",
        lcsc="C68116",  # generic 10uF 16V radial
    )
    c_bulk[1] += vcc  # + lead
    c_bulk[2] += gnd  # - lead


# ---------------------------------------------------------------------------
# Top-level circuit
# ---------------------------------------------------------------------------

@cs.circuit(name="scale_carrier_board")
def scale_carrier():
    """Wemos D1 Mini + 4x HX711 carrier board (Luna scale-board)."""

    # --- Power and signal nets ---
    vcc = cs.Net("3V3")
    gnd = cs.Net("GND")
    hx_sck = cs.Net("HX_SCK")
    dout_nets = [cs.Net(f"HX{i}_DOUT") for i in range(4)]

    # --- Wemos D1 Mini (mounted via female sockets in the through-holes) ---
    wemos = cs.Component(
        symbol=SYM_WEMOS,
        ref="U1",
        value="WEMOS_D1_mini",
        footprint=FP_WEMOS,
        description="Wemos D1 Mini ESP8266 module socket (2x 1x8 female header) -- module supplied by user",
        mfg_part_num="WEMOS_D1_mini",
    )

    # Power pins
    wemos["3V3"] += vcc
    wemos["GND"] += gnd

    # Shared clock from Wemos D7 (MOSI/D7, KiCad pin 6 = GPIO13)
    wemos["MOSI/D7"] += hx_sck

    # Per-HX711 DOUT pins -> Wemos D6/D1/D2/D5
    wemos["MISO/D6"] += dout_nets[0]   # HX711 #0 DOUT -> D6 (GPIO12)
    wemos["SCL/D1"]  += dout_nets[1]   # HX711 #1 DOUT -> D1 (GPIO5)
    wemos["SDA/D2"]  += dout_nets[2]   # HX711 #2 DOUT -> D2 (GPIO4)
    wemos["SCK/D5"]  += dout_nets[3]   # HX711 #3 DOUT -> D5 (GPIO14)

    # --- Bulk cap on the 3V3 rail (shared across all HX711s) ---
    c_bulk = cs.Component(
        symbol=SYM_CAP_POL,
        ref="C1",
        value="100uF",
        footprint=FP_CAP_ELEC_D6,
        description="3V3 rail bulk capacitor",
        lcsc="C16133",  # generic 100uF 16V radial
    )
    c_bulk[1] += vcc
    c_bulk[2] += gnd

    # --- Power LED (3V3 indicator) ---
    led = cs.Component(
        symbol=SYM_LED,
        ref="D1",
        value="PWR",
        footprint=FP_LED_0603,
        description="3V3 power indicator LED",
        lcsc="C72043",  # green 0603
    )
    r_led = cs.Component(
        symbol=SYM_R,
        ref="R1",
        value="1k",
        footprint=FP_R_0603,
        description="Power LED current limit (~2 mA at 3V3)",
        lcsc="C21190",  # 1k 0603 1%
    )
    # 3V3 -> R1 -> LED anode, cathode -> GND
    r_led[1] += vcc
    r_led[2] += led[2]   # LED pin 2 = anode in KiCad Device:LED
    led[1] += gnd        # LED pin 1 = cathode

    # --- Four HX711 channels ---
    for i in range(4):
        hx711_channel(i, vcc, gnd, hx_sck, dout_nets[i])


# ---------------------------------------------------------------------------
# Generate the project + BOM
# ---------------------------------------------------------------------------

def write_bom_csv(circuit_obj, out_path: str) -> None:
    """
    Write a manufacturing BOM by walking the in-memory circuit. We do this
    ourselves because circuit-synth's `generate_bom` requires kicad-cli,
    which isn't installed in this environment.

    Columns: reference, value, footprint, lcsc, manufacturer, mfg_part_num,
             description, quantity (always 1; consolidate downstream).
    """
    import csv

    rows = []
    for comp in circuit_obj.components:
        # The Circuit.components iterator yields component refs (strings)
        # in this version of circuit-synth. Look them up via _components.
        c = circuit_obj._components[comp] if isinstance(comp, str) else comp
        rows.append({
            "reference": c.ref,
            "value": c.value,
            "footprint": c.footprint or "",
            "lcsc": c.properties.get("lcsc", "") if hasattr(c, "properties") else getattr(c, "lcsc", ""),
            "manufacturer": getattr(c, "manufacturer", "") or (c.properties.get("manufacturer", "") if hasattr(c, "properties") else ""),
            "mfg_part_num": getattr(c, "mfg_part_num", "") or (c.properties.get("mfg_part_num", "") if hasattr(c, "properties") else ""),
            "description": c.description or "",
            "quantity": 1,
        })
    rows.sort(key=lambda r: (r["reference"][0], int("".join(ch for ch in r["reference"][1:] if ch.isdigit()) or "0")))

    # Append "supplied by user" mechanical parts that aren't in the schematic
    # but are needed to actually populate the board.
    rows.append({
        "reference": "U1_socket_a",
        "value": "1x8 Female Pin Socket (2.54mm)",
        "footprint": "Connector_PinSocket_2.54mm:PinSocket_1x08_P2.54mm_Vertical",
        "lcsc": "C146454",  # generic 1x8 2.54mm female header (HDR)
        "manufacturer": "Boomele",
        "mfg_part_num": "1*8P-2.54-Female",
        "description": "Female header into D1 Mini through-hole row A (solder into U1 footprint)",
        "quantity": 1,
    })
    rows.append({
        "reference": "U1_socket_b",
        "value": "1x8 Female Pin Socket (2.54mm)",
        "footprint": "Connector_PinSocket_2.54mm:PinSocket_1x08_P2.54mm_Vertical",
        "lcsc": "C146454",
        "manufacturer": "Boomele",
        "mfg_part_num": "1*8P-2.54-Female",
        "description": "Female header into D1 Mini through-hole row B (solder into U1 footprint)",
        "quantity": 1,
    })

    with open(out_path, "w", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=["reference", "value", "footprint", "lcsc",
                        "manufacturer", "mfg_part_num", "description", "quantity"],
        )
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    here = os.path.abspath(os.path.dirname(__file__))
    os.chdir(here)

    circuit = scale_carrier()
    n_comp = len(list(circuit.components))
    n_net = len(list(circuit.nets))
    print(f"Built circuit with {n_comp} components and {n_net} nets.")

    # Generate the KiCad project (schematic + JSON + KiCad netlist).
    # NB: circuit-synth's open-source build does NOT generate .kicad_pcb
    #     (PCB generation is paywalled). The .net file we produce here is
    #     the canonical input for Quilter.ai's autonomous placement+routing,
    #     and KiCad itself will lay down a fresh .kicad_pcb when you open
    #     the project (Tools -> Update PCB from Schematic).
    result = circuit.generate_kicad_project(
        project_name="kicad",
        generate_pcb=False,  # paywalled; see README for KiCad/Quilter workflow
        force_regenerate=True,
        placement_algorithm="hierarchical",
        generate_ratsnest=True,
    )
    print("KiCad project generated:")
    for k, v in (result or {}).items():
        print(f"  {k}: {v}")

    # Write a BOM CSV next to the project.
    bom_path = os.path.join(here, "bom.csv")
    write_bom_csv(circuit, bom_path)
    print(f"BOM written to {bom_path}")
