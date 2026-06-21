const fs = require('fs');
const toml = require('toml');
const path = require('path');
const { validateConfig } = require('./config/validate');

let config = { labs: [], quizzes: [], homepage: null };
let rawConfig = '';
let configOverride = null;

const CONFIGS_DIR = 'configs';

function resolveConfigPaths(projectRoot) {
    const configsDir = path.join(projectRoot, CONFIGS_DIR);
    return {
        configsDir,
        labPath: path.join(configsDir, 'lab.conf'),
        quizPath: path.join(configsDir, 'quiz.conf'),
        homepagePath: path.join(configsDir, 'homepage.conf'),
    };
}

function normalizeBlock(block, defaultTitle) {
    return {
        title: (block && block.title) ? String(block.title).trim() : defaultTitle,
        body: String((block && block.body) || '').trim(),
    };
}

function normalizeHomepage(homepage) {
    if (!homepage || homepage.enabled !== true) return null;
    return {
        enabled: true,
        page_title: String(homepage.page_title || '').trim(),
        subtitle: String(homepage.subtitle || '').trim(),
        logo: String(homepage.logo || '/logo.png').trim(),
        comp_start: homepage.comp_start || null,
        comp_end: homepage.comp_end || null,
        period_label: String(homepage.period_label || '').trim(),
        rules: normalizeBlock(homepage.rules, 'Rules'),
        prizes: normalizeBlock(homepage.prizes, 'Prizes'),
        readme: normalizeBlock(homepage.readme, 'README'),
    };
}

function isHomepageEnabled(cfg) {
    return !!(cfg && cfg.homepage && cfg.homepage.enabled === true);
}

function loadConfigFromDisk(options = {}) {
    const projectRoot = options.projectRoot || path.resolve(__dirname, '..');
    const { labPath, quizPath, homepagePath } = resolveConfigPaths(projectRoot);
    const next = { labs: [], quizzes: [], homepage: null };
    let nextRaw = '';

    if (fs.existsSync(labPath)) {
        nextRaw = fs.readFileSync(labPath, 'utf-8');
        if (nextRaw.charCodeAt(0) === 0xFEFF) nextRaw = nextRaw.slice(1);
        const parsedLab = toml.parse(nextRaw);
        next.labs = parsedLab.labs || [];
    }

    if (fs.existsSync(quizPath)) {
        let quizRaw = fs.readFileSync(quizPath, 'utf-8');
        if (quizRaw.charCodeAt(0) === 0xFEFF) quizRaw = quizRaw.slice(1);
        const parsedQuiz = toml.parse(quizRaw);
        next.quizzes = parsedQuiz.quizzes || [];
    }

    if (fs.existsSync(homepagePath)) {
        let homepageRaw = fs.readFileSync(homepagePath, 'utf-8');
        if (homepageRaw.charCodeAt(0) === 0xFEFF) homepageRaw = homepageRaw.slice(1);
        const parsedHomepage = toml.parse(homepageRaw);
        next.homepage = normalizeHomepage(parsedHomepage.homepage);
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
    const homepageNote = isHomepageEnabled(config) ? ' Homepage enabled.' : '';
    console.log(`CSSS Config loaded. ${config.labs.length} Labs, ${config.quizzes.length} Quizzes.${homepageNote}`);
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

function getCompetitionWindowStatus(item) {
    if (!item) return null;
    if (!item.comp_start && !item.comp_end) return null;

    let startTime = null;
    let endTime = null;

    if (item.comp_start) {
        startTime = new Date(item.comp_start).getTime();
        if (Number.isNaN(startTime)) return null;
    }

    if (item.comp_end) {
        endTime = new Date(item.comp_end).getTime();
        if (Number.isNaN(endTime)) return null;
    }

    const now = Date.now();
    if (startTime !== null && now < startTime) return 'upcoming';
    if (endTime !== null && now > endTime) return 'ended';
    return 'live';
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
    CONFIGS_DIR,
    getConfig,
    getRawConfig: () => rawConfig,
    isWindowOpen,
    getCompetitionWindowStatus,
    isHomepageEnabled,
    reloadConfig,
    loadConfigFromDisk,
    resolveConfigPaths,
    warnValidationErrors,
    setConfigOverride,
    clearConfigOverride,
};
