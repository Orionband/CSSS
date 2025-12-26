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

router.get('/history', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Not logged in" });
    try {
        const submissions = db.prepare(`SELECT id, score, max_score, timestamp, details FROM submissions WHERE user_id = ? ORDER BY id DESC`).all(req.session.userId);
        const opts = getConfig().options || {};
        const showCheckMessages = opts.show_check_messages !== false;
        const showScore = opts.show_score !== false;
        const safeSubmissions = submissions.map(sub => {
            let details = [];
            try { details = JSON.parse(sub.details); } catch(e) {}
            const clientDetails = details.filter(item => {
                const isPenalty = item.possible < 0;
                return isPenalty ? item.awarded < 0 : item.awarded > 0;
            }).map(item => ({ message: item.message, points: item.awarded }));
            return {
                id: sub.id,
                score: showScore ? sub.score : null,
                max_score: showScore ? sub.max_score : null,
                timestamp: sub.timestamp,
                details: showCheckMessages ? clientDetails : []
            };
        });
        res.json({ success: true, history: safeSubmissions });
    } catch (err) {
        res.status(500).json({ error: "DB Error" });
    }
});

module.exports = router;
