import { h } from "preact";
import { useState, useEffect } from "preact/hooks";
import htm from "htm";
import { get, post, setToken } from "../api.js";
import { navigate } from "../router.js";
const html = htm.bind(h);
export function Login({ onLogin }) {
  const [isRegister, setIsRegister] = useState(false);
  // null = unknown; hide the Register toggle until the server has answered.
  const [registrationOpen, setRegistrationOpen] = useState(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    get("/auth/status")
      .then((s) => {
        if (cancelled) return;
        setRegistrationOpen(!!s.registration_open);
        // First run: registering is the only useful action — lead with it.
        if (s.registration_open) setIsRegister(true);
      })
      .catch(() => {
        if (!cancelled) setRegistrationOpen(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      const data = await post(isRegister ? "/auth/register" : "/auth/login", {
        username,
        password,
      });
      setToken(data.token);
      navigate("/");
      onLogin();
    } catch (err) {
      setError(err.message);
    }
  }
  return html`<div class="auth-page">
    <form class="auth-form" onSubmit=${handleSubmit}>
      <h1>VLMP</h1>
      ${error && html`<div class="error">${error}</div>`}
      ${
        isRegister &&
        html`<p class="auth-note">
          Set up this server — the first account becomes the administrator.
        </p>`
      }
      <input
        type="text"
        placeholder="Username"
        value=${username}
        onInput=${(e) => setUsername(e.target.value)}
        autocomplete="username"
      />
      <input
        type="password"
        placeholder="Password"
        value=${password}
        onInput=${(e) => setPassword(e.target.value)}
        autocomplete=${isRegister ? "new-password" : "current-password"}
      />
      <button type="submit">
        ${isRegister ? "Create Admin Account" : "Sign In"}
      </button>
      ${
        registrationOpen &&
        html`<div class="toggle">
          ${isRegister ? "Already have an account? " : "First run? "}<a
            onClick=${() => setIsRegister(!isRegister)}
            >${isRegister ? "Sign in" : "Register"}</a
          >
        </div>`
      }
    </form>
  </div>`;
}
