const fs = require('fs');
const path = require('path');
const toml = require('toml');

const TESTING_DIR = path.join(__dirname, '..');

function fixturesAvailable() {
    return fs.existsSync(path.join(TESTING_DIR, 'test.pka'))
        && fs.existsSync(path.join(TESTING_DIR, 'lab.conf'));
}

function loadPkaBuffer() {
    return fs.readFileSync(path.join(TESTING_DIR, 'test.pka'));
}

function loadLabConfig(labId = 'tstrnd') {
    const parsed = toml.parse(fs.readFileSync(path.join(TESTING_DIR, 'lab.conf'), 'utf-8'));
    const lab = (parsed.labs || []).find((l) => l.id === labId);
    if (!lab) throw new Error(`Lab ${labId} not found in testing/lab.conf`);
    return lab;
}

module.exports = {
    TESTING_DIR,
    fixturesAvailable,
    loadPkaBuffer,
    loadLabConfig,
};
