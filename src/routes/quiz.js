const express = require('express');
 const path = require('path');
 const fs = require('fs');
 const crypto = require('crypto');
 const db = require('../database');
 const { getConfig, isWindowOpen } = require('../config');
 const RE2 = require('re2'); // Prevents Catastrophic Backtracking (ReDoS)
const rateLimit = require('express-rate-limit');
const router = express.Router();

const quizSubmitLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many quiz submissions. Please wait before trying again." },
});

function safeObject() {
    return Object.create(null);
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
            if (qCfg) {
                let closeSession = false;
                let reason = "";

                if (qCfg.time_limit_minutes > 0) {
                    const startTime = parseDbTime(sub.timestamp);
                    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                    if (elapsedSeconds > (qCfg.time_limit_minutes * 60) + 2) {
                        closeSession = true;
                        reason = "Auto-closed: Time limit expired.";
                    }
                }

                if (!isWindowOpen(qCfg)) {
                    closeSession = true;
                    reason = "Auto-closed: Competition window ended.";
                }

                if (closeSession) {
                    db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ? WHERE id = ?")
                      .run(JSON.stringify([{message: reason, correct: false}]), sub.id);
                }
            }
        });
    } catch (e) {
        console.error("Error in quiz sweeper:", e.message);
    }
}, 60 * 1000);

router.get('/asset/:type/:filename', (req, res) => {
    if (!req.session.userId) return res.status(401).send("Unauthorized");
    
    const type = req.params.type;
    if (type !== 'image' && type !== 'pka' && type !== 'pkt') return res.status(400).send("Invalid asset type");

    const safeFilename = path.basename(req.params.filename);
    
    if (/[/\\:\0]/.test(safeFilename) || safeFilename.startsWith('.')) {
        return res.status(400).send("Invalid filename.");
    }
    
    const cfg = getConfig();
    let isFileAllowed = false;
    let allowingQuiz = null;
    const quizzes = cfg.quizzes || [];
    
    for (const q of quizzes) {
        let containsAsset = false;
        for (const question of (q.questions || [])) {
            if (type === 'image' && question.image === safeFilename) containsAsset = true;
            if (type === 'pka' && question.pka === safeFilename) containsAsset = true;
        }

        if (!containsAsset) continue;

        const activeSession = db.prepare("SELECT id FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz'")
            .get(req.session.userId, q.id);
        
        if (activeSession) {
            isFileAllowed = true;
            allowingQuiz = q;
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
        return res.status(403).send("Forbidden.");
    }

    try {
        // statSync (not lstatSync) — realpathSync already resolved any symlinks above
        const stats = fs.statSync(assetPath);
        if (!stats.isFile()) {
            return res.status(404).send("Not found.");
        }
    } catch (e) {
        return res.status(404).send("File not found.");
    }

    if (type === 'pka') res.download(assetPath, safeFilename);
    else res.sendFile(assetPath);
});

router.get('/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);

    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    // Return minimal metadata before the window opens — enough for the UI to show
    // the quiz exists, but without attempt counts or session details that are only
    // relevant once the window is active or after it closes.
    if (!isWindowOpen(quiz)) {
        return res.json({ id: quiz.id, title: quiz.title, window_open: false });
    }

    let attemptsTaken = 0;
    try {
        attemptsTaken = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
    } catch(e) {}

    let sessionActive = false;
    let timeRemaining = null;
    const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);

    if (existingInProgress) {
        sessionActive = true;
        if (quiz.time_limit_minutes > 0) {
            const startTime = parseDbTime(existingInProgress.timestamp);
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            timeRemaining = Math.max(0, (quiz.time_limit_minutes * 60) - elapsedSeconds);

            if (timeRemaining <= 0) {
                db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ? WHERE id = ?")
                  .run(JSON.stringify([{message: "Time expired", correct: false}]), existingInProgress.id);
                sessionActive = false;
                timeRemaining = null;
            }
        }
    }

    res.json({
        id: quiz.id,
        title: quiz.title,
        time_limit: quiz.time_limit_minutes,
        max_attempts: quiz.max_attempts || 0,
        attempts_taken: attemptsTaken,
        question_count: quiz.questions.length,
        session_active: sessionActive,
        time_remaining_seconds: timeRemaining
    });
});

