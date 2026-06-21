import { escapeHtml, securePost, showModal, closeModal, showAlert, showConfirm, apiFetch, NETWORK_ERROR_MESSAGE, isNetworkError, showNetworkError } from './utils.js';

const ADMIN_USERS_PAGE_SIZE = 50;
const ADMIN_SUBS_LIMIT = 100;
const AUDIT_LOG_LIMIT = 50;
let adminUsersCache = [];
let adminUsersSort = 'id';
let adminUsersSortDir = 'asc';
let adminLbSort = 'username';
let adminLbSortDir = 'asc';
let adminUsersPage = 1;
let adminLbPage = 1;
let auditLogOffset = 0;

const AUDIT_EVENT_LABELS = {
    account_created: 'Account created',
    password_changed: 'Password changed',
    admin_granted: 'Admin granted',
    admin_revoked: 'Admin revoked',
    owner_granted: 'Owner granted',
    user_deleted: 'User deleted',
    server_error: 'Server error',
};

function adminUsesDiscordReauth() {
    return window.adminReauthMethod === 'discord';
}

function adminConfirmSectionHtml(inputId) {
    if (adminUsesDiscordReauth()) {
        if (window.adminDiscordReauthValid) {
            return '<p class="text-muted mb-20">Discord verification is active for the next few minutes.</p>';
        }
        return `<div class="mb-20">
            <p class="text-muted">Verify with Discord before continuing.</p>
            <a class="btn-block btn-discord" href="/api/auth/discord/reauth?return=${encodeURIComponent('/admin')}">Verify with Discord</a>
        </div>`;
    }
    return `<div class="mb-20">
        <input type="password" id="${inputId}" class="field-input" placeholder="Your Current Password" autocomplete="current-password">
    </div>`;
}

function readAdminConfirmPassword(inputId) {
    if (adminUsesDiscordReauth()) return '';
    return document.getElementById(inputId)?.value || '';
}

async function showAdminActionError(data) {
    if (!data?.error) return;
    await showAlert(data.error, { title: 'Error' });
}

function closeAllRowActionMenus() {
    document.querySelectorAll('.row-action-menu-panel').forEach((panel) => {
        panel.classList.add('hidden');
        panel.style.position = '';
        panel.style.top = '';
        panel.style.left = '';
        panel.style.visibility = '';
        panel.style.width = '';
    });
    document.querySelectorAll('.row-action-menu-btn').forEach((btn) => btn.setAttribute('aria-expanded', 'false'));
}

function openRowActionMenu(menuBtn, panel) {
    panel.classList.remove('hidden');
    panel.style.position = 'fixed';
    panel.style.width = 'max-content';
    panel.style.visibility = 'hidden';
    panel.style.top = '0';
    panel.style.left = '0';

    const panelRect = panel.getBoundingClientRect();
    const btnRect = menuBtn.getBoundingClientRect();
    const gap = 4;
    const margin = 8;

    let top = btnRect.bottom + gap;
    if (top + panelRect.height > window.innerHeight - margin) {
        top = btnRect.top - gap - panelRect.height;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - panelRect.height - margin));

    let left = btnRect.right - panelRect.width;
    left = Math.max(margin, Math.min(left, window.innerWidth - panelRect.width - margin));

    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
    panel.style.visibility = '';
}

let rowActionMenusBound = false;

function bindRowActionMenus() {
    if (rowActionMenusBound) return;
    rowActionMenusBound = true;
    document.addEventListener('click', (e) => {
        const menuBtn = e.target.closest('.row-action-menu-btn');
        if (menuBtn) {
            e.stopPropagation();
            const panel = menuBtn.closest('.row-action-menu')?.querySelector('.row-action-menu-panel');
            const wasOpen = panel && !panel.classList.contains('hidden');
            closeAllRowActionMenus();
            if (!wasOpen && panel) {
                openRowActionMenu(menuBtn, panel);
                menuBtn.setAttribute('aria-expanded', 'true');
            }
            return;
        }
        if (e.target.closest('.row-action-menu-item')) {
            closeAllRowActionMenus();
            return;
        }
        closeAllRowActionMenus();
    });
    document.querySelectorAll('.table-wrapper').forEach((wrapper) => {
        wrapper.addEventListener('scroll', closeAllRowActionMenus, { passive: true });
    });
    window.addEventListener('resize', closeAllRowActionMenus);
}

function bindAdminUserButtons() {
    document.querySelectorAll('.btn-admin-subs').forEach(btn => {
        btn.addEventListener('click', (e) => adminViewSubmissions(e.currentTarget.dataset.id, e.currentTarget.dataset.name));
    });
    document.querySelectorAll('.btn-admin-pass').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptPassword(e.currentTarget.dataset.id, e.currentTarget.dataset.name));
    });
    document.querySelectorAll('.btn-admin-del').forEach(btn => {
        btn.addEventListener('click', (e) => adminDeleteUser(e.currentTarget.dataset.id, e.currentTarget.dataset.name));
    });
    document.querySelectorAll('.btn-admin-score').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptScore(
            e.currentTarget.dataset.id, e.currentTarget.dataset.name, e.currentTarget.dataset.adj, e.currentTarget.dataset.withheld
        ));
    });
    document.querySelectorAll('.btn-admin-withhold').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptWithholdToggle(
            e.currentTarget.dataset.id,
            e.currentTarget.dataset.name,
            e.currentTarget.dataset.adj,
            e.currentTarget.dataset.withheld,
        ));
    });
    document.querySelectorAll('.btn-admin-role').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptRole(
            e.currentTarget.dataset.id, e.currentTarget.dataset.name, e.currentTarget.dataset.isadmin === '1'
        ));
    });
}

function adminRoleMenuItemHtml(u) {
    if (!window.isOwner || u.is_owner || u.id === window.currentUserId) return '';
    const id = escapeHtml(String(u.id));
    const name = escapeHtml(u.username);
    if (u.is_admin) {
        return `<button type="button" class="row-action-menu-item btn-admin-role" role="menuitem" data-id="${id}" data-name="${name}" data-isadmin="1">Revoke Admin</button>`;
    }
    return `<button type="button" class="row-action-menu-item btn-admin-role" role="menuitem" data-id="${id}" data-name="${name}" data-isadmin="0">Grant Admin</button>`;
}

function adminUserActionsMenuHtml(u, canDelete) {
    const id = escapeHtml(String(u.id));
    const name = escapeHtml(u.username);
    const deleteItem = canDelete
        ? `<button type="button" class="row-action-menu-item row-action-menu-item--danger btn-admin-del" role="menuitem" data-id="${id}" data-name="${name}">Delete User</button>`
        : '';

    return `
        <div class="row-action-menu">
            <button type="button" class="row-action-menu-btn" aria-label="User actions" aria-haspopup="true" aria-expanded="false">&#8942;</button>
            <div class="row-action-menu-panel hidden" role="menu">
                <button type="button" class="row-action-menu-item btn-admin-subs" role="menuitem" data-id="${id}" data-name="${name}">View Submissions</button>
                <button type="button" class="row-action-menu-item btn-admin-pass" role="menuitem" data-id="${id}" data-name="${name}">Reset Password</button>
                ${adminRoleMenuItemHtml(u)}
                ${deleteItem}
            </div>
        </div>
    `;
}

function adminLbActionsMenuHtml(u) {
    const id = escapeHtml(String(u.id));
    const name = escapeHtml(u.username);
    const adj = escapeHtml(String(u.score_adjustment ?? 0));
    const withheld = escapeHtml(String(u.withheld || 0));
    const withholdLabel = u.withheld ? 'Show on Leaderboard' : 'Withhold from Leaderboard';
    return `
        <div class="row-action-menu">
            <button type="button" class="row-action-menu-btn" aria-label="Score actions" aria-haspopup="true" aria-expanded="false">&#8942;</button>
            <div class="row-action-menu-panel hidden" role="menu">
                <button type="button" class="row-action-menu-item btn-admin-score" role="menuitem" data-id="${id}" data-name="${name}" data-adj="${adj}" data-withheld="${withheld}">Adjust Score</button>
                <button type="button" class="row-action-menu-item btn-admin-withhold" role="menuitem" data-id="${id}" data-name="${name}" data-adj="${adj}" data-withheld="${withheld}">${withholdLabel}</button>
            </div>
        </div>
    `;
}

