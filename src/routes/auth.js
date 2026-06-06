const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const { sanitizeUsername, sanitizeEmail, MAX_FIELD_LEN } = require('../sanitizeUserFields');
const { validatePasswordPolicy } = require('../passwordPolicy');
const { parsePagination, MAX_LEADERBOARD, rateLimitPreset, getConfigNumber, ensureArray } = require('../limits');
const { buildLeaderboard } = require('../leaderboardScores');
const { elapsedSecondsSince } = require('../submissionDuration');
const { getConfig, isWindowOpen } = require('../config');
const router = express.Router();
const { customAlphabet } = require('nanoid');
const rateLimit = require('express-rate-limit');

function generateUniqueId() { 
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const nanoid = customAlphabet(alphabet, 12);
    const id = nanoid();
    return id.match(/.{1,4}/g).join('-');
}

const DUMMY_HASH = bcrypt.hashSync('__dummy_timing_safe_value_never_matches__', 10);

const registerLimiter = rateLimit(rateLimitPreset({ windowMs: 24 * 60 * 60 * 1000, max: 10 }));
const loginLimiter = rateLimit(rateLimitPreset({ windowMs: 5 * 60 * 1000, max: 5 }));
const csrfLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const leaderboardLimiter = rateLimit(rateLimitPreset({ windowMs: 10 * 1000, max: 5 }));
const historyLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const labInfoLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const labStartLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 10 }));
const downloadLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 10 }));
const configLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const bootstrapLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const meLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));

function envBool(name, defaultValue = false) {
    const val = process.env[name];
    if (val === undefined || val === null || String(val).trim() === '') return defaultValue;
    return String(val).trim().toLowerCase() === 'true';
}

function ensureCsrfToken(req) {
    if (!req.session) return null;
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrfToken;
}

router.get('/csrf-token', csrfLimiter, (req, res) => {
    if (!req.session) return res.status(500).json({ error: "Session unavailable" });
    res.json({ csrfToken: ensureCsrfToken(req) });
});

router.post('/register', registerLimiter, async (req, res) => {
    if (!envBool('ALLOW_REGISTRATION', false)) {
        return res.status(403).json({ error: "Registration is currently disabled by the administrator." });
    }

    const { username, email, password } = req.body;
    
    if (!username || !email || password === undefined || password === null) {
        return res.status(400).json({ error: "Missing fields" });
    }
    
    const pwd = String(password);
    const userStr = sanitizeUsername(username);
    const emailStr = sanitizeEmail(email);

    if (!userStr || !emailStr) {
        return res.status(400).json({ error: "Invalid username or email. Use ASCII letters, numbers, and . _ - for usernames." });
    }

    const pwdCheck = validatePasswordPolicy(pwd);
    if (!pwdCheck.ok) {
        return res.status(400).json({ error: pwdCheck.error });
    }

    try {
        const hashedPassword = await bcrypt.hash(pwd, 10);
        const uid = generateUniqueId();
        const stmt = db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)');
        const info = stmt.run(userStr, emailStr, hashedPassword, uid);
        req.session.regenerate((err) => {
            if (err) return res.status(500).json({ error: "Registration failed. Please try again." });
            req.session.userId = info.lastInsertRowid;
            req.session.uniqueId = uid;
            req.session.authenticatedAt = Date.now();
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ error: "Session save failed." });
                res.json({ success: true, unique_id: uid, csrfToken: req.session.csrfToken });
            });
        });
    } catch (err) {
        res.status(400).json({ error: "Registration failed. Please try different details." });
    }
});

router.post('/logout', (req, res) => {
    const userId = req.session && req.session.userId;
    req.session.destroy(err => {
        res.clearCookie('connect.sid'); 
        if (userId && global.activeUserSockets) {
            const userSockets = global.activeUserSockets.get(userId);
            if (userSockets) {
                userSockets.forEach(s => s.disconnect(true));
            }
        }
        res.json({ success: true });
    });
});

