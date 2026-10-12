import React from 'react';
import { createRoot } from 'react-dom/client';
import '@phosphor-icons/web/regular';
import '@phosphor-icons/web/fill';
import './nocturne.css';
import './app.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
