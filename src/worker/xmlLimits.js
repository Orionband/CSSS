const xml2js = require('xml2js');

const DEFAULT_MAX_ELEMENTS = 250000;
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_PARSED_NODES = 500000;
const DEFAULT_MAX_ATTRIBUTES = 500000;

const XML2JS_PARSER_OPTIONS = {
    strict: true,
    xmlns: false,
    entityExpansionMaxDepth: 1,
};

function countEqualsInRange(str, start, end) {
    let count = 0;
    for (let j = start; j < end; j++) {
        if (str.charCodeAt(j) === 61) count++;
    }
    return count;
}

/**
 * Lightweight pre-parse scan: count elements and nesting without building a DOM.
 */
function validateXmlParseBudget(xml, opts = {}) {    const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const maxAttributes = opts.maxAttributes ?? DEFAULT_MAX_ATTRIBUTES;
    const len = xml.length;
    let depth = 0;
    let elements = 0;
    let attributes = 0;

    for (let i = 0; i < len; i++) {
        if (xml.charCodeAt(i) !== 60) continue;

        const c1 = xml.charCodeAt(i + 1);
        if (c1 === 33) {
            if (xml.startsWith('!--', i + 2)) {
                const end = xml.indexOf('-->', i + 5);
                i = end === -1 ? len - 1 : end + 2;
                continue;
            }
            const gt = xml.indexOf('>', i + 2);
            i = gt === -1 ? len - 1 : gt;
            continue;
        }
        if (c1 === 63) {
            const end = xml.indexOf('?>', i + 2);
            i = end === -1 ? len - 1 : end + 1;
            continue;
        }
        if (c1 === 47) {
            depth--;
            if (depth < 0) throw new Error('Invalid XML structure.');
            const gt = xml.indexOf('>', i + 2);
            i = gt === -1 ? len - 1 : gt;
            continue;
        }

        const gt = xml.indexOf('>', i + 1);
        if (gt === -1) throw new Error('Invalid XML structure.');

        elements++;
        if (elements > maxElements) {
            throw new Error('XML exceeds element limit.');
        }

        const attrCount = countEqualsInRange(xml, i, gt + 1);
        if (attrCount > 0) {
            attributes += attrCount;
            if (attributes > maxAttributes) {
                throw new Error('XML exceeds attribute limit.');
            }
        }        const selfClosing = /\/\s*>$/.test(tagSlice);
        if (!selfClosing) {
            depth++;
            if (depth > maxDepth) {
                throw new Error('XML exceeds nesting depth.');
            }
        }
        i = gt;
    }
}

function walkParsedXmlBudget(node, budget) {
    if (budget.remaining <= 0) {
        throw new Error('XML exceeds parse size limit.');
    }
    budget.remaining--;

    if (node === null || node === undefined) return;
    if (typeof node !== 'object') return;

    if (Array.isArray(node)) {
        for (const item of node) walkParsedXmlBudget(item, budget);
        return;
    }

    for (const key of Object.keys(node)) {
        walkParsedXmlBudget(node[key], budget);
    }
}

function assertParsedXmlWithinBudget(root, maxNodes = DEFAULT_MAX_PARSED_NODES) {
    walkParsedXmlBudget(root, { remaining: maxNodes });
}

/**
 * Secure XML load for grading: pre-scan budgets, parse with strict xml2js, post-walk node budget.
 * Keeps the same security gates as the previous three-step sequence in one API.
 */
async function parseXmlForGrading(xml, opts = {}) {
    validateXmlParseBudget(xml, opts);
    const parser = new xml2js.Parser(XML2JS_PARSER_OPTIONS);
    const xmlObj = await parser.parseStringPromise(xml);
    assertParsedXmlWithinBudget(xmlObj, opts.maxNodes ?? DEFAULT_MAX_PARSED_NODES);
    return xmlObj;
}

module.exports = {
    validateXmlParseBudget,
    assertParsedXmlWithinBudget,
    parseXmlForGrading,
    XML2JS_PARSER_OPTIONS,
    DEFAULT_MAX_ELEMENTS,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_PARSED_NODES,
    DEFAULT_MAX_ATTRIBUTES,
};