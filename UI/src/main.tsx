import { createRoot } from 'react-dom/client';
import App from './App';
import { useStore } from './lib/store';
import './styles.css';

useStore.getState().init();

createRoot(document.getElementById('root')!).render(<App />);
