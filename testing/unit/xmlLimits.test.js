const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateXmlParseBudget, parseXmlForGrading } = require('../../src/worker/xmlLimits');

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
});
