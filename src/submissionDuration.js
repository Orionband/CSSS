function parseDbTimestamp(dbTimestamp) {
    return new Date(String(dbTimestamp).replace(' ', 'T') + 'Z').getTime();
}

function elapsedSecondsSince(dbTimestamp) {
    const start = parseDbTimestamp(dbTimestamp);
    return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

module.exports = { parseDbTimestamp, elapsedSecondsSince };
