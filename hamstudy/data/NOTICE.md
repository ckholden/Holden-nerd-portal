# Attribution

The raw question/answer/rule-citation data in `technician.json`, `general.json`,
and `extra.json` is derived from:

**[russolsen/ham_radio_question_pool](https://github.com/russolsen/ham_radio_question_pool)**
Licensed under the [Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0).

That project transcribes the NCVEC (National Conference of Volunteer Examiner
Coordinators) public-domain amateur radio license exam question pools into
machine-readable form. It adds no explanations or commentary of its own.

## What changed from the upstream source

- Reshaped from the upstream per-pool JSON schema into this app's schema
  (`id`, `licenseClass`, `subelement`, `question`, `answers`, `correctIndex`,
  `refs`, `figure`, `explanation`) via `_build_pools.py`.
- All `explanation` fields are original content written for this app — not
  present in and not derived from the upstream source.
- Restored the superscript 2 that the upstream text lost in five Technician
  answer choices: T5C08 C, T5D01 C and D, T5D02 C and D now read I-squared /
  E-squared (U+00B2), as printed in NCVEC's 2026-02-19 Technician PDF
  (checked 2026-10-22).

## Pool versions in use (verified current as of 2026-08-12)

| Class | Pool cycle | Effective through | Questions |
|---|---|---|---|
| Technician (Element 2) | 2026-2030 | Jun 30, 2030 | 409 |
| General (Element 3) | 2023-2027 | Jun 30, 2027 | 423 |
| Extra (Element 4) | 2024-2028 | Jun 30, 2028 | 599 |

Verified ID-by-ID and wording-by-wording against the official NCVEC PDFs —
see `Desktop/radio/_hamstudy_source/VERIFICATION_REPORT.md` for the full
verification methodology and receipts. Recheck ncvec.org's release pages
before this app's next pool refresh; general and extra can still take
another errata round before their cycle ends.
