const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { getConfig } = require('../config');
const router = express.Router();

function generateUniqueId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let result = '';
    for (let i = 0; i < 12; i++) {
        if (i > 0 && i % 4 === 0) result += '-';
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// --- AUTH ---
router.post('/register', async (req, res) => {
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

router.post('/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(401).json({ error: "Invalid credentials" });
    }
    req.session.userId = user.id;
    req.session.uniqueId = user.unique_id;
    res.json({ success: true, unique_id: user.unique_id });
});

router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

router.get('/me', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
    res.json({ id: req.session.userId, unique_id: req.session.uniqueId });
});

// --- DATA ---
router.get('/config', (req, res) => {
    const cfg = getConfig();
    const safeLabs = (cfg.labs || []).map(l => ({ id: l.id, title: l.title }));
    res.json({ 
        labs: safeLabs,
        options: { show_leaderboard: cfg.options?.show_leaderboard !== false }
    });
});

router.get('/leaderboard', (req, res) => {
    const cfg = getConfig();
    if (cfg.options?.show_leaderboard === false) {
        return res.status(403).json({ error: "Leaderboard disabled" });
    }
    const labs = cfg.labs || [];
    const users = db.prepare('SELECT id, username FROM users').all();
    const leaderboard = [];
    users.forEach(u => {
        let total = 0;
        const scores = {};
        labs.forEach(lab => {
            const row = db.prepare('SELECT MAX(score) as s FROM submissions WHERE user_id = ? AND lab_id = ?').get(u.id, lab.id);
            const score = row && row.s !== null ? row.s : 0;
            scores[lab.id] = score;
            total += score;
        });
        if (total > 0) {
            leaderboard.push({ username: u.username, scores: scores, total_score: total });
        }
    });
    leaderboard.sort((a, b) => b.total_score - a.total_score);
    const labHeaders = labs.map(l => ({ id: l.id, title: l.title }));
    res.json({ success: true, labs: labHeaders, leaderboard: leaderboard });
});

router.get('/history', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
    
    const cfg = getConfig();
    const submissions = db.prepare('SELECT id, lab_id, score, max_score, timestamp, details FROM submissions WHERE user_id = ? ORDER BY id DESC').all(req.session.userId);
    
    const safeSubmissions = submissions.map(sub => {
        const labCfg = (cfg.labs || []).find(l => l.id === sub.lab_id);
        const showChecks = labCfg ? (labCfg.show_check_messages !== false) : true;
        const showScore = labCfg ? (labCfg.show_score !== false) : true;

        let details = [];
        try { details = JSON.parse(sub.details); } catch(e) {}
        
        const clientDetails = details.filter(item => {
            const isPenalty = item.possible < 0;
            return isPenalty ? item.awarded < 0 : item.awarded > 0;
        }).map(item => ({ message: item.message, points: item.awarded }));
        
        // FIX: Return NULL if hidden, otherwise array
        return {
            id: sub.id,
            lab_id: sub.lab_id,
            score: showScore ? sub.score : null,
            max_score: showScore ? sub.max_score : null,
            timestamp: sub.timestamp,
            details: showChecks ? clientDetails : null
        };
    });
    res.json({ success: true, history: safeSubmissions });
});

module.exports = router;
