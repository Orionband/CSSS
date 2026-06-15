const fs = require('fs');
const path = require('path');
const RE2 = require('re2');

const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const CHECK_TYPES = new Set([
    'ConfigMatch', 'ConfigRegex', 'XmlMatch', 'XmlRegex', 'Type5Match',
    'ConfigMatchNot', 'ConfigRegexNot', 'XmlMatchNot', 'XmlRegexNot', 'Type5MatchNot',
]);
const QUIZ_TYPES = new Set(['radio', 'checkbox', 'text', 'matching']);
const SOCKET_MAX_UPLOAD_MB = 50;

function parseDateMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isNaN(ms) ? null : ms;
}

function tryCompileRegex(pattern, context) {
    if (typeof pattern !== 'string' || !pattern) {
        return `${context}: regex pattern must be a non-empty string`;
    }
    try {
        // eslint-disable-next-line no-new
        new RE2(pattern);
        return null;
    } catch (e) {
        return `${context}: invalid regex — ${e.message}`;
    }
}

function asBlockArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

function validateCheckBlock(block, context, errors) {
    if (!block || typeof block !== 'object') {
        errors.push(`${context}: check block must be an object`);
        return;
    }
    const type = block.type;
    if (typeof type !== 'string' || !CHECK_TYPES.has(type)) {
        errors.push(`${context}: unknown or missing check type "${type}"`);
        return;
    }
    const baseType = type.endsWith('Not') ? type.slice(0, -3) : type;
    if (baseType === 'ConfigRegex' || baseType === 'XmlRegex') {
        const err = tryCompileRegex(block.value, context);
        if (err) errors.push(err);
    }
    if (baseType === 'Type5Match') {
        if (!block.password) errors.push(`${context}: Type5Match requires password`);
        if (!block.mode) errors.push(`${context}: Type5Match requires mode`);
    }
    if (baseType === 'XmlMatch' || baseType === 'XmlRegex') {
        if (!block.path) errors.push(`${context}: ${baseType} requires path`);
    }
}

function validateLab(lab, index, projectRoot, errors, options) {
    const prefix = `lab[${index}]`;
    if (!lab.id || typeof lab.id !== 'string') {
        errors.push(`${prefix}: missing id`);
    } else if (!ID_PATTERN.test(lab.id)) {
        errors.push(`${prefix}: id "${lab.id}" must match ${ID_PATTERN}`);
    }
    if (!lab.title || typeof lab.title !== 'string') {
        errors.push(`${prefix}: missing title`);
    }

    const startMs = parseDateMs(lab.comp_start);
    const endMs = parseDateMs(lab.comp_end);
    if (lab.comp_start && startMs === null) errors.push(`${prefix}: invalid comp_start`);
    if (lab.comp_end && endMs === null) errors.push(`${prefix}: invalid comp_end`);
    if (startMs !== null && endMs !== null && startMs >= endMs) {
        errors.push(`${prefix}: comp_start must be before comp_end`);
    }

    if (lab.pka_file && !options.skipAssetChecks) {
        const pkaPath = path.resolve(projectRoot, lab.pka_file);
        if (!fs.existsSync(pkaPath)) {
            errors.push(`${prefix}: pka_file not found: ${lab.pka_file}`);
        }
    }

    if (lab.max_upload_mb !== undefined) {
        const mb = Number(lab.max_upload_mb);
        if (!Number.isFinite(mb) || mb <= 0 || mb > SOCKET_MAX_UPLOAD_MB) {
            errors.push(`${prefix}: max_upload_mb must be between 1 and ${SOCKET_MAX_UPLOAD_MB}`);
        }
    }
    if (lab.max_xml_output_mb !== undefined) {
        const mb = Number(lab.max_xml_output_mb);
        if (!Number.isFinite(mb) || mb <= 0) {
            errors.push(`${prefix}: max_xml_output_mb must be positive`);
        }
    }

    const checks = lab.checks || [];
    if (!Array.isArray(checks)) {
        errors.push(`${prefix}: checks must be an array`);
        return;
    }
    checks.forEach((check, ci) => {
        const ctx = `${prefix}.checks[${ci}]`;
        if (!check.device) errors.push(`${ctx}: missing device`);
        if (check.points === undefined) errors.push(`${ctx}: missing points`);

        const passBlocks = asBlockArray(check.pass).filter(Boolean);
        const passOverrideBlocks = asBlockArray(check.passoverride).filter(Boolean);
        const failBlocks = asBlockArray(check.fail).filter(Boolean);

        if (passBlocks.length === 0 && passOverrideBlocks.length === 0) {
            errors.push(`${ctx}: requires at least one pass or passoverride condition`);
        }

        passBlocks.forEach((b, bi) => {
            validateCheckBlock(b, `${ctx}.pass[${bi}]`, errors);
        });
        passOverrideBlocks.forEach((b, bi) => {
            validateCheckBlock(b, `${ctx}.passoverride[${bi}]`, errors);
        });
        failBlocks.forEach((b, bi) => {
            validateCheckBlock(b, `${ctx}.fail[${bi}]`, errors);
        });
    });
}

