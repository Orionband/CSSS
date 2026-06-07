const db = require('./database');

function getBestSubmissionsMaps() {
    const rows = db.prepare(`
        WITH ranked AS (
            SELECT user_id, lab_id, score, duration_seconds,
                ROW_NUMBER() OVER (
                    PARTITION BY user_id, lab_id
                    ORDER BY score DESC, COALESCE(duration_seconds, 2147483647) ASC
                ) AS rn
            FROM submissions
            WHERE status = 'completed'
        )
        SELECT user_id, lab_id, score AS max_score, duration_seconds
        FROM ranked
        WHERE rn = 1
    `).all();

    const scoreMap = {};
    const durationMap = {};
    rows.forEach(row => {
        if (!scoreMap[row.user_id]) {
            scoreMap[row.user_id] = {};
            durationMap[row.user_id] = {};
        }
        scoreMap[row.user_id][row.lab_id] = row.max_score;
        if (row.duration_seconds != null) {
            durationMap[row.user_id][row.lab_id] = row.duration_seconds;
        }
    });
    return { scoreMap, durationMap };
}

function getScoreMap() {
    return getBestSubmissionsMaps().scoreMap;
}

function getLeaderboardUserIds(scoreMap) {
    const userIds = new Set(Object.keys(scoreMap).map(Number));
    db.prepare('SELECT id FROM users WHERE score_adjustment != 0 OR withheld != 0').all()
        .forEach(row => userIds.add(row.id));
    return [...userIds];
}

function loadUsersByIds(ids) {
    if (ids.length === 0) return [];
    const users = [];
    const chunkSize = 400;
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const placeholders = chunk.map(() => '?').join(',');
        const rows = db.prepare(
            `SELECT id, username, score_adjustment, withheld FROM users WHERE id IN (${placeholders})`
        ).all(...chunk);
        users.push(...rows);
    }
    return users;
}

function buildEntryForUser(u, allChallenges, labs, quizzes, scoreMap, durationMap) {
    let total = 0;
    let totalTime = 0;
    const scores = {};

    allChallenges.forEach(ch => {
        let hideScore = false;
        if (ch.type === 'quiz') {
            const qCfg = quizzes.find(q => q.id === ch.id);
            if (qCfg && qCfg.show_score === false) hideScore = true;
        } else {
            const lCfg = labs.find(l => l.id === ch.id);
            if (lCfg && lCfg.show_score === false) hideScore = true;
        }

        const score = (scoreMap[u.id] && scoreMap[u.id][ch.id] != null) ? scoreMap[u.id][ch.id] : 0;
        const duration = durationMap[u.id] && durationMap[u.id][ch.id];

        if (hideScore) {
            scores[ch.id] = '?';
        } else {
            scores[ch.id] = score;
            total += score;
            if (duration != null) totalTime += duration;
        }
    });

    if (u.score_adjustment) {
        total += u.score_adjustment;
    }
    if (total < 0) total = 0;

    if (!(total > 0 || Object.values(scores).some(s => s === '?'))) {
        return null;
    }

    if (u.withheld) {
        Object.keys(scores).forEach(k => { scores[k] = 'W'; });
    }

    return {
        username: u.username,
        scores,
        total_score: u.withheld ? 'W' : total,
        total_time_seconds: totalTime > 0 ? totalTime : null,
    };
}

function sortLeaderboard(leaderboard) {
    leaderboard.sort((a, b) => {
        if (a.total_score === 'W' && b.total_score !== 'W') return 1;
        if (a.total_score !== 'W' && b.total_score === 'W') return -1;
        if (a.total_score === 'W' && b.total_score === 'W') return 0;
        if (b.total_score !== a.total_score) return b.total_score - a.total_score;
        const aTime = a.total_time_seconds ?? Number.MAX_SAFE_INTEGER;
        const bTime = b.total_time_seconds ?? Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
    });
    return leaderboard;
}

function buildLeaderboard(cfg) {
    const labs = cfg.labs || [];
    const quizzes = cfg.quizzes || [];
    const allChallenges = [...labs, ...quizzes];
    const { scoreMap, durationMap } = getBestSubmissionsMaps();
    const users = loadUsersByIds(getLeaderboardUserIds(scoreMap));

    const leaderboard = [];
    users.forEach(u => {
        const entry = buildEntryForUser(u, allChallenges, labs, quizzes, scoreMap, durationMap);
        if (entry) leaderboard.push(entry);
    });
    return { allChallenges, leaderboard: sortLeaderboard(leaderboard) };
}

function totalScoreForUser(userId, cfg, maps = null) {
    const { labs, quizzes } = cfg;
    const allChallenges = [...(labs || []), ...(quizzes || [])];
    const { scoreMap, durationMap } = maps || getBestSubmissionsMaps();
    const user = db.prepare('SELECT id, username, score_adjustment, withheld FROM users WHERE id = ?').get(userId);
    if (!user) return 0;
    const entry = buildEntryForUser(user, allChallenges, labs || [], quizzes || [], scoreMap, durationMap);
    if (!entry || entry.total_score === 'W') return entry ? 'W' : 0;
    return entry.total_score;
}

module.exports = {
    buildLeaderboard,
    buildEntryForUser,
    getBestSubmissionsMaps,
    getScoreMap,
    totalScoreForUser,
};
