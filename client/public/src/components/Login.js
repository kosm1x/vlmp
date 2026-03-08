import { h } from 'https://unpkg.com/preact@10/dist/preact.module.js';
import { useState } from 'https://unpkg.com/preact@10/hooks/dist/hooks.module.js';
import htm from 'https://unpkg.com/htm@3?module';
import { post, setToken } from '../api.js';
import { navigate } from '../router.js';
const html = htm.bind(h);
export function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  async function handleSubmit(e) {
    e.preventDefault(); setError('');
    try { const data = await post(isRegister ? '/auth/register' : '/auth/login', { username, password }); setToken(data.token); navigate('/'); onLogin(); }
    catch (err) { setError(err.message); }
  }
  return html`<div class="auth-page"><form class="auth-form" onSubmit=${handleSubmit}>
    <h1>VLMP</h1>
    ${error && html`<div class="error">${error}</div>`}
    <input type="text" placeholder="Username" value=${username} onInput=${e => setUsername(e.target.value)} autocomplete="username" />
    <input type="password" placeholder="Password" value=${password} onInput=${e => setPassword(e.target.value)} autocomplete=${isRegister ? 'new-password' : 'current-password'} />
    <button type="submit">${isRegister ? 'Create Account' : 'Sign In'}</button>
    <div class="toggle">${isRegister ? 'Already have an account? ' : 'Need an account? '}<a onClick=${() => setIsRegister(!isRegister)}>${isRegister ? 'Sign in' : 'Register'}</a></div>
  </form></div>`;
}
