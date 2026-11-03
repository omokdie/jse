# OMR evaluation report

Date: 2026-11-03T13:17:32.370Z  ·  corpus: `../../../tmp/pt`  ·  images: 8

| group | n | staff recall | measure count ok | avg |Δmeasures| | note recall | pitch acc | duration acc | rest acc | symbol error rate | time/img |
|---|---|---|---|---|---|---|---|---|---|---|
| dev_clean | 4 | 100.0% | 100.0% | 0.00 | 96.8% | 95.2% | 96.2% | 98.2% | 5.1% | 0.56s |
| dev_photo | 4 | 56.3% | 0.0% | 14.50 | 36.3% | 30.9% | 24.9% | 29.1% | 79.7% | 0.55s |
| ALL | 8 | 78.1% | 50.0% | 7.25 | 66.6% | 63.1% | 60.6% | 63.6% | 42.4% | 0.55s |

## Per image

| image | staves | measures | note recall | pitch | duration | SER | ms |
|---|---|---|---|---|---|---|---|
| 000_mono.png | 4/4 | 20/20 | 93.3% | 93.3% | 92.8% | 8.7% | 819 |
| 001_mono.png | 3/3 | 16/16 | 98.3% | 94.9% | 97.3% | 5.5% | 454 |
| 002_mono.png | 2/2 | 11/11 | 100.0% | 97.1% | 100.0% | 2.6% | 541 |
| 003_bass.png | 7/7 | 52/52 | 96.9% | 95.7% | 96.3% | 4.2% | 410 |
| 000_mono_flat.jpg | 4/4 | 19/20 | 93.3% | 86.7% | 55.1% | 59.4% | 870 |
| 001_mono_curl.jpg | 3/3 | 11/16 | 44.1% | 30.5% | 32.9% | 74.0% | 572 |
| 002_mono_scan.jpg | 2/2 | 10/11 | 94.1% | 79.4% | 78.9% | 26.3% | 351 |
| 003_bass_hard.jpg | 0/7 | 1/52 | 0.0% | 0.0% | 0.0% | 100.0% | 402 |

Metrics: sequences are aligned per staff with edit distance (substitution cost 0.4 for a pitch-or-duration slip, 0.75 for both, 0.95 note↔rest).
pitch acc = GT notes whose aligned note has the identical pitch set / all GT notes; duration acc = GT events whose aligned event has the same kind and duration;
symbol error rate = (substitutions + insertions + deletions) / GT events.
