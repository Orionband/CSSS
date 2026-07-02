const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const { URLSearchParams } = require('url');
const fs = require('fs');
const db = require('../database');
const { sanitizeUsername, sanitizeEmail, MAX_FIELD_LEN } = require('../sanitizeUserFields');
const { validatePasswordPolicy } = require('../passwordPolicy');
const { parsePagination, MAX_LEADERBOARD, rateLimitPreset, getConfigNumber, ensureArray, resolveUploadMb } = require('../limits');
const { buildLeaderboard, buildEntryForUser, getBestSubmissionsMaps } = require('../leaderboardScores');
const { getCachedLeaderboard } = require('../leaderboardCache');
const { elapsedSecondsSince, chartTimeMs } = require('../submissionDuration');
const { getConfig, isWindowOpen, isHomepageEnabled, getCompetitionWindowStatus } = require('../config');
const { logAccountCreated } = require('../auditLog');
const { loginCredentialsStillValid } = require('../loginFreshness');
const { createLabSessionService } = require('../services/labSessionService');
const {
    buildAuthorizeUrl,
    exchangeCodeForToken,
    fetchDiscordUser,
    findOrCreateDiscordUser,
    getDiscordConfig,
} = require('../discordOAuth');
const { getAdminReauthStatus, sanitizeAdminReturnTo } = require('../adminReauth');
const router = express.Router();
const { customAlphabet } = require('nanoid');
const rateLimit = require('express-rate-limit');

const labSessionService = createLabSessionService(db);

function generateUniqueId() { 
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	const nanoid = customAlphabet(alphabet, 12);
    const id = nanoid();
    return id.match(/.{1,4}/g).join('-');
}

let dummyHashCache = null;
function getDummyHash() {
    if (!dummyHashCache) {
        dummyHashCache = bcrypt.hashSync('__dummy_timing_safe_value_never_matches__', 10);
    }
    return dummyHashCache;
}

const registerLimiter = rateLimit(rateLimitPreset({ windowMs: 24 * 60 * 60 * 1000, max: 10 }));
const loginLimiter = rateLimit(rateLimitPreset({ windowMs: 5 * 60 * 1000, max: 10 }));
const csrfLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 120 }));
const leaderboardLimiter = rateLimit(rateLimitPreset({ windowMs: 10 * 1000, max: 30 }));
const historyLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 60 }));
const labInfoLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 120 }));
const labStartLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 10 }));
const downloadLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 30 }));
const configLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 120 }));
const bootstrapLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 120 }));
const meLimiter = rateLimit(rateLimitPreset({ windowMs: 60 * 1000, max: 120 }));
const discordAuthLimiter = rateLimit(rateLimitPreset({ windowMs: 5 * 60 * 1000, max: 20 }));

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

function discordAuthFailureRedirect(res, message) {
    const params = new URLSearchParams({ discord_error: message || 'Discord sign-in failed.' });
    const base = isHomepageEnabled(getConfig()) ? '/login' : '/';
    return res.redirect(`${base}?${params.toString()}`);
}

function adminReauthFailureRedirect(res, message) {
    const params = new URLSearchParams({ reauth_error: message || 'Discord verification failed.' });
    return res.redirect(`/admin?${params.toString()}`);
}

function buildSessionUserPayload(session, user) {
    const reauth = getAdminReauthStatus(session, user);
    return {
        id: session.userId,
        username: user?.username,
        unique_id: session.uniqueId,
        is_admin: user && user.is_admin === 1,
        is_owner: user && user.is_owner === 1,
        admin_reauth_method: reauth.method,
        admin_discord_reauth_valid: reauth.discordValid,
    };
}

function oauthStateMatches(sessionState, queryState) {
    if (!sessionState || !queryState || typeof queryState !== 'string') return false;
    const stateBuf = Buffer.from(queryState);
    const expectedBuf = Buffer.from(sessionState);
    try {
        if (stateBuf.length !== expectedBuf.length) return false;
        return crypto.timingSafeEqual(stateBuf, expectedBuf);
    } catch {
        return false;
    }
}

