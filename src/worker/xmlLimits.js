const xml2js = require('xml2js');

const DEFAULT_MAX_ELEMENTS = 350000;
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_ATTRIBUTES = 500000;

const XML2JS_PARSER_OPTIONS = {
    strict: true,
    xmlns: false,
    entityExpansionMaxDepth: 1,
    useNullPrototype: true,
};

function countEqualsInRange(str, start, end) {
    let count = 0;
    for (let j = start; j < end; j++) {
        if (str.charCodeAt(j) === 61) count++;
    }
    return count;
}

function findGtRespectingQuotes(xml, start) {
    let inQuote = false;
    let quoteChar = null;
    for (let i = start; i < xml.length; i++) {
        const c = xml[i];
        if (inQuote) {
            if (c === quoteChar) inQuote = false;
        } else {
            if (c === '"' || c === "'") {
                inQuote = true;
                quoteChar = c;
            } else if (c === '>') {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Lightweight pre-parse scan: count elements and nesting without building a DOM.
 */
function validateXmlParseBudget(xml, opts = {}) {
    const maxElements = opts.maxElements ?? DEFAULT_MAX_ELEMENTS;
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
            if (xml.startsWith('[CDATA[', i + 2)) {
                const end = xml.indexOf(']]>', i + 9);
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

        const gt = findGtRespectingQuotes(xml, i + 1);
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
        }

        const tagSlice = xml.slice(i, gt + 1);
        const selfClosing = /\/\s*>$/.test(tagSlice);
        if (!selfClosing) {
            depth++;
            if (depth > maxDepth) {
                throw new Error('XML exceeds nesting depth.');
            }
        }
        i = gt;
    }
}

/**
 * Secure XML load for grading: pre-scan budgets, then strict xml2js parse.
 * Decompressed size is already capped by zlib maxOutputLength in the worker.
 */
async function parseXmlForGrading(xml, opts = {}) {
    validateXmlParseBudget(xml, opts);
    const parser = new xml2js.Parser(XML2JS_PARSER_OPTIONS);
    return parser.parseStringPromise(xml);
}

module.exports = {
    validateXmlParseBudget,
    parseXmlForGrading,
    XML2JS_PARSER_OPTIONS,
    DEFAULT_MAX_ELEMENTS,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_ATTRIBUTES,
};
