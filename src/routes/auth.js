const express = require('express');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const db = require('../database');
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

const registerLimiter = rateLimit({ windowMs: 24*60*60*1000, max: 10, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 5*60*1000, max: 5, standardHeaders: true, legacyHeaders: false });
const csrfLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const leaderboardLimiter = rateLimit({ windowMs: 10 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });

router.get('/csrf-token', csrfLimiter, (req, res) => {
    if (!req.session) return res.status(500).json({ error: "Session unavailable" });
    if (!req.session.csrfToken) {
        const crypto = require('crypto');
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    res.json({ csrfToken: req.session.csrfToken });
});

router.post('/register', registerLimiter, async (req, res) => {
    if (process.env.ALLOW_REGISTRATION === 'false') {
        return res.status(403).json({ error: "Registration is currently disabled by the administrator." });
    }

    const cfg = getConfig();
    const allChallenges = [...(cfg.labs || []), ...(cfg.quizzes || [])];
    
    let anyOpen = allChallenges.length === 0;
    for (const c of allChallenges) {
        if (isWindowOpen(c)) { anyOpen = true; break; }
    }
    
    if (!anyOpen) {
        return res.status(403).json({ error: "Registration is currently closed outside of the competition window." });
    }

    const { username, email, password } = req.body;
    
    if (!username || !email || password === undefined || password === null) {
        return res.status(400).json({ error: "Missing fields" });
    }
    
    const pwd = String(password);
    const userStr = String(username);
    const emailStr = String(email);

    if (userStr.length > 100 || emailStr.length > 100 || pwd.length > 100) {
        return res.status(400).json({ error: "Fields must be 100 characters or less." });
    }
    
    if (pwd.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
    }
    if (!/[A-Z]/.test(pwd)) {
        return res.status(400).json({ error: "Password must contain at least one uppercase letter." });
    }
    if (!/[0-9]/.test(pwd)) {
        return res.status(400).json({ error: "Password must contain at least one number." });
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
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ error: "Session save failed." });
                res.json({ success: true, unique_id: uid });
            });
        });
    } catch (err) {
        // Redefined to prevent account enumeration / reconnaissance (VULN-D)
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
        const userStr = String(username ?? "");
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(userStr);
        const hashToCompare = user ? user.password : DUMMY_HASH;
        
        const pwd = password !== undefined && password !== null ? String(password) : "";
        const passwordMatch = await bcrypt.compare(pwd, hashToCompare);

        if (!user || !passwordMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: "Login failed. Please try again." });
            req.session.userId = user.id;
            req.session.uniqueId = user.unique_id;
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ error: "Session save failed." });
                res.json({ success: true, unique_id: user.unique_id });
            });
        });
    } catch (err) {
        res.status(500).json({ error: "Login failed. Please try again." });
    }
});

router.get('/me', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in" });
    const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    res.json({ id: req.session.userId, unique_id: req.session.uniqueId, is_admin: user && user.is_admin === 1 });
});

router.get('/config', (req, res) => {
    const cfg = getConfig();
    const safeLabs = (cfg.labs || []).filter(l => isWindowOpen(l)).map(l => ({ id: l.id, title: l.title, type: 'lab' }));
    const safeQuizzes = (cfg.quizzes || []).filter(q => isWindowOpen(q)).map(q => ({ id: q.id, title: q.title, type: 'quiz' }));

    const fullTitle = process.env.APP_TITLE || 'CSSS ENGINE';
    const parts = fullTitle.split(' ');
    let titleMain = parts[0] || '';
    let titleHighlight = parts.slice(1).join(' ') || '';

    const isAuthenticated = req.session && req.session.userId;
    res.json({ 
        challenges: isAuthenticated ? [...safeLabs, ...safeQuizzes] : [],
        options: { 
            show_leaderboard: process.env.SHOW_LEADERBOARD === 'true',
            show_history: process.env.SHOW_HISTORY === 'true',
            app_title: fullTitle,
            app_title_main: titleMain,
            app_title_highlight: titleHighlight
        }
    });
});

router.get('/lab/:id', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    
    const cfg = getConfig();
    const lab = (cfg.labs || []).find(l => l.id === req.params.id);
    if (!lab) return res.status(404).json({ error: "Lab not found." });

    const totalAttempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?')
        .get(req.session.userId, lab.id).c;
    
    const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
        .get(req.session.userId, lab.id);

    let timeRemaining = null;
    let sessionActive = false;

    if (activeSession) {
        sessionActive = true;
        if (lab.time_limit_minutes && lab.time_limit_minutes > 0) {
            const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
            const elapsed = Math.floor((Date.now() - startTime) / 1000);
            timeRemaining = Math.max(0, (lab.time_limit_minutes * 60) - elapsed);
            
            if (timeRemaining <= 0) {
                db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ? WHERE id = ?")
                    .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), activeSession.id);
                sessionActive = false;
                timeRemaining = null;
            }
        }
    }

    res.json({
        id: lab.id,
        title: lab.title,
        max_submissions: lab.max_submissions || 0,
        attempts_taken: totalAttempts,
        time_limit_minutes: lab.time_limit_minutes || 0,
        has_pka_file: !!lab.pka_file,
        session_active: sessionActive,
        time_remaining_seconds: timeRemaining
    });
});

