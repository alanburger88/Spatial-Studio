import { createRoot } from 'react-dom/client';
import './styles/tokens.css'; import './styles/app.css';
import { AssetLibraryDialog } from './screens/design/AssetLibrary';
try { const t = localStorage.getItem('iss.theme'); if (t) document.documentElement.dataset.theme = t; } catch {}
createRoot(document.getElementById('root')!).render(<AssetLibraryDialog onClose={() => {}} onPick={(a) => { (window as any).__picked = a; }} />);
