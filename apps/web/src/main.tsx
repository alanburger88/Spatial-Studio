import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/app.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);

// Read-only inspection hook for automated acceptance tests (no secrets; synthetic data only).
import { useStudio } from './state/store';
import { projectContentDigest } from '@iss/model';
(window as any).__iss = { store: useStudio, digest: () => { const p = useStudio.getState().project; return p ? projectContentDigest(p) : null; } };
