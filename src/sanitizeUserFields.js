/** Zero-width, bidi, and other default-invisible format characters (TR36 / UTS #39). */
const INVISIBLE_FORMAT =
    /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;

const USERNAME_RE = /^[A-Za-z0-9._-]+$/;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const MAX_FIELD_LEN = 100;
const PRE_MAX_LEN = 10000;

/** Strip controls, normalize Unicode (NFC), remove invisible format chars, trim. */
function sanitizeUserField(value) {
    if (value === undefined || value === null) return '';
    let s = String(value);
    if (s.length > PRE_MAX_LEN) s = s.slice(0, PRE_MAX_LEN);
    s = s.normalize('NFC');
    s = s.replace(/[\x00-\x1f\x7f]/g, '');
    s = s.replace(INVISIBLE_FORMAT, '');
    return s.trim();
}

/** Username: sanitized, printable ASCII [A-Za-z0-9._-], max 100 chars. */
function sanitizeUsername(value) {
    const s = sanitizeUserField(value);
    if (!s || s.length > MAX_FIELD_LEN || !USERNAME_RE.test(s)) return '';
    return s;
}

/** Email: sanitized, ASCII local@domain, max 100 chars. */
function sanitizeEmail(value) {
    const s = sanitizeUserField(value);
    if (!s || s.length > MAX_FIELD_LEN || !EMAIL_RE.test(s)) return '';
    return s;
}

module.exports = { sanitizeUserField, sanitizeUsername, sanitizeEmail, MAX_FIELD_LEN };
