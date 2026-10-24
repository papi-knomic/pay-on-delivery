import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

console.log(
  '%cPay on Delivery%c\nHello, curious one. Built with care, for Moses Erakpoweri.',
  'font-weight:700;font-size:14px',
  'color:#64748b',
);

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
