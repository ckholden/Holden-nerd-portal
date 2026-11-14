"""Printable radio guide that ships inside a family member's template download.

export.py builds it from the SAME CSV folder that goes into the zip, so zone numbers and knob
positions in the guide can never drift from the codeplug: every export regenerates it.
Only Pete (kk7rbq/878) has one so far (Christian, 2026-11-05).
"""
import csv
from pathlib import Path

GUIDE_NAME = {("kk7rbq", "878"): "PETE RADIO GUIDE - print me.txt"}

HS_INFO = {
    "HOLDEN PARROT": "TEST - hear your own voice back", "HOLDEN DMR": "FAMILY - talk to Christian & Chris",
    "HOLDEN PRESTON": "PRESTON'S TALK GROUP - talk with Preston",
    "HOLDEN RADIO CHK": "Radio check - Radio answers", "HOLDEN VOICEMAIL": "Family voicemail",
    "HOLDEN QUIET": "(family service)", "HOLDEN INFO": "(family service)",
    "HOLDEN NEWS": "Ham radio news", "HOLDEN ASK RADIO": "Ask Radio (the robot)",
    "HOLDEN CHECK IN": "(family service)",
    "PNW DISCONNECT": "Hang up the last PNW group", "PNW PARROT": "TEST - hear your own voice back",
    "PNW OREGON1": "OREGON 1 - your usual check-in", "PNW RGNL": "PNW REGIONAL - your usual",
    "PNW ORCEN": "Oregon Central", "PNW PNW1": "Pacific Northwest 1", "PNW CASC1": "Cascadia 1",
    "PNW I-84": "I-84 corridor", "PNW ARRG": "ARRG group", "PNW WASH1": "Washington 1",
    "PNW WASH2": "Washington 2", "PNW IDAHO": "Idaho", "PNW TAC1": "Side chat 1", "PNW TAC2": "Side chat 2",
    "PNW TAC310": "Side chat 310", "PNW TAC311": "Side chat 311", "PNW TAC312": "Side chat 312",
    "BCT DISCONNECT": "Hang up the last BC group", "BCT PARROT": "TEST - hear your own voice back",
    "BCT BC1": "British Columbia 1", "BCT PNW1": "Pacific Northwest 1 (via BC)",
    "BCT PNWR2": "PNW Regional (via BC)", "BCT I5": "I-5 corridor", "BCT TAC310": "Side chat 310",
    "BM DISCONNECT": "Hang up the last BM group", "BM PARROT": "TEST - hear your own voice back",
    "BM OREGON": "Oregon", "BM PNW REGION": "PNW Region", "USA BRIDGE": "USA nationwide",
    "BM WW ENGLISH": "Worldwide, English", "BM N AMERICA": "North America", "BM WORLDWIDE": "Worldwide",
    "BM WASHINGTON": "Washington", "BM TAC310": "Side chat 310",
}
NET = {"HOLDEN": "FAMILY (Holden)", "PNW": "PNW DIGITAL", "BCT": "BC-TRBO (Canada)", "BM": "BRANDMEISTER"}
WHERE = {"HAM CROOK CO": "FM voice repeaters around Prineville / Crook County",
         "HAM DESCHUTES CO": "FM voice repeaters around Bend / Redmond / Sisters",
         "DMR CROOK": "Digital repeater - Crook County", "DMR GRIZZLY": "Digital repeater - Grizzly Mtn (Prineville)",
         "DMR POWELLBTT": "Digital repeater - Powell Butte", "DMR GRAY BUTTE": "Digital repeater - Gray Butte",
         "CORBETT AREA": "FM voice repeaters near Chris's house (Corbett)",
         "HAM MULTNOMAH CO": "FM voice repeaters around Portland",
         "DMR CORBETT": "Digital repeater - Corbett (Chris's area)", "DMR GRESHAM": "Digital repeater - Gresham",
         "DMR KOIN TOWER": "Digital repeater - KOIN Tower, Portland", "DMR PPMC": "Digital repeater - Portland (PPMC)"}
PDX = {"CORBETT AREA", "HAM MULTNOMAH CO", "DMR CORBETT", "DMR GRESHAM", "DMR KOIN TOWER", "DMR PPMC"}


def _net(n):
    k = n.split()[0]
    return "BM" if k in ("BM", "USA") else k


def _bare(zone_name):
    p = zone_name.split(" ", 1)
    return p[1] if len(p) == 2 and p[0].isdigit() else zone_name


def _span(nums):
    return f"{nums[0]}-{nums[-1]}" if len(nums) > 1 else str(nums[0]) if nums else "-"


