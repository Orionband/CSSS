#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const toml = require('toml');
const { validateConfig } = require('../src/config/validate');

const projectRoot = path.resolve(__dirname, '..');

function loadToml(filePath) {
    if (!fs.existsSync(filePath)) return {};
    let raw = fs.readFileSync(filePath, 'utf-8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return toml.parse(raw);
}

function main() {
    let config = { labs: [], quizzes: [] };

    try {
        const labPath = path.join(projectRoot, 'lab.conf');
        const quizPath = path.join(projectRoot, 'quiz.conf');
        if (fs.existsSync(labPath)) {
            const parsedLab = loadToml(labPath);
            config.labs = parsedLab.labs || [];
        }
        if (fs.existsSync(quizPath)) {
            const parsedQuiz = loadToml(quizPath);
            config.quizzes = parsedQuiz.quizzes || [];
        }
    } catch (e) {
        console.error('TOML parse error:', e.message);
        process.exit(1);
    }

    const result = validateConfig(config, { projectRoot });
    if (!result.ok) {
        console.error('Config validation failed:');
        result.errors.forEach((err) => console.error(`  - ${err}`));
        process.exit(1);
    }

    console.log(`Config OK: ${config.labs.length} lab(s), ${config.quizzes.length} quiz(zes).`);
}

main();
