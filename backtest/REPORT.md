# Commute risk engine: backtest

Generated 2026-10-20 by `node scripts/commute/backtest.mjs` from `public/data/commute/hotspots.geojson` (100 hotspots) and the engine settings in `src/commute/config.ts`. Rain: Open-Meteo historical archive (reanalysis, CC BY 4.0).

## Read this first

- **The rain is far too low.** The archive is a reanalysis averaged over 9–25 km cells, not a rain gauge. On Bengaluru flood days it holds 2.5–7 times less rain than the gauges the reports quote, and wettest hours of 4–12 mm instead of the 30–60 mm/h the reports describe (PROGRESS.md, "Real storms"). Several parts of the city share one cell, so every hotspot in a cell gets the same rain. The forecast the app uses comes from the same kind of model (ECMWF IFS, ~9 km), which is why the thresholds are in model rain, not gauge rain.
- **The reports are not a list of floods.** "Reported" means a sourced news article names that hotspot on that date. Most waterlogging is never reported, busy and central roads are reported more than the outskirts, and an article usually names a handful of places for a city-wide storm. Many "false alarms" below are probably unreported floods; many "misses" are storms the archive barely shows. Article dates can trail the rain by a day.
- **Few positives.** 170 hotspot-days with a report across 63 report days. One storm more or less changes these numbers a lot.
- **What was fitted.** Only one number: a multiplier on every type threshold (`THRESHOLD_SCALE`), chosen on the training days by the best critical success index (CSI = hits / (hits + misses + false alarms)). Weights, level bands and type thresholds are as committed and were not tuned on these days. The evaluation days were not used for anything.

## Set-up

- **Days:** every date with a sourced report at a hotspot (63 days, 2015-05-16 to 2026-05-29); month-only dates are left out. Plus 44 control days: the date 9 days after a report day, when no report falls within 3 days of it.
- **Split:** report days in date order alternate training / evaluation (32 / 31); a control day goes with its report day.
- **Prediction:** a hotspot-day is predicted when any 30-minute bucket from 12:00 IST the day before to the end of the day is *likely* or *severe* (reports describe the evening or night before as often as the day itself).
- **Rain:** hourly archive precipitation at 10 points (hotspots grouped in 0.1° cells), the 24 h before each window for the antecedent term.
- **Engine:** type thresholds underpass 5, junction 7, service_road 7, flyover_ramp 7, road 8, layout 10 mm/h; level bands watch 0.35, likely 1, severe 2; persist 0.5, antecedent 0.5 at 50 mm, lowness 0.5, history 0.5 at 6 days.

## Threshold scale (training days only)

| scale | precision | recall | false-alarm rate | CSI |
|---|---|---|---|---|
| 0.25 | 2 % | 87 % | 68 % | 0.019 |
| 0.35 | 2 % | 87 % | 63 % | 0.020 |
| 0.5 | 2 % | 82 % | 56 % | 0.021 |
| 0.7 | 2 % | 74 % | 47 % | 0.022 |
| 1 | 3 % | 68 % | 37 % | 0.026 |
| 1.4 (chosen) | 3 % | 57 % | 26 % | 0.031 |
| 2 | 3 % | 30 % | 14 % | 0.029 |

Chosen: **1.4**, so an underpass is flagged from about 7.0 mm/h of archive rain and a road from 11.2 mm/h, before the lowness, history and wet-ground terms lower that further. `config.ts` ships this value.

## Held-out evaluation days

| | hotspot-days | hits | false alarms | misses | precision | recall | false-alarm rate | CSI |
|---|---|---|---|---|---|---|---|---|
| all days, scale 1.4 | 5400 | 49 | 1803 | 44 | 3 % | 53 % | 34 % | 0.026 |
| report days only, scale 1.4 | 3100 | 49 | 1414 | 44 | 3 % | 53 % | 47 % | 0.033 |
| control days only, scale 1.4 | 2300 | 0 | 389 | 0 | 0 % | – | 17 % | 0.000 |
| all days, scale 1 (no fitting) | 5400 | 61 | 2483 | 32 | 2 % | 66 % | 47 % | 0.024 |

