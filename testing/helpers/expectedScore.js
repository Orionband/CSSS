function expectedMaxScore(lab) {
    return (lab.checks || []).reduce((sum, check) => {
        const pts = parseInt(check.points, 10);
        return pts > 0 ? sum + pts : sum;
    }, 0);
}

function sumAwarded(serverBreakdown) {
    return (serverBreakdown || []).reduce((sum, row) => sum + (row.awarded || 0), 0);
}

/** gradeJob clamps negative totals to zero. */
function clampedTotal(serverBreakdown) {
    return Math.max(0, sumAwarded(serverBreakdown));
}

function positiveChecks(lab) {
    return (lab.checks || []).filter((c) => parseInt(c.points, 10) > 0);
}

function penaltyChecks(lab) {
    return (lab.checks || []).filter((c) => parseInt(c.points, 10) < 0);
}

module.exports = {
    expectedMaxScore,
    sumAwarded,
    clampedTotal,
    positiveChecks,
    penaltyChecks,
};
