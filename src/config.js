const fs = require('fs');
const toml = require('toml');
const path = require('path');
const { validateConfig } = require('./config/validate');

let config = { labs: [], quizzes: [] };
let rawConfig = '';
let configOverride = null;

function loadConfigFromDisk(options = {}) {
    const projectRoot = options.projectRoot || path.resolve(__dirname, '..');
    const next = { labs: [], quizzes: [] };
    let nextRaw = '';

    const labPath = path.join(projectRoot, 'lab.conf');
    if (fs.existsSync(labPath)) {
        nextRaw = fs.readFileSync(labPath, 'utf-8');
        if (nextRaw.charCodeAt(0) === 0xFEFF) nextRaw = nextRaw.slice(1);
        const parsedLab = toml.parse(nextRaw);
        next.labs = parsedLab.labs || [];
    }

    const quizPath = path.join(projectRoot, 'quiz.conf');
    if (fs.existsSync(quizPath)) {
        let quizRaw = fs.readFileSync(quizPath, 'utf-8');
        if (quizRaw.charCodeAt(0) === 0xFEFF) quizRaw = quizRaw.slice(1);
        const parsedQuiz = toml.parse(quizRaw);
        next.quizzes = parsedQuiz.quizzes || [];
    }

    const validation = validateConfig(next, {
        projectRoot,
        skipAssetChecks: process.env.CSSS_SKIP_ASSET_VALIDATION === 'true' || process.env.NODE_ENV === 'test',
    });
    if (!validation.ok) {
        console.warn('Config validation warnings (server will still start):');
        validation.errors.forEach((e) => console.warn(`   ${e}`));
    }

    return { config: next, rawConfig: nextRaw, validation };
}

function warnValidationErrors(validation) {
    if (!validation || validation.ok) return;
    console.warn('Config validation warnings (server will still start):');
    validation.errors.forEach((e) => console.warn(`   ${e}`));
}

function reloadConfig() {
    configOverride = null;
    const loaded = loadConfigFromDisk();
    config = loaded.config;
    rawConfig = loaded.rawConfig;
    console.log(`CSSS Config loaded. ${config.labs.length} Labs, ${config.quizzes.length} Quizzes.`);
}

function isWindowOpen(challenge) {
    if (!challenge) return true;

    if (!challenge.comp_start && !challenge.comp_end) return true;

    const now = Date.now();

    if (challenge.comp_start) {
        const startTime = new Date(challenge.comp_start).getTime();
        if (isNaN(startTime)) return false;
        if (now < startTime) return false;
    }

    if (challenge.comp_end) {
        const endTime = new Date(challenge.comp_end).getTime();
        if (isNaN(endTime)) return false;
        if (now > endTime) return false;
    }

    return true;
}

if (process.env.NODE_ENV !== 'test') {
    try {
        reloadConfig();
    } catch (e) {
        console.error('FATAL: Could not parse configuration files.');
        console.error(`   ${e.message}`);
        process.exit(1);
    }
}

function getConfig() {
    return configOverride || config;
}

function setConfigOverride(override) {
    configOverride = override;
}

function clearConfigOverride() {
    configOverride = null;
}

module.exports = {
    getConfig,
    getRawConfig: () => rawConfig,
    isWindowOpen,
    reloadConfig,
    loadConfigFromDisk,
    warnValidationErrors,
    setConfigOverride,
    clearConfigOverride,
};
