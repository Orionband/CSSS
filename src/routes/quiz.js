const express = require('express');
 const path = require('path');
 const fs = require('fs');
 const crypto = require('crypto');
const db = require('../database');
const { elapsedSecondsSince } = require('../submissionDuration');
const { getConfig, isWindowOpen } = require('../config');
 const RE2 = require('re2'); // Prevents Catastrophic Backtracking (ReDoS)
const rateLimit = require('express-rate-limit');
const { rateLimitPreset, getConfigNumber, ensureArray } = require('../limits');
const { logServerError } = require('../auditLog');
const router = express.Router();

const quizSubmitLimiter = rateLimit(rateLimitPreset({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: "Too many quiz submissions. Please wait before trying again." },
}));

const quizStartLimiter = rateLimit(rateLimitPreset({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: "Too many quiz starts. Please wait before trying again." },
}));

const quizAssetLimiter = rateLimit(rateLimitPreset({
    windowMs: 60 * 1000,
    max: 10,
    message: { error: "Too many asset downloads. Please wait before trying again." },
}));

const quizLimiter = rateLimit(rateLimitPreset({
    windowMs: 60 * 1000,
    max: 30,
    message: { error: "Too many requests. Please wait before trying again." },
}));

function clearQuizMappings(req, quizId) {
    if (req.session?.quizMappings?.[quizId]) {
        delete req.session.quizMappings[quizId];
        if (Object.keys(req.session.quizMappings).length === 0) delete req.session.quizMappings;
        req.session.save(() => {});
    }
    if (req.session?.userId) {
        db.clearQuizMappingsForUser(req.session.userId, quizId);
    }
}

function safeObject() {
    return Object.create(null);
}

function answerIndexForOpaqueId(mappings, questionIdx, opaqueId, answerCount) {
    const sid = String(opaqueId);
    for (let ai = 0; ai < answerCount; ai++) {
        if (mappings && mappings[`${questionIdx}_${ai}`] === sid) return ai;
    }
    return -1;
}

function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex != 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

function parseDbTime(dbTimestamp) {
    return new Date(dbTimestamp.replace(' ', 'T') + 'Z').getTime();
}

/** RE2 flags for text questions: default case-insensitive; set regex_flags in quiz config (e.g. "" or "m"). */
function quizTextRegexFlags(q) {
    if (q.regex_flags === undefined || q.regex_flags === null) return 'i';
    return String(q.regex_flags).replace(/[^im]/g, '');
}

setInterval(() => {
    try {
        const inProgress = db.prepare("SELECT * FROM submissions WHERE status = 'in_progress' AND type = 'quiz'").all();
        const cfg = getConfig();
        const quizzes = cfg.quizzes || [];

        inProgress.forEach(sub => {
            const qCfg = quizzes.find(q => q.id === sub.lab_id);
            if (!qCfg) return;

            let closeSession = false;
            let reason = "";
            const timeLimitMinutes = getConfigNumber(qCfg.time_limit_minutes, 0);

            if (timeLimitMinutes > 0) {
                const startTime = parseDbTime(sub.timestamp);
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                if (elapsedSeconds > (timeLimitMinutes * 60) + 2) {
                    closeSession = true;
                    reason = "Auto-closed: Time limit expired.";
                }
            }

            if (!isWindowOpen(qCfg)) {
                closeSession = true;
                reason = "Auto-closed: Competition window ended.";
            }

            if (!closeSession) return;

            const lockKey = `quiz_${sub.user_id}_${sub.lab_id}`;
            if (!db.acquireLock(lockKey)) {
                return;
            }

            try {
                const durationSeconds = elapsedSecondsSince(sub.timestamp);
                db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                  .run(JSON.stringify([{message: reason, correct: false}]), durationSeconds, sub.id);
                db.clearQuizMappingsForUser(sub.user_id, sub.lab_id);
            } finally {
                db.releaseLock(lockKey);
            }
        });
    } catch (e) {
        logServerError({ detail: e.message, source: 'quiz_sweeper' });
        console.error("Error in quiz sweeper:", e.message);
    }
}, 60 * 1000);

