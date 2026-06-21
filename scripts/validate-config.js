#!/usr/bin/env node
const path = require('path');
const { loadConfigFromDisk } = require('../src/config');

const rootArg = process.argv.indexOf('--project-root');
const projectRoot = rootArg !== -1
    ? path.resolve(process.argv[rootArg + 1])
    : path.resolve(__dirname, '..');

function main() {
    let loaded;
    try {
        loaded = loadConfigFromDisk({ projectRoot });
    } catch (e) {
        console.error('TOML parse error:', e.message);
        process.exit(1);
    }

    if (!loaded.validation.ok) {
        console.error('Config validation failed:');
        loaded.validation.errors.forEach((err) => console.error(`  - ${err}`));
        process.exit(1);
    }

    const { labs, quizzes, homepage } = loaded.config;
    const homepageNote = homepage?.enabled === true ? ', homepage enabled' : '';
    console.log(`Config OK: ${labs.length} lab(s), ${quizzes.length} quiz(zes)${homepageNote}.`);
}

main();
