const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateXmlParseBudget, parseXmlForGrading, sanitizeXmlForGrading } = require('../../src/worker/xmlLimits');

describe('xmlLimits', () => {
    it('validateXmlParseBudget accepts small well-formed XML', () => {
        const xml = '<root><child>text</child></root>';
        assert.doesNotThrow(() => validateXmlParseBudget(xml));
    });

    it('validateXmlParseBudget throws on element limit', () => {
        const xml = '<a></a>'.repeat(5);
        assert.throws(
            () => validateXmlParseBudget(xml, { maxElements: 2 }),
            /element limit/i,
        );
    });

    it('validateXmlParseBudget throws on depth limit', () => {
        const xml = '<a><b><c></c></b></a>';
        assert.throws(
            () => validateXmlParseBudget(xml, { maxDepth: 1 }),
            /nesting depth/i,
        );
    });

    it('validateXmlParseBudget respects quoted greater-than in attributes', () => {
        const xml = '<tag attr="a>b"></tag>';
        assert.doesNotThrow(() => validateXmlParseBudget(xml));
    });

    it('parseXmlForGrading parses valid XML', async () => {
        const obj = await parseXmlForGrading('<root><item>ok</item></root>');
        assert.equal(obj.root.item[0], 'ok');
    });

    it('parseXmlForGrading rejects over-budget XML before parse', async () => {
        const xml = '<a></a>'.repeat(10);
        await assert.rejects(
            () => parseXmlForGrading(xml, { maxElements: 2 }),
            /element limit/i,
        );
    });

    it('sanitizeXmlForGrading rejects DOCTYPE', () => {
        assert.throws(
            () => sanitizeXmlForGrading('<!DOCTYPE foo [<!ENTITY x "y">]><root/>'),
            /Invalid XML/,
        );
    });

    it('sanitizeXmlForGrading rejects ENTITY declarations', () => {
        assert.throws(
            () => sanitizeXmlForGrading('<root><!ENTITY x "y"></root>'),
            /Invalid XML/,
        );
    });

    it('sanitizeXmlForGrading rejects ENTITY with whitespace after bang', () => {
        assert.throws(
            () => sanitizeXmlForGrading('<root><! ENTITY x "y"></root>'),
            /Invalid XML/,
        );
    });

    it('validateXmlParseBudget rejects ENTITY with whitespace after bang', () => {
        assert.throws(
            () => validateXmlParseBudget('<root><! ENTITY x "y"></root>'),
            /Invalid XML structure/,
        );
    });

    it('validateXmlParseBudget rejects DOCTYPE in declaration scan', () => {
        assert.throws(
            () => validateXmlParseBudget('<!DOCTYPE foo><root/>'),
            /Invalid XML structure/,
        );
    });

    it('sanitizeXmlForGrading rejects DOCTYPE with whitespace after bang', () => {
        assert.throws(
            () => sanitizeXmlForGrading('<! DOCTYPE foo><root/>'),
            /Invalid XML/,
        );
    });

    it('validateXmlParseBudget rejects DOCTYPE with whitespace after bang', () => {
        assert.throws(
            () => validateXmlParseBudget('<! DOCTYPE foo><root/>'),
            /Invalid XML structure/,
        );
    });

    it('sanitizeXmlForGrading strips non-XML processing instructions', () => {
        const result = sanitizeXmlForGrading('<?xml version="1.0"?><?foo bar?><root/>');
        assert.equal(result, '<?xml version="1.0"?><root/>');
    });

    it('parseXmlForGrading parses XML after stripping non-XML processing instructions', async () => {
        const obj = await parseXmlForGrading('<?xml version="1.0"?><?foo bar?><root><item>ok</item></root>');
        assert.equal(obj.root.item[0], 'ok');
    });
});
