import { escapeHtml, securePost, showModal, closeModal } from './utils.js';

const ADMIN_USERS_LIMIT = 100;
const ADMIN_SUBS_LIMIT = 100;
let adminUsersOffset = 0;

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

function renderAdminUserRows(users, usersBody, lbBody) {
    users.forEach(u => {
        const row = document.createElement('tr');
        const actionsHtml = `
            <div class="action-btns">
                <button class="btn-small btn-secondary btn-admin-subs" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">View Submissions</button>
                <button class="btn-small btn-secondary btn-admin-pass" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">Reset Password</button>
                <button class="btn-small btn-danger btn-admin-del" data-id="${escapeHtml(String(u.id))}" data-name="${escapeHtml(u.username)}">Delete User</button>
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

    const res = await fetch(`/api/admin/users?limit=${ADMIN_USERS_LIMIT}&offset=${adminUsersOffset}`);
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

    if (data.hasMore) {
        adminUsersOffset = data.offset + data.users.length;
    }
    appendAdminUsersLoadMore(data.hasMore);
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

    const res = await securePost('/api/admin/users', { username, email, password, is_admin });
    const data = await res.json();
    if (data.error) alert(data.error);
    else { closeModal(); loadAdminPanel(); }
}

function adminPromptPassword(id, username) {
    showModal(`
        <h2 class="text-accent mb-20">Reset Password: ${escapeHtml(username)}</h2>
        <div class="mb-20">
            <input type="password" id="admin-reset-pass" class="field-input" placeholder="New Password">
            <div class="password-hint">Min 8 characters, 1 uppercase letter, 1 number, 1 symbol</div>
        </div>
        <button id="btn-admin-reset-pass-exec" data-id="${id}" class="btn-block">Reset Password</button>
    `);
    document.getElementById('btn-admin-reset-pass-exec').addEventListener('click', (e) => adminExecutePassword(e.target.dataset.id));
}

async function adminExecutePassword(id) {
    const password = document.getElementById('admin-reset-pass').value;
    const res = await securePost(`/api/admin/users/${id}/password`, { password });
    const data = await res.json();
    if (data.error) alert(data.error);
    else { alert('Password updated.'); closeModal(); }
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
        <button id="btn-admin-score-exec" data-id="${id}" class="btn-block">Save Adjustments</button>
    `);
    document.getElementById('btn-admin-score-exec').addEventListener('click', (e) => adminExecuteScore(e.target.dataset.id));
}

async function adminExecuteScore(id) {
    const adjustment = document.getElementById('admin-score-adj').value;
    const withheld = document.getElementById('admin-score-withhold').checked;
    const res = await securePost(`/api/admin/users/${id}/score`, { adjustment, withheld });
    const data = await res.json();
    if (data.error) alert(data.error);
    else { closeModal(); loadAdminPanel(); }
}

async function adminDeleteUser(id, username) {
    if (confirm(`Are you sure you want to permanently delete user '${username}' and ALL their submissions?`)) {
        const res = await securePost(`/api/admin/users/${id}`, {}, 'DELETE');
        const data = await res.json();
        if (data.error) alert(data.error);
        else loadAdminPanel();
    }
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

function bindSubmissionDeleteButtons(userId, username) {
    document.querySelectorAll('.btn-admin-del-sub').forEach(btn => {
        btn.addEventListener('click', (e) => adminDeleteSubmission(
            e.target.dataset.subid, e.target.dataset.userid, e.target.dataset.username
        ));
    });
}

async function adminViewSubmissions(userId, username, offset = 0) {
    const res = await fetch(`/api/admin/users/${userId}/submissions?limit=${ADMIN_SUBS_LIMIT}&offset=${offset}`);
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
        bindSubmissionDeleteButtons(userId, username);
        const loadBtn = document.getElementById('admin-subs-load-more');
        if (loadBtn) {
            loadBtn.addEventListener('click', () => {
                adminViewSubmissions(userId, username, offset + data.submissions.length);
            });
        }
        return;
    }

    const tbody = document.getElementById('admin-sub-tbody');
    data.submissions.forEach(s => {
        tbody.insertAdjacentHTML('beforeend', submissionRowHtml(s, userId, username));
    });
    bindSubmissionDeleteButtons(userId, username);

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
}

async function adminDeleteSubmission(subId, userId, username) {
    if (confirm(`Delete submission #${subId}?`)) {
        const res = await securePost(`/api/admin/submissions/${subId}`, {}, 'DELETE');
        const data = await res.json();
        if (data.error) alert(data.error);
        else adminViewSubmissions(userId, username);
    }
}