router.post('/login', loginLimiter, async (req, res) => {
    try {
        const { username, password } = req.body;
        const userStr = sanitizeUsername(username);
        if (!userStr) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(userStr);
        const hashToCompare = user ? user.password : DUMMY_HASH;
        
        const pwd = password !== undefined && password !== null ? String(password) : "";
        if (pwd.length > 100) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const passwordMatch = await bcrypt.compare(pwd, hashToCompare);

        if (!user || !passwordMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: "Login failed. Please try again." });
            req.session.userId = user.id;
            req.session.uniqueId = user.unique_id;
            req.session.authenticatedAt = Date.now();
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ error: "Session save failed." });
                res.json({ success: true, unique_id: user.unique_id, csrfToken: req.session.csrfToken });
            });
        });
    } catch (err) {
        res.status(500).json({ error: "Login failed. Please try again." });
    }
});

router.get('/me', meLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in" });
    const user = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(req.session.userId);
    res.json({
        id: req.session.userId,
        unique_id: req.session.uniqueId,
        is_admin: user && user.is_admin === 1,
        is_owner: user && user.is_owner === 1,
    });
});

function appOptions() {
    const fullTitle = process.env.APP_TITLE || 'CSSS ENGINE';
    const parts = fullTitle.split(' ');
    return {
        show_leaderboard: envBool('SHOW_LEADERBOARD'),
        show_history: envBool('SHOW_HISTORY'),
        app_title: fullTitle,
        app_title_main: parts[0] || '',
        app_title_highlight: parts.slice(1).join(' ') || '',
    };
}

function labMaxPoints(lab) {
    return ensureArray(lab.checks).reduce((sum, c) => {
        const p = parseInt(c.points, 10);
        return sum + (Number.isFinite(p) && p > 0 ? p : 0);
    }, 0);
}

function quizMaxPoints(quiz) {
    return ensureArray(quiz.questions).reduce((sum, q) => {
        const p = q.points !== undefined ? parseInt(q.points, 10) : 1;
        return sum + (Number.isFinite(p) && p > 0 ? p : 0);
    }, 0);
}

function buildChallengeList(cfg) {
    const safeLabs = (cfg.labs || []).filter(l => isWindowOpen(l)).map(l => ({
        id: l.id,
        title: l.title,
        type: 'lab',
        points: labMaxPoints(l),
    }));

    const safeQuizzes = (cfg.quizzes || []).filter(q => isWindowOpen(q)).map(q => ({
        id: q.id,
        title: q.title,
        type: 'quiz',
        points: quizMaxPoints(q),
    }));

    return [...safeLabs, ...safeQuizzes];
}

router.get('/config', configLimiter, (req, res) => {
    const cfg = getConfig();
    const isAuthenticated = req.session && req.session.userId;
    res.json({
        challenges: isAuthenticated ? buildChallengeList(cfg) : [],
        options: appOptions(),
    });
});

router.get('/bootstrap', bootstrapLimiter, (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    const user = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(req.session.userId);
    const cfg = getConfig();

    res.json({
        user: {
            id: req.session.userId,
            unique_id: req.session.uniqueId,
            is_admin: user && user.is_admin === 1,
            is_owner: user && user.is_owner === 1,
        },
        csrfToken: ensureCsrfToken(req),
        challenges: buildChallengeList(cfg),
        options: appOptions(),
    });
});

router.get('/lab/:id', labInfoLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    
    const cfg = getConfig();
    const lab = (cfg.labs || []).find(l => l.id === req.params.id);
    if (!lab || !isWindowOpen(lab)) {
        return res.status(404).json({ error: "Lab not found." });
    }

    const totalAttempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?')
        .get(req.session.userId, lab.id).c;
    
    const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
        .get(req.session.userId, lab.id);

    let timeRemaining = null;
    let sessionActive = false;

    const timeLimitMinutes = getConfigNumber(lab.time_limit_minutes, 0);

    if (activeSession) {
        sessionActive = true;
        if (timeLimitMinutes > 0) {
            const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            timeRemaining = Math.max(0, (timeLimitMinutes * 60) - elapsed);
            
            if (timeRemaining <= 0) {
                const durationSeconds = elapsedSecondsSince(activeSession.timestamp);
                db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ?")
                    .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), durationSeconds, activeSession.id);
                sessionActive = false;
                timeRemaining = null;
            }
        }
    }

    res.json({
        id: lab.id,
        title: lab.title,
        max_submissions: getConfigNumber(lab.max_submissions, 0),
        attempts_taken: totalAttempts,
        time_limit_minutes: timeLimitMinutes,
        has_pka_file: !!lab.pka_file,
        session_active: sessionActive,
        time_remaining_seconds: timeRemaining
    });
});