router.get('/auth/discord', discordAuthLimiter, (req, res) => {
    const config = getDiscordConfig();
    if (!config.configured) {
        return res.status(404).send('Discord authentication is not enabled.');
    }

    const state = crypto.randomBytes(32).toString('hex');
    req.session.discordOAuthMode = 'login';
    req.session.discordOAuthState = state;
    req.session.save((err) => {
        if (err) return res.status(500).send('Session save failed.');
        const url = buildAuthorizeUrl({
            clientId: config.clientId,
            redirectUri: config.redirectUri,
            scope: config.scope,
            state,
        });
        res.redirect(url);
    });
});

router.get('/auth/discord/callback', discordAuthLimiter, async (req, res) => {
    const config = getDiscordConfig();
    if (!config.configured) {
        return discordAuthFailureRedirect(res, 'Discord authentication is not enabled.');
    }

    const { code, state, error: oauthError } = req.query;
    const pendingMode = req.session?.discordOAuthMode || 'login';
    if (oauthError) {
        if (pendingMode === 'reauth') {
            return adminReauthFailureRedirect(res, 'Discord authorization was denied.');
        }
        return discordAuthFailureRedirect(res, 'Discord authorization was denied.');
    }

    const expectedState = req.session?.discordOAuthState;
    const oauthMode = pendingMode;
    const reauthUserId = req.session?.discordReauthUserId;
    const returnTo = sanitizeAdminReturnTo(req.session?.discordReauthReturnTo);
    delete req.session.discordOAuthState;
    delete req.session.discordOAuthMode;
    delete req.session.discordReauthUserId;
    delete req.session.discordReauthReturnTo;

    if (!code || typeof code !== 'string' || !oauthStateMatches(expectedState, state)) {
        if (oauthMode === 'reauth') {
            return adminReauthFailureRedirect(res, 'Invalid Discord callback.');
        }
        return discordAuthFailureRedirect(res, 'Invalid Discord callback.');
    }

    try {
        const tokenData = await exchangeCodeForToken({
            code,
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            redirectUri: config.redirectUri,
        });
        const profile = await fetchDiscordUser(tokenData.access_token);

        if (oauthMode === 'reauth') {
            if (!req.session?.userId || reauthUserId !== req.session.userId) {
                return adminReauthFailureRedirect(res, 'Admin session changed during verification.');
            }
            const linked = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(req.session.userId);
            if (!linked?.discord_id || String(profile.id) !== String(linked.discord_id)) {
                return adminReauthFailureRedirect(res, 'Discord account does not match the signed-in user.');
            }
            req.session.adminDiscordReauthAt = Date.now();
            req.session.save((saveErr) => {
                if (saveErr) return adminReauthFailureRedirect(res, 'Session save failed.');
                const separator = returnTo.includes('?') ? '&' : '?';
                res.redirect(`${returnTo}${separator}reauth=ok`);
            });
            return;
        }

        let user;
        try {
            user = findOrCreateDiscordUser(db, profile);
        } catch (createErr) {
            if (createErr.code === 'REGISTRATION_DISABLED') {
                return discordAuthFailureRedirect(res, createErr.message);
            }
            throw createErr;
        }
        const loginStartedAt = Date.now();

        req.session.regenerate((err) => {
            if (err) return discordAuthFailureRedirect(res, 'Login failed.');

            req.session.userId = user.id;
            req.session.uniqueId = user.unique_id;
            req.session.authenticatedAt = loginStartedAt;
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.save((saveErr) => {
                if (saveErr) return discordAuthFailureRedirect(res, 'Session save failed.');
                res.redirect('/challenges');
            });
        });
    } catch {
        if (oauthMode === 'reauth') {
            return adminReauthFailureRedirect(res, 'Discord verification failed.');
        }
        return discordAuthFailureRedirect(res, 'Discord sign-in failed.');
    }
});

