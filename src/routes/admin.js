const express = require('express');

const bcrypt = require('bcryptjs');

const db = require('../database');

const { sanitizeUsername, sanitizeEmail, MAX_FIELD_LEN } = require('../sanitizeUserFields');

const { validatePasswordPolicy } = require('../passwordPolicy');

const { customAlphabet } = require('nanoid');

const rateLimit = require('express-rate-limit');

const { rateLimitPreset, parsePagination } = require('../limits');

const { getBestSubmissionsMaps, totalScoreForUser } = require('../leaderboardScores');

const { getConfig } = require('../config');

const {

    logAccountCreated,

    logPasswordChanged,

    logAdminChange,

    logUserDeleted,

    isValidEventType,

    readAuditLog,

} = require('../auditLog');

const router = express.Router();



const adminLimiter = rateLimit(rateLimitPreset({

    windowMs: 5 * 60 * 1000,

    max: 20,

    message: { error: "Too many admin requests. Please try again later." },

}));



const auditLogLimiter = rateLimit(rateLimitPreset({

    windowMs: 60 * 1000,

    max: 15,

    message: { error: "Too many audit log requests. Please try again later." },

}));



router.use((req, res, next) => {

    if (req.method === 'GET' && req.path === '/audit-log') return next();

    return adminLimiter(req, res, next);

});



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



async function verifyAdminCurrentPassword(req, current_password) {

   if (!current_password) {

       return { ok: false, status: 400, error: "Current password confirmation is required." };

   }

   const adminUser = db.prepare('SELECT password FROM users WHERE id = ?').get(req.session.userId);

   if (!adminUser) {

       return { ok: false, status: 401, error: "Unauthorized" };

   }

   const valid = await bcrypt.compare(String(current_password), adminUser.password);

   if (!valid) {

       return { ok: false, status: 403, error: "Current password is incorrect." };

   }

   return { ok: true };

}



function countOwners() {

   return db.prepare('SELECT COUNT(*) as c FROM users WHERE is_owner = 1').get().c;

}



function disconnectUserSockets(userId) {

   const userSockets = global.activeUserSockets && global.activeUserSockets.get(userId);

   if (userSockets) {

       userSockets.forEach(s => s.disconnect(true));

   }

}



const adminOnly = (req, res, next) => {

   if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });

   const user = db.prepare('SELECT is_admin, is_owner FROM users WHERE id = ?').get(req.session.userId);

   if (!user || user.is_admin !== 1) {

       return res.status(403).json({ error: "Forbidden: Admin access required." });

   }

   req.isOwner = user.is_owner === 1;

   next();

};



router.use(adminOnly);



router.get('/users', (req, res) => {

   const { limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });

   const total = db.prepare('SELECT COUNT(*) as total FROM users').get().total;



   const users = db.prepare(

       'SELECT id, username, email, unique_id, is_admin, is_owner, created_at, score_adjustment, withheld FROM users ORDER BY id DESC LIMIT ? OFFSET ?'

   ).all(limit, offset);



   const countMap = {};

   if (users.length > 0) {

       const placeholders = users.map(() => '?').join(',');

       const ids = users.map(u => u.id);

       db.prepare(

           `SELECT user_id, COUNT(*) as c FROM submissions WHERE user_id IN (${placeholders}) GROUP BY user_id`

       ).all(...ids).forEach(row => { countMap[row.user_id] = row.c; });

   }



   const cfg = getConfig();

   const submissionMaps = getBestSubmissionsMaps();

   users.forEach(u => {

       u.submission_count = countMap[u.id] || 0;

       u.leaderboard_total = totalScoreForUser(u.id, cfg, submissionMaps);

   });



   const hasMore = offset + users.length < total;

   res.json({ success: true, users, total, limit, offset, hasMore });

});