router.get('/asset/:type/:filename', quizAssetLimiter, (req, res) => {
    if (!req.session.userId) return res.status(401).send("Unauthorized");
    
    const type = req.params.type;
    if (type !== 'image' && type !== 'pka' && type !== 'pkt') return res.status(400).send("Invalid asset type");

    const rawFilename = req.params.filename;
    if (!/^[A-Za-z0-9._-]+$/.test(rawFilename) || rawFilename.startsWith('.')) {
        return res.status(400).send("Invalid filename.");
    }
    const safeFilename = rawFilename;
    
    const cfg = getConfig();
    let isFileAllowed = false;
    let allowingQuiz = null;
    const quizzes = cfg.quizzes || [];

    const candidateQuizIds = [];
    const candidateQuizMap = new Map();
    for (const q of quizzes) {
        let containsAsset = false;
        for (const question of ensureArray(q.questions)) {
            if (type === 'image' && question.image === safeFilename) containsAsset = true;
            if (type === 'pka' && question.pka === safeFilename) containsAsset = true;
        }
        if (!containsAsset) continue;
        candidateQuizIds.push(q.id);
        candidateQuizMap.set(q.id, q);
    }

    if (candidateQuizIds.length > 0) {
        const placeholders = candidateQuizIds.map(() => '?').join(',');
        const activeRows = db.prepare(
            `SELECT lab_id FROM submissions WHERE user_id = ? AND lab_id IN (${placeholders}) AND status = 'in_progress' AND type = 'quiz'`
        ).all(req.session.userId, ...candidateQuizIds);
        const activeLabIds = new Set(activeRows.map((r) => r.lab_id));
        for (const labId of candidateQuizIds) {
            if (!activeLabIds.has(labId)) continue;
            isFileAllowed = true;
            allowingQuiz = candidateQuizMap.get(labId);
            break;
        }
    }

    if (!isFileAllowed) return res.status(403).send("Forbidden: No active quiz session for this asset.");

    // Window check applied after the full search, against the specific quiz that granted access
    if (!isWindowOpen(allowingQuiz)) {
        return res.status(403).send("Forbidden: Competition window has closed.");
    }

    // Resolve baseDir canonically so the containment check compares real paths on both sides
    let baseDir;
    try {
        baseDir = fs.realpathSync(path.join(__dirname, '../../protected', type === 'image' ? 'images' : 'pka'));
    } catch (e) {
        return res.status(500).send("Server configuration error.");
    }

    // realpathSync follows all symlinks to the final target; throws if path doesn't exist.
    // The containment check then compares two canonical paths, closing the symlink traversal gap.
    let assetPath;
    try {
        assetPath = fs.realpathSync(path.join(baseDir, safeFilename));
    } catch (e) {
        return res.status(404).send("File not found.");
    }

    if (!assetPath.startsWith(baseDir + path.sep) && assetPath !== baseDir) {
        return res.status(404).send("File not found.");
    }

    try {
        // statSync (not lstatSync) — realpathSync already resolved any symlinks above
        const stats = fs.statSync(assetPath);
        if (!stats.isFile()) {
            return res.status(404).send("File not found.");
        }
    } catch (e) {
        return res.status(404).send("File not found.");
    }

    if (type === 'pka') res.download(assetPath, safeFilename);
    else res.sendFile(assetPath);
});

