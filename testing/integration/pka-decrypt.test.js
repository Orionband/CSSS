const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { runGrade } = require('../../src/worker/gradeJob');
const { fixturesAvailable, loadPkaBuffer } = require('../helpers/loadFixtures');

describe('PKA decrypt integration', () => {
    it('decrypts test.pka to valid Packet Tracer XML', async (t) => {
        if (!fixturesAvailable()) {
            t.skip('testing/test.pka or testing/lab.conf not found');
            return;
        }

        const events = [];
        const result = await runGrade({
            fileBuffer: loadPkaBuffer(),
            labConfig: { checks: [] },
            retainXml: true,
            maxXmlMb: 25,
        }, (msg) => events.push(msg));

        assert.ok(events.some((e) => e.type === 'file_verified'));
        assert.ok(events.some((e) => e.type === 'progress' && e.stage === 'Complete'));
        assert.ok(result.xml.includes('PACKETTRACER5'));
        assert.ok(result.xml.includes('PIX-NYC-R1'));
        assert.ok(result.xml.includes('NYC-PC1'));
    });
});
