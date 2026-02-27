const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { getConfig } = require('../config');
const router = express.Router();
const { customAlphabet } = require('nanoid');
const rateLimit = require('express-rate-limit');

function generateUniqueId() { 
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const nanoid = customAlphabet(alphabet, 12);
    const id = nanoid();
    return id.match(/.{1,4}/g).join('-');
}

const registerLimiter = rateLimit({ windowMs: 24*60*60*1000, max: 2, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 5*60*1000, max: 5, standardHeaders: true, legacyHeaders: false });

router.post('/register', registerLimiter, async (req, res) => {
    const { username, email, password } = req.body;
    if (!username || !email || !password) return res.status(400).json({ error: "Missing fields" });
    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        const uid = generateUniqueId();
        const stmt = db.prepare('INSERT INTO users (username, email, password, unique_id) VALUES (?, ?, ?, ?)');
        const info = stmt.run(username, email, hashedPassword, uid);
        req.session.userId = info.lastInsertRowid;
        req.session.uniqueId = uid;
        res.json({ success: true, unique_id: uid });
    } catch (err) {
        res.status(400).json({ error: "Username or Email already exists" });
    }
});

router.post('/logout', (req, res) => {
    req.session.destroy(err => {
        res.clearCookie('connect.sid'); 
        res.json({ success: true });
    });
});

router.post('/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
    }

    req.session.regenerate(err => {
        if (err) return res.status(500).json({ error: "Session regeneration failed" });
        req.session.userId = user.id;
        req.session.uniqueId = user.unique_id;
        res.json({ success: true, unique_id: user.unique_id });
    });
});

router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
    res.json({ id: req.session.userId, unique_id: req.session.uniqueId });
});

router.get('/config', (req, res) => {
    const cfg = getConfig();
    const safeLabs = (cfg.labs || []).map(l => ({ id: l.id, title: l.title, type: 'lab' }));
    
    const safeQuizzes = (cfg.quizzes || [])
        .filter(q => q.enabled !== false)
        .map(q => ({ id: q.id, title: q.title, type: 'quiz' }));

    res.json({ 
        challenges: [...safeLabs, ...safeQuizzes],
        options: { 
            show_leaderboard: process.env.SHOW_LEADERBOARD === 'true',
            show_history: process.env.SHOW_HISTORY === 'true' // NEW FLAG
        }
    });
});

router.get('/leaderboard', (req, res) => {
    if (process.env.SHOW_LEADERBOARD !== 'true') {
        return res.status(403).json({ error: "Leaderboard disabled" });
    }
    
    const cfg = getConfig();
    const labs = cfg.labs || [];
    const quizzes = (cfg.quizzes || []).filter(q => q.enabled !== false);
    const allChallenges = [...labs, ...quizzes];

    const users = db.prepare('SELECT id, username FROM users').all();
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

            const row = db.prepare("SELECT MAX(score) as s FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'completed'").get(u.id, ch.id);
            const score = row && row.s !== null ? row.s : 0;
            
            if (hideScore) {
                scores[ch.id] = '?'; 
            } else {
                scores[ch.id] = score;
                total += score;
            }
        });
        
        if (total > 0 || Object.values(scores).some(s => s === '?')) {
            leaderboard.push({ username: u.username, scores: scores, total_score: total });
        }
    });

    leaderboard.sort((a, b) => b.total_score - a.total_score);
    const headers = allChallenges.map(c => ({ id: c.id, title: c.title }));
    res.json({ success: true, labs: headers, leaderboard: leaderboard });
});

router.get('/history', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });


    if (process.env.SHOW_HISTORY !== 'true') return res.status(403).json({ error: "History disabled" });
    
    const cfg = getConfig();
    const submissions = db.prepare("SELECT id, lab_id, score, max_score, timestamp, details, type FROM submissions WHERE user_id = ? AND status = 'completed' ORDER BY id DESC").all(req.session.userId);
    
    const safeSubmissions = submissions.map(sub => {
        let showScore = true;
        let showDetails = true;
        let type = sub.type || 'lab';

        if (type === 'quiz') {
            const qCfg = (cfg.quizzes || []).find(q => q.id === sub.lab_id);
            showScore = qCfg ? (qCfg.show_score !== false) : true;
            showDetails = qCfg ? (qCfg.show_corrections !== false) : true;
        } else {
            const lCfg = (cfg.labs || []).find(l => l.id === sub.lab_id);
            showScore = lCfg ? (lCfg.show_score !== false) : true;
            showDetails = lCfg ? (lCfg.show_check_messages !== false) : true;
        }

        let details = [];
        try { details = JSON.parse(sub.details); } catch(e) {}
        
        let clientDetails = null;
        if (showDetails) {
            if (type === 'quiz') {
                clientDetails = details; 
            } else {
                clientDetails = details.filter(item => {
                    const isPenalty = item.possible < 0;
                    return isPenalty ? item.awarded < 0 : item.awarded > 0;
                }).map(item => ({ message: item.message, points: item.awarded }));
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