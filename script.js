const socket = io();
let currentUser = null;
let availableLabs = [];
let currentLabId = null;

function toggleAuth(mode) {
    document.getElementById('login-form').classList.toggle('hidden', mode !== 'login');
    document.getElementById('register-form').classList.toggle('hidden', mode !== 'register');
    document.getElementById('auth-error').innerText = '';
}
async function login() {
    const user = document.getElementById('l-user').value;
    const pass = document.getElementById('l-pass').value;
    const res = await fetch('/api/login', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if(data.success) initApp(data.unique_id);
    else document.getElementById('auth-error').innerText = data.error;
}
async function register() {
    const user = document.getElementById('r-user').value;
    const email = document.getElementById('r-email').value;
    const pass = document.getElementById('r-pass').value;
    const res = await fetch('/api/register', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ username: user, email: email, password: pass })
    });
    const data = await res.json();
    if(data.success) initApp(data.unique_id);
    else document.getElementById('auth-error').innerText = data.error;
}
async function logout() {
    await fetch('/api/logout', { method: 'POST' });
    location.reload();
}
function initApp(uid) {
    currentUser = uid;
    document.getElementById('auth-view').classList.add('hidden');
    document.getElementById('app-view').classList.remove('hidden');
    document.getElementById('uid-display').innerText = uid;
    socket.emit('authenticate', uid);
    fetchLabs();
}
fetch('/api/me').then(r => r.json()).then(data => {
    if(data.unique_id) initApp(data.unique_id);
});

async function fetchLabs() {
    const res = await fetch('/api/config');
    const data = await res.json();
    availableLabs = data.labs;
    renderNav(data.options);
    if(availableLabs.length > 0) switchTab(availableLabs[0].id);
}
function renderNav(options) {
    const nav = document.getElementById('nav-links-container');
    nav.innerHTML = '';
    availableLabs.forEach(lab => {
        const item = document.createElement('div');
        item.className = 'nav-item';
        item.id = 'nav-' + lab.id;
        item.innerText = lab.title;
        item.onclick = () => switchTab(lab.id);
        nav.appendChild(item);
    });
    if (options.show_leaderboard) {
        const lb = document.createElement('div');
        lb.className = 'nav-item';
        lb.id = 'nav-leaderboard';
        lb.innerText = 'Leaderboard';
        lb.onclick = () => switchTab('leaderboard');
        nav.appendChild(lb);
    }
    const hist = document.createElement('div');
    hist.className = 'nav-item';
    hist.id = 'nav-history';
    hist.innerText = 'History';
    hist.onclick = () => switchTab('history');
    nav.appendChild(hist);
}
function switchTab(tabId) {
    document.getElementById('view-grader').classList.add('hidden');
    document.getElementById('view-history').classList.add('hidden');
    document.getElementById('view-leaderboard').classList.add('hidden');
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const activeNav = document.getElementById('nav-' + tabId);
    if(activeNav) activeNav.classList.add('active');
    if(tabId === 'history') {
        document.getElementById('view-history').classList.remove('hidden');
        loadHistory();
    } else if(tabId === 'leaderboard') {
        document.getElementById('view-leaderboard').classList.remove('hidden');
        loadLeaderboard();
    } else {
        currentLabId = tabId;
        const lab = availableLabs.find(l => l.id === tabId);
        if(lab) {
            document.getElementById('view-grader').classList.remove('hidden');
            document.getElementById('lab-title').innerText = lab.title;
            document.getElementById('report').classList.add('hidden');
            document.getElementById('progress-container').style.display = 'none';
            document.getElementById('status').innerText = '';
        }
    }
}
async function loadLeaderboard() {
    const res = await fetch('/api/leaderboard');
    const data = await res.json();
    const theadRow = document.querySelector('#lb-table thead tr');
    theadRow.innerHTML = '';
    const thRank = document.createElement('th'); thRank.innerText = 'Rank';
    theadRow.appendChild(thRank);
    const thUser = document.createElement('th'); thUser.innerText = 'User';
    theadRow.appendChild(thUser);
    data.labs.forEach(l => {
        const th = document.createElement('th');
        th.innerText = l.title;
        theadRow.appendChild(th);
    });
    const thTotal = document.createElement('th'); thTotal.innerText = 'Total Score';
    theadRow.appendChild(thTotal);
    const tbody = document.getElementById('lb-body');
    tbody.innerHTML = '';
    data.leaderboard.forEach((entry, index) => {
        const tr = document.createElement('tr');
        let html = `<td>#${index + 1}</td><td>${entry.username}</td>`;
        data.labs.forEach(l => {
            const score = entry.scores[l.id] || 0;
            html += `<td style="color:#b8b8b8">${score}</td>`;
        });
        html += `<td style="color:var(--accent); font-weight:bold">${entry.total_score}</td>`;
        tr.innerHTML = html;
        tbody.appendChild(tr);
    });
}
async function loadHistory() {
    const res = await fetch('/api/history');
    const data = await res.json();
    const list = document.getElementById('history-list');
    if(!data.history || data.history.length === 0) {
        list.innerHTML = "<div style='text-align:center; padding:20px; color:#888'>No submissions yet.</div>";
        return;
    }
    list.innerHTML = '';
    data.history.forEach(sub => {
        const item = document.createElement('div');
        item.className = 'history-row';
        const date = new Date(sub.timestamp).toLocaleString();
        item.onclick = () => showHistoryDetail(sub);
        const scoreText = (sub.score !== null) ? `${sub.score} / ${sub.max_score}` : "Hidden";
        const lab = availableLabs.find(l => l.id === sub.lab_id);
        const labTitle = lab ? lab.title : (sub.lab_id || "Unknown Lab");
        item.innerHTML = `<div><div style="font-weight:bold; color:#fff">${labTitle}</div><div class="hist-date">${date}</div></div><div class="hist-score">${scoreText}</div>`;
        list.appendChild(item);
    });
}
function showHistoryDetail(sub) {
    document.getElementById('history-list').parentElement.classList.add('hidden');
    document.getElementById('history-detail').classList.remove('hidden');
    document.getElementById('hist-date').innerText = new Date(sub.timestamp).toLocaleString();
    const lab = availableLabs.find(l => l.id === sub.lab_id);
    document.getElementById('hist-lab').innerText = lab ? lab.title : sub.lab_id;
    const scoreText = (sub.score !== null) ? `${sub.score} / ${sub.max_score}` : "Hidden";
    document.getElementById('hist-score').innerText = scoreText;
    const cont = document.getElementById('hist-checks');
    cont.innerHTML = '';
    
    // FIX: Check for NULL specifically
    if(sub.details === null) {
        cont.innerHTML = "<div style='text-align:center; padding:20px; color:#888'>Feedback hidden by instructor.</div>";
    } else if (sub.details.length === 0) {
        cont.innerHTML = "<div style='text-align:center; padding:20px; color:#888'>No checks passed.</div>";
    } else {
        sub.details.forEach(c => {
            const row = document.createElement('div');
            row.className = 'check-item ' + (c.points >= 0 ? 'gain' : 'penalty');
            row.innerHTML = `<span>${c.message}</span><span class="pts">${c.points > 0 ? '+'+c.points : c.points}</span>`;
            cont.appendChild(row);
        });
    }
}
function closeHistory() {
    document.getElementById('history-detail').classList.add('hidden');
    document.getElementById('history-list').parentElement.classList.remove('hidden');
}
const fileInput = document.getElementById('f');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status');
fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    if(!currentLabId) { alert("No lab selected."); return; }
    document.getElementById('report').classList.add('hidden');
    document.getElementById('progress-container').style.display = 'block';
    progressBar.style.width = '0%';
    statusText.innerText = "Uploading...";
    fileInput.value = ''; 
    const reader = new FileReader();
    reader.onload = (evt) => {
        socket.emit('upload_file', {
            fileData: evt.target.result,
            labId: currentLabId
        });
        statusText.innerText = "Queued...";
    };
    reader.readAsArrayBuffer(file);
});
socket.on('progress', (d) => {
    let pct = parseFloat(d.percent) || 0;
    if(pct > 100) pct = 100;
    progressBar.style.width = pct + '%';
    statusText.innerText = `${d.stage} (${Math.round(pct)}%)`;
});
socket.on('result', (data) => {
    progressBar.style.width = '100%';
    statusText.innerText = "Done";
    const checksList = document.getElementById('checks-list');
    const scoreBox = document.getElementById('final-score');
    checksList.innerHTML = '';
    document.getElementById('report').classList.remove('hidden');
    if (data.show_score) scoreBox.innerText = `${data.total} / ${data.max}`;
    else scoreBox.innerText = "Hidden";

    // FIX: Check for NULL specifically
    if (data.clientBreakdown === null) {
        checksList.innerHTML = "<div style='text-align:center; color:#888; padding:10px'>Feedback hidden by instructor.</div>";
    } else if (data.clientBreakdown.length === 0) {
        checksList.innerHTML = "<div style='text-align:center; color:#888; padding:10px'>No checks passed.</div>";
    } else {
        data.clientBreakdown.forEach(c => {
            const row = document.createElement('div');
            row.className = 'check-item ' + (c.points >= 0 ? 'gain' : 'penalty');
            row.innerHTML = `<span>${c.message}</span><span class="pts">${c.points > 0 ? '+'+c.points : c.points}</span>`;
            checksList.appendChild(row);
        });
    }
});
socket.on('err', (msg) => {
    statusText.innerText = "Error: " + msg;
    progressBar.style.background = '#f44747';
});