router.post('/users', async (req, res) => {

   const { username, email, password, is_admin } = req.body;

   

   if (!username || !password) return res.status(400).json({ error: "Username and password required." });



   const userStr = sanitizeUsername(username);

   if (!userStr) {

       return res.status(400).json({ error: "Invalid username. Use ASCII letters, numbers, and . _ - only." });

   }



   let emailStr = null;

   if (email != null && email !== '') {

       emailStr = sanitizeEmail(email);

       if (!emailStr) {

           return res.status(400).json({ error: "Invalid email address." });

       }

   }



   const pwd = String(password);

   if (userStr.length > MAX_FIELD_LEN || (emailStr && emailStr.length > MAX_FIELD_LEN)) {

       return res.status(400).json({ error: "Username or email must be 100 characters or less." });

   }

   const pwdCheck = validatePasswordPolicy(pwd);

   if (!pwdCheck.ok) {

       return res.status(400).json({ error: pwdCheck.error });

   }



   const adminFlag = parseStrictAdminFlag(is_admin);

   if (adminFlag === null) {

       return res.status(400).json({ error: "is_admin must be a boolean." });

   }



   if (adminFlag === 1 && !req.isOwner) {

       return res.status(403).json({ error: "Only the owner can create admin accounts." });

   }



   try {

       const hashedPassword = await bcrypt.hash(pwd, 10);

       const uid = generateUniqueId();



       const info = db.prepare('INSERT INTO users (username, email, password, unique_id, is_admin) VALUES (?, ?, ?, ?, ?)')

           .run(userStr, emailStr || null, hashedPassword, uid, adminFlag);



       logAccountCreated({

           actorUserId: req.session.userId,

           targetUserId: info.lastInsertRowid,

           username: userStr,

           isAdmin: adminFlag === 1,

           isOwner: false,

           source: 'admin_panel',

       });



       res.json({ success: true, id: info.lastInsertRowid });

   } catch (e) {

       res.status(400).json({ error: "Username or email already exists." });

   }

});



router.delete('/users/:id', (req, res) => {

   const targetId = parseInt(req.params.id, 10);

   if (!Number.isFinite(targetId)) {

       return res.status(400).json({ error: "Invalid user id." });

   }

   if (targetId === req.session.userId) return res.status(400).json({ error: "Cannot delete yourself." });



   try {

       const existing = db.prepare('SELECT id, username, is_admin, is_owner FROM users WHERE id = ?').get(targetId);

       if (!existing) {

           return res.status(404).json({ error: "User not found." });

       }

       if (existing.is_admin === 1 && !req.isOwner) {

           return res.status(403).json({ error: "Cannot delete another admin user." });

       }

       if (existing.is_owner === 1 && countOwners() <= 1) {

           return res.status(403).json({ error: "Cannot delete the only owner account." });

       }



       db.transaction(() => {

           db.prepare('DELETE FROM submissions WHERE user_id = ?').run(targetId);

           db.prepare('DELETE FROM users WHERE id = ?').run(targetId);

           db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(targetId);

       })();



       disconnectUserSockets(targetId);



       logUserDeleted({

           actorUserId: req.session.userId,

           targetUserId: targetId,

           username: existing.username,

           source: 'admin_panel',

       });



       console.log(`Admin id=${req.session.userId} deleted user id=${targetId}`);

       res.json({ success: true });

   } catch (e) {

       res.status(500).json({ error: "Failed to delete user." });

   }

});



