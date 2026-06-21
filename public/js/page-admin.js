import { initShell } from './shell.js';
import { loadAdminPanel, adminPromptCreateUser, loadAuditLog, loadAnalyticsLabOptions, loadLabAnalytics, bindAdminUserSearch } from './admin.js';
import { initResizableTable } from './table-resize.js';
import { showAlert } from './utils.js';
import { clearBootstrapCache } from './auth.js';

const AUDIT_TABLE_DEFAULT_COL_WIDTHS = [170, 130, 90, 90, 90, 100];

document.addEventListener('DOMContentLoaded', async () => {
    const params = new URLSearchParams(location.search);
    const reauthOk = params.get('reauth') === 'ok';
    const reauthError = params.get('reauth_error');
    if (reauthOk) clearBootstrapCache();

    const boot = await initShell('admin');
    if (!boot) return;
    if (!boot.user?.is_admin) {
        location.href = '/challenges';
        return;
    }

    if (reauthOk) {
        if (boot.user?.admin_discord_reauth_valid) {
            await showAlert('Discord verification successful. You can perform sensitive admin actions for the next few minutes.', { title: 'Verified' });
        } else {
            await showAlert('Discord verification could not be confirmed. Please verify again.', { title: 'Verification failed' });
        }
        params.delete('reauth');
        const next = params.toString();
        window.history.replaceState(null, '', next ? `?${next}` : location.pathname);
    }
    if (reauthError) {
        await showAlert(reauthError, { title: 'Verification failed' });
        params.delete('reauth_error');
        const next = params.toString();
        window.history.replaceState(null, '', next ? `?${next}` : location.pathname);
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
        initResizableTable(document.getElementById('admin-audit-table'), {
            storageKey: 'csss-admin-audit-cols',
            defaults: AUDIT_TABLE_DEFAULT_COL_WIDTHS,
        });
        loadAuditLog();
    });
    document.getElementById('audit-event-filter')?.addEventListener('change', () => loadAuditLog());
});
