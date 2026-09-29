import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { bootTheme } from './theme.js';
import './styles.css';

// Before the first render, so a dark-mode user never sees a white frame. The
// CSP forbids an inline script in index.html, so this is the earliest point
// available — and it is a local module, so "earliest" is a frame at most.
bootTheme();

createRoot(document.getElementById('root')).render(<App />);
