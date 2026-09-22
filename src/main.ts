import { App } from './ui/App';
import './ui/theme.css';
import './ui/components.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

const app = new App(root);
app.start();
if (import.meta.env.VITE_MEMELAB_AUTOMATION === '1') {
  void import('./domain/automation').then(({ installAutomation }) => installAutomation(app));
}