Day level, held-out days: how often the engine flags anything, and how many hotspots, on days with and without reports.

| days | n | mean archive rain in the 36 h window, wettest point (mm) | days with any hotspot likely or severe | mean hotspots flagged | days where a reported hotspot was flagged |
|---|---|---|---|---|---|
| report | 31 | 25.1 | 25 (81 %) | 47.2 of 100 | 17 (55 %) |
| control | 23 | 11.9 | 10 (43 %) | 16.9 of 100 | – |

Per type, held-out days, scale 1.4:

| | hotspot-days | hits | false alarms | misses | precision | recall | false-alarm rate | CSI |
|---|---|---|---|---|---|---|---|---|
| flyover_ramp | 324 | 5 | 108 | 3 | 4 % | 63 % | 34 % | 0.043 |
| junction | 972 | 9 | 377 | 11 | 2 % | 45 % | 40 % | 0.023 |
| layout | 1296 | 9 | 297 | 12 | 3 % | 43 % | 23 % | 0.028 |
| road | 1998 | 14 | 629 | 10 | 2 % | 58 % | 32 % | 0.021 |
| underpass | 810 | 12 | 392 | 8 | 3 % | 60 % | 50 % | 0.029 |

## Gauge-scaled variant

The four storms in `src/weather.ts` with a reported gauge total (2024-10-20..2024-10-22 190 mm KSNDMC Yelahanka; 2022-09-04..2022-09-06 131 mm IMD Bengaluru city; 2022-05-17..2022-05-18 114 mm IMD Bengaluru; 2017-08-14..2017-08-16 144 mm IMD HAL airport): the archive hours of each storm are scaled so the storm totals the gauge reading, at every hotspot (one gauge stands for the whole city, and the hours keep the archive's smeared shape: our adjustment, not observed rain). Same days, all splits (8 days):

| | hotspot-days | hits | false alarms | misses | precision | recall | false-alarm rate | CSI |
|---|---|---|---|---|---|---|---|---|
| archive rain, scale 1.4 | 800 | 23 | 460 | 7 | 5 % | 77 % | 60 % | 0.047 |
| gauge-scaled rain, scale 1.4 | 800 | 30 | 770 | 0 | 4 % | 100 % | 100 % | 0.037 |
| gauge-scaled rain, scale 1 | 800 | 30 | 770 | 0 | 4 % | 100 % | 100 % | 0.037 |
| gauge-scaled rain, thresholds x 4 (archive-to-gauge factor, not fitted) | 800 | 23 | 543 | 7 | 4 % | 77 % | 71 % | 0.040 |

The thresholds are in model rain. On rain scaled up to the gauge totals they flag 100 % of the reported and 100 % of the unreported hotspot-days. Raised by the archive-to-gauge factor (4, the middle of the 2.5-7x range, fixed before looking) they flag 77 % and 71 %: on city-wide storm days like these the rule still flags most places, and most of those false alarms are probably unreported floods. These 8 days cannot tell a good rule from a bad one; they show that the rain input, not the rule, sets the miss rate.

| date | kind | split | archive 36 h max (mm) | wettest hour (mm) | reported | predicted | both | gauge-scaled: predicted | both |
|---|---|---|---|---|---|---|---|---|---|
| 2017-08-15 | report | test | 20.5 | 6.0 | 1 | 15 | 0 | 100 | 1 |
| 2022-05-17 | report | test | 47.5 | 10.8 | 1 | 87 | 1 | 100 | 1 |
| 2022-05-18 | report | train | 39.4 | 10.8 | 1 | 89 | 1 | 100 | 1 |
| 2022-09-04 | report | train | 22.5 | 9.7 | 2 | 41 | 2 | 100 | 2 |
| 2022-09-05 | report | test | 33.3 | 9.7 | 9 | 44 | 8 | 100 | 9 |
| 2022-09-06 | report | train | 29.7 | 14.2 | 1 | 66 | 0 | 100 | 1 |
| 2024-10-20 | report | train | 38.2 | 10.4 | 6 | 72 | 5 | 100 | 6 |
| 2024-10-21 | report | test | 31.7 | 10.4 | 9 | 69 | 6 | 100 | 9 |

## Every day (held-out and training), chosen scale

"archive 36 h" and "wettest hour" are the wettest archive point in the window. "predicted" = hotspots flagged likely or severe, "both" = flagged and reported.

| date | kind | split | archive 36 h max (mm) | wettest hour (mm) | reported | predicted | both |
|---|---|---|---|---|---|---|---|
| 2015-05-16 | report | train | 34.9 | 10.0 | 1 | 100 | 1 |
| 2015-05-25 | control | train | 0.6 | 0.4 | 0 | 0 | 0 |
| 2017-08-15 | report | test | 20.5 | 6.0 | 1 | 15 | 0 |
| 2017-08-24 | control | test | 21.1 | 10.5 | 0 | 67 | 0 |
| 2017-09-09 | report | train | 53.6 | 9.9 | 4 | 82 | 4 |
| 2017-09-18 | control | train | 11.8 | 4.8 | 0 | 11 | 0 |
| 2017-09-25 | report | test | 35.2 | 15.1 | 2 | 79 | 2 |
| 2017-09-26 | report | train | 30.2 | 15.1 | 6 | 35 | 2 |
| 2017-10-05 | report | test | 18.6 | 9.2 | 1 | 5 | 0 |
| 2017-10-08 | report | train | 14.4 | 2.6 | 1 | 0 | 0 |
| 2017-10-13 | report | test | 39.6 | 11.9 | 4 | 99 | 4 |
| 2017-10-17 | control | train | 6.2 | 4.0 | 0 | 2 | 0 |
| 2017-10-22 | control | test | 0.6 | 0.3 | 0 | 0 | 0 |
| 2018-06-02 | report | train | 32.2 | 10.1 | 1 | 86 | 1 |
| 2018-06-11 | control | train | 10.3 | 7.4 | 0 | 3 | 0 |
| 2018-09-24 | report | test | 39.4 | 8.9 | 3 | 74 | 1 |
| 2018-10-03 | control | test | 4.9 | 3.1 | 0 | 0 | 0 |
| 2020-04-30 | report | train | 0.3 | 0.3 | 2 | 0 | 0 |
| 2020-05-09 | control | train | 0.0 | 0.0 | 0 | 0 | 0 |
| 2020-09-08 | report | test | 25.8 | 12.3 | 1 | 56 | 0 |
| 2020-09-09 | report | train | 33.7 | 12.3 | 1 | 56 | 0 |
| 2020-09-10 | report | test | 42.3 | 7.4 | 2 | 85 | 1 |
| 2020-09-17 | control | test | 20.2 | 8.1 | 0 | 62 | 0 |
| 2020-09-18 | control | train | 20.8 | 5.4 | 0 | 11 | 0 |
| 2020-09-19 | control | test | 24.7 | 5.4 | 0 | 11 | 0 |
| 2020-10-20 | report | train | 15.5 | 3.6 | 1 | 0 | 0 |
| 2020-10-21 | report | test | 27.4 | 5.0 | 3 | 23 | 1 |
| 2020-10-23 | report | train | 22.3 | 5.1 | 4 | 2 | 0 |
| 2020-10-29 | control | train | 0.6 | 0.3 | 0 | 0 | 0 |
| 2020-10-30 | control | test | 0.6 | 0.3 | 0 | 0 | 0 |
| 2020-11-01 | control | train | 1.7 | 0.4 | 0 | 0 | 0 |
| 2021-10-04 | report | test | 5.6 | 1.8 | 1 | 0 | 0 |
| 2021-10-13 | control | test | 30.7 | 4.9 | 0 | 15 | 0 |
| 2021-11-15 | report | train | 43.8 | 10.6 | 4 | 84 | 3 |
| 2021-11-21 | report | test | 26.8 | 7.3 | 1 | 29 | 0 |
| 2021-11-22 | report | train | 26.7 | 6.8 | 1 | 25 | 1 |
| 2021-11-30 | control | test | 6.0 | 1.4 | 0 | 0 | 0 |
| 2021-12-01 | control | train | 3.4 | 0.8 | 0 | 0 | 0 |
| 2022-04-14 | report | test | 20.2 | 13.8 | 1 | 91 | 1 |
| 2022-04-23 | control | test | 0.0 | 0.0 | 0 | 0 | 0 |
| 2022-05-10 | report | train | 8.5 | 3.9 | 1 | 0 | 0 |
| 2022-05-17 | report | test | 47.5 | 10.8 | 1 | 87 | 1 |
| 2022-05-18 | report | train | 39.4 | 10.8 | 1 | 89 | 1 |
| 2022-05-26 | control | test | 7.9 | 4.2 | 0 | 0 | 0 |
| 2022-05-27 | control | train | 6.9 | 4.2 | 0 | 0 | 0 |
| 2022-08-31 | report | test | 11.1 | 5.6 | 2 | 8 | 0 |
| 2022-09-04 | report | train | 22.5 | 9.7 | 2 | 41 | 2 |
| 2022-09-05 | report | test | 33.3 | 9.7 | 9 | 44 | 8 |
| 2022-09-06 | report | train | 29.7 | 14.2 | 1 | 66 | 0 |
| 2022-09-13 | control | train | 2.6 | 1.1 | 0 | 0 | 0 |
| 2022-09-14 | control | test | 4.9 | 2.0 | 0 | 0 | 0 |
| 2022-09-15 | control | train | 3.3 | 2.0 | 0 | 0 | 0 |
| 2023-05-08 | report | test | 28.0 | 17.9 | 1 | 100 | 1 |
| 2023-05-17 | control | test | 0.2 | 0.1 | 0 | 0 | 0 |
| 2023-05-21 | report | train | 12.3 | 9.4 | 1 | 43 | 1 |
| 2023-05-26 | report | test | 5.1 | 4.2 | 1 | 0 | 0 |
| 2023-05-30 | report | train | 37.6 | 10.8 | 2 | 84 | 2 |
| 2023-05-31 | report | test | 50.6 | 10.8 | 3 | 84 | 3 |
| 2023-06-04 | control | test | 0.9 | 0.7 | 0 | 0 | 0 |
| 2023-06-08 | control | train | 0.2 | 0.2 | 0 | 0 | 0 |
| 2023-06-12 | report | train | 15.3 | 11.5 | 2 | 87 | 2 |
| 2023-06-13 | report | test | 19.0 | 11.5 | 6 | 87 | 5 |
| 2023-06-16 | report | train | 0.2 | 0.2 | 1 | 0 | 0 |
| 2023-06-20 | report | test | 26.7 | 8.6 | 7 | 72 | 6 |
| 2023-06-25 | control | train | 4.4 | 1.8 | 0 | 0 | 0 |
| 2023-06-29 | control | test | 15.3 | 9.3 | 0 | 60 | 0 |
| 2023-10-09 | report | train | 35.7 | 8.6 | 2 | 85 | 2 |
| 2023-10-18 | control | train | 0.3 | 0.2 | 0 | 0 | 0 |
| 2023-11-07 | report | test | 35.6 | 8.6 | 7 | 81 | 5 |
| 2023-11-16 | control | test | 1.5 | 0.6 | 0 | 0 | 0 |
| 2024-05-03 | report | train | 3.0 | 1.6 | 1 | 0 | 0 |
| 2024-05-04 | report | test | 9.7 | 4.0 | 6 | 0 | 0 |
| 2024-05-12 | control | train | 8.7 | 5.3 | 0 | 10 | 0 |
| 2024-05-13 | control | test | 14.9 | 5.9 | 0 | 18 | 0 |
| 2024-08-06 | report | train | 16.9 | 7.1 | 2 | 3 | 0 |
| 2024-08-12 | report | test | 7.4 | 3.3 | 2 | 0 | 0 |
| 2024-08-21 | control | test | 41.9 | 20.6 | 0 | 68 | 0 |
| 2024-10-05 | report | train | 27.2 | 6.5 | 2 | 17 | 0 |
| 2024-10-06 | report | test | 8.6 | 2.6 | 6 | 0 | 0 |
| 2024-10-15 | report | train | 55.5 | 7.6 | 4 | 44 | 4 |
| 2024-10-16 | report | test | 34.4 | 7.6 | 1 | 50 | 1 |
| 2024-10-20 | report | train | 38.2 | 10.4 | 6 | 72 | 5 |
| 2024-10-21 | report | test | 31.7 | 10.4 | 9 | 69 | 6 |
| 2024-10-23 | report | train | 56.3 | 10.1 | 2 | 84 | 2 |
| 2024-10-31 | report | test | 5.0 | 3.7 | 1 | 1 | 0 |
| 2024-11-09 | control | test | 0.0 | 0.0 | 0 | 0 | 0 |
| 2025-03-26 | report | train | 0.0 | 0.0 | 3 | 0 | 0 |
| 2025-04-04 | control | train | 10.6 | 4.5 | 0 | 3 | 0 |
| 2025-04-17 | report | test | 15.1 | 10.7 | 1 | 48 | 0 |
| 2025-04-26 | control | test | 0.0 | 0.0 | 0 | 0 | 0 |
| 2025-05-13 | report | train | 12.5 | 5.8 | 1 | 7 | 0 |
| 2025-05-16 | report | test | 6.8 | 4.3 | 4 | 0 | 0 |
| 2025-05-19 | report | train | 24.7 | 8.5 | 10 | 77 | 9 |
| 2025-05-20 | report | test | 28.1 | 8.5 | 2 | 80 | 2 |
| 2025-05-21 | report | train | 16.6 | 7.9 | 3 | 71 | 2 |
| 2025-05-25 | control | test | 11.8 | 3.0 | 0 | 0 | 0 |
| 2025-05-28 | control | train | 7.7 | 3.9 | 0 | 0 | 0 |
| 2025-05-29 | control | test | 13.3 | 4.4 | 0 | 4 | 0 |
| 2025-05-30 | control | train | 11.0 | 4.4 | 0 | 4 | 0 |
| 2025-07-14 | report | test | 19.3 | 6.0 | 3 | 4 | 0 |
| 2025-07-23 | control | test | 15.8 | 4.5 | 0 | 5 | 0 |
| 2025-09-03 | report | train | 19.2 | 8.6 | 1 | 7 | 0 |
| 2025-09-12 | control | train | 0.9 | 0.3 | 0 | 0 | 0 |
| 2025-10-10 | report | test | 52.8 | 14.8 | 1 | 92 | 1 |
| 2025-10-19 | control | test | 37.0 | 7.9 | 0 | 79 | 0 |
| 2026-05-29 | report | train | 4.1 | 1.4 | 3 | 0 | 0 |
| 2026-06-07 | control | train | 4.1 | 1.2 | 0 | 0 | 0 |

## What this says

- On held-out days the engine flags 53 % of the reported hotspot-days, and 3 % of its flags have a report (false-alarm rate 34 % of unreported hotspot-days). With archive rain this low, a level from the forecast is a weak signal; treat it as "rain near the level that has flooded this place before", which is how the app words it.
- Day level: on held-out report days something is flagged on 81 % of days (47 hotspots on average), on control days on 43 % (17). The engine separates storm days from quieter ones, but it flags many more places than the news names, and 14 of 31 report days had none of their reported hotspots flagged.
- The gauge-scaled rows show how much of the miss rate is the rain input rather than the rule: with storm totals at gauge level every reported hotspot is flagged, and so is everything else.
- Per-type numbers rest on very few reports each; differences between types are not meaningful yet.
- To do better: an hourly gauge or radar source (KSNDMC telemetry is neither open nor keyless), more dated reports (especially "no flooding" days), and per-hotspot thresholds once a place has several reports with known rain.
