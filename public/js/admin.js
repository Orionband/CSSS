import { escapeHtml, securePost, showModal, closeModal } from './utils.js';

export async function loadAdminPanel() {
    const usersBody = document.getElementById('admin-users-body');
    const lbBody = document.getElementById('admin-lb-body');

    const res = await fetch('/api/admin/users');
    if (!res.ok) {
        usersBody.innerHTML = `<tr><td colspan="4" style="color:var(--accent);text-align:center">Error loading users.</td></tr>`;
        return;
    }
    const data = await res.json();

    usersBody.innerHTML = '';
    data.users.forEach(u => {
        const row = document.createElement('tr');
        const actionsHtml = `
            <div class="action-btns">
                <button class="btn-small btn-secondary btn-admin-subs" data-id="${u.id}" data-name="${escapeHtml(u.username)}">View Submissions</button>
                <button class="btn-small btn-secondary btn-admin-pass" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Reset Password</button>
                <button class="btn-small btn-danger btn-admin-del" data-id="${u.id}" data-name="${escapeHtml(u.username)}">Delete User</button>
            </div>
        `;
        row.innerHTML = `
            <td>${u.id}</td>
            <td>${escapeHtml(u.username)}${u.is_admin ? '<span class="badge" style="background:var(--accent);color:#000;">ADMIN</span>' : ''}</td>
            <td>${u.submission_count}</td>
            <td>${actionsHtml}</td>
        `;
        usersBody.appendChild(row);
    });

    lbBody.innerHTML = '';
    const lbRes = await fetch('/api/leaderboard');
    const lbData = await lbRes.json();
    const lbMap = {};
    if (lbData.leaderboard) {
        lbData.leaderboard.forEach(entry => { lbMap[entry.username] = entry; });
    }

    data.users.forEach(u => {
        const row = document.createElement('tr');
        const totalScore = lbMap[u.username] ? lbMap[u.username].total_score : 0;
        row.innerHTML = `
            <td>${escapeHtml(u.username)}</td>
            <td>(Calculated on Server)</td>
            <td style="color:${u.score_adjustment > 0 ? '#4CAF50' : (u.score_adjustment < 0 ? '#f44747' : '#888')}">${u.score_adjustment || 0}</td>
            <td>${totalScore}</td>
            <td style="color:${u.withheld ? '#f44747' : '#888'}">${u.withheld ? 'YES' : 'NO'}</td>
            <td><button class="btn-small btn-secondary btn-admin-score" data-id="${u.id}" data-name="${escapeHtml(u.username)}" data-adj="${u.score_adjustment || 0}" data-withheld="${u.withheld || 0}">Adjust Score</button></td>
        `;
        lbBody.appendChild(row);
    });

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
        btn.addEventListener('click', (e) => adminPromptScore(e.target.dataset.id, e.target.dataset.name, e.target.dataset.adj, e.target.dataset.withheld));
    });
}

export function adminPromptCreateUser() {
    showModal(`
        <h2 style="color:var(--accent);margin-bottom:20px;">Create New User</h2>
        <div style="margin-bottom:15px;"><input type="text" id="admin-new-user" class="field-input" placeholder="Username"></div>
        <div style="margin-bottom:15px;"><input type="email" id="admin-new-email" class="field-input" placeholder="Email (Optional)"></div>
        <div style="margin-bottom:20px;">
            <input type="password" id="admin-new-pass" class="field-input" placeholder="Password">
            <div class="password-hint">Min 8 characters, 1 uppercase letter, 1 number</div>
        </div>
        <div style="margin-bottom:25px;">
            <label class="custom-label"><input type="checkbox" id="admin-new-isadmin"><span class="checkmark"></span> Grant Admin Privileges</label>
        </div>
        <button id="btn-admin-create-user-exec" class="btn-block">Create User</button>
    `);
    document.getElementById('btn-admin-create-user-exec').addEventListener('click', adminExecuteCreateUser);
}

async function adminExecuteCreateUser() {
    const username = document.getElementById('admin-new-user').value;
    const email = document.getElementById('admin-new-email').value;
    const password = document.getElementById('admin-new-pass').value;
    const is_admin = document.getElementById('admin-new-isadmin').checked;

    const res = await securePost('/api/admin/users', { username, email, password, is_admin });
    const data = await res.json();
    if (data.error) alert(data.error);
    else { closeModal(); loadAdminPanel(); }
}

function adminPromptPassword(id, username) {
    showModal(`
        <h2 style="color:var(--accent);margin-bottom:20px;">Reset Password: ${escapeHtml(username)}</h2>
        <div style="margin-bottom:20px;">
            <input type="password" id="admin-reset-pass" class="field-input" placeholder="New Password">
            <div class="password-hint">Min 8 characters, 1 uppercase letter, 1 number</div>
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
        <h2 style="color:var(--accent);margin-bottom:20px;">Adjust Score: ${escapeHtml(username)}</h2>
        <div style="margin-bottom:15px;">
            <label style="margin-bottom:5px;display:block;">Global Modifier (+/- Points)</label>
            <input type="number" id="admin-score-adj" value="${currentAdj}" class="field-input">
        </div>
        <div style="margin-bottom:25px;">
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

async function adminViewSubmissions(userId, username) {
    const res = await fetch(`/api/admin/users/${userId}/submissions`);
    const data = await res.json();

    let listHtml;
    if (data.error) {
        listHtml = escapeHtml(data.error);
    } else if (data.submissions.length === 0) {
        listHtml = "<div style='color:#888'>No submissions found.</div>";
    } else {
        let tableHtml = `<div class="table-scroll" style="max-height:400px;"><table class="admin-table"><thead><tr><th>ID</th><th>Lab ID</th><th>Type</th><th>Score</th><th>Date</th><th>Actions</th></tr></thead><tbody>`;
        data.submissions.forEach(s => {
            tableHtml += `
                <tr>
                    <td>${s.id}</td>
                    <td>${escapeHtml(s.lab_id)}</td>
                    <td>${escapeHtml(s.type)}</td>
                    <td>${s.score}/${s.max_score}</td>
                    <td>${new Date(s.timestamp).toLocaleString()}</td>
                    <td><button class="btn-small btn-danger btn-admin-del-sub" data-subid="${s.id}" data-userid="${userId}" data-username="${escapeHtml(username)}">Delete</button></td>
                </tr>
            `;
        });
        tableHtml += '</tbody></table></div>';
        listHtml = tableHtml;
    }

    showModal(`<h2 style="color:var(--accent);margin-bottom:15px;">Submissions: ${escapeHtml(username)}</h2><div id="admin-sub-list">${listHtml}</div>`);
    document.querySelectorAll('.btn-admin-del-sub').forEach(btn => {
        btn.addEventListener('click', (e) => adminDeleteSubmission(e.target.dataset.subid, e.target.dataset.userid, e.target.dataset.username));
    });
}

async function adminDeleteSubmission(subId, userId, username) {
    if (confirm(`Delete submission #${subId}?`)) {
        const res = await securePost(`/api/admin/submissions/${subId}`, {}, 'DELETE');
        const data = await res.json();
        if (data.error) alert(data.error);
        else adminViewSubmissions(userId, username);
    }
}
