import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { api, ApiFailure } from '../api/client';
import { useStudio } from '../state/store';
import { BrandMark } from '../ui/icons';
import './Activity.css';

/** Sign-in page (only reachable/needed when the API runs with AUTH=on). */
export function Login() {
  const navigate = useNavigate();
  const { search } = useLocation();
  const session = useStudio((s) => s.session);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const next = (() => { const n = new URLSearchParams(search).get('next'); return n && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/projects'; })();
  useEffect(() => { document.title = 'Sign in · InfoSlips Spatial Studio'; return () => { document.title = 'InfoSlips Spatial Studio'; }; }, []);

  if (session && (!session.authEnabled || session.user)) return <Navigate to={next} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.login(email.trim(), password);
      await useStudio.getState().loadSession();
      navigate(next, { replace: true });
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : 'Sign-in failed.');
      setBusy(false);
    }
  };
  return (
    <main className="login-page" id="main">
      <form className="login-card" onSubmit={submit} aria-labelledby="login-title" data-testid="login-form">
        <div className="login-brand"><BrandMark /> <span>InfoSlips <strong>Spatial Studio</strong></span></div>
        <h1 id="login-title">Sign in</h1>
        <p className="muted">Use the account your studio admin created for you.</p>
        <label className="field"><span className="label">Email</span>
          <input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus data-testid="login-email" />
        </label>
        <label className="field"><span className="label">Password</span>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required data-testid="login-password" />
        </label>
        {error && <div className="callout error" role="alert" data-testid="login-error">{error}</div>}
        <button type="submit" className="btn primary login-submit" disabled={busy} data-testid="login-submit">{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="login-note">Synthetic data only. Sessions end after 12 hours or when you sign out.</p>
      </form>
    </main>
  );
}
