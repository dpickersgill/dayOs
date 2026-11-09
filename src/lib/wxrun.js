'use strict';

// The weather breaker, one per job run (2026.11.15 review). The daily job's day records, its morning snapshots and the
// morning brief all ask Open-Meteo, and each lookup can wait its full timeout (WEATHER_TIMEOUT_MS, 10 seconds) when the
// service hangs. A run carries one of these: after WX_BREAKER failed lookups the rest of the run does not ask again, and
// the brief remembers each mountain's forecast for the run (asked once for the operations, patrol and school briefs,
// and a failure is remembered too). The daily job hands the same run to all three stages.
const WX_BREAKER = 3;

/** A new run: { wxFailed, forecasts } (forecasts: the brief's per-mountain forecast for this run). */
const newRun = () => ({ wxFailed: 0, forecasts: new Map() });
/** True when this run has stopped asking for weather. */
const down = (run) => Boolean(run && run.wxFailed >= WX_BREAKER);
/** One failed lookup. */
const failed = (run) => { if (run) run.wxFailed += 1; };

module.exports = { WX_BREAKER, newRun, down, failed };