def generate_guide(key, radio, src):
    """Return (filename, text) for this person's printable guide, or None if they have none."""
    if (key, radio) not in GUIDE_NAME:
        return None
    src = Path(src)
    with open(src / "Zone.CSV", encoding="utf-8-sig", newline="") as fh:
        zones = list(csv.reader(fh))[1:]
    names = [_bare(z[1]) for z in zones]
    if "HOTSPOT" not in names:
        raise ValueError(f"{key}/{radio}: no HOTSPOT zone in {src.name}; refusing to ship a wrong guide")
    hs_no = names.index("HOTSPOT") + 1
    hs = zones[hs_no - 1][2].split("|")
    away = [i for i in range(1, len(zones) + 1) if i != hs_no]
    pdx = [i for i in away if names[i - 1] in PDX]
    cor = [i for i in away if i not in pdx]

    L = []
    w = L.append
    rule = lambda c="=": w(c * 76)

    def grid(items, cols=3, width=25):
        cells = [f"{i:2} {n}"[:width - 1].ljust(width) for i, n in enumerate(items, 1)]
        rows = (len(cells) + cols - 1) // cols
        for r in range(rows):                                   # read DOWN each column, like the knob
            w("  " + "".join(cells[r + c * rows] for c in range(cols) if r + c * rows < len(cells)).rstrip())

    rule(); w("  PETE  KK7RBQ  -  AnyTone 878 radio guide        (radio ID 3206088)")
    w("  Made by Christian. Matches the codeplug in this download."); rule()
    w("")
    w("BEFORE YOU TALK - LOOK AT THE SCREEN")
    w("  TOP line   = the ZONE   (which folder of channels you are in)")
    w("  BIG line   = the CHANNEL (who you will talk to)")
    w("  If both say what you want, hold the side button (PTT), wait one")
    w("  second, then talk. Let go to listen.")
    w("")
    w("  Pick a CHANNEL ... turn the TOP-RIGHT knob")
    w("  Pick a ZONE ...... press MENU, choose Zone, pick one, press MENU")
    w("  Volume / power ... TOP-LEFT knob")
    w("")
    w("THE ZONES (press MENU > Zone)")
    for i, nm in enumerate(names, 1):
        use = "AT HOME, on your hotspot box" if nm == "HOTSPOT" else WHERE.get(nm, "")
        w(f"  {i:2}  {nm:<17} {use}")
    w("")
    rule("-"); w(f"AT HOME:  ZONE {hs_no}  HOTSPOT"); rule("-")
    w("  Your hotspot box must be plugged in. It works only near the box")
    w("  (in the house and yard). Same zone works at Christian's and Chris's")
    w("  houses on their hotspots.")
    w("")
    w("  Each group starts with its TEST (parrot) channel. PNW, BC and BM")
    w("  also have a HANG UP (disconnect) channel just before the TEST.")
    fam = hs.index("HOLDEN DMR") + 1 if "HOLDEN DMR" in hs else None
    if fam:
        w(f"  You will always hear the FAMILY channel (#{fam}), whatever channel you")
        w(f"  are on. To answer family, turn to #{fam} HOLDEN DMR first.")
    w("")
    cur = None
    for i, n in enumerate(hs, 1):
        k = _net(n)
        if k != cur:
            if cur:
                w("")
            cur = k
            w(f"  --- {NET.get(k, k)} ---")
        w(f"  {i:2}  {n:<17} {HS_INFO.get(n, '')}".rstrip())
    w("")
    w("  TEST YOUR RADIO: turn to a TEST (parrot) channel, hold PTT, say")
    w("  \"KK7RBQ testing\", let go, wait 5 seconds. You hear yourself back.")
    w("  HANG UP: if a group you visited keeps talking, key its HANG UP")
    w("  channel for one second.")
    w("")
    w("  Knob grid (read down each column):")
    grid(hs)
    w("")
    rule("-"); w(f"AWAY FROM HOME:  REPEATER ZONES {_span(away)}"); rule("-")
    w("  HAM ... zones = regular FM voice repeaters (like the old radios).")
    w("  DMR ... zones = digital repeaters. In each one, the OR1 channel is")
    w("  OREGON 1, your usual check-in. To meet family, say \"KK7RBQ, let's")
    w("  go to TAC 310\" and both turn to the TAC310 channel.")
    w(f"  Near Prineville use zones {_span(cor)}. Near Corbett / Portland use {_span(pdx)}.")
    for i in away:
        nm = names[i - 1]
        mem = zones[i - 1][2].split("|")
        w(""); w(f"  ZONE {i}  {nm}")
        if WHERE.get(nm):
            w(f"  {WHERE[nm]}")
        o = [j for j, n in enumerate(mem, 1) if n.endswith(" OR1")]
        if o:
            w(f"  Oregon 1 = channel #{o[0]}  ({mem[o[0] - 1]})")
        grid(mem)
    w("")
    rule("-"); w("IF SOMETHING IS WRONG"); rule("-")
    w("  No beep / can't talk ... check the TOP line: right zone? At home it")
    w("                           must say HOTSPOT.")
    w("  Hotspot silent ......... is the box plugged in with its lights on?")
    w("                           Unplug it, count to 10, plug it back in.")
    w("  Nothing on TEST ........ wait 20 seconds of quiet, try again.")
    w(f"  Lost? .................. MENU > Zone > {hs_no} HOTSPOT, knob to #{fam or 1}.")
    w("                           Call Christian.")
    w("")
    rule("-"); w("FOR CHRISTIAN (setup notes, not for Pete)"); rule("-")
    w("  Codeplug folder:")
    w(f"    {src.name}"[:76])
    w("  CPS import order: TalkGroups, ReceiveGroupCallList, Channel, Zone.")
    w("  Then Optional Setting: Sub Channel OFF (single display), write radio.")
    w("  Hotspot channels: 432.800 simplex, CC1, slot 2 (same as every family")
    w("  hotspot). Prefixes: 7 HOLDEN, 9 PNW, 6 BC-TRBO, bare = BM.")
    w("  Not yet verified on air: PNW/BC DISCONNECT (TG 4000).")
    w("  Pete's ID 3206088 must be on: the HOLDEN family list (Manage tab),")
    w("  Dad's hotspot white list, your new hotspot's white list.")
    w("  On Dad's hotspot PNW is off until Dad has his own PNW login.")
    return GUIDE_NAME[(key, radio)], "\n".join(L) + "\n"