router.post('/users/:id/password', async (req, res) => {

   const targetId = parseInt(req.params.id);

   const { password, current_password } = req.body;



   if (!Number.isFinite(targetId)) {

       return res.status(400).json({ error: "Invalid user id." });

   }



   const pwdConfirm = await verifyAdminCurrentPassword(req, current_password);

   if (!pwdConfirm.ok) {

       return res.status(pwdConfirm.status).json({ error: pwdConfirm.error });

   }



   let targetUsername = null;

   if (targetId !== req.session.userId) {

       const targetUser = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(targetId);

       if (!targetUser) {

           return res.status(404).json({ error: "User not found." });

       }

       targetUsername = targetUser.username;

       if (targetUser.is_admin === 1 && !req.isOwner) {

           return res.status(403).json({ error: "Cannot reset another admin's password." });

       }

   } else {

       const self = db.prepare('SELECT username FROM users WHERE id = ?').get(targetId);

       targetUsername = self?.username || null;

   }



   const pwd = String(password);

   const pwdCheck = validatePasswordPolicy(pwd);

   if (!pwdCheck.ok) {

       return res.status(400).json({ error: pwdCheck.error });

   }



   try {

       const hashedPassword = await bcrypt.hash(pwd, 10);

       const changedAt = Date.now();



       const sessionsRemoved = db.transaction(() => {

           const info = db.prepare(

               'UPDATE users SET password_changed_at = ?, password = ? WHERE id = ?'

           ).run(changedAt, hashedPassword, targetId);

           if (info.changes === 0) {

               const err = new Error('USER_NOT_FOUND');

               err.code = 'USER_NOT_FOUND';

               throw err;

           }

           return db.prepare(

               "DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"

           ).run(targetId).changes;

       })();



       disconnectUserSockets(targetId);



       logPasswordChanged({

           actorUserId: req.session.userId,

           targetUserId: targetId,

           targetUsername,

           source: 'admin_panel',

       });



       console.log(`Admin id=${req.session.userId} reset password for user id=${targetId}, sessions removed=${sessionsRemoved}.`);

       res.json({ success: true });

   } catch (e) {

       if (e.code === 'USER_NOT_FOUND') {

           return res.status(404).json({ error: "User not found." });

       }

       console.error(`Password reset failed for user id=${targetId}:`, e.message);

       res.status(500).json({ error: "Failed to update password." });

   }

});



router.post('/users/:id/score', async (req, res) => {

   const targetId = parseInt(req.params.id, 10);

   if (!Number.isFinite(targetId)) {

       return res.status(400).json({ error: "Invalid user id." });

   }

   const targetUser = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId);

   if (!targetUser) {

       return res.status(404).json({ error: "User not found." });

   }

   if (targetUser.is_admin === 1 && targetId !== req.session.userId && !req.isOwner) {

       return res.status(403).json({ error: "Cannot modify another admin's score modifiers." });

   }



   const pwdConfirm = await verifyAdminCurrentPassword(req, req.body.current_password);

   if (!pwdConfirm.ok) {

       return res.status(pwdConfirm.status).json({ error: pwdConfirm.error });

   }



   const { adjustment, withheld } = req.body;

   

   let adjInt = null;

   if ('adjustment' in req.body) {

       const raw = parseInt(adjustment, 10);

       if (!Number.isFinite(raw)) {

           return res.status(400).json({ error: "Adjustment must be a valid integer." });

       }

       const MAX_ADJUSTMENT = 1000000;

       adjInt = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, raw));

   }

   const withheldInt = parseStrictAdminFlag(withheld);

   if (withheldInt === null) {

       return res.status(400).json({ error: "withheld must be a boolean." });

   }



   try {

       const updates = [];

       const params = [];

       if (adjInt !== null) { updates.push('score_adjustment = ?'); params.push(adjInt); }

       if (withheld !== undefined) { updates.push('withheld = ?'); params.push(withheldInt); }

       if (!updates.length) {

           return res.status(400).json({ error: "No fields to update." });

       }

       params.push(targetId);

       const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

       const info = db.prepare(sql).run(...params);

       if (info.changes === 0) {

           return res.status(404).json({ error: "User not found." });

       }

       res.json({ success: true });

   } catch (e) {

       console.error(`Score modifier update failed for user id=${targetId}:`, e.message);

       res.status(500).json({ error: "Failed to update score modifiers." });

   }

});



