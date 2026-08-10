"""Generates the CLAUDE.md packaged into every codeplug download zip.

Two parts, combined at build time so this can never hand-drift from the actual
files it describes:
  1. A shared POLICY section, entirely derived from the live CSVs in the source
     folder (channel/zone/talkgroup counts, last-updated date, the person's own
     identity read from RadioIDList.CSV) -- same structure for everyone.
  2. A per (key, radio model) PROCEDURE section -- CPS steps and hardware-
     specific gotchas that cannot be derived from a CSV (e.g. the GD-168's
     silent-import bug). These are hand-maintained constants, same as before;
     only the policy section and the identity/stats are now generated.

Called from export.py's zip_person_codeplug() once per (key, radio).
"""
import csv
from datetime import datetime


PERSON_INFO = {
    "kk7ion": {"first": "Chris", "full": 'Christopher "Chris" Holden', "relation": "Christian's dad, Corbett OR"},
    "kk7rbq": {"first": "Pete", "full": 'Peter "Pete" Holden', "relation": "Christian's grandpa, Prineville OR"},
    "admin": {"first": "Christian", "full": "Christian Holden", "relation": "KJ7DTS, builds and maintains the shared codeplug"},
}


def _read_csv(path):
    if not path.exists():
        return []
    with open(path, encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def derive_identity(src):
    rows = _read_csv(src / "RadioIDList.CSV")
    if len(rows) < 2:
        return "?", "?"
    dmr_id, callsign = rows[1][1].strip(), rows[1][2].strip()
    return dmr_id, callsign


def derive_stats(src):
    channels = _read_csv(src / "Channel.CSV")
    zones = _read_csv(src / "Zone.CSV")
    talkgroups = _read_csv(src / "TalkGroups.CSV")
    ch_path = src / "Channel.CSV"
    mtime = datetime.fromtimestamp(ch_path.stat().st_mtime).strftime("%Y-%m-%d") if ch_path.exists() else "unknown"
    return {
        "channels": max(len(channels) - 1, 0),
        "zones": max(len(zones) - 1, 0),
        "talkgroups": max(len(talkgroups) - 1, 0),
        "updated": mtime,
    }


RENAME_TABLE = (
    ("LOCAL 2", "METRO 2"), ("CASCADES EAST", "CASCADES 1"), ("NORTH AMERICA", "N.AMERICA 2"),
    ("PNW REGIONAL", "PNW RGNL 2"), ("WASH 1", "WASHINGTON 1"), ("WASH 2", "WASHINGTON 2"),
    ("RACOM", "RACOM ARC 2"), ("MTN 2", "MOUNTAIN 2"), ("WORLDWIDE ENGLSH", "WW ENGLISH 2"),
    ("AUD TEST/BM ECHO", "AUDIO TEST 2"), ("TG 99", "SIMPLEX 99"),
)


PROCEDURES = {
    ("kk7ion", "878"): """# Helping Chris update his AnyTone 878 — context for Claude Code

> **Chris — if you opened this file yourself:** open *this folder* in Claude
> Code and type **"help me update my radio."** Everything below is notes for
> your AI helper so it knows exactly how to walk you through it.

## Your job (Claude, read this first)

You're helping **Christopher "Chris" Holden — callsign KK7ION** load an
**updated** configuration onto his **AnyTone AT-D878UVII PLUS** handheld
radio. Chris already programmed this radio once before — this is a refresh,
not a first-time setup. He should already have the CPS software and USB
driver installed.

**How to help:** go one step at a time, plain language, patient. If firmware
ever comes up, **stop and suggest he call Christian (KJ7DTS)** — firmware
mistakes can damage the radio. This folder is downloaded fresh from
**holdenportal.com/878** — that's the normal way updates reach him now.

## The plan in one breath

Connect the radio → open CPS → **Read From Radio first** (backup + confirms
the connection works) → **Tools ▸ Import**, one file at a time, in order:
**TalkGroups → Channel → Zone → Scan List → Hot Key → GPS Roaming** → confirm
the boot picture is still his → **Program ▸ Write to Radio** → test on Parrot.

Import order matters — TalkGroups before Channel (channels reference
talkgroup contacts by name) and before Zone (zones reference channels by
name).

## Gotchas

1. This is the **AT-D878UVII PLUS ("V2" model)**, firmware **V4.00**. Any
   firmware or version-mismatch prompt — stop and call Christian, don't
   attempt a flash yourself.
2. **Back up first** — Read From Radio, save as a dated file.
3. **Never unplug during a Write.**
4. No COM port = driver issue or loose cable — try a different port, re-seat
   the cable.
5. **Never edit these CSVs in Excel** — it silently reformats them (strips
   quoting, drops trailing zeros) even from a plain open-and-close. View in
   Notepad if curious.

## After writing — test

Power cycle → boot picture should still be his. Switch to **PARROT**, hold
PTT ~3 sec, release — hearing his own voice echoed back confirms DMR works.

## When to stop and call Christian

Any firmware/version-mismatch prompt, a Write/Read that fails twice, or
anything that feels different from last time.
""",

    ("kk7ion", "gd168"): """# Helping Chris program his Radioddity GD-168 — context for Claude Code

> **Chris — if you opened this file yourself:** open *this folder* in Claude
> Code and type **"help me program my GD-168."**

## Your job (Claude, read this first)

You're helping **Christopher "Chris" Holden — callsign KK7ION** with his
**Radioddity GD-168** — different programming software from his 878, and a
genuinely more careful procedure. Treat Chris as a beginner on this specific
radio even though he's programmed the 878 before.

**Follow this order exactly — it is not optional.** This radio's CPS has a
confirmed bug: a cold CSV import into a blank/offline session **silently
does nothing** — reports no error, loads nothing. Always start from a real,
populated session — **Read From Radio** — before importing anything. (An
`.rdt` fallback used to ship in this download for when Read From Radio
wasn't possible; it's no longer included, since a stale one is worse than
none — it would silently revert everything to whatever date it was saved.
If Read From Radio genuinely isn't possible, stop and call Christian rather
than opening any `.rdt` file you find elsewhere.)

## What you need that isn't in this download

The CPS software (**GD168 CPS v1.07**) and matching firmware aren't included
— they don't change with the codeplug. **Have Chris ask Christian for
these specifically** — CPS version and firmware version must match exactly,
or imports can fail silently with no error.

## The plan, in order (do NOT skip step 3)

1. Install the CPS software Christian provided.
2. Connect via USB. Check **Settings ▸ Device Info** for firmware version —
   if it doesn't match what Christian gave, stop and call him.
3. **File ▸ Read From Radio** (not File ▸ New). This is what makes the CSV
   import actually work — skipping it is the #1 cause of silent failure.
4. Import CSVs **one at a time, in exactly this order** (not any bulk-import
   option): **RadioIDList → TalkGroups → Zone → ScanList → Channel (last —
   opposite of the 878!) → everything else** (APRS, HotKey, PrefabricatedSMS,
   OptionalSetting, ReceiveGroupCallList, AlertTone, small tone tables).
5. Load the boot picture via CPS's boot-image tool.
6. **Spot-check before writing**: open a couple DMR channels, confirm Color
   Code fields show real numbers, not blank/0 — a bad import leaves these
   silently wrong with no error. If anything looks off, redo step 4.
7. **Program ▸ Write to Radio.** Don't unplug until finished.
8. Test on Parrot.

## Gotchas

1. The silent-import bug is real — "no errors" ≠ "it worked." Always verify
   (step 6) before writing.
2. CPS version must match firmware version, or data can be silently corrupted.
3. Zone names are capped at **16 characters** on this radio (878 allows 20).
4. A field literally labeled **"Send Talker Aias"** is Radioddity's own typo,
   not a mistake in anything Chris is doing.
5. Never edit these CSVs in Excel. Never unplug during a Write.
6. No COM port = driver issue or loose cable.
7. **No GPS on this radio** — `GPSRoaming.CSV` is intentionally empty; GPS is
   an optional module this specific unit doesn't have. Expected, not a bug.

## After writing — test, then browse

Power cycle → boot picture should be his. PARROT test as above. Browse
`878_Zone_Reference.txt` together to get oriented.

## When to stop and call Christian

Getting the CPS/firmware files, any version mismatch, step 6 turning up
anything wrong, a Write/Read failing twice, or anything uncertain — this
radio is less forgiving of guesses than the 878.
""",

    ("kk7ion", "maverick"): """# Helping Chris set up his BridgeCom Maverick D890UV — context for Claude Code

> **Chris — if you opened this file yourself:** open *this folder* in Claude
> Code and type **"help me set up my Maverick."**

## Your job (Claude, read this first) — read the caveat below first

You're helping **Christopher "Chris" Holden — callsign KK7ION** set up a
**BridgeCom Maverick D890UV** mobile radio (a rebadged AnyTone D890UV) — his
**third** radio, different from both the 878 and the GD-168.

**⚠ This conversion has been verified at the CSV/schema level only — channel
counts, field mappings, no data loss — but has NOT yet been tested against
real Maverick CPS software or real hardware.** This is the first-ever
conversion built for this radio model, with no prior working session to
compare against (unlike the GD-168, which now has a proven procedure below).
Go carefully, back up before every step, and if anything behaves
unexpectedly, **stop and have Chris call Christian** rather than guessing —
this is genuinely less charted territory than his other two radios.

## What changed for this radio (so you know what "normal" looks like)

The D890UV's CPS uses a newer schema than the 878's — 13 renamed columns in
`Channel.CSV` (including the DMR contact/TG mapping itself) plus ~21 new
NXDN/MDC1200/Bluetooth/satellite columns, all deliberately left off since
Chris isn't using those features. 17 other files are byte-identical to the
878's. This is expected structure, not something to "fix."

**Not included on purpose:**
- **Boot image** — the 878's boot picture is sized for a small HT screen; the
  D890UV needs its own, correctly sized. Don't drop the 878's `.bmp` in.
- The big USA/Canada digital contact database (available separately from
  holdenportal.com/878 if wanted).

## The plan (same shape as the 878, go section by section)

1. Back up whatever's currently on the radio / in the CPS session first.
2. Import in order: **TalkGroups → Channel → Zone → Scan List → Hot Key.**
3. **Review `OptionalSetting.CSV` by hand in the CPS GUI rather than
   blind-importing it** — it's global settings (backlight, boot behavior)
   that should match this radio's actual physical setup, not get copied
   wholesale from an HT.
4. Write to the radio. Test on Parrot.

## Known, pre-existing, not a bug

14 channels (all under the `RIPP` zone) show `TxCC != RxColorCode` — flagged
during a past audit as unrelated to this or any specific build, carried
through unchanged.

## When to stop and call Christian

Anything that doesn't match what's described here, any import error, or
genuinely any point where you're unsure — there's no prior "this definitely
works" precedent for this specific radio yet.
""",

    ("kk7rbq", "878"): """# Helping Pete update his AnyTone 878 — context for Claude Code

> **Pete — if you opened this file yourself:** open *this folder* in Claude
> Code and type **"help me update my radio."**

## Your job (Claude, read this first)

You're helping **Peter "Pete" Holden — callsign KK7RBQ** load an updated
configuration onto his **AnyTone AT-D878UVII** handheld radio (Prineville
OR — Christian's grandpa). Go one step at a time, plain language, patient.
If firmware ever comes up, **stop and suggest he call Christian (KJ7DTS)**
— firmware mistakes can damage the radio.

This folder is downloaded fresh from **holdenportal.com/878** — that's the
normal way updates reach him.

## The plan in one breath

Connect the radio → open CPS → **Read From Radio first** (backup + confirms
the connection works) → **Tools ▸ Import**, one file at a time, in order:
**TalkGroups → Channel → Zone → Scan List → Hot Key** (no GPS Roaming — this
build doesn't include one for Pete) → confirm the boot picture is still his
→ **Program ▸ Write to Radio** → test on Parrot.

Import order matters — TalkGroups before Channel, both before Zone.

## Gotchas

1. Pete's radio has run on **firmware V3.03** historically — any firmware or
   version-mismatch prompt, stop and call Christian rather than guessing.
2. **Back up first** — Read From Radio, save as a dated file.
3. **Never unplug during a Write.**
4. No COM port = driver issue or loose cable.
5. **Never edit these CSVs in Excel** — it silently reformats them even from
   a plain open-and-close. View in Notepad if curious.

## After writing — test

Power cycle → boot picture should still be his. Switch to **PARROT**, hold
PTT ~3 sec, release — hearing his own voice echoed back confirms DMR works.

## When to stop and call Christian

Any firmware/version-mismatch prompt, a Write/Read that fails twice, or
anything that feels uncertain.
""",

    ("admin", "878"): """# Christian's own AnyTone 878 — reference notes

This is your own master template, packaged the same way everyone else's
download is, mainly so you have a one-click copy independent of digging
through OneDrive. You built this file structure, so the procedure notes
that Chris's and Pete's packages spell out in detail aren't repeated here
in full — the short version: **Read From Radio first, import TalkGroups →
Channel → Zone → Scan List → Hot Key → GPS Roaming, in that order, then
Write.**

The policy section below (naming conventions, the file-chain explanation,
the RX-group example) is the same content every package gets — worth a skim
even for you, since it's regenerated from the live files and will reflect
whatever's actually current, not what you remember building.
""",

    ("admin", "gd168"): """# Christian's own Radioddity GD-168 — reference notes

Your own GD-168 master, packaged for a one-click download. Same shorthand as
your 878 package: **Read From Radio first is mandatory on this radio** (cold
CSV import into a blank session silently no-ops), then import in order
**RadioIDList → TalkGroups → Zone → ScanList → Channel (last) → everything
else.** No GPS Roaming on this radio (this specific unit has no GPS module).

The policy section below applies to you the same as everyone else — it's
generated from the live files, not hand-maintained, so it won't drift out
of sync with what's actually in this download.
""",
}


def build_policy_section(key, radio, callsign, dmr_id, stats):
    rename_rows = "\n".join(f"| `{old}` | `{new}` |" for old, new in RENAME_TABLE)
    return f"""
---

## Your identity on this radio (do not change)

- **Callsign:** {callsign}
- **DMR Radio ID:** {dmr_id}

These are read from your own `RadioIDList.CSV`, `OptionalSetting.CSV`, and
boot screen, and they're what identify you on the air every time you key up.
**Never copy identity fields from someone else's template onto this radio** --
DMR ID, callsign, and boot display text specifically. If those get overwritten
with someone else's, your radio transmits as *them*, not you -- a real FCC
Part 97 identification problem, not a cosmetic bug, and it's exactly the kind
of thing that shows up as a mystery ID on someone else's monitor with no
obvious cause. If a future update ever needs your identity fields touched,
that should only ever be Christian doing it deliberately, never a side effect
of copying "settings" from another radio.

## How the files reference each other

`Channel.CSV` names a `Contact` (e.g. `METRO 2`) and a `Contact TG/DMR ID`
(e.g. `3166`) for every DMR channel. `TalkGroups.CSV` is the master list that
defines what each TG ID is *called*. `ReceiveGroupCallList.CSV` has its own,
separate, pipe-delimited list of contact names -- a channel's Receive Group
List is what other talkgroups it *listens for* while parked on that channel,
and it's built from these same names.

**These three files must agree on the name for a given TG ID, or things go
quietly wrong.** A real example from this codeplug's history: talkgroup 3166
was renamed from the old generic label `LOCAL 2` to PNWDigital's current name
`METRO 2`. The rename script updated `Channel.CSV` and `TalkGroups.CSV` but
missed `ReceiveGroupCallList.CSV` -- so for a while, channels *looked* right
in the channel list, but their receive groups were silently still listening
for a contact name that no longer existed anywhere else in the codeplug. That
kind of gap doesn't throw an error; it just quietly stops receiving traffic
on the affected talkgroup. If you're ever troubleshooting "I can key up but
don't hear anything on a TG I should," a name mismatch across these three
files is a real, previously-confirmed cause to check.

## Naming conventions

Talkgroup labels in this codeplug are kept in sync with PNWDigital's current
live naming, not older/generic names some of them used to have:

| Old (retired) | Current |
|---|---|
{rename_rows}

Channel *names* (e.g. `PB LOCAL2`) are short mnemonic codes and don't
necessarily spell out the full talkgroup name -- that's intentional, not a
naming bug.

## What's safe to change vs. what isn't

- **Personal and generally safe:** which zones you keep, scan list membership,
  hot key assignments, display/backlight/power-on behavior, key press
  durations -- things that only affect how *you* use the radio.
- **Network facts -- don't hand-edit these:** talkgroup IDs, DMR color codes,
  repeater frequencies/offsets, timeslots. These describe how the real
  network is actually configured; changing them locally doesn't change the
  network, it just makes your radio wrong. If a repeater or talkgroup needs a
  correction, that's an upstream fix Christian makes once for everyone, not a
  per-radio edit.
- **Off limits, see above:** DMR ID, callsign, boot text.

## What happens to changes you make yourself

**If you edit this template locally and load it, that's fine for your radio
right now -- but the next time you download an updated codeplug from
holdenportal.com/878, it will overwrite whatever you changed.** The download
always reflects Christian's current shared master, not your last edit. If
you want a change to stick permanently, tell Christian what you want (a
channel, a zone, a setting) rather than just editing your own copy and
expecting it to persist -- otherwise the work quietly disappears the next
time you update.

## Current build

- **{stats['channels']} channels · {stats['zones']} zones · {stats['talkgroups']} talkgroups**
- Source last updated **{stats['updated']}**

(These numbers are generated fresh from the actual files in this download
every time it's built -- if you're reading a stale copy, re-download from
holdenportal.com/878 to get current numbers.)
"""


def generate_claude_md(key, radio, src):
    procedure = PROCEDURES.get((key, radio))
    if procedure is None:
        return None  # no procedure content authored for this (key, radio) yet
    dmr_id, callsign = derive_identity(src)
    stats = derive_stats(src)
    return procedure + build_policy_section(key, radio, callsign, dmr_id, stats)
