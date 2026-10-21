| Field | seed 42 (10,000 rows) | seed 7 (10,000 rows) |
|---|---:|---:|
| Price → integer cents (rows with a price) | 100.00% (9700/9700) | 100.00% (9745/9745) |
| Missing price flagged, never guessed | 100.00% (224/224) | 100.00% (184/184) |
| Currency | 100.00% (9700/9700) | 100.00% (9745/9745) |
| Weight → grams (±1%) | 100.00% (9980/9980) | 100.00% (9980/9980) |
| Colour (typos, German, mojibake) | 100.00% (9980/9980) | 100.00% (9980/9980) |
| Size | 100.00% (9980/9980) | 100.00% (9980/9980) |
| Row language (EN/DE/FR) | 98.52% (9832/9980) | 98.88% (9868/9980) |
| Unsafe HTML removed | 100.00% (1178/1178) | 100.00% (1205/1205) |
| Empty rows → Failed | 100.00% (20/20) | 100.00% (20/20) |
| Grouping purity (one product per group) | 100.00% (3237/3237) | 100.00% (3275/3275) |
| Grouping completeness (one group per product) | 100.00% (3237/3237) | 100.00% (3275/3275) |
| Conflicting duplicate rows flagged | 100.00% (56/56) | 100.00% (48/48) |
| Fuzzy duplicate products flagged | 100.00% (33/33) | 96.30% (26/27) |

Examples of misses:
- duplicateDetection (seed 7): P:tpx2790: "Kestrel Terrace Edition Terracotta Pot terracotta S"
