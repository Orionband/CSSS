const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateConfig } = require('../../src/config/validate');
const { loadConfigFromDisk, isHomepageEnabled, getCompetitionWindowStatus } = require('../../src/config');

describe('homepage config', () => {
    let tmpDir;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csss-homepage-config-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeHomepageConf(contents) {
        const configsDir = path.join(tmpDir, 'configs');
        fs.mkdirSync(configsDir, { recursive: true });
        fs.writeFileSync(path.join(configsDir, 'homepage.conf'), contents);
    }

    it('returns homepage null when file is missing', () => {
        const loaded = loadConfigFromDisk({ projectRoot: tmpDir });
        assert.equal(loaded.config.homepage, null);
        assert.equal(isHomepageEnabled(loaded.config), false);
    });

    it('returns homepage null when enabled is false', () => {
        writeHomepageConf('[homepage]\nenabled = false\npage_title = "Hidden"\n');
        const loaded = loadConfigFromDisk({ projectRoot: tmpDir });
        assert.equal(loaded.config.homepage, null);
        assert.equal(isHomepageEnabled(loaded.config), false);
    });

    it('normalizes enabled homepage with defaults', () => {
        writeHomepageConf([
            '[homepage]',
            'enabled = true',
            'page_title = "Spring Event"',
            '',
            '[homepage.rules]',
            'body = "Be fair"',
        ].join('\n'));

        const loaded = loadConfigFromDisk({ projectRoot: tmpDir });
        assert.equal(isHomepageEnabled(loaded.config), true);
        assert.equal(loaded.config.homepage.page_title, 'Spring Event');
        assert.equal(loaded.config.homepage.logo, '/logo.png');
        assert.equal(loaded.config.homepage.rules.title, 'Rules');
        assert.equal(loaded.config.homepage.rules.body, 'Be fair');
        assert.equal(loaded.config.homepage.readme.title, 'README');
    });

    it('reports validation errors for invalid homepage fields', () => {
        const validation = validateConfig({
            labs: [],
            quizzes: [],
            homepage: {
                enabled: true,
                logo: '/../logo.png',
                comp_start: 'bad-date',
                comp_end: '2099-01-01T00:00:00Z',
                rules: { body: 'x'.repeat(8001) },
            },
        }, { skipAssetChecks: true });

        assert.equal(validation.ok, false);
        assert.ok(validation.errors.some((e) => e.includes('invalid logo path')));
        assert.ok(validation.errors.some((e) => e.includes('invalid comp_start')));
        assert.ok(validation.errors.some((e) => e.includes('rules.body exceeds')));
    });

    it('requires comp_start before comp_end', () => {
        const validation = validateConfig({
            labs: [],
            quizzes: [],
            homepage: {
                enabled: true,
                comp_start: '2099-12-31T00:00:00Z',
                comp_end: '2099-01-01T00:00:00Z',
            },
        }, { skipAssetChecks: true });

        assert.equal(validation.ok, false);
        assert.ok(validation.errors.some((e) => e.includes('comp_start must be before comp_end')));
    });

    it('getCompetitionWindowStatus returns null for invalid dates', () => {
        assert.equal(getCompetitionWindowStatus({ comp_start: 'bad', comp_end: '2099-01-01T00:00:00Z' }), null);
        assert.equal(getCompetitionWindowStatus({ comp_start: '2099-01-01T00:00:00Z', comp_end: 'bad' }), null);
    });

    it('getCompetitionWindowStatus returns upcoming, live, and ended', () => {
        const farFuture = '2099-06-01T00:00:00Z';
        const farEnd = '2099-12-31T00:00:00Z';
        const pastStart = '2000-01-01T00:00:00Z';
        const pastEnd = '2000-12-31T00:00:00Z';

        assert.equal(getCompetitionWindowStatus({ comp_start: farFuture, comp_end: farEnd }), 'upcoming');
        assert.equal(getCompetitionWindowStatus({ comp_start: pastStart, comp_end: farEnd }), 'live');
        assert.equal(getCompetitionWindowStatus({ comp_start: pastStart, comp_end: pastEnd }), 'ended');
        assert.equal(getCompetitionWindowStatus({}), null);
    });
});