router.post('/lab/:id/start', labStartLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const lab = (cfg.labs || []).find(l => l.id === req.params.id);
    if (!lab) return res.status(404).json({ error: "Lab not found." });

    if (!isWindowOpen(lab)) {
        return res.status(403).json({ error: "Lab is currently closed outside of the competition window." });
    }

    const timeLimitMinutes = getConfigNumber(lab.time_limit_minutes, 0);
    const maxSubmissions = getConfigNumber(lab.max_submissions, 0);

    const startSession = db.transaction(() => {
        const existing = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
            .get(req.session.userId, lab.id);

        if (existing) {
            let timeRemaining = null;
            if (timeLimitMinutes > 0) {
                const startTime = new Date(existing.timestamp.replace(' ', 'T') + 'Z').getTime();
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                timeRemaining = Math.max(0, (timeLimitMinutes * 60) - elapsed);

                if (timeRemaining <= 0) {
                    const durationSeconds = elapsedSecondsSince(existing.timestamp);
                    db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ?")
                        .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), durationSeconds, existing.id);
                    return { error: "Your previous session has expired.", code: 403 };
                }
            }

            return { resumed: true, timeRemaining };
        }

        if (maxSubmissions > 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?')
                .get(req.session.userId, lab.id).c;
            if (count >= maxSubmissions) {
                return { error: "Maximum attempts reached.", code: 403 };
            }
        }

        db.prepare("INSERT INTO submissions (user_id, unique_id, lab_id, status, type) VALUES (?, ?, ?, 'in_progress', 'lab')")
            .run(req.session.userId, req.session.uniqueId, lab.id);

        let timeRemaining = null;
        if (timeLimitMinutes > 0) {
            timeRemaining = timeLimitMinutes * 60;
        }

        return { resumed: false, timeRemaining };
    });

    try {
        const result = startSession();
        if (result.error) return res.status(result.code).json({ error: result.error });

        res.json({
            success: true,
            resumed: result.resumed,
            has_pka_file: !!lab.pka_file,
            time_remaining_seconds: result.timeRemaining
        });
    } catch (err) {
        res.status(500).json({ error: "An internal error occurred." });
    }
});

router.get('/lab/:id/download', downloadLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).send("Unauthorized");

    const cfg = getConfig();
    const lab = (cfg.labs || []).find(l => l.id === req.params.id);
    if (!lab) return res.status(404).send("Lab not found.");
    if (!lab.pka_file) return res.status(404).send("No PKA file configured for this lab.");

    if (!isWindowOpen(lab)) {
        return res.status(403).send("Forbidden: Competition window has closed.");
    }

    const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
        .get(req.session.userId, lab.id);

    if (!activeSession) {
        return res.status(403).send("Forbidden: No active lab session. Start the lab first.");
    }

    const timeLimitMinutes = getConfigNumber(lab.time_limit_minutes, 0);
    if (timeLimitMinutes > 0) {
        const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed > (timeLimitMinutes * 60)) {
            db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ?, duration_seconds = ? WHERE id = ?")
                .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), elapsed, activeSession.id);
            return res.status(403).send("Forbidden: Lab session has expired.");
        }
    }

    const safeFilename = path.basename(lab.pka_file);
    if (/[/\\:\0]/.test(safeFilename) || safeFilename.startsWith('.')) {
        return res.status(400).send("Invalid file configuration.");
    }

    // Resolve baseDir canonically so the containment check compares real paths on both sides
    let baseDir;
    try {
        baseDir = fs.realpathSync(path.join(__dirname, '../../protected/pka'));
    } catch (e) {
        return res.status(500).send("Server configuration error.");
    }

    // realpathSync follows all symlinks to the final target; throws if path doesn't exist.
    // The containment check then compares two canonical paths, closing the symlink traversal gap.
    let filePath;
    try {
        filePath = fs.realpathSync(path.join(baseDir, safeFilename));
    } catch (e) {
        return res.status(404).send("File not found.");
    }

    if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) {
        return res.status(403).send("Forbidden.");
    }

    try {
        // statSync (not lstatSync) — realpathSync already resolved any symlinks above
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) return res.status(404).send("File not found.");
    } catch (e) {
        return res.status(404).send("File not found.");
    }

    res.download(filePath, safeFilename);
});