router.post('/lab/:id/start', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const lab = (cfg.labs || []).find(l => l.id === req.params.id);
    if (!lab) return res.status(404).json({ error: "Lab not found." });

    if (!isWindowOpen(lab)) {
        return res.status(403).json({ error: "Lab is currently closed outside of the competition window." });
    }

    const startSession = db.transaction(() => {
        const existing = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
            .get(req.session.userId, lab.id);

        if (existing) {
            let timeRemaining = null;
            if (lab.time_limit_minutes && lab.time_limit_minutes > 0) {
                const startTime = new Date(existing.timestamp.replace(' ', 'T') + 'Z').getTime();
                const elapsed = Math.floor((Date.now() - startTime) / 1000);
                timeRemaining = Math.max(0, (lab.time_limit_minutes * 60) - elapsed);

                if (timeRemaining <= 0) {
                    db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ? WHERE id = ?")
                        .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), existing.id);
                    return { error: "Your previous session has expired.", code: 403 };
                }
            }

            return { resumed: true, timeRemaining };
        }

        if (lab.max_submissions && lab.max_submissions > 0) {
            const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?')
                .get(req.session.userId, lab.id).c;
            if (count >= lab.max_submissions) {
                return { error: "Maximum attempts reached.", code: 403 };
            }
        }

        db.prepare("INSERT INTO submissions (user_id, unique_id, lab_id, status, type) VALUES (?, ?, ?, 'in_progress', 'lab')")
            .run(req.session.userId, req.session.uniqueId, lab.id);

        let timeRemaining = null;
        if (lab.time_limit_minutes && lab.time_limit_minutes > 0) {
            timeRemaining = lab.time_limit_minutes * 60;
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

router.get('/lab/:id/download', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).send("Unauthorized");

    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
        req.session.destroy(() => {});
        return res.status(401).send("Unauthorized");
    }

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

    if (lab.time_limit_minutes && lab.time_limit_minutes > 0) {
        const startTime = new Date(activeSession.timestamp.replace(' ', 'T') + 'Z').getTime();
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed > (lab.time_limit_minutes * 60)) {
            db.prepare("UPDATE submissions SET status = 'completed', score = 0, max_score = 0, details = ? WHERE id = ?")
                .run(JSON.stringify([{message: "Time expired.", device: "N/A", possible: 0, awarded: 0, passed: false}]), activeSession.id);
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
    if (process.env.SHOW_LEADERBOARD !== 'true') {
        return res.status(403).json({ error: "Leaderboard disabled" });
    }
    
    const cfg = getConfig();
    const labs = cfg.labs || [];
    const quizzes = cfg.quizzes || [];
    const allChallenges = [...labs, ...quizzes];

    const users = db.prepare('SELECT id, username, score_adjustment, withheld FROM users').all();

    // Single query replaces N*M synchronous queries in nested loops
    const allScores = db.prepare(`
        SELECT user_id, lab_id, MAX(score) as max_score
        FROM submissions
        WHERE status = 'completed'
        GROUP BY user_id, lab_id
    `).all();

    const scoreMap = {};
    allScores.forEach(row => {
        if (!scoreMap[row.user_id]) scoreMap[row.user_id] = {};
        scoreMap[row.user_id][row.lab_id] = row.max_score;
    });

    const leaderboard = [];

    users.forEach(u => {
        let total = 0;
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

            // O(1) map lookup instead of a DB query
            const score = (scoreMap[u.id] && scoreMap[u.id][ch.id] != null) ? scoreMap[u.id][ch.id] : 0;
            
            if (hideScore) {
                scores[ch.id] = '?'; 
            } else {
                scores[ch.id] = score;
                total += score;
            }
        });

        // Apply global modifier
        if (u.score_adjustment) {
            total += u.score_adjustment;
        }
        
        // Ensure total doesn't dip below 0
        if (total < 0) total = 0;

        if (total > 0 || Object.values(scores).some(s => s === '?')) {
            if (u.withheld) {
                Object.keys(scores).forEach(k => scores[k] = 'W');
            }
            leaderboard.push({ 
                username: u.username, 
                scores: scores, 
                total_score: u.withheld ? 'W' : total 
            });
        }
    });

    leaderboard.sort((a, b) => {
        if (a.total_score === 'W' && b.total_score !== 'W') return 1;
        if (a.total_score !== 'W' && b.total_score === 'W') return -1;
        if (a.total_score === 'W' && b.total_score === 'W') return 0;
        return b.total_score - a.total_score;
    });

    const headers = allChallenges.map(c => ({ id: c.id, title: c.title }));
    res.json({ success: true, labs: headers, leaderboard: leaderboard });
});

router.get('/history', (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in" });
    if (process.env.SHOW_HISTORY !== 'true') return res.status(403).json({ error: "History disabled" });
    
    const cfg = getConfig();
    const submissions = db.prepare("SELECT id, lab_id, score, max_score, timestamp, details, type FROM submissions WHERE user_id = ? AND status = 'completed' ORDER BY id DESC").all(req.session.userId);
    
    const safeSubmissions = submissions.map(sub => {
        let showScore = true;
        let showDetails = true;
        let showMissed = false;
        let type = sub.type || 'lab';

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
        try { details = JSON.parse(sub.details); } catch(e) {}
        
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
            details: clientDetails
        };
    });
    res.json({ success: true, history: safeSubmissions });
});

module.exports = router;