const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeErrorMessage } = require('../../src/worker/gradeJob');

describe('sanitizeErrorMessage', () => {
    it('maps integrity failures', () => {
        assert.match(sanitizeErrorMessage('File Integrity Failed'), /integrity check failed/i);
    });

    it('maps XML limit errors', () => {
        assert.match(sanitizeErrorMessage('XML exceeds element limit.'), /size or complexity limits/i);
    });

    it('maps decompression failures', () => {
        assert.match(sanitizeErrorMessage('Decompression failed or file too large.'), /decompression failed/i);
    });

    it('maps lab config missing', () => {
        assert.match(sanitizeErrorMessage('Lab configuration not found.'), /Lab configuration not found/i);
    });

    it('maps generic XML errors', () => {
        assert.match(sanitizeErrorMessage('not well-formed XML'), /invalid or malformed/i);
    });

    it('returns generic message for unknown errors', () => {
        assert.match(sanitizeErrorMessage('something weird happened'), /error occurred while processing/i);
    });

    it('handles empty input', () => {
        assert.match(sanitizeErrorMessage(''), /unknown error/i);
    });
});

describe('sanitizeXmlForGrading', () => {
    const { sanitizeXmlForGrading } = require('../../src/worker/xmlLimits');

    it('rejects XML containing DOCTYPE', () => {
        const xml = '<?xml version="1.0"?><!DOCTYPE foo [<!ELEMENT foo ANY>]><root/>';
        assert.throws(() => sanitizeXmlForGrading(xml), /Invalid XML/);
    });

    it('returns quickly for adversarial DOCTYPE internal subset', () => {
        const payload = '<!DOCTYPE x [' + ']"'.repeat(5000) + ']>';
        const start = Date.now();
        assert.throws(() => sanitizeXmlForGrading(`<?xml?>${payload}<root/>`), /Invalid XML/);
        assert.ok(Date.now() - start < 500, 'DOCTYPE rejection should not backtrack');
    });

    it('rejects ENTITY declarations', () => {
        const xml = '<?xml version="1.0"?><!ENTITY x "y"><root/>';
        assert.throws(() => sanitizeXmlForGrading(xml), /Invalid XML/);
    });

    it('rejects ENTITY with whitespace after bang', () => {
        const xml = '<?xml version="1.0"?><! ENTITY x "y"><root/>';
        assert.throws(() => sanitizeXmlForGrading(xml), /Invalid XML/);
    });
});
