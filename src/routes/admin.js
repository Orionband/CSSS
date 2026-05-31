const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../database');
const { customAlphabet } = require('nanoid');
const rateLimit = require('express-rate-limit');
const router = express.Router();

const adminLimiter = rateLimit({
 windowMs: 5 * 60 * 1000,
 max: 20,
 standardHeaders: true,
 legacyHeaders: false,
 message: { error: "Too many admin requests. Please try again later." }
});

router.use(adminLimiter);

function generateUniqueId() {
   const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
   const nanoid = customAlphabet(alphabet, 12);
   const id = nanoid();
   return id.match(/.{1,4}/g).join('-');
}

function parseStrictAdminFlag(value) {
   if (value === true || value === 1) return 1;
   if (value === false || value === 0 || value === null || value === undefined) return 0;
   return null;
}

const adminOnly = (req, res, next) => {
   if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });
   const user = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
   if (!user || user.is_admin !== 1) {
       return res.status(403).json({ error: "Forbidden: Admin access required." });
   }
   next();
};

router.use(adminOnly);

router.get('/users', (req, res) => {
   const users = db.prepare('SELECT id, username, email, unique_id, is_admin, created_at, score_adjustment, withheld FROM users ORDER BY id DESC').all();
   
   const counts = db.prepare('SELECT user_id, COUNT(*) as c FROM submissions GROUP BY user_id').all();
   const countMap = {};
   counts.forEach(row => countMap[row.user_id] = row.c);

   users.forEach(u => u.submission_count = countMap[u.id] || 0);
   res.json({ success: true, users });
});

router.post('/users', async (req, res) => {
   const { username, email, password, is_admin } = req.body;
   
   if (!username || !password) return res.status(400).json({ error: "Username and password required." });

   const pwd = String(password);
   if (pwd.length < 8 || !/[A-Z]/.test(pwd) || !/[0-9]/.test(pwd)) {
       return res.status(400).json({ error: "Password must be >= 8 chars, contain an uppercase letter and a number." });
   }

   const adminFlag = parseStrictAdminFlag(is_admin);
   if (adminFlag === null) {
       return res.status(400).json({ error: "is_admin must be a boolean." });
   }

   try {
       const hashedPassword = await bcrypt.hash(pwd, 10);
       const uid = generateUniqueId();

       const info = db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin) VALUES (?, ?, ?, ?, ?)')
           .run(String(username), email ? String(email) : null, hashedPassword, uid, adminFlag);
       
       res.json({ success: true, id: info.lastInsertRowid });
   } catch (e) {
       res.status(400).json({ error: "Username or email already exists." });
   }
});

router.delete('/users/:id', (req, res) => {
   const targetId = parseInt(req.params.id);
   if (targetId === req.session.userId) return res.status(400).json({ error: "Cannot delete yourself." });

   try {
       db.transaction(() => {
           db.prepare('DELETE FROM submissions WHERE user_id = ?').run(targetId);
           db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
       })();

       // Terminate any active WebSocket connections for the deleted user
       const userSockets = global.activeUserSockets && global.activeUserSockets.get(targetId);
       if (userSockets) {
           userSockets.forEach(s => s.disconnect(true));
       }

       try {
           db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(targetId);
       } catch (e) {}

       res.json({ success: true });
   } catch (e) {
       res.status(500).json({ error: "Failed to delete user." });
   }
});

router.post('/users/:id/password', async (req, res) => {
   const targetId = parseInt(req.params.id);
   const { password } = req.body;

   const pwd = String(password);
   if (pwd.length < 8 || !/[A-Z]/.test(pwd) || !/[0-9]/.test(pwd)) {
       return res.status(400).json({ error: "Password must be >= 8 chars, contain an uppercase letter and a number." });
   }

   try {
       const hashedPassword = await bcrypt.hash(pwd, 10);
       db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, targetId);

       // Terminate active WebSocket sessions so the user must re-authenticate
       const userSockets = global.activeUserSockets && global.activeUserSockets.get(targetId);
       if (userSockets) {
           userSockets.forEach(s => s.disconnect(true));
       }
       try {
           const result = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(targetId);
           console.log(`Admin password reset: Invalidated ${result.changes} session(s) for user id=${targetId}.`);
       } catch (e) {
           console.error(`CRITICAL: Failed to invalidate sessions for user id=${targetId} after password reset:`, e.message);
           // Don't fail the request, but alert the admin that sessions may persist
       }
       // Set a timestamp so the auth middleware can invalidate stale sessions
       db.prepare('UPDATE users SET password_changed_at = ? WHERE id = ?').run(Date.now(), targetId);

       res.json({ success: true });
   } catch (e) {
       res.status(500).json({ error: "Failed to update password." });
   }
});

router.post('/users/:id/score', (req, res) => {
   const targetId = parseInt(req.params.id);
   const { adjustment, withheld } = req.body;
   
   const adjInt = parseInt(adjustment) || 0;
   const withheldInt = parseStrictAdminFlag(withheld);
   if (withheldInt === null) {
       return res.status(400).json({ error: "withheld must be a boolean." });
   }

   try {
       db.prepare('UPDATE users SET score_adjustment = ?, withheld = ? WHERE id = ?').run(adjInt, withheldInt, targetId);
       res.json({ success: true });
   } catch (e) {
       res.status(500).json({ error: "Failed to update score modifiers." });
   }
});

router.get('/users/:id/submissions', (req, res) => {
   const targetId = parseInt(req.params.id);
   try {
       const subs = db.prepare("SELECT id, lab_id, score, max_score, timestamp, type, status FROM submissions WHERE user_id = ? ORDER BY id DESC").all(targetId);
       res.json({ success: true, submissions: subs });
   } catch (e) {
       res.status(500).json({ error: "Failed to fetch submissions." });
   }
});

router.delete('/submissions/:id', (req, res) => {
   const subId = parseInt(req.params.id);
   try {
       const sub = db.prepare('SELECT id, status, user_id, lab_id FROM submissions WHERE id = ?').get(subId);
       if (!sub) return res.status(404).json({ error: "Submission not found." });
       if (sub.status === 'in_progress') {
           return res.status(400).json({ error: "Cannot delete a submission that is currently in progress. Wait for it to complete or expire." });
       }
       db.prepare('DELETE FROM submissions WHERE id = ?').run(subId);
       res.json({ success: true });
   } catch (e) {
       res.status(500).json({ error: "Failed to delete submission." });
   }
});

module.exports = router;