router.get('/auth/discord/reauth', discordAuthLimiter, (req, res) => {
    if (!req.session?.userId) {
        return res.status(401).send('Not logged in.');
    }

    const config = getDiscordConfig();
    if (!config.configured) {
        return res.status(404).send('Discord authentication is not enabled.');
    }

    const user = db.prepare('SELECT discord_id FROM users WHERE id = ?').get(req.session.userId);
    if (!user?.discord_id) {
        return res.status(400).send('This account is not linked to Discord.');
    }
    const adminFlags = db.prepare('SELECT is_admin FROM users WHERE id = ?').get(req.session.userId);
    if (!adminFlags?.is_admin) {
        return res.status(403).send('Discord verification is only available to admins.');
    }

    const state = crypto.randomBytes(32).toString('hex');
    req.session.discordOAuthMode = 'reauth';
    req.session.discordOAuthState = state;
    req.session.discordReauthUserId = req.session.userId;
    req.session.discordReauthReturnTo = sanitizeAdminReturnTo(req.query.return);

    req.session.save((err) => {
        if (err) return res.status(500).send('Session save failed.');
        const url = buildAuthorizeUrl({
            clientId: config.clientId,
            redirectUri: config.redirectUri,
            scope: config.scope,
            state,
        });
        res.redirect(url);
    });
});

router.post('/register', registerLimiter, async (req, res) => {
    if (getDiscordConfig().configured) {
        return res.status(403).json({ error: "Registration is only available through Discord sign-in." });
    }

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
        logAccountCreated({
            actorUserId: null,
            targetUserId: info.lastInsertRowid,
            username: userStr,
            isAdmin: false,
            isOwner: false,
            source: 'registration',
        });
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
        if (getDiscordConfig().configured) {
            return res.status(403).json({ error: "Sign in with Discord is required." });
        }

        const { username, password } = req.body;
        const userStr = sanitizeUsername(username);
        if (!userStr) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const user = db.prepare('SELECT * FROM users WHERE username = ?').get(userStr);
        const hashToCompare = user && user.password ? user.password : getDummyHash();
        const loginStartedAt = Date.now();
        const credentialSnapshot = user ? {
            passwordHashAtRead: user.password,
            passwordChangedAtAtRead: user.password_changed_at ?? null,
            loginStartedAt,
        } : null;

        const pwd = password !== undefined && password !== null ? String(password) : "";
        if (pwd.length > 100) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const passwordMatch = await bcrypt.compare(pwd, hashToCompare);

        if (!user || !user.password || !passwordMatch) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (!loginCredentialsStillValid(db, user.id, credentialSnapshot)) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const rejectStaleLogin = () => {
            req.session.destroy(() => {
                res.status(401).json({ error: "Invalid credentials" });
            });
        };

        req.session.regenerate(err => {
            if (err) return res.status(500).json({ error: "Login failed. Please try again." });
            if (!loginCredentialsStillValid(db, user.id, credentialSnapshot)) {
                return rejectStaleLogin();
            }
            req.session.userId = user.id;
            req.session.uniqueId = user.unique_id;
            req.session.authenticatedAt = loginStartedAt;
            req.session.csrfToken = crypto.randomBytes(32).toString('hex');
            req.session.save((saveErr) => {
                if (saveErr) return res.status(500).json({ error: "Session save failed." });
                if (!loginCredentialsStillValid(db, user.id, credentialSnapshot)) {
                    return rejectStaleLogin();
                }
                res.json({ success: true, unique_id: user.unique_id, csrfToken: req.session.csrfToken });
            });
        });
    } catch (err) {
        res.status(500).json({ error: "Login failed. Please try again." });
    }
});

router.get('/me', meLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Not logged in" });
    const user = db.prepare('SELECT username, is_admin, is_owner, discord_id FROM users WHERE id = ?').get(req.session.userId);
    res.json(buildSessionUserPayload(req.session, user));
});

function appOptions() {
    const fullTitle = process.env.APP_TITLE || 'CSSS ENGINE';
    const parts = fullTitle.split(' ');
    const discord = getDiscordConfig();
    return {
        show_leaderboard: envBool('SHOW_LEADERBOARD'),
        show_history: envBool('SHOW_HISTORY'),
        discord_auth_enabled: discord.configured,
        homepage_enabled: isHomepageEnabled(getConfig()),
        app_title: fullTitle,
        app_title_main: parts[0] || '',
        app_title_highlight: parts.slice(1).join(' ') || '',
    };
}