router.get('/:id', quizLimiter, (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);

    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    // Return minimal metadata before the window opens — enough for the UI to show
    // the quiz exists, but without attempt counts or session details that are only
    // relevant once the window is active or after it closes.
    if (!isWindowOpen(quiz)) {
        return res.json({ id: quiz.id, window_open: false });
    }

    let attemptsTaken = 0;
    try {
        attemptsTaken = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
    } catch(e) {}

    let sessionActive = false;
    let timeRemaining = null;
    const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);
    const timeLimitMinutes = getConfigNumber(quiz.time_limit_minutes, 0);

    if (existingInProgress) {
        sessionActive = true;
        if (timeLimitMinutes > 0) {
            const startTime = parseDbTime(existingInProgress.timestamp);
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            timeRemaining = Math.max(0, (timeLimitMinutes * 60) - elapsedSeconds);

            if (timeRemaining <= 0) {
                const durationSeconds = elapsedSecondsSince(existingInProgress.timestamp);
                db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                  .run(JSON.stringify([{message: "Time expired", correct: false}]), durationSeconds, existingInProgress.id);
                clearQuizMappings(req, quiz.id);
                sessionActive = false;
                timeRemaining = null;
            }
        }
    }

    res.json({
        id: quiz.id,
        title: quiz.title,
        time_limit: getConfigNumber(quiz.time_limit_minutes, 0),
        max_attempts: getConfigNumber(quiz.max_attempts, 0),
        attempts_taken: attemptsTaken,
        question_count: ensureArray(quiz.questions).length,
        session_active: sessionActive,
        time_remaining_seconds: timeRemaining
    });
});

router.post('/:id/start', quizStartLimiter, (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    if (!isWindowOpen(quiz)) {
        return res.status(403).json({ error: "Quiz is currently closed outside of the competition window." });
    }

    const timeLimitMinutes = getConfigNumber(quiz.time_limit_minutes, 0);
    let timeRemaining = timeLimitMinutes * 60;
    const maxAttempts = getConfigNumber(quiz.max_attempts, 0);
    const rateLimitCount = getConfigNumber(quiz.rate_limit_count, 0);
    const rateLimitWindow = getConfigNumber(quiz.rate_limit_window_seconds, 60);

    const startQuiz = db.transaction(() => {
        const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);

        if (existingInProgress) {
            if (timeLimitMinutes > 0) {
                const startTime = parseDbTime(existingInProgress.timestamp);
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                timeRemaining = Math.max(0, timeRemaining - elapsedSeconds);

                if (timeRemaining <= 0) {
                    const durationSeconds = elapsedSecondsSince(existingInProgress.timestamp);
                    db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                      .run(JSON.stringify([{message: "Time expired", correct: false}]), durationSeconds, existingInProgress.id);
                    return { error: "Time limit expired for this attempt.", code: 403, clearMappings: true };
                }
            }
            return { success: true };
        }

        let sql = "INSERT INTO submissions (user_id, unique_id, lab_id, status, type) " +
            "SELECT ?, ?, ?, 'in_progress', 'quiz' " +
            "WHERE NOT EXISTS (SELECT 1 FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz')";
        const params = [req.session.userId, req.session.uniqueId, quiz.id, req.session.userId, quiz.id];
        if (maxAttempts > 0) {
            sql += " AND (SELECT COUNT(*) FROM submissions WHERE user_id = ? AND lab_id = ?) < ?";
            params.push(req.session.userId, quiz.id, maxAttempts);
        }
        if (rateLimitCount > 0) {
            sql += " AND (SELECT COUNT(*) FROM submissions WHERE user_id = ? AND lab_id = ? AND timestamp > datetime('now', '-' || ? || ' seconds')) < ?";
            params.push(req.session.userId, quiz.id, rateLimitWindow, rateLimitCount);
        }
        const result = db.prepare(sql).run(...params);
        if (result.changes === 0) {
            const hasActive = db.prepare(
                "SELECT 1 AS ok FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' LIMIT 1"
            ).get(req.session.userId, quiz.id);
            if (hasActive) {
                return { error: "An active quiz session already exists.", code: 409 };
            }
            if (rateLimitCount > 0) {
                const recent = db.prepare(
                    "SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ? AND timestamp > datetime('now', '-' || ? || ' seconds')"
                ).get(req.session.userId, quiz.id, rateLimitWindow).c;
                if (recent >= rateLimitCount) {
                    return { error: "Rate limit exceeded. Please wait before starting another attempt.", code: 429 };
                }
            }
            if (maxAttempts > 0) {
                const attempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
                if (attempts >= maxAttempts) {
                    return { error: "Maximum attempts reached.", code: 403 };
                }
            }
            return { error: "Could not start quiz session.", code: 409 };
        }
        return { success: true };
    });

    try {
        const result = startQuiz();
        if (result.error) {
            if (result.clearMappings) clearQuizMappings(req, quiz.id);
            return res.status(result.code).json({ error: result.error });
        }
    } catch (e) {
        logServerError({ userId: req.session.userId, labId: quiz.id, detail: e.message, source: 'quiz' });
        return res.status(500).json({ error: "An internal error occurred." });
    }

    const quizMappings = {};
    const safeQuestions = ensureArray(quiz.questions).map((q, idx) => {
        const qType = String(q.type || '');
        if (!['radio', 'checkbox', 'text', 'matching'].includes(qType)) {
            console.warn(`Skipping question ${idx} with invalid type: ${qType}`);
            return null;
        }
        const base = { id: idx, text: String(q.text || ''), type: qType, image: q.image || null, pka: q.pka || null, points: q.points !== undefined ? parseInt(q.points) : 1 };
        if (qType === 'radio' || qType === 'checkbox') {
            if (!Array.isArray(q.answers)) {
                console.warn(`Skipping question ${idx}: answers must be an array`);
                return null;
            }
            base.answers = q.answers.map((a, aIdx) => {
                const opaqueId = crypto.randomBytes(8).toString('hex');
                quizMappings[`${idx}_${aIdx}`] = opaqueId;
                return { id: opaqueId, text: String(a.text || '') };
            });
        } else if (qType === 'matching') {
            if (!Array.isArray(q.pairs)) {
                console.warn(`Skipping question ${idx}: pairs must be an array`);
                return null;
            }
            const rightOptions = q.pairs.map((p, pIdx) => {
                const opaqueId = crypto.randomBytes(8).toString('hex');
                quizMappings[`${idx}_${pIdx}`] = opaqueId;
                return { id: opaqueId, text: String(p.right || '') };
            });
            base.leftItems = q.pairs.map((p, pIdx) => ({ id: pIdx, text: String(p.left || '') }));
            base.rightOptions = shuffle(rightOptions);
        } else if (qType === 'text') {
            if (!q.regex) {
                console.warn(`Skipping question ${idx}: regex is required for text questions`);
                return null;
            }
        }
        return base;
    }).filter((q) => q !== null);
    if (!req.session.quizMappings) req.session.quizMappings = {};
    req.session.quizMappings[quiz.id] = quizMappings;
    req.session.save((saveErr) => {
        if (saveErr) {
            logServerError({ userId: req.session.userId, labId: quiz.id, detail: saveErr.message, source: 'quiz' });
            console.error('Failed to save quiz mappings to session:', saveErr.message);
        }
        res.json({ questions: safeQuestions, time_remaining_seconds: timeRemaining });
    });
});

