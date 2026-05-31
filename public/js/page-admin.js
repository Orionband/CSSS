import { initShell } from './shell.js';
import { loadAdminPanel, adminPromptCreateUser } from './admin.js';

document.addEventListener('DOMContentLoaded', async () => {
    const boot = await initShell('admin');
    if (!boot) return;
    if (!boot.user?.is_admin) {
        location.href = '/challenges.html';
        return;
    }
    await loadAdminPanel();

    document.getElementById('btn-admin-new-user')?.addEventListener('click', adminPromptCreateUser);
    document.getElementById('tab-admin-users')?.addEventListener('click', () => {
        document.getElementById('admin-panel-users')?.classList.remove('hidden');
        document.getElementById('admin-panel-lb')?.classList.add('hidden');
        document.getElementById('tab-admin-users')?.classList.add('active');
        document.getElementById('tab-admin-lb')?.classList.remove('active');
    });
    document.getElementById('tab-admin-lb')?.addEventListener('click', () => {
        document.getElementById('admin-panel-lb')?.classList.remove('hidden');
        document.getElementById('admin-panel-users')?.classList.add('hidden');
        document.getElementById('tab-admin-lb')?.classList.add('active');
        document.getElementById('tab-admin-users')?.classList.remove('active');
    });
});
