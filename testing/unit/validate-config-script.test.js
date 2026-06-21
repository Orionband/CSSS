const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

describe('validate-config script', () => {
    let tmpDir;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csss-validate-config-'));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeConfigs({ homepage = null } = {}) {
        const configsDir = path.join(tmpDir, 'configs');
        fs.mkdirSync(configsDir, { recursive: true });
        if (homepage) {
            fs.writeFileSync(path.join(configsDir, 'homepage.conf'), homepage);
        }
    }

    it('reports homepage enabled in success output', () => {
        writeConfigs({
            homepage: [
                '[homepage]',
                'enabled = true',
                'page_title = "Ops Check"',
            ].join('\n'),
        });

        const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'validate-config.js');
        const output = execFileSync(process.execPath, [scriptPath, '--project-root', tmpDir], {
            encoding: 'utf8',
            env: { ...process.env, NODE_ENV: 'test', CSSS_SKIP_ASSET_VALIDATION: 'true' },
        });

        assert.match(output, /Config OK: 0 lab\(s\), 0 quiz\(zes\), homepage enabled\./);
    });

    it('exits non-zero for invalid homepage config', () => {
        writeConfigs({
            homepage: [
                '[homepage]',
                'enabled = true',
                'comp_start = "bad-date"',
            ].join('\n'),
        });

        const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'validate-config.js');
        assert.throws(
            () => execFileSync(process.execPath, [scriptPath, '--project-root', tmpDir], {
                encoding: 'utf8',
                env: { ...process.env, NODE_ENV: 'test', CSSS_SKIP_ASSET_VALIDATION: 'true' },
            }),
            (err) => err.status === 1,
        );
    });
});