router.get('/leaderboard', leaderboardLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    if (!envBool('SHOW_LEADERBOARD')) {
        return res.status(403).json({ error: "Leaderboard disabled" });
    }

    const cfg = getConfig();
    const { allChallenges, leaderboard: fullBoard } = buildLeaderboard(cfg);
    const truncated = fullBoard.length > MAX_LEADERBOARD;
    const leaderboard = truncated ? fullBoard.slice(0, MAX_LEADERBOARD) : fullBoard;

    const headers = allChallenges.map(c => ({ id: c.id, title: c.title }));
    res.json({ success: true, labs: headers, leaderboard, truncated, total_entries: fullBoard.length });
});

function formatHistoryRow(sub, cfg) {
    let showScore = true;
    let showDetails = true;
    let showMissed = false;
    const type = sub.type || 'lab';

    if (type === 'quiz') {
        const qCfg = (cfg.quizzes || []).find(q => q.id === sub.lab_id);
        showScore = qCfg ? (qCfg.show_score !== false) : true;
        showDetails = qCfg ? (qCfg.show_corrections !== false) : true;
        showMissed = qCfg ? (qCfg.show_missed_points === true) : false;
    } else {
        const lCfg = (cfg.labs || []).find(l => l.id === sub.lab_id);
        showScore = lCfg ? (lCfg.show_score !== false) : true;
        showDetails = lCfg ? (lCfg.show_check_messages !== false) : true;
        showMissed = lCfg ? (lCfg.show_missed_points === true) : false;
    }

    let details = [];
    try { details = JSON.parse(sub.details); } catch (e) { /* ignore */ }
    if (!Array.isArray(details)) details = [];

    let clientDetails = null;
    if (showDetails) {
        if (type === 'quiz') {
            clientDetails = details.filter(item => item.correct || showMissed);
        } else {
            clientDetails = details.filter(item => item.passed !== false || showMissed).map(item => ({
                message: item.message,
                points: item.awarded,
                passed: item.passed,
                device: item.device,
                context: item.context
            }));
        }
    }

    return {
        id: sub.id,
        lab_id: sub.lab_id,
        type: type,
        score: showScore ? sub.score : null,
        max_score: showScore ? sub.max_score : null,
        timestamp: sub.timestamp,
        duration_seconds: sub.duration_seconds,
        details: clientDetails
    };
}

router.get('/history', historyLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in" });
    if (!envBool('SHOW_HISTORY')) return res.status(403).json({ error: "History disabled" });

    const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
    const userId = req.session.userId;
    const cfg = getConfig();

    const { total } = db.prepare(
        "SELECT COUNT(*) as total FROM submissions WHERE user_id = ? AND status = 'completed'"
    ).get(userId);

    const submissions = db.prepare(
        "SELECT id, lab_id, score, max_score, timestamp, details, type, duration_seconds FROM submissions WHERE user_id = ? AND status = 'completed' ORDER BY id DESC LIMIT ? OFFSET ?"
    ).all(userId, limit, offset);

    const history = submissions.map(sub => formatHistoryRow(sub, cfg));
    const hasMore = offset + history.length < total;

    res.json({ success: true, history, total, limit, offset, hasMore });
});

module.exports = router;