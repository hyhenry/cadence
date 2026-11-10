import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyTheme } from './theme.ts';
import './styles.css';

// Inside Home Assistant (Ingress iframe) HA already keeps the frame clear of
// the notch and home bar, so the app must not add the safe areas again.
if (window.parent !== window) document.documentElement.classList.add('embedded');
applyTheme();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