function buildHomepageBlock(block) {
    if (!block || !block.body) return null;
    return { title: block.title, body: block.body };
}

function buildHomepagePayload(homepage) {
    if (!homepage || homepage.enabled !== true) return null;

    const payload = {
        page_title: homepage.page_title,
        subtitle: homepage.subtitle,
        logo: homepage.logo,
        period: {
            start: homepage.comp_start,
            end: homepage.comp_end,
            label: homepage.period_label || null,
            status: getCompetitionWindowStatus(homepage),
        },
    };

    const rules = buildHomepageBlock(homepage.rules);
    const prizes = buildHomepageBlock(homepage.prizes);
    const readme = buildHomepageBlock(homepage.readme);
    if (rules) payload.rules = rules;
    if (prizes) payload.prizes = prizes;
    if (readme) payload.readme = readme;

    return payload;
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

function buildChallengeList(cfg, userId) {
    const activeKeys = new Set();
    if (userId) {
        const rows = db.prepare(
            "SELECT lab_id, type FROM submissions WHERE user_id = ? AND status = 'in_progress'"
        ).all(userId);
        for (const row of rows) {
            activeKeys.add(`${row.type}:${row.lab_id}`);
        }
    }

    const safeLabs = (cfg.labs || []).filter(l => isWindowOpen(l)).map(l => ({
        id: l.id,
        title: l.title,
        type: 'lab',
        points: labMaxPoints(l),
        session_active: activeKeys.has(`lab:${l.id}`),
    }));

    const safeQuizzes = (cfg.quizzes || []).filter(q => isWindowOpen(q)).map(q => ({
        id: q.id,
        title: q.title,
        type: 'quiz',
        points: quizMaxPoints(q),
        session_active: activeKeys.has(`quiz:${q.id}`),
    }));

    return [...safeLabs, ...safeQuizzes];
}

router.get('/config', configLimiter, (req, res) => {
    const cfg = getConfig();
    const isAuthenticated = req.session && req.session.userId;
    const payload = {
        challenges: isAuthenticated ? buildChallengeList(cfg, req.session.userId) : [],
        options: appOptions(),
    };
    const homepage = buildHomepagePayload(cfg.homepage);
    if (homepage) payload.homepage = homepage;
    res.json(payload);
});

router.get('/bootstrap', bootstrapLimiter, (req, res) => {
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ error: 'Not logged in' });
    }

    const user = db.prepare('SELECT username, is_admin, is_owner, discord_id FROM users WHERE id = ?').get(req.session.userId);
    const cfg = getConfig();

    res.json({
        user: buildSessionUserPayload(req.session, user),
        csrfToken: ensureCsrfToken(req),
        challenges: buildChallengeList(cfg, req.session.userId),
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

    const totalAttempts = db.countLabAttempts(req.session.userId, lab.id);
    
    const activeSession = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
        .get(req.session.userId, lab.id);

    let timeRemaining = null;
    let sessionActive = false;

    const timeLimitMinutes = labSessionService.getTimeLimitMinutes(lab);

    if (activeSession) {
        sessionActive = true;
        if (timeLimitMinutes > 0) {
            timeRemaining = labSessionService.getTimeRemainingSeconds(activeSession.timestamp, timeLimitMinutes);

            if (labSessionService.isTimeExpired(activeSession.timestamp, timeLimitMinutes)) {
                labSessionService.closeExpiredSession(activeSession.id, activeSession.timestamp, 'Time expired.');
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
        max_upload_mb: resolveUploadMb(lab.max_upload_mb),
        has_pka_file: !!lab.pka_file,
        live_streaming: lab.live_streaming === true,
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

    const timeLimitMinutes = labSessionService.getTimeLimitMinutes(lab);
    const maxSubmissions = getConfigNumber(lab.max_submissions, 0);

    const startSession = db.transaction(() => {
        const existing = db.prepare("SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1")
            .get(req.session.userId, lab.id);

        if (existing) {
            let timeRemaining = null;
            if (timeLimitMinutes > 0) {
                timeRemaining = labSessionService.getTimeRemainingSeconds(existing.timestamp, timeLimitMinutes);

                if (labSessionService.isTimeExpired(existing.timestamp, timeLimitMinutes)) {
                    labSessionService.closeExpiredSession(existing.id, existing.timestamp, 'Time expired.');
                    const expiredError = maxSubmissions > 0
                        ? 'Your previous session has expired.'
                        : 'Time limit expired for this lab.';
                    return { error: expiredError, code: 403 };
                }
            }

            return { resumed: true, timeRemaining };
        }

        if (labSessionService.isRestartBlockedAfterTimeLimit(req.session.userId, lab.id, timeLimitMinutes, maxSubmissions)) {
            return { error: 'Time limit expired for this lab.', code: 403 };
        }

        let sql = "INSERT INTO submissions (user_id, unique_id, lab_id, status, type) " +
            "SELECT ?, ?, ?, 'in_progress', 'lab' " +
            "WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab')";
        const params = [req.session.userId, req.session.uniqueId, lab.id, req.session.userId, lab.id];
        if (maxSubmissions > 0) {
            sql += " AND (SELECT COUNT(*) FROM submissions WHERE user_id = ? AND lab_id = ? AND COALESCE(stream_poll, 0) = 0) < ?";
            params.push(req.session.userId, lab.id, maxSubmissions);
        }
        const insertResult = db.prepare(sql).run(...params);

        if (insertResult.changes === 0) {
            const active = db.prepare(
                "SELECT id, timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1"
            ).get(req.session.userId, lab.id);
            if (active) {
                let timeRemaining = null;
                if (timeLimitMinutes > 0) {
                    timeRemaining = labSessionService.getTimeRemainingSeconds(active.timestamp, timeLimitMinutes);
                }
                return { resumed: true, timeRemaining };
            }
            if (maxSubmissions > 0 && db.countLabAttempts(req.session.userId, lab.id) >= maxSubmissions) {
                return { error: "Maximum attempts reached.", code: 403 };
            }
            return { error: "Could not start lab session.", code: 409 };
        }

        let timeRemaining = null;
        if (timeLimitMinutes > 0) {
            const inserted = db.prepare(
                "SELECT timestamp FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'lab' ORDER BY id DESC LIMIT 1"
            ).get(req.session.userId, lab.id);
            timeRemaining = labSessionService.getTimeRemainingSeconds(inserted.timestamp, timeLimitMinutes);
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
            live_streaming: lab.live_streaming === true,
            max_upload_mb: resolveUploadMb(lab.max_upload_mb),
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

    const timeLimitMinutes = labSessionService.getTimeLimitMinutes(lab);
    if (timeLimitMinutes > 0 && labSessionService.isTimeExpired(activeSession.timestamp, timeLimitMinutes)) {
        labSessionService.closeExpiredSession(activeSession.id, activeSession.timestamp, 'Time expired.');
        return res.status(403).send("Forbidden: Lab session has expired.");
    }

    const safeFilename = path.basename(lab.pka_file);
    if (/[/\\:\0]/.test(safeFilename) || safeFilename.startsWith('.')) {
        return res.status(400).send("Invalid file configuration.");
    }

    let baseDir;
    try {
        baseDir = fs.realpathSync(path.join(__dirname, '../../protected/pka'));
    } catch (e) {
        return res.status(500).send("Server configuration error.");
    }

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
    const { allChallenges, leaderboard: fullBoard } = getCachedLeaderboard(() => buildLeaderboard(cfg));
    const truncated = fullBoard.length > MAX_LEADERBOARD;
    const leaderboard = truncated ? fullBoard.slice(0, MAX_LEADERBOARD) : fullBoard;

    const headers = allChallenges.map(c => ({ id: c.id, title: c.title }));
    res.json({ success: true, labs: headers, leaderboard, truncated, total_entries: fullBoard.length });
});

function formatPlayTime(seconds) {
    if (seconds == null) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

router.get('/leaderboard/user/:username', leaderboardLimiter, (req, res) => {
    if (!req.session || !req.session.userId) return res.status(401).json({ error: "Unauthorized" });
    if (!envBool('SHOW_LEADERBOARD')) {
        return res.status(403).json({ error: "Leaderboard disabled" });
    }

    const username = typeof req.params.username === 'string' ? req.params.username.trim() : '';
    if (!username) return res.status(400).json({ error: "Invalid username." });

    const user = db.prepare('SELECT id, username, score_adjustment, withheld FROM users WHERE username = ?').get(username);
    if (!user) return res.status(404).json({ error: "User not found." });

    const cfg = getConfig();
    const labs = cfg.labs || [];
    const quizzes = cfg.quizzes || [];
    const allChallenges = [
        ...labs.map(l => ({ ...l, type: 'lab' })),
        ...quizzes.map(q => ({ ...q, type: 'quiz' })),
    ];

    const { scoreMap, durationMap } = getBestSubmissionsMaps();
    const entry = buildEntryForUser(user, allChallenges, labs, quizzes, scoreMap, durationMap);

    const challenges = allChallenges.map(ch => {
        let hideScore = false;
        if (ch.type === 'quiz') {
            hideScore = ch.show_score === false;
        } else {
            hideScore = ch.show_score === false;
        }

        if (user.withheld || hideScore) {
            return {
                id: ch.id,
                title: ch.title,
                type: ch.type,
                hidden: hideScore,
                withheld: Boolean(user.withheld),
                best_score: null,
                best_duration_seconds: null,
                records: [],
            };
        }

        const rows = db.prepare(`
            SELECT score, max_score, timestamp, duration_seconds, COALESCE(stream_poll, 0) AS stream_poll
            FROM submissions
            WHERE user_id = ? AND lab_id = ? AND status = 'completed'
            ORDER BY timestamp ASC, id ASC
        `).all(user.id, ch.id);

        const bestScore = scoreMap[user.id]?.[ch.id] ?? null;
        const bestDuration = durationMap[user.id]?.[ch.id] ?? null;
        const officialCount = rows.filter(row => !row.stream_poll).length;

        return {
            id: ch.id,
            title: ch.title,
            type: ch.type,
            live_streaming: ch.type === 'lab' && ch.live_streaming === true,
            hidden: false,
            withheld: false,
            best_score: bestScore,
            best_duration_seconds: bestDuration,
            submission_count: officialCount,
            records: rows.map(row => ({
                timestamp: row.timestamp,
                chart_time: chartTimeMs(row),
                score: row.score,
                max_score: row.max_score,
                duration_seconds: row.duration_seconds,
                stream_poll: Boolean(row.stream_poll),
                play_time: formatPlayTime(row.duration_seconds),
            })),
        };
    });

    res.json({
        success: true,
        user: {
            username: user.username,
            total_score: entry ? entry.total_score : 0,
            total_time_seconds: entry ? entry.total_time_seconds : null,
            withheld: Boolean(user.withheld),
        },
        challenges,
    });
});

function formatHistoryRow(sub, cfg) {
    let showScore = true;
    let showDetails = true;
    let showMissed = false;
    const type = sub.type || 'lab';
    let title = sub.lab_id;

    if (type === 'quiz') {
        const qCfg = (cfg.quizzes || []).find(q => q.id === sub.lab_id);
        if (qCfg) {
            title = qCfg.title || title;
            showScore = qCfg.show_score !== false;
            showDetails = qCfg.show_corrections !== false;
            showMissed = qCfg.show_missed_points === true;
        }
    } else {
        const lCfg = (cfg.labs || []).find(l => l.id === sub.lab_id);
        if (lCfg) {
            title = lCfg.title || title;
            showScore = lCfg.show_score !== false;
            showDetails = lCfg.show_check_messages !== false;
            showMissed = lCfg.show_missed_points === true;
        }
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
        title,
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