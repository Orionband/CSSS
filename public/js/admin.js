import { escapeHtml, securePost, showModal, closeModal, showAlert, showConfirm, apiFetch, NETWORK_ERROR_MESSAGE, isNetworkError, showNetworkError } from './utils.js';

const ADMIN_USERS_LIMIT = 100;
const ADMIN_SUBS_LIMIT = 100;
const AUDIT_LOG_LIMIT = 50;
let adminUsersOffset = 0;
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

function bindAdminUserButtons() {
    document.querySelectorAll('.btn-admin-subs').forEach(btn => {
        btn.addEventListener('click', (e) => adminViewSubmissions(e.target.dataset.id, e.target.dataset.name));
    });
    document.querySelectorAll('.btn-admin-pass').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptPassword(e.target.dataset.id, e.target.dataset.name));
    });
    document.querySelectorAll('.btn-admin-del').forEach(btn => {
        btn.addEventListener('click', (e) => adminDeleteUser(e.target.dataset.id, e.target.dataset.name));
    });
    document.querySelectorAll('.btn-admin-score').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptScore(
            e.target.dataset.id, e.target.dataset.name, e.target.dataset.adj, e.target.dataset.withheld
        ));
    });
    document.querySelectorAll('.btn-admin-role').forEach(btn => {
        btn.addEventListener('click', (e) => adminPromptRole(
            e.target.dataset.id, e.target.dataset.name, e.target.dataset.isadmin === '1'
        ));
    });
}

function appendAdminUsersLoadMore(hasMore) {
    let btn = document.getElementById('admin-users-load-more');
    if (!hasMore) {
        if (btn) btn.remove();
        return;
    }
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'admin-users-load-more';
        btn.className = 'btn-secondary btn-small';
        btn.style.marginTop = '12px';
        btn.textContent = 'Load more users';
        btn.addEventListener('click', () => loadAdminPanel(true));
        document.getElementById('admin-panel-users').appendChild(btn);
    }
}

function adminRoleButtonHtml(u) {
    if (!window.isOwner || u.is_owner || u.id === window.currentUserId) return '';
    if (u.is_admin) {
        return `<button class="btn-small btn-secondary btn-admin-role" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}" data-isadmin="1">Revoke Admin</button>`;
    }
    return `<button class="btn-small btn-secondary btn-admin-role" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}" data-isadmin="0">Grant Admin</button>`;
}

function applyAdminUserSearch(query) {
    const q = query.trim().toLowerCase();
    document.querySelectorAll('#admin-users-body tr[data-username], #admin-lb-body tr[data-username]').forEach((row) => {
        row.hidden = Boolean(q) && !row.dataset.username.includes(q);
    });
}

export function bindAdminUserSearch() {
    document.querySelectorAll('.admin-user-search').forEach((input) => {
        input.addEventListener('input', () => {
            const { value } = input;
            document.querySelectorAll('.admin-user-search').forEach((el) => {
                if (el !== input) el.value = value;
            });
            applyAdminUserSearch(value);
        });
    });
}

function renderAdminUserRows(users, usersBody, lbBody) {
    users.forEach(u => {
        const row = document.createElement('tr');
        row.dataset.username = u.username.toLowerCase();
        const canDelete = u.id !== window.currentUserId && (!u.is_admin || window.isOwner);
        const actionsHtml = `
            <div class="action-btns">
                <button class="btn-small btn-secondary btn-admin-subs" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">View Submissions</button>
                <button class="btn-small btn-secondary btn-admin-pass" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">Reset Password</button>
                ${adminRoleButtonHtml(u)}
                ${canDelete ? `<button class="btn-small btn-danger btn-admin-del" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">Delete User</button>` : ''}
            </div>
        `;
        row.innerHTML = `
            <td>${escapeHtml(String(u.id))}</td>
            <td>${escapeHtml(u.username)}${u.is_owner ? '<span class="badge badge-owner">OWNER</span>' : (u.is_admin ? '<span class="badge badge-admin">ADMIN</span>' : '')}</td>
            <td>${u.submission_count}</td>
            <td>${actionsHtml}</td>
        `;
        usersBody.appendChild(row);

        const totalScore = u.leaderboard_total ?? 0;
        const adjClass = u.score_adjustment > 0 ? 'adj-positive' : (u.score_adjustment < 0 ? 'adj-negative' : 'adj-zero');
        const withheldClass = u.withheld ? 'withheld-yes' : 'withheld-no';
        const lbRow = document.createElement('tr');
        lbRow.dataset.username = u.username.toLowerCase();
        lbRow.innerHTML = `
            <td>${escapeHtml(u.username)}</td>
            <td>(Calculated on Server)</td>
            <td class="${adjClass}">${u.score_adjustment || 0}</td>
            <td>${totalScore}</td>
            <td class="${withheldClass}">${u.withheld ? 'YES' : 'NO'}</td>
            <td><button class="btn-small btn-secondary btn-admin-score" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}" data-adj="${escapeHtml(String(u.score_adjustment ?? 0))}" data-withheld="${escapeHtml(String(u.withheld || 0))}">Adjust Score</button></td>
        `;
        lbBody.appendChild(lbRow);
    });
}

export async function loadAdminPanel(append = false) {
    const usersBody = document.getElementById('admin-users-body');
    const lbBody = document.getElementById('admin-lb-body');

    if (!append) adminUsersOffset = 0;

    try {
        const res = await apiFetch(`/api/admin/users?limit=${ADMIN_USERS_LIMIT}&offset=${adminUsersOffset}`);
        if (!res.ok) {
            usersBody.innerHTML = `<tr><td colspan="4" class="error-center">Error loading users.</td></tr>`;
            return;
        }
        const data = await res.json();

        if (!append) {
            usersBody.innerHTML = '';
            lbBody.innerHTML = '';
        }

        renderAdminUserRows(data.users, usersBody, lbBody);
        bindAdminUserButtons();
        applyAdminUserSearch(document.querySelector('.admin-user-search')?.value || '');

        if (data.hasMore) {
            adminUsersOffset = data.offset + data.users.length;
        }
        appendAdminUsersLoadMore(data.hasMore);
    } catch (err) {
        if (!append) {
            usersBody.innerHTML = `<tr><td colspan="4" class="error-center">${escapeHtml(isNetworkError(err) ? NETWORK_ERROR_MESSAGE : 'Error loading users.')}</td></tr>`;
        }
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
            <input type="password" id="admin-current-pass" class="field-input" placeholder="Your Current Password" autocomplete="current-password">
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
    const current_password = document.getElementById('admin-current-pass').value;
    try {
        const res = await securePost(`/api/admin/users/${id}/password`, { password, current_password });
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
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
        <div class="mb-20">
            <input type="password" id="admin-score-current-pass" class="field-input" placeholder="Your Current Password" autocomplete="current-password">
        </div>
        <button id="btn-admin-score-exec" data-id="${id}" class="btn-block">Save Adjustments</button>
    `);
    document.getElementById('btn-admin-score-exec').addEventListener('click', (e) => adminExecuteScore(e.target.dataset.id));
}

async function adminExecuteScore(id) {
    const adjustment = document.getElementById('admin-score-adj').value;
    const withheld = document.getElementById('admin-score-withhold').checked;
    const current_password = document.getElementById('admin-score-current-pass').value;
    try {
        const res = await securePost(`/api/admin/users/${id}/score`, { adjustment, withheld, current_password });
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
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
        <div class="mb-20">
            <input type="password" id="admin-role-current-pass" class="field-input" placeholder="Your Current Password" autocomplete="current-password">
        </div>
        <button id="btn-admin-role-exec" data-id="${id}" data-isadmin="${isAdmin ? '0' : '1'}" class="btn-block">${action}</button>
    `);
    document.getElementById('btn-admin-role-exec').addEventListener('click', (e) => adminExecuteRole(e.target.dataset.id, e.target.dataset.isadmin === '1'));
}

async function adminExecuteRole(id, grantAdmin) {
    const current_password = document.getElementById('admin-role-current-pass').value;
    try {
        const res = await securePost(`/api/admin/users/${id}/admin`, { is_admin: grantAdmin, current_password });
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
        else { closeModal(); loadAdminPanel(); }
    } catch (err) {
        await showNetworkError(err);
    }
}

function adminPromptDelete(id, username) {
    showModal(`
        <h2 class="text-accent mb-20">Delete User: ${escapeHtml(username)}</h2>
        <p class="text-muted mb-20">This permanently deletes the user and all their submissions. This cannot be undone.</p>
        <div class="mb-20">
            <input type="password" id="admin-delete-current-pass" class="field-input" placeholder="Your Current Password" autocomplete="current-password">
        </div>
        <button id="btn-admin-delete-exec" data-id="${id}" class="btn-block btn-danger">Delete User</button>
    `);
    document.getElementById('btn-admin-delete-exec').addEventListener('click', (e) => adminExecuteDelete(e.target.dataset.id));
}

async function adminExecuteDelete(id) {
    const current_password = document.getElementById('admin-delete-current-pass').value;
    try {
        const res = await securePost(`/api/admin/users/${id}`, { current_password }, 'DELETE');
        const data = await res.json();
        if (data.error) await showAlert(data.error, { title: 'Error' });
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
        /* analytics lab list is optional on failure */
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
