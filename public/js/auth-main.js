import { login, register, toggleAuth, bootstrapAuthPage } from './auth.js';

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('btn-login-submit')?.addEventListener('click', login);
    document.getElementById('btn-register-submit')?.addEventListener('click', register);
    document.getElementById('link-show-register')?.addEventListener('click', () => toggleAuth('register'));
    document.getElementById('link-show-login')?.addEventListener('click', () => toggleAuth('login'));
    bootstrapAuthPage();
});
