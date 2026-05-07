import { App } from './ui/App';
import './ui/theme.css';
import './ui/components.css';

const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

const app = new App(root);
app.start();