router.post('/users/:id/admin', async (req, res) => {

   if (!req.isOwner) {

       return res.status(403).json({ error: "Only the owner can change admin privileges." });

   }



   const targetId = parseInt(req.params.id, 10);

   if (!Number.isFinite(targetId)) {

       return res.status(400).json({ error: "Invalid user id." });

   }

   if (targetId === req.session.userId) {

       return res.status(400).json({ error: "Cannot change your own admin privileges." });

   }



   const adminFlag = parseStrictAdminFlag(req.body.is_admin);

   if (adminFlag === null) {

       return res.status(400).json({ error: "is_admin must be a boolean." });

   }



   const pwdConfirm = await verifyAdminCurrentPassword(req, req.body.current_password);

   if (!pwdConfirm.ok) {

       return res.status(pwdConfirm.status).json({ error: pwdConfirm.error });

   }



   const targetUser = db.prepare('SELECT id, is_admin, is_owner, username FROM users WHERE id = ?').get(targetId);

   if (!targetUser) {

       return res.status(404).json({ error: "User not found." });

   }

   if (targetUser.is_owner === 1) {

       return res.status(403).json({ error: "Cannot change admin privileges for an owner account." });

   }

   if (targetUser.is_admin === adminFlag) {

       return res.json({ success: true });

   }



   try {

       db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(adminFlag, targetId);



       if (adminFlag === 0) {

           const sessionsRemoved = db.prepare(

               "DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?"

           ).run(targetId).changes;

           disconnectUserSockets(targetId);

           logAdminChange({

               granted: false,

               actorUserId: req.session.userId,

               targetUserId: targetId,

               username: targetUser.username,

               source: 'admin_panel',

           });

           console.log(`Owner id=${req.session.userId} revoked admin for user id=${targetId}, sessions removed=${sessionsRemoved}.`);

       } else {

           logAdminChange({

               granted: true,

               actorUserId: req.session.userId,

               targetUserId: targetId,

               username: targetUser.username,

               source: 'admin_panel',

           });

           console.log(`Owner id=${req.session.userId} granted admin to user id=${targetId}.`);

       }



       res.json({ success: true });

   } catch (e) {

       console.error(`Admin privilege update failed for user id=${targetId}:`, e.message);

       res.status(500).json({ error: "Failed to update admin privileges." });

   }

});



router.get('/users/:id/submissions', (req, res) => {

   const targetId = parseInt(req.params.id);

   if (!Number.isFinite(targetId)) {

       return res.status(400).json({ error: "Invalid user id." });

   }

   const { limit, offset } = parsePagination(req.query, { defaultLimit: 100, maxLimit: 500 });

   try {

       const { total } = db.prepare('SELECT COUNT(*) as total FROM submissions WHERE user_id = ?').get(targetId);

       const subs = db.prepare(

           "SELECT id, lab_id, score, max_score, timestamp, type, status, duration_seconds FROM submissions WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?"

       ).all(targetId, limit, offset);

       const hasMore = offset + subs.length < total;

       res.json({ success: true, submissions: subs, total, limit, offset, hasMore });

   } catch (e) {

       res.status(500).json({ error: "Failed to fetch submissions." });

   }

});



router.get('/audit-log', auditLogLimiter, (req, res) => {

   const { limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });

   const eventType = typeof req.query.event_type === 'string' ? req.query.event_type.trim() : '';

   const filterType = isValidEventType(eventType) ? eventType : null;



   try {

       const result = readAuditLog({ limit, offset, eventType: filterType });

       res.json({ success: true, ...result });

   } catch (e) {

       console.error('Failed to fetch audit log:', e.message);

       res.status(500).json({ error: 'Failed to fetch audit log.' });

   }

});



router.delete('/submissions/:id', (req, res) => {

   const subId = parseInt(req.params.id, 10);

   if (!Number.isFinite(subId)) {

       return res.status(400).json({ error: "Invalid submission id." });

   }

   try {

       const sub = db.prepare('SELECT id, status, user_id, lab_id FROM submissions WHERE id = ?').get(subId);

       if (!sub) return res.status(404).json({ error: "Submission not found." });

       if (sub.status === 'in_progress') {

           return res.status(400).json({ error: "Cannot delete a submission that is currently in progress. Wait for it to complete or expire." });

       }

       db.prepare('DELETE FROM submissions WHERE id = ?').run(subId);

       const selfNote = sub.user_id === req.session.userId ? ' (own submission)' : '';

       console.log(`Admin id=${req.session.userId} deleted submission id=${subId} (user_id=${sub.user_id}, lab_id=${sub.lab_id})${selfNote}`);

       res.json({ success: true });

   } catch (e) {

       res.status(500).json({ error: "Failed to delete submission." });

   }

});



module.exports = router;