router.post('/:id/start', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);
    if (!quiz) return res.status(404).json({ error: "Quiz not found." });

    if (!isWindowOpen(quiz)) {
        return res.status(403).json({ error: "Quiz is currently closed outside of the competition window." });
    }

    let timeRemaining = quiz.time_limit_minutes * 60;

    const startQuiz = db.transaction(() => {
        const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);

        if (existingInProgress) {
            if (quiz.time_limit_minutes > 0) {
                const startTime = parseDbTime(existingInProgress.timestamp);
                const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
                timeRemaining = Math.max(0, timeRemaining - elapsedSeconds);

                if (timeRemaining <= 0) {
                    db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ? WHERE id = ?")
                      .run(JSON.stringify([{message: "Time expired", correct: false}]), existingInProgress.id);
                    return { error: "Time limit expired for this attempt.", code: 403 };
                }
            }
        } else {
            const rateLimitCount = quiz.rate_limit_count || 0;
            const rateLimitWindow = quiz.rate_limit_window_seconds || 60;
            
            if (rateLimitCount > 0) {
                const recent = db.prepare("SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ? AND timestamp > datetime('now', '-' || ? || ' seconds')").get(req.session.userId, quiz.id, rateLimitWindow).c;
                if (recent >= rateLimitCount) {
                    return { error: "Rate limit exceeded. Please wait before starting another attempt.", code: 429 };
                }
            }

            if (quiz.max_attempts > 0) {
                const attempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
                if (attempts >= quiz.max_attempts) return { error: "Maximum attempts reached.", code: 403 };
            }
            
            db.prepare("INSERT INTO submissions (user_id, unique_id, lab_id, status, type) VALUES (?, ?, ?, 'in_progress', 'quiz')")
              .run(req.session.userId, req.session.uniqueId, quiz.id);
        }
        return { success: true };
    });

    try {
        const result = startQuiz();
        if (result.error) return res.status(result.code).json({ error: result.error });
    } catch (e) {
        return res.status(500).json({ error: "An internal error occurred." });
    }

    const matchingMappings = {};
        const safeQuestions = quiz.questions.map((q, idx) => {
          const base = { id: idx, text: q.text, type: q.type, image: q.image, pka: q.pka, points: q.points !== undefined ? parseInt(q.points) : 1 };
          if (q.type === 'radio' || q.type === 'checkbox') {
            base.answers = q.answers.map((a, aIdx) => ({ id: aIdx, text: a.text }));
          } else if (q.type === 'matching') {
            const rightOptions = q.pairs.map((p, pIdx) => {
              const opaqueId = crypto.randomBytes(8).toString('hex');
              matchingMappings[`${idx}_${pIdx}`] = opaqueId;
              return { id: opaqueId, text: p.right };
            });
            base.leftItems = q.pairs.map((p, pIdx) => ({ id: pIdx, text: p.left }));
            base.rightOptions = shuffle(rightOptions);
          }
          return base;
        });
        if (!req.session.quizMappings) req.session.quizMappings = {};
        req.session.quizMappings[quiz.id] = matchingMappings;
        req.session.save(() => {});
        res.json({ questions: safeQuestions, time_remaining_seconds: timeRemaining });
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

    try {
        if (!isWindowOpen(quiz)) {
            return res.status(403).json({ error: "Submissions are currently closed outside of the competition window." });
        }

        const existingInProgress = db.prepare("SELECT * FROM submissions WHERE user_id = ? AND lab_id = ? AND status = 'in_progress' AND type = 'quiz' ORDER BY id DESC LIMIT 1").get(req.session.userId, quiz.id);

        if (!existingInProgress) {
            return res.status(403).json({ error: "No active quiz session found." });
        }

        if (quiz.time_limit_minutes > 0) {
            const startTime = parseDbTime(existingInProgress.timestamp);
            const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
            
            if (elapsedSeconds > (quiz.time_limit_minutes * 60) + 2) {
                 db.prepare("UPDATE submissions SET status = 'completed', score = 0, details = ? WHERE id = ?")
                      .run(JSON.stringify([{message: "Submission rejected: Time limit expired.", correct: false}]), existingInProgress.id);
                 return res.status(403).json({ error: "Time limit expired." });
            }
        }

        const rawAnswers = req.body.answers;
        const userAnswers = safeObject();
        
        if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
            for (let i = 0; i < quiz.questions.length; i++) {
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

        quiz.questions.forEach((q, idx) => {
            const input = userAnswers[String(idx)];
            let isCorrect = false;

            if (q.type === 'radio') {
                if (typeof input !== 'undefined' && input !== null) {
                    const ansId = parseInt(input);
                    if (!isNaN(ansId) && ansId >= 0 && ansId < q.answers.length && q.answers[ansId] && q.answers[ansId].correct) isCorrect = true;
                }
            } 
            else if (q.type === 'checkbox') {
                if (Array.isArray(input)) {
                    const selected = input.map(i => parseInt(i)).filter(i => !isNaN(i) && i >= 0 && i < q.answers.length).sort().toString();
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

        db.prepare("UPDATE submissions SET score = ?, max_score = ?, details = ?, status = 'completed' WHERE id = ?")
          .run(score, maxScore, JSON.stringify(breakdown), existingInProgress.id);

        const showScore = quiz.show_score !== false;
        const showCorrections = quiz.show_corrections !== false;

        res.json({
            success: true,
            score: showScore ? score : null,
            max_score: showScore ? maxScore : null,
            breakdown: showCorrections ? breakdown : null
        });
    } finally {
        db.releaseLock(lockKey);
        if (req.session.quizMappings && req.session.quizMappings[quiz.id]) {
            delete req.session.quizMappings[quiz.id];
            req.session.save(() => {});
        }
    }
});

module.exports = router;