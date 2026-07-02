const fs = require('fs');
const v8 = require('v8');
const xml2js = require('xml2js');

const DEFAULT_MAX_ELEMENTS = 350000;
const HEAP_PRESSURE_RATIO = 0.8;
const DEFAULT_MAX_DEPTH = 48;
const DEFAULT_MAX_ATTRIBUTES = 500000;

const XML2JS_PARSER_OPTIONS = {
    strict: true,
    xmlns: false,
};

function isDoctypeOrEntityAfterBang(xml, bangIndex) {
    let j = bangIndex + 1;
    while (j < xml.length && /\s/.test(xml[j])) j++;
    const tail = xml.slice(j, j + 8).toUpperCase();
    return tail.startsWith('DOCTYPE') || tail.startsWith('ENTITY');
}

/**
 * Reject DTD/entity declarations and strip non-XML processing instructions.
 * Called before budget scan and parse so all grading paths share the same rules.
 */
function sanitizeXmlForGrading(xml) {
    if (/<!\s*DOCTYPE\b/i.test(xml)) {
        throw new Error('Invalid XML');
    }
    if (/<!\s*ENTITY\b/i.test(xml)) {
        throw new Error('Invalid XML');
    }
    return xml.replace(/<\?(?!xml\s)[^?]*\?>/gi, '');
}

function countAttributeDelimiters(str, start, end) {
    let count = 0;
    let inQuote = false;
    let quoteChar = null;
    for (let j = start; j < end; j++) {
        const c = str[j];
        if (inQuote) {
            if (c === quoteChar) inQuote = false;
        } else if (c === '"' || c === "'") {
            inQuote = true;
            quoteChar = c;
        } else if (c === '=') {
            count++;
        }
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
            if (isDoctypeOrEntityAfterBang(xml, i + 1)) {
                throw new Error('Invalid XML structure.');
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

        const attrCount = countAttributeDelimiters(xml, i + 1, gt);
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

function readCgroupMemoryLimitBytes() {
    const paths = [
        '/sys/fs/cgroup/memory.max',
        '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    ];
    for (const filePath of paths) {
        try {
            const raw = fs.readFileSync(filePath, 'utf8').trim();
            if (raw === 'max') continue;
            const n = Number.parseInt(raw, 10);
            if (Number.isFinite(n) && n > 0) return n;
        } catch {
            /* not in a cgroup or path unavailable */
        }
    }
    return 0;
}

function assertHeapBudgetForXmlParse() {
    const { heapUsed, rss } = process.memoryUsage();
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    const cgroupLimit = readCgroupMemoryLimitBytes();
    const effectiveLimit = cgroupLimit > 0 ? Math.min(heapLimit, cgroupLimit) : heapLimit;
    const used = cgroupLimit > 0 ? rss : heapUsed;
    if (used > effectiveLimit * HEAP_PRESSURE_RATIO) {
        throw new Error('XML parse refused: insufficient memory before parse.');
    }
}

/**
 * Secure XML load for grading: pre-scan budgets, then strict xml2js parse.
 * Decompressed size is already capped by zlib maxOutputLength in the worker.
 */
async function parseXmlForGrading(xml, opts = {}) {
    const sanitized = sanitizeXmlForGrading(xml);
    validateXmlParseBudget(sanitized, opts);
    assertHeapBudgetForXmlParse();
    const parser = new xml2js.Parser(XML2JS_PARSER_OPTIONS);
    return parser.parseStringPromise(sanitized);
}

module.exports = {
    sanitizeXmlForGrading,
    validateXmlParseBudget,
    parseXmlForGrading,
    XML2JS_PARSER_OPTIONS,
    DEFAULT_MAX_ELEMENTS,
    DEFAULT_MAX_DEPTH,
    DEFAULT_MAX_ATTRIBUTES,
};