function compareLeaderboardTotal(a, b, dir) {
    const av = a.leaderboard_total;
    const bv = b.leaderboard_total;
    const aW = av === 'W';
    const bW = bv === 'W';
    if (aW && bW) return 0;
    if (aW) return 1;
    if (bW) return -1;
    return ((Number(av) || 0) - (Number(bv) || 0)) * dir;
}

function sortAdminUsers(users, sort, sortDir) {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...users].sort((a, b) => {
        if (sort === 'username') {
            const av = a.username.toLowerCase();
            const bv = b.username.toLowerCase();
            if (av < bv) return -dir;
            if (av > bv) return dir;
            return 0;
        }
        if (sort === 'submissions') {
            return ((a.submission_count ?? 0) - (b.submission_count ?? 0)) * dir;
        }
        if (sort === 'raw') {
            return ((a.leaderboard_raw ?? 0) - (b.leaderboard_raw ?? 0)) * dir;
        }
        if (sort === 'adjustment') {
            return ((a.score_adjustment ?? 0) - (b.score_adjustment ?? 0)) * dir;
        }
        if (sort === 'total') {
            return compareLeaderboardTotal(a, b, dir);
        }
        if (sort === 'withheld') {
            return ((a.withheld ? 1 : 0) - (b.withheld ? 1 : 0)) * dir;
        }
        return (a.id - b.id) * dir;
    });
}

function filterUsersByUsername(users, query) {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => u.username.toLowerCase().includes(q));
}

function paginateUsers(users, page, pageSize) {
    const total = users.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const start = (safePage - 1) * pageSize;
    return {
        page: safePage,
        totalPages,
        total,
        items: users.slice(start, start + pageSize),
    };
}

function renderAdminPagination(containerId, { page, totalPages, total }, onPage) {
    const nav = document.getElementById(containerId);
    if (!nav) return;

    if (total <= ADMIN_USERS_PAGE_SIZE) {
        nav.innerHTML = total > 0
            ? `<span>${total} user${total === 1 ? '' : 's'}</span>`
            : '';
        return;
    }

    const start = (page - 1) * ADMIN_USERS_PAGE_SIZE + 1;
    const end = Math.min(page * ADMIN_USERS_PAGE_SIZE, total);

    nav.innerHTML = `
        <button type="button" class="btn-secondary btn-small admin-page-prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${page} of ${totalPages} &middot; ${start}&ndash;${end} of ${total}</span>
        <button type="button" class="btn-secondary btn-small admin-page-next" ${page >= totalPages ? 'disabled' : ''}>Next</button>
    `;

    nav.querySelector('.admin-page-prev')?.addEventListener('click', () => onPage(page - 1));
    nav.querySelector('.admin-page-next')?.addEventListener('click', () => onPage(page + 1));
}

function renderAdminUsersFromCache() {
    const usersBody = document.getElementById('admin-users-body');
    const lbBody = document.getElementById('admin-lb-body');
    if (!usersBody || !lbBody) return;

    const usersQuery = document.querySelector('.admin-users-search')?.value || '';
    const usersFiltered = filterUsersByUsername(
        sortAdminUsers(adminUsersCache, adminUsersSort, adminUsersSortDir),
        usersQuery,
    );
    const usersPageData = paginateUsers(usersFiltered, adminUsersPage, ADMIN_USERS_PAGE_SIZE);
    adminUsersPage = usersPageData.page;

    usersBody.innerHTML = '';
    usersPageData.items.forEach((u) => appendAdminUserRow(u, usersBody));

    const lbQuery = document.querySelector('.admin-lb-search')?.value || '';
    const lbFiltered = filterUsersByUsername(
        sortAdminUsers(adminUsersCache, adminLbSort, adminLbSortDir),
        lbQuery,
    );
    const lbPageData = paginateUsers(lbFiltered, adminLbPage, ADMIN_USERS_PAGE_SIZE);
    adminLbPage = lbPageData.page;

    lbBody.innerHTML = '';
    lbPageData.items.forEach((u) => appendAdminLbRow(u, lbBody));

    bindAdminUserButtons();
    renderAdminPagination('admin-users-pagination', usersPageData, (p) => {
        adminUsersPage = p;
        renderAdminUsersFromCache();
    });
    renderAdminPagination('admin-lb-pagination', lbPageData, (p) => {
        adminLbPage = p;
        renderAdminUsersFromCache();
    });
    updateAdminUserSortHeaders();
    updateAdminLbSortHeaders();
}

