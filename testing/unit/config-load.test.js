const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateConfig } = require('../../src/config/validate');
const { warnValidationErrors, loadConfigFromDisk } = require('../../src/config');

describe('config load behavior', () => {
    let tmpDir;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csss-config-load-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('warnValidationErrors does not throw on invalid validation', () => {
        const validation = validateConfig({
            labs: [{ id: 'dup', title: 'A' }, { id: 'dup', title: 'B' }],
            quizzes: [],
        }, { skipAssetChecks: true });
        assert.equal(validation.ok, false);
        assert.doesNotThrow(() => warnValidationErrors(validation));
    });

    it('loadConfigFromDisk returns parsed config despite validation warnings', () => {
        const invalidLab = [
            '[[labs]]',
            'id = "dup"',
            'title = "Lab A"',
            '',
            '[[labs]]',
            'id = "dup"',
            'title = "Lab B"',
            '',
        ].join('\n');
        fs.writeFileSync(path.join(tmpDir, 'lab.conf'), invalidLab);

        const loaded = loadConfigFromDisk({ projectRoot: tmpDir });
        assert.equal(loaded.config.labs.length, 2);
        assert.equal(loaded.validation.ok, false);
        assert.ok(loaded.validation.errors.some((e) => e.includes('Duplicate lab id')));
    });
});
