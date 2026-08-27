import { installFocusTrap } from './focus';
import { ICONS, icon } from './icons';
// "What is this?" modal — explains the model, history, and backing research
// without requiring a separate page or routing layer.

const CONTENT = `
  <header class="about-head">
    <div class="about-mark" aria-hidden="true">${ICONS['igduo']}</div>
    <div class="about-titles">
      <h2>What is MemeLab?</h2>
      <p class="about-tag">Simulate outbreaks. Evolve strains. Master defenses.</p>
    </div>
  </header>

  <section>
    <h3>The model</h3>
    <p>
      MemeLab is a <strong>cellular-automaton SEIRS model</strong> of contagion dynamics.
      Each cell on the grid represents a person, host, or node and lives in one of five states:
      <em>Susceptible → Exposed → Infectious → Recovered → (Dead)</em>.
    </p>
    <ul>
      <li><strong>Transmission</strong> happens between Manhattan-distance neighbors. The probability per contact is <code>attackRate × (1 − wearer source-control) × (1 − target protection)</code>.</li>
      <li><strong>Defenses</strong> (mask, vaccine) stack multiplicatively and have separate protection / source-control / mortality-reduction effects.</li>
      <li><strong>Immunity wanes</strong> over a configurable mean duration. With finite immunity plus a sufficient population the disease becomes <strong>endemic</strong> rather than dying out — the central insight of the original CDA.</li>
      <li><strong>Mutation</strong> (optional) applies Gaussian drift to each gene on transmission, so strains evolve under selection pressure rather than teleport to random genotypes.</li>
    </ul>
  </section>

  <section>
    <h3>Why CDA exists</h3>
    <p>
      Cellular Defense Automata started as a Python research toy in 2021, motivated by a question: how much does <em>source control</em> (e.g., a mask on the infectious person) actually move the needle compared to <em>protection</em> (a mask on the susceptible)?
      The answer the model showed — and that real-world studies later corroborated — is that source control is dramatically more effective than personal protection alone.
    </p>
    <p>
      v3 is a clean-room TypeScript rewrite. It moved the simulation into a Web Worker, swapped per-cell DOM nodes for direct canvas rendering, made every run reproducible from a permalink, and ships at roughly an order of magnitude better performance than v2.
    </p>
  </section>

  <section>
    <h3>Backing research</h3>
    <ul class="about-links">
      <li><a href="https://en.wikipedia.org/wiki/Compartmental_models_in_epidemiology#The_SEIR_model" target="_blank" rel="noopener">SEIR / SEIRS compartmental models</a> — the textbook framework MemeLab implements spatially.</li>
      <li><a href="https://en.wikipedia.org/wiki/Cellular_automaton" target="_blank" rel="noopener">Cellular automata</a> — discrete-space, discrete-time substrate.</li>
      <li><a href="https://www.ucsf.edu/news/2020/06/417906/still-confused-about-masks-heres-science-behind-how-face-masks-prevent" target="_blank" rel="noopener">UCSF — how masks reduce transmission</a> — empirical basis for the source-control vs protection asymmetry.</li>
      <li><a href="https://www.cdc.gov/coronavirus/2019-ncov/php/contact-tracing/contact-tracing-plan/appendix.html" target="_blank" rel="noopener">CDC contact-tracing exposure definition</a> — the 15-minute cumulative exposure heuristic that informs neighbor interactions.</li>
      <li><a href="https://en.wikipedia.org/wiki/Serial_passage" target="_blank" rel="noopener">Serial passage</a> — the principle behind the mutation/natural-selection mode.</li>
      <li><a href="https://www.who.int/news-room/q-a-detail/coronavirus-disease-covid-19-how-is-it-transmitted" target="_blank" rel="noopener">WHO — SARS-CoV-2 transmission</a> — incubation and infectious-period defaults.</li>
      <li><a href="https://www.the-scientist.com/news-opinion/cold-causing-coronaviruses-dont-seem-to-confer-lasting-immunity-67832" target="_blank" rel="noopener">Coronaviruses and waning immunity</a> — basis for the SARS-2 reinfection defaults.</li>
      <li><a href="https://www.nature.com/articles/s41591-022-01913-0" target="_blank" rel="noopener">Reinfection rates with SARS-CoV-2 variants (Nature Medicine)</a></li>
    </ul>
  </section>

  <section>
    <h3>How to read the dish</h3>
    <p>The legend below the petri dish maps each state to a color (or sprite, in emoji mode). Watch for:</p>
    <ul>
      <li><strong>R<sub>0</sub></strong>: expected secondary infections from one infectious cell on a fully-susceptible grid. Above 1 → outbreak grows; below 1 → it fizzles.</li>
      <li><strong>R<sub>eff</sub></strong>: live ratio of new infections per new infectious cell, over a 14-day window. The <em>actual</em> growth factor of the running outbreak.</li>
      <li><strong>Strains</strong>: how many distinct genotypes are circulating (relevant when natural selection is on).</li>
    </ul>
  </section>

  <section>
    <h3>Reproducibility</h3>
    <p>
      Every run is fully deterministic from its <code>seed</code>. The <strong>Share</strong> button copies a URL — and shows a scannable QR code — that encodes the seed, grid size, disease genes, defenses, theme, and speed in plain query-string form. Share it and the recipient sees byte-identical state. Edit any value in the URL directly to fork a scenario.
    </p>
  </section>

  <footer class="about-foot">
    <span>Institute of Armchair Epidemiology · clean-room V3 rebuild</span>
    <span class="about-foot-version">v3 · 10× faster · fully deterministic</span>
  </footer>
`;

export class AboutModal {
  private el: HTMLDivElement | null = null;
  private untrap: (() => void) | null = null;

  open(): void {
    if (this.el) return;
    const overlay = document.createElement('div');
    overlay.className = 'about-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'about-title');
    overlay.innerHTML = `
      <div class="about-card">
        <button class="about-close" type="button" aria-label="Close">${icon('close')}</button>
        <div class="about-body">${CONTENT}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.el = overlay;

    const close = () => this.close();
    overlay.querySelector('.about-close')?.addEventListener('click', close);
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) close();
    });
    document.addEventListener('keydown', this.onKey);
    this.untrap = installFocusTrap(
      overlay.querySelector('.about-card') as HTMLElement,
      overlay.querySelector('.about-close') as HTMLElement,
    );
  }

  close(): void {
    if (!this.el) return;
    this.untrap?.();
    this.untrap = null;
    document.removeEventListener('keydown', this.onKey);
    const e = this.el;
    this.el = null;
    e.classList.add('about-out');
    setTimeout(() => e.remove(), 200);
  }

  private onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') this.close();
  };
}
