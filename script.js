const socket = io();
let currentUser = null;

// --- AUTH ---
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
    loadHistory();
}

fetch('/api/me').then(r => r.json()).then(data => {
    if(data.unique_id) initApp(data.unique_id);
});

// --- NAVIGATION ---
function switchTab(tab) {
    document.getElementById('view-grader').classList.toggle('hidden', tab !== 'grader');
    document.getElementById('view-history').classList.toggle('hidden', tab !== 'history');
    
    document.getElementById('nav-grader').classList.toggle('active', tab === 'grader');
    document.getElementById('nav-history').classList.toggle('active', tab === 'history');
    
    if(tab === 'history') loadHistory();
}

// --- HISTORY ---
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

        item.innerHTML = `
            <div class="hist-date">${date}</div>
            <div class="hist-score">${scoreText}</div>
        `;
        list.appendChild(item);
    });
}

function showHistoryDetail(sub) {
    document.getElementById('history-list').parentElement.classList.add('hidden');
    document.getElementById('history-detail').classList.remove('hidden');
    
    document.getElementById('hist-date').innerText = new Date(sub.timestamp).toLocaleString();
    
    const scoreText = (sub.score !== null) ? `${sub.score} / ${sub.max_score}` : "Hidden";
    document.getElementById('hist-score').innerText = scoreText;
    
    const cont = document.getElementById('hist-checks');
    cont.innerHTML = '';
    
    if(sub.details.length === 0) {
        cont.innerHTML = "<div style='text-align:center; padding:20px; color:#888'>Feedback hidden.</div>";
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

// --- GRADER ---
const fileInput = document.getElementById('f');
const progressBar = document.getElementById('progress-bar');
const statusText = document.getElementById('status');

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    
    document.getElementById('report').classList.add('hidden');
    document.getElementById('progress-container').style.display = 'block';
    progressBar.style.width = '0%';
    statusText.innerText = "Uploading...";
    fileInput.value = ''; 

    const reader = new FileReader();
    reader.onload = (evt) => {
        socket.emit('upload_file', evt.target.result);
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

    if (data.options.show_score) scoreBox.innerText = `${data.total} / ${data.max}`;
    else scoreBox.innerText = "Hidden";

    if (data.clientBreakdown.length === 0) {
        checksList.innerHTML = "<div style='text-align:center; color:#888; padding:10px'>Feedback hidden.</div>";
    } else {
        data.clientBreakdown.forEach(c => {
            const row = document.createElement('div');
            row.className = 'check-item ' + (c.points >= 0 ? 'gain' : 'penalty');
            row.innerHTML = `<span>${c.message}</span><span class="pts">${c.points > 0 ? '+'+c.points : c.points}</span>`;
            checksList.appendChild(row);
        });
    }
    
    loadHistory();
});

socket.on('err', (msg) => {
    statusText.innerText = "Error: " + msg;
    progressBar.style.background = '#f44747';
});