function updateAdminLbSortHeaders() {
    document.querySelectorAll('#admin-lb-table th.sortable').forEach((th) => {
        const col = th.dataset.sort;
        if (col === adminLbSort) {
            th.setAttribute('aria-sort', adminLbSortDir === 'asc' ? 'ascending' : 'descending');
        } else {
            th.setAttribute('aria-sort', 'none');
        }
    });
}

function updateAdminUserSortHeaders() {
    document.querySelectorAll('#admin-users-table th.sortable').forEach((th) => {
        const col = th.dataset.sort;
        if (col === adminUsersSort) {
            th.setAttribute('aria-sort', adminUsersSortDir === 'asc' ? 'ascending' : 'descending');
        } else {
            th.setAttribute('aria-sort', 'none');
        }
    });
}

export function bindAdminUserSearch() {
    document.querySelectorAll('#admin-users-table th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (col === adminUsersSort) {
                adminUsersSortDir = adminUsersSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                adminUsersSort = col;
                adminUsersSortDir = 'asc';
            }
            adminUsersPage = 1;
            renderAdminUsersFromCache();
        });
    });
    document.querySelectorAll('#admin-lb-table th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const col = th.dataset.sort;
            if (col === adminLbSort) {
                adminLbSortDir = adminLbSortDir === 'asc' ? 'desc' : 'asc';
            } else {
                adminLbSort = col;
                adminLbSortDir = 'asc';
            }
            adminLbPage = 1;
            renderAdminUsersFromCache();
        });
    });
    document.querySelectorAll('.admin-users-search').forEach((input) => {
        input.addEventListener('input', () => {
            adminUsersPage = 1;
            renderAdminUsersFromCache();
        });
    });
    document.querySelectorAll('.admin-lb-search').forEach((input) => {
        input.addEventListener('input', () => {
            adminLbPage = 1;
            renderAdminUsersFromCache();
        });
    });
    bindRowActionMenus();
    updateAdminUserSortHeaders();
    updateAdminLbSortHeaders();
}

function appendAdminUserRow(u, usersBody) {
    const row = document.createElement('tr');
    row.dataset.userId = String(u.id);
    row.dataset.username = u.username.toLowerCase();
    row.dataset.submissions = String(u.submission_count);
    const canDelete = u.id !== window.currentUserId && (!u.is_admin || window.isOwner);
    const actionsHtml = adminUserActionsMenuHtml(u, canDelete);
    row.innerHTML = `
        <td>${escapeHtml(String(u.id))}</td>
        <td>${escapeHtml(u.username)}${u.is_owner ? '<span class="badge badge-owner">OWNER</span>' : (u.is_admin ? '<span class="badge badge-admin">ADMIN</span>' : '')}</td>
        <td>${u.submission_count}</td>
        <td>${actionsHtml}</td>
    `;
    usersBody.appendChild(row);
}

function leaderboardRawScore(u) {
    if (u.leaderboard_raw != null) return u.leaderboard_raw;
    const total = u.leaderboard_total;
    const adj = Number(u.score_adjustment) || 0;
    if (typeof total === 'number') return Math.max(0, total - adj);
    return 0;
}

function appendAdminLbRow(u, lbBody) {
    const rawScore = leaderboardRawScore(u);
    const totalScore = u.leaderboard_total ?? 0;
    const adjClass = u.score_adjustment > 0 ? 'adj-positive' : (u.score_adjustment < 0 ? 'adj-negative' : 'adj-zero');
    const withheldClass = u.withheld ? 'withheld-yes' : 'withheld-no';
    const lbRow = document.createElement('tr');
    lbRow.dataset.username = u.username.toLowerCase();
    lbRow.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(String(rawScore))}</td>
        <td class="${adjClass}">${u.score_adjustment || 0}</td>
        <td>${totalScore}</td>
        <td class="${withheldClass}">${u.withheld ? 'YES' : 'NO'}</td>
        <td>${adminLbActionsMenuHtml(u)}</td>
    `;
    lbBody.appendChild(lbRow);
}

export async function loadAdminPanel() {
    const usersBody = document.getElementById('admin-users-body');
    adminUsersCache = [];
    adminUsersPage = 1;
    adminLbPage = 1;

    try {
        const res = await apiFetch('/api/admin/users?all=1');
        if (!res.ok) {
            usersBody.innerHTML = `<tr><td colspan="4" class="error-center">Error loading users.</td></tr>`;
            return;
        }
        const data = await res.json();
        adminUsersCache = data.users;
        renderAdminUsersFromCache();
    } catch (err) {
        usersBody.innerHTML = `<tr><td colspan="4" class="error-center">${escapeHtml(isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Error loading users.')}</td></tr>`;
    }
}