router.post('/:id/submit', quizSubmitLimiter, (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    const lockKey = `quiz_${req.session.userId}_${quiz.id}`;
    if (!db.acquireLock(lockKey)) {
        return res.status(429).json({ error: "A submission is currently processing. Please wait." });
    }

    let clearMappingsOnExit = false;
    try {
        if (!isWindowOpen(quiz)) {
            return res.status(403).json({ error: "Submissions are currently closed outside of the competition window." });
        }

        const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);

        if (!existingInProgress) {
            return res.status(403).json({ error: "No active quiz session found." });
        }

        const submitTimeLimitMinutes = getConfigNumber(quiz.time_limit_minutes, 0);
        if (submitTimeLimitMinutes > 0) {
            const startTime = parseDbTime(existingInProgress.timestamp);
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            
            if (elapsedSeconds > (submitTimeLimitMinutes * 60) + 2) {
                 db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ?, duration_seconds = ? WHERE id = ? AND status = 'in_progress'")
                      .run(JSON.stringify([{message: "Submission rejected: Time limit expired.", correct: false}]), elapsedSeconds, existingInProgress.id);
                 clearMappingsOnExit = true;
                 return res.status(403).json({ error: "Time limit expired." });
            }
        }

        const rawAnswers = req.body.answers;
        const userAnswers = safeObject();
        
        const questions = ensureArray(quiz.questions);
        if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
            for (let i = 0; i < questions.length; i++) {
                const key = String(i);
                if (key in rawAnswers) {
                    userAnswers[key] = rawAnswers[key];
                }
            }
        }

        let score = 0;
        let maxScore = 0;
        const breakdown = [];
        const showMissed = quiz.show_missed_points === true;

        const mappings = req.session.quizMappings && req.session.quizMappings[quiz.id];

        questions.forEach((q, idx) => {
            const input = userAnswers[String(idx)];
            let isCorrect = false;

            if (q.type === 'radio') {
                if (typeof input !== 'undefined' && input !== null) {
                    const ansIdx = answerIndexForOpaqueId(mappings, idx, input, q.answers.length);
                    if (ansIdx >= 0 && q.answers[ansIdx] && q.answers[ansIdx].correct) isCorrect = true;
                }
            } 
            else if (q.type === 'checkbox') {
                if (Array.isArray(input)) {
                    const selected = input
                        .map((i) => answerIndexForOpaqueId(mappings, idx, i, q.answers.length))
                        .filter((i) => i >= 0)
                        .sort()
                        .toString();
                    const correctIndices = q.answers.map((a, i) => a.correct ? i : -1).filter(i => i !== -1).sort().toString();
                    if (selected === correctIndices) isCorrect = true;
                }
            } 
            else if (q.type === 'text') {
                if (typeof input === 'string' && input.trim() !== '') {
                    const sanitizedInput = input.trim().substring(0, 200);
                    try {
                        const re = new RE2(q.regex, quizTextRegexFlags(q));
                        if (re.test(sanitizedInput)) isCorrect = true;
                    } catch (e) {} 
                }
            }
            else if (q.type === 'matching') {
                    if (input && typeof input === 'object' && !Array.isArray(input)) {
                      const mappings = req.session.quizMappings && req.session.quizMappings[quiz.id];
                      if (mappings) {
                        const totalPairs = q.pairs.length;
                        let matches = 0;
                        let validEntries = 0;
                        for (let pairIdx = 0; pairIdx < totalPairs; pairIdx++) {
                          const key = String(pairIdx);
                          if (key in input) {
                            validEntries++;
                            const expectedOpaqueId = mappings[`${idx}_${pairIdx}`];
                            if (expectedOpaqueId && String(input[key]) === String(expectedOpaqueId)) {
                              matches++;
                            }
                          }
                        }
                        if (matches === totalPairs && validEntries === totalPairs) isCorrect = true;
                      }
                    }
                  }

            const pts = (q.points !== undefined && !isNaN(parseInt(q.points))) ? parseInt(q.points) : 1;
            maxScore += pts;
            
            if (isCorrect) {
                score += pts;
            }

            if (isCorrect || showMissed) {
                breakdown.push({
                    questionIdx: idx,
                    message: `Question ${idx + 1}`,
                    possible: pts,
                    awarded: isCorrect ? pts : 0,
                    correct: isCorrect,
                    explanation: q.explanation || (isCorrect ? "Correct" : "Incorrect")
                });
            }
        });

        const durationSeconds = elapsedSecondsSince(existingInProgress.timestamp);
        const updateResult = db.prepare(
            "UPDATE submissions SET score = ?, max_score = ?, details = ?, status = 'completed', duration_seconds = ? WHERE id = ? AND status = 'in_progress'"
        ).run(score, maxScore, JSON.stringify(breakdown), durationSeconds, existingInProgress.id);
        if (updateResult.changes === 0) {
            clearMappingsOnExit = true;
            return res.status(403).json({ error: 'Quiz session ended before your submission was recorded.' });
        }

        const showScore = quiz.show_score !== false;
        const showCorrections = quiz.show_corrections !== false;

        clearMappingsOnExit = true;
        res.json({
            success: true,
            score: showScore ? score : null,
            max_score: showScore ? maxScore : null,
            breakdown: showCorrections ? breakdown : null
        });
    } catch (e) {
        logServerError({ userId: req.session.userId, labId: quiz.id, detail: e.message, source: 'quiz_submit' });
        res.status(500).json({ error: "An internal error occurred." });
    } finally {
        db.releaseLock(lockKey);
        if (clearMappingsOnExit) clearQuizMappings(req, quiz.id);
    }
});

module.exports = router;