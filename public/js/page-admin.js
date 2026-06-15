import { initShell } from './shell.js';
import { loadAdminPanel, adminPromptCreateUser, loadAuditLog, loadAnalyticsLabOptions, loadLabAnalytics, bindAdminUserSearch } from './admin.js';

document.addEventListener('DOMContentLoaded', async () => {
    const boot = await initShell('admin');
    if (!boot) return;
    if (!boot.user?.is_admin) {
        location.href = '/challenges';
        return;
    }
    await loadAdminPanel();
    bindAdminUserSearch();

    document.getElementById('btn-admin-new-user')?.addEventListener('click', adminPromptCreateUser);
    function showAdminTab(panelId, tabId) {
        ['admin-panel-users', 'admin-panel-lb', 'admin-panel-analytics', 'admin-panel-audit'].forEach(id => {
            document.getElementById(id)?.classList.add('hidden');
        });
        ['tab-admin-users', 'tab-admin-lb', 'tab-admin-analytics', 'tab-admin-audit'].forEach(id => {
            document.getElementById(id)?.classList.remove('active');
        });
        document.getElementById(panelId)?.classList.remove('hidden');
        document.getElementById(tabId)?.classList.add('active');
    }

    document.getElementById('tab-admin-users')?.addEventListener('click', () => {
        showAdminTab('admin-panel-users', 'tab-admin-users');
    });
    document.getElementById('tab-admin-lb')?.addEventListener('click', () => {
        showAdminTab('admin-panel-lb', 'tab-admin-lb');
    });
    document.getElementById('tab-admin-analytics')?.addEventListener('click', async () => {
        showAdminTab('admin-panel-analytics', 'tab-admin-analytics');
        await loadAnalyticsLabOptions();
        await loadLabAnalytics();
    });
    document.getElementById('analytics-lab-select')?.addEventListener('change', () => loadLabAnalytics());
    document.getElementById('tab-admin-audit')?.addEventListener('click', () => {
        showAdminTab('admin-panel-audit', 'tab-admin-audit');
        loadAuditLog();
    });
    document.getElementById('audit-event-filter')?.addEventListener('change', () => loadAuditLog());
});