function validateQuiz(quiz, index, errors) {
    const prefix = `quiz[${index}]`;
    if (!quiz.id || typeof quiz.id !== 'string') {
        errors.push(`${prefix}: missing id`);
    } else if (!ID_PATTERN.test(quiz.id)) {
        errors.push(`${prefix}: id "${quiz.id}" must match ${ID_PATTERN}`);
    }

    const startMs = parseDateMs(quiz.comp_start);
    const endMs = parseDateMs(quiz.comp_end);
    if (quiz.comp_start && startMs === null) errors.push(`${prefix}: invalid comp_start`);
    if (quiz.comp_end && endMs === null) errors.push(`${prefix}: invalid comp_end`);
    if (startMs !== null && endMs !== null && startMs >= endMs) {
        errors.push(`${prefix}: comp_start must be before comp_end`);
    }

    const questions = quiz.questions || [];
    if (!Array.isArray(questions)) {
        errors.push(`${prefix}: questions must be an array`);
        return;
    }

    let scorable = 0;
    questions.forEach((q, qi) => {
        const ctx = `${prefix}.questions[${qi}]`;
        const qType = String(q.type || '');
        if (!QUIZ_TYPES.has(qType)) {
            errors.push(`${ctx}: invalid type "${qType}"`);
            return;
        }
        if (qType === 'radio' || qType === 'checkbox') {
            if (!Array.isArray(q.answers) || q.answers.length === 0) {
                errors.push(`${ctx}: answers must be a non-empty array`);
            } else {
                let correctCount = 0;
                let validAnswers = true;
                q.answers.forEach((ans, ai) => {
                    if (!ans || typeof ans !== 'object') {
                        errors.push(`${ctx}.answers[${ai}]: must be an object`);
                        validAnswers = false;
                    } else {
                        if (!ans.text || typeof ans.text !== 'string' || !ans.text.trim()) {
                            errors.push(`${ctx}.answers[${ai}]: missing or empty text`);
                            validAnswers = false;
                        }
                        if (ans.correct === true) correctCount++;
                    }
                });
                if (validAnswers) {
                    if (qType === 'radio' && correctCount !== 1) {
                        errors.push(`${ctx}: radio questions must have exactly one correct answer`);
                    } else if (qType === 'checkbox' && correctCount === 0) {
                        errors.push(`${ctx}: checkbox questions must have at least one correct answer`);
                    } else {
                        scorable++;
                    }
                }
            }
        } else if (qType === 'matching') {
            if (!Array.isArray(q.pairs) || q.pairs.length === 0) {
                errors.push(`${ctx}: pairs must be a non-empty array`);
            } else {
                scorable++;
            }
        } else if (qType === 'text') {
            if (!q.regex) {
                errors.push(`${ctx}: text questions require regex`);
            } else {
                const err = tryCompileRegex(q.regex, ctx);
                if (err) errors.push(err);
                else scorable++;
            }
        }
    });

    if (questions.length > 0 && scorable === 0) {
        errors.push(`${prefix}: no scorable questions after validation`);
    }
}

function validateConfig(config, options = {}) {
    const projectRoot = options.projectRoot || path.resolve(__dirname, '../..');
    const errors = [];
    const labs = config.labs || [];
    const quizzes = config.quizzes || [];

    const labIds = new Set();
    labs.forEach((lab, i) => {
        if (lab.id) {
            if (labIds.has(lab.id)) errors.push(`Duplicate lab id: ${lab.id}`);
            labIds.add(lab.id);
        }
        validateLab(lab, i, projectRoot, errors, options);
    });

    const quizIds = new Set();
    quizzes.forEach((quiz, i) => {
        if (quiz.id) {
            if (quizIds.has(quiz.id)) errors.push(`Duplicate quiz id: ${quiz.id}`);
            quizIds.add(quiz.id);
        }
        validateQuiz(quiz, i, errors);
    });

    return { ok: errors.length === 0, errors };
}

module.exports = { validateConfig, CHECK_TYPES, QUIZ_TYPES };
