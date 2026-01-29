const express = require('express');
const db = require('../database');
const { getConfig } = require('../config');
const router = express.Router();

function shuffle(array) {
    let currentIndex = array.length, randomIndex;
    while (currentIndex != 0) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }
    return array;
}

// 1. Get Quiz Metadata ONLY (No Questions)
router.get('/:id', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);

    if (!quiz || quiz.enabled === false) return res.status(404).json({ error: "Quiz not found or disabled" });

    // Check attempts for display
    let attemptsTaken = 0;
    try {
        attemptsTaken = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
    } catch(e) {}

    res.json({
        id: quiz.id,
        title: quiz.title,
        time_limit: quiz.time_limit_minutes,
        max_attempts: quiz.max_attempts || 0,
        attempts_taken: attemptsTaken,
        question_count: quiz.questions.length
    });
});

// 2. Start Quiz (Returns Questions)
router.post('/:id/start', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);
    if (!quiz || quiz.enabled === false) return res.status(404).json({ error: "Quiz not found" });

    // Enforce Limits
    if (quiz.max_attempts > 0) {
        const attempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
        if (attempts >= quiz.max_attempts) {
            return res.status(403).json({ error: "Maximum attempts reached." });
        }
    }

    // Sanitize Questions (Strip answers/regex/explanations)
    const safeQuestions = quiz.questions.map((q, idx) => {
        const base = { id: idx, text: q.text, type: q.type, image: q.image };
        
        if (q.type === 'radio' || q.type === 'checkbox') {
            base.answers = q.answers.map((a, aIdx) => ({ id: aIdx, text: a.text }));
        } else if (q.type === 'matching') {
            const rightOptions = q.pairs.map((p, pIdx) => ({ id: pIdx, text: p.right }));
            base.leftItems = q.pairs.map((p, pIdx) => ({ id: pIdx, text: p.left }));
            base.rightOptions = shuffle(rightOptions);
        }
        return base;
    });

    res.json({ questions: safeQuestions });
});

// 3. Submit Quiz
router.post('/:id/submit', (req, res) => {
    if (!req.session.userId) return res.status(401).json({ error: "Unauthorized" });

    const cfg = getConfig();
    const quiz = (cfg.quizzes || []).find(q => q.id === req.params.id);
    if (!quiz || quiz.enabled === false) return res.status(404).json({ error: "Quiz not found" });

    // Enforce limits on submission too (prevent race conditions)
    if (quiz.max_attempts > 0) {
        const attempts = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE user_id = ? AND lab_id = ?').get(req.session.userId, quiz.id).c;
        if (attempts >= quiz.max_attempts) {
            return res.status(403).json({ error: "Submission rejected: Limit reached." });
        }
    }

    const userAnswers = req.body.answers || {}; 
    let score = 0;
    const maxScore = quiz.questions.length;
    const breakdown = [];

    quiz.questions.forEach((q, idx) => {
        const input = userAnswers[idx];
        let isCorrect = false;

        if (q.type === 'radio') {
            const ansId = parseInt(input);
            if (!isNaN(ansId) && q.answers[ansId] && q.answers[ansId].correct) isCorrect = true;
        } 
        else if (q.type === 'checkbox') {
            if (Array.isArray(input)) {
                const selected = input.map(i => parseInt(i)).sort().toString();
                const correctIndices = q.answers.map((a, i) => a.correct ? i : -1).filter(i => i !== -1).sort().toString();
                if (selected === correctIndices) isCorrect = true;
            }
        } 
        else if (q.type === 'text') {
            if (input && typeof input === 'string') {
                const re = new RegExp(q.regex, 'i');
                if (re.test(input.trim())) isCorrect = true;
            }
        }
        else if (q.type === 'matching') {
            if (input && typeof input === 'object') {
                const totalPairs = q.pairs.length;
                let matches = 0;
                Object.keys(input).forEach(leftId => {
                    if (parseInt(leftId) === parseInt(input[leftId])) matches++;
                });
                if (matches === totalPairs) isCorrect = true;
            }
        }

        if (isCorrect) score++;

        breakdown.push({
            questionIdx: idx,
            message: `Question ${idx + 1}`,
            possible: 1,
            awarded: isCorrect ? 1 : 0,
            correct: isCorrect,
            explanation: q.explanation || (isCorrect ? "Correct" : "Incorrect")
        });
    });

    db.prepare('INSERT INTO submissions (user_id, unique_id, lab_id, score, max_score, details, type) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.session.userId, req.session.uniqueId, quiz.id, score, maxScore, JSON.stringify(breakdown), 'quiz');

    const showScore = quiz.show_score !== false;
    const showCorrections = quiz.show_corrections !== false;

    // Secure Response: Don't send score if hidden
    res.json({
        success: true,
        score: showScore ? score : null,
        max_score: showScore ? maxScore : null,
        breakdown: showCorrections ? breakdown : null
    });
});

module.exports = router;
