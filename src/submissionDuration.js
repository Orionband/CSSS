function parseDbTimestamp(dbTimestamp) {
    if (dbTimestamp == null) return NaN;
    const raw = String(dbTimestamp).trim();
    if (!raw) return NaN;
    if (raw.includes('T')) {
        const iso = /[zZ]|[+-]\d{2}:\d{2}$/.test(raw) ? raw : `${raw}Z`;
        return new Date(iso).getTime();
    }
    return new Date(raw.replace(' ', 'T') + 'Z').getTime();
}

function elapsedSecondsSince(dbTimestamp) {
    const start = parseDbTimestamp(dbTimestamp);
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

/** Wall-clock ms for score-over-time charts (stream polls use grade time; finals use start + play time). */
function chartTimeMs(row) {
    const base = parseDbTimestamp(row.timestamp);
    if (row.stream_poll) return base;
    if (row.duration_seconds != null) return base + row.duration_seconds * 1000;
    return base;
}

module.exports = { parseDbTimestamp, elapsedSecondsSince, chartTimeMs };