export function adminPromptCreateUser() {
    showModal(`
        <h2 class="text-accent mb-20">Create New User</h2>
        <div class="mb-15"><input type="text" id="admin-new-user" class="field-input" placeholder="Username"></div>
        <div class="mb-15"><input type="email" id="admin-new-email" class="field-input" placeholder="Email (Optional)"></div>
        <div class="mb-20">
            <input type="password" id="admin-new-pass" class="field-input" placeholder="Password">
            <div class="password-hint">Min 8 characters, 1 uppercase letter, 1 number, 1 symbol</div>
        </div>
        ${window.isOwner ? `<div class="mb-25">
            <label class="custom-label"><input type="checkbox" id="admin-new-isadmin"><span class="checkmark"></span> Grant Admin Privileges</label>
        </div>` : ''}
        <button id="btn-admin-create-user-exec" class="btn-block">Create User</button>
    `);
    document.getElementById('btn-admin-create-user-exec').addEventListener('click', adminExecuteCreateUser);
}

async function adminExecuteCreateUser() {
    const username = document.getElementById('admin-new-user').value;
    const email = document.getElementById('admin-new-email').value;
    const password = document.getElementById('admin-new-pass').value;
    const is_admin = window.isOwner && document.getElementById('admin-new-isadmin')?.checked;

    try {
        const res = await securePost('/api/admin/users', { username, email, password, is_admin });
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptPassword(id, username) {
    showModal(`
        <h2 class="text-accent mb-20">Reset Password: ${escapeHtml(username)}</h2>
        <div class="mb-15">
            ${adminConfirmSectionHtml('admin-current-pass')}
        </div>
        <div class="mb-20">
            <input type="password" id="admin-reset-pass" class="field-input" placeholder="New Password" autocomplete="new-password">
            <div class="password-hint">Min 8 characters, 1 uppercase letter, 1 number, 1 symbol</div>
        </div>
        <button id="btn-admin-reset-pass-exec" data-id="${id}" class="btn-block">Reset Password</button>
    `);
    document.getElementById('btn-admin-reset-pass-exec').addEventListener('click', (e) => adminExecutePassword(e.target.dataset.id));
}

async function adminExecutePassword(id) {
    const password = document.getElementById('admin-reset-pass').value;
    const current_password = readAdminConfirmPassword('admin-current-pass');
    try {
        const res = await securePost(`/api/admin/users/${id}/password`, { password, current_password });
        const data = await res.json();
        if (data.error) await showAdminActionError(data);
        else { await showAlert('Password updated.'); closeModal(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptScore(id, username, currentAdj, currentWithheld) {
    const isWithheld = parseInt(currentWithheld) === 1;
    showModal(`
        <h2 class="text-accent mb-20">Adjust Score: ${escapeHtml(username)}</h2>
        <div class="mb-15">
            <label class="block-label">Global Modifier (+/- Points)</label>
            <input type="number" id="admin-score-adj" value="${escapeHtml(String(currentAdj))}" class="field-input">
        </div>
        <div class="mb-25">
            <label class="custom-label"><input type="checkbox" id="admin-score-withhold" ${isWithheld ? 'checked' : ''}><span class="checkmark"></span> Withhold from Leaderboard</label>
        </div>
        ${adminConfirmSectionHtml('admin-score-current-pass')}
        <button id="btn-admin-score-exec" data-id="${id}" class="btn-block">Save Adjustments</button>
    `);
    document.getElementById('btn-admin-score-exec').addEventListener('click', (e) => adminExecuteScore(e.target.dataset.id));
}

async function adminExecuteScore(id) {
    const adjustment = document.getElementById('admin-score-adj').value;
    const withheld = document.getElementById('admin-score-withhold').checked;
    const current_password = readAdminConfirmPassword('admin-score-current-pass');
    try {
        const res = await securePost(`/api/admin/users/${id}/score`, { adjustment, withheld, current_password });
        const data = await res.json();
        if (data.error) await showAdminActionError(data);
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptWithholdToggle(id, username, currentAdj, currentWithheld) {
    const isWithheld = parseInt(currentWithheld, 10) === 1;
    const action = isWithheld ? 'Show on Leaderboard' : 'Withhold from Leaderboard';
    showModal(`
        <h2 class="text-accent mb-20">${action}: ${escapeHtml(username)}</h2>
        <p class="text-muted mb-20">${isWithheld
            ? 'This user will appear on the public leaderboard again.'
            : 'This user will be hidden from the public leaderboard. Their score is unchanged.'
        }</p>
        ${adminConfirmSectionHtml('admin-withhold-current-pass')}
        <button id="btn-admin-withhold-exec" data-id="${id}" data-adj="${escapeHtml(String(currentAdj))}" data-withheld="${isWithheld ? '0' : '1'}" class="btn-block">${action}</button>
    `);
    document.getElementById('btn-admin-withhold-exec').addEventListener('click', (e) => {
        adminExecuteWithholdToggle(e.currentTarget.dataset.id, e.currentTarget.dataset.adj, e.currentTarget.dataset.withheld);
    });
}

async function adminExecuteWithholdToggle(id, adjustment, withheld) {
    const current_password = readAdminConfirmPassword('admin-withhold-current-pass');
    try {
        const res = await securePost(`/api/admin/users/${id}/score`, {
            adjustment,
            withheld: withheld === '1',
            current_password,
        });
        const data = await res.json();
        if (data.error) await showAdminActionError(data);
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptRole(id, username, isAdmin) {
    const action = isAdmin ? 'Revoke Admin' : 'Grant Admin';
    showModal(`
        <h2 class="text-accent mb-20">${action}: ${escapeHtml(username)}</h2>
        <p class="text-muted mb-20">${isAdmin
            ? 'This user will lose admin panel access and their active sessions will be ended.'
            : 'This user will gain full admin panel access (except owner-only actions).'
        }</p>
        ${adminConfirmSectionHtml('admin-role-current-pass')}
        <button id="btn-admin-role-exec" data-id="${id}" data-isadmin="${isAdmin ? '0' : '1'}" class="btn-block">${action}</button>
    `);
    document.getElementById('btn-admin-role-exec').addEventListener('click', (e) => adminExecuteRole(e.target.dataset.id, e.target.dataset.isadmin === '1'));
}

async function adminExecuteRole(id, grantAdmin) {
    const current_password = readAdminConfirmPassword('admin-role-current-pass');
    try {
        const res = await securePost(`/api/admin/users/${id}/admin`, { is_admin: grantAdmin, current_password });
        const data = await res.json();
        if (data.error) await showAdminActionError(data);
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptDelete(id, username) {
    showModal(`
        <h2 class="text-accent mb-20">Delete User: ${escapeHtml(username)}</h2>
        <p class="text-muted mb-20">This permanently deletes the user and all their submissions. This cannot be undone.</p>
        ${adminConfirmSectionHtml('admin-delete-current-pass')}
        <button id="btn-admin-delete-exec" data-id="${id}" class="btn-block btn-danger">Delete User</button>
    `);
    document.getElementById('btn-admin-delete-exec').addEventListener('click', (e) => adminExecuteDelete(e.target.dataset.id));
}

async function adminExecuteDelete(id) {
    const current_password = readAdminConfirmPassword('admin-delete-current-pass');
    try {
        const res = await securePost(`/api/admin/users/${id}`, { current_password }, 'DELETE');
        const data = await res.json();
        if (data.error) await showAdminActionError(data);
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

async function adminDeleteUser(id, username) {
    if (!await showConfirm(
        `Are you sure you want to permanently delete user '${username}' and ALL their submissions?`,
        { title: 'Delete User', confirmLabel: 'Delete', danger: true }
    )) return;

    adminPromptDelete(id, username);
}

function submissionRowHtml(s, userId, username) {
    return `
        <tr>
            <td>${s.id}</td>
            <td>${escapeHtml(s.lab_id)}</td>
            <td>${escapeHtml(s.type)}</td>
            <td>${s.score}/${s.max_score}</td>
            <td>${new Date(s.timestamp).toLocaleString()}</td>
            <td><button class="btn-small btn-danger btn-admin-del-sub" data-subid="${s.id}" data-userid="${userId}" data-username="${escapeHtml(username)}">Delete</button></td>
        </tr>
    `;
}

let submissionListActionsBound = false;

function ensureSubmissionListActions() {
    if (submissionListActionsBound) return;
    submissionListActionsBound = true;
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-admin-del-sub');
        if (!btn || !btn.closest('#admin-sub-list')) return;
        adminDeleteSubmission(btn.dataset.subid, btn.dataset.userid, btn.dataset.username);
    });
}

async function adminViewSubmissions(userId, username, offset = 0) {
    try {
        const res = await apiFetch(`/api/admin/users/${userId}/submissions?limit=${ADMIN_SUBS_LIMIT}&offset=${offset}`);
        const data = await res.json();

        if (data.error) {
            showModal(`<h2 class="text-accent mb-15">Submissions: ${escapeHtml(username)}</h2><div>${escapeHtml(data.error)}</div>`);
            return;
        }

        if (offset === 0) {
            let listHtml;
            if (data.submissions.length === 0) {
                listHtml = "<div class='text-muted'>No submissions found.</div>";
            } else {
                let tableHtml = `<div class="table-scroll table-scroll-400"><table class="admin-table"><thead><tr><th>ID</th><th>Lab ID</th><th>Type</th><th>Score</th><th>Date</th><th>Actions</th></tr></thead><tbody id="admin-sub-tbody">`;
                data.submissions.forEach(s => { tableHtml += submissionRowHtml(s, userId, username); });
                tableHtml += '</tbody></table></div>';
                if (data.hasMore) {
                    tableHtml += `<button type="button" id="admin-subs-load-more" class="btn-secondary btn-small mt-12">Load more submissions</button>`;
                }
                listHtml = tableHtml;
            }
            showModal(`<h2 class="text-accent mb-15">Submissions: ${escapeHtml(username)}</h2><div id="admin-sub-list">${listHtml}</div>`);
            ensureSubmissionListActions();
            const loadBtn = document.getElementById('admin-subs-load-more');
            if (loadBtn) {
                loadBtn.addEventListener('click', () => {
                    adminViewSubmissions(userId, username, offset + data.submissions.length);
                });
            }
            return;
        }

        const tbody = document.getElementById('admin-sub-tbody');
        if (!tbody) return;
        data.submissions.forEach(s => {
            tbody.insertAdjacentHTML('beforeend', submissionRowHtml(s, userId, username));
        });

        const loadBtn = document.getElementById('admin-subs-load-more');
        if (data.hasMore && loadBtn) {
            const nextOffset = offset + data.submissions.length;
            loadBtn.replaceWith(loadBtn.cloneNode(true));
            document.getElementById('admin-subs-load-more').addEventListener('click', () => {
                adminViewSubmissions(userId, username, nextOffset);
            });
        } else if (loadBtn) {
            loadBtn.remove();
        }
    } catch (err) {
        const msg = isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Failed to load submissions.';
        showModal(`<h2 class="text-accent mb-15">Submissions: ${escapeHtml(username)}</h2><div class="error-center">${escapeHtml(msg)}</div>`);
    }
}

async function adminDeleteSubmission(subId, userId, username) {
    if (!await showConfirm(
        `Delete submission #${subId}?`,
        { title: 'Delete Submission', confirmLabel: 'Delete', danger: true }
    )) return;

    try {
        const res = await securePost(`/api/admin/submissions/${subId}`, {}, 'DELETE');
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
        else adminViewSubmissions(userId, username);
    } catch (err) {
        await showNetworkError(err);
    }
}

function formatAuditActor(entry) {
    if (entry.actor_username) return escapeHtml(entry.actor_username);
    if (entry.actor_user_id) return `#${escapeHtml(String(entry.actor_user_id))}`;
    return '-';
}

function formatAuditTarget(entry) {
    if (entry.target_username) return escapeHtml(entry.target_username);
    if (entry.target_user_id) return `#${escapeHtml(String(entry.target_user_id))}`;
    return '-';
}

function auditRowHtml(entry) {
    const label = AUDIT_EVENT_LABELS[entry.event_type] || escapeHtml(entry.event_type);
    const time = entry.created_at ? new Date(entry.created_at).toLocaleString() : '-';
    return `
        <tr>
            <td>${escapeHtml(time)}</td>
            <td>${escapeHtml(label)}</td>
            <td>${formatAuditActor(entry)}</td>
            <td>${formatAuditTarget(entry)}</td>
            <td>${entry.lab_id ? escapeHtml(entry.lab_id) : '-'}</td>
            <td>${entry.source ? escapeHtml(entry.source) : '-'}</td>
            <td class="audit-detail-cell">${entry.detail ? escapeHtml(entry.detail) : '-'}</td>
        </tr>
    `;
}

function appendAuditLoadMore(hasMore) {
    let btn = document.getElementById('audit-log-load-more');
    if (!hasMore) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'audit-log-load-more';
        btn.className = 'btn-secondary btn-small';
        btn.style.marginTop = '12px';
        btn.textContent = 'Load more entries';
        btn.addEventListener('click', () => loadAuditLog(true));
        document.getElementById('admin-panel-audit').appendChild(btn);
    }
}

export async function loadAuditLog(append = false) {
    const tbody = document.getElementById('admin-audit-body');
    if (!tbody) return;

    const filterEl = document.getElementById('audit-event-filter');
    const eventType = filterEl ? filterEl.value : '';
    if (!append) auditLogOffset = 0;

    const params = new URLSearchParams({
        limit: String(AUDIT_LOG_LIMIT),
        offset: String(auditLogOffset),
    });
    if (eventType) params.set('event_type', eventType);

    try {
        const res = await apiFetch(`/api/admin/audit-log?${params}`);
        if (!res.ok) {
            if (!append) tbody.innerHTML = `<tr><td colspan="7" class="error-center">Error loading audit log.</td></tr>`;
            return;
        }
        const data = await res.json();

        if (!append) tbody.innerHTML = '';

        if (data.entries.length === 0 && !append) {
            tbody.innerHTML = `<tr><td colspan="7" class="text-muted" style="text-align:center;padding:24px;">No audit entries yet.</td></tr>`;
            appendAuditLoadMore(false);
            return;
        }

        data.entries.forEach(entry => {
            tbody.insertAdjacentHTML('beforeend', auditRowHtml(entry));
        });

        if (data.hasMore) {
            auditLogOffset = data.offset + data.entries.length;
        }
        appendAuditLoadMore(data.hasMore);
    } catch (err) {
        if (!append) {
            const msg = isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Error loading audit log.';
            tbody.innerHTML = `<tr><td colspan="7" class="error-center">${escapeHtml(msg)}</td></tr>`;
        }
    }
}

export async function loadAnalyticsLabOptions() {
    const select = document.getElementById('analytics-lab-select');
    if (!select) return;
    try {
        const res = await apiFetch('/api/config');
        if (!res.ok) return;
        const data = await res.json();
        const labs = (data.challenges || []).filter((c) => c.type !== 'quiz');
        select.innerHTML = labs.map((l) => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.title || l.id)}</option>`).join('');
    } catch {
    }
}

export async function loadLabAnalytics() {
    const select = document.getElementById('analytics-lab-select');
    const labId = select?.value;
    if (!labId) return;

    try {
        const res = await apiFetch(`/api/admin/labs/${encodeURIComponent(labId)}/analytics`);
        if (!res.ok) {
            showAlert('Failed to load lab analytics.');
            return;
        }
        const data = await res.json();
        const summary = document.getElementById('analytics-summary');
        if (summary) {
            summary.innerHTML = `
            <p><strong>${escapeHtml(data.lab.title)}</strong> - ${data.total_attempts} attempt(s), ${data.unique_users} user(s), median time: ${data.median_duration_seconds ?? '-'}s</p>
        `;
        }

        const tbody = document.getElementById('admin-analytics-body');
        if (tbody) {
            tbody.innerHTML = '';
            (data.attempt_timeline || []).forEach((row) => {
                tbody.insertAdjacentHTML('beforeend', `
                <tr>
                    <td>${escapeHtml(row.username)}</td>
                    <td>${row.score}/${row.max_score}</td>
                    <td>${row.duration_seconds ?? '-'}</td>
                    <td>${escapeHtml(row.timestamp)}</td>
                </tr>
            `);
            });
        }
    } catch (err) {
        await showNetworkError(err, { title: 'Analytics' });
    }
}
