const MIN_COL_WIDTH = 48;
const SNAP_PX = 6;
const RESIZE_SENSITIVITY = 0.65;

function snapWidth(width) {
    return Math.max(MIN_COL_WIDTH, Math.round(width / SNAP_PX) * SNAP_PX);
}

function loadWidths(storageKey, defaults, count) {
    if (storageKey) {
        try {
            const saved = JSON.parse(localStorage.getItem(storageKey));
            if (Array.isArray(saved) && saved.length === count) {
                return saved.map((w) => Math.max(MIN_COL_WIDTH, Number(w) || MIN_COL_WIDTH));
            }
        } catch (_) { /* ignore */ }
    }
    if (Array.isArray(defaults) && defaults.length === count) {
        return defaults.map((w) => Math.max(MIN_COL_WIDTH, Number(w) || MIN_COL_WIDTH));
    }
    return Array.from({ length: count }, () => null);
}

function syncTableMinWidth(table, widths) {
    const wrapper = table.closest('.table-wrapper');
    const parentWidth = wrapper ? wrapper.clientWidth : 0;
    const sum = widths.reduce((total, w) => total + (w || 0), 0);
    table.style.minWidth = `${Math.max(parentWidth, sum)}px`;
}

/**
 * Adds drag handles to resize table columns. The last column absorbs remaining width.
 * @param {HTMLTableElement} table
 * @param {{ storageKey?: string, defaults?: number[] }} options
 */
export function initResizableTable(table, { storageKey, defaults } = {}) {
    if (!table || table.dataset.resizeInit) return;
    table.dataset.resizeInit = '1';
    table.classList.add('admin-table--resizable');

    const headers = [...table.querySelectorAll('thead th')];
    if (headers.length < 2) return;

    const resizableCount = headers.length - 1;
    let widths = loadWidths(storageKey, defaults, resizableCount);

    let colgroup = table.querySelector('colgroup');
    if (!colgroup) {
        colgroup = document.createElement('colgroup');
        headers.forEach(() => colgroup.appendChild(document.createElement('col')));
        table.insertBefore(colgroup, table.firstChild);
    }
    const cols = [...colgroup.children];

    function applyWidths() {
        widths.forEach((w, i) => {
            if (cols[i] && w) cols[i].style.width = `${w}px`;
        });
        syncTableMinWidth(table, widths);
    }

    if (!widths.some(Boolean)) {
        widths = headers.slice(0, resizableCount).map((th) => th.offsetWidth || MIN_COL_WIDTH);
    }
    applyWidths();

    headers.slice(0, resizableCount).forEach((th, i) => {
        const handle = document.createElement('span');
        handle.className = 'col-resize-handle';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.setAttribute('aria-label', `Resize ${th.textContent.trim()} column`);
        th.appendChild(handle);

        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.clientX;
            const startW = widths[i] || th.offsetWidth;
            handle.classList.add('is-dragging');

            document.body.classList.add('col-resize-active');

            function onMove(ev) {
                const delta = (ev.clientX - startX) * RESIZE_SENSITIVITY;
                widths[i] = snapWidth(startW + delta);
                applyWidths();
            }

            function onUp() {
                handle.classList.remove('is-dragging');
                document.body.classList.remove('col-resize-active');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (storageKey) {
                    try {
                        localStorage.setItem(storageKey, JSON.stringify(widths));
                    } catch (_) { /* ignore */ }
                }
            }

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}
