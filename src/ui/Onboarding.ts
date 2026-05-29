export class Onboarding {
  private el: HTMLElement;
  private onAccept: () => void;

  constructor(host: HTMLElement, onAccept: () => void) {
    this.onAccept = onAccept;
    const card = document.createElement('div');
    card.className = 'onboard-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-labelledby', 'onboard-title');
    card.innerHTML = `
      <button class="onboard-close" type="button" aria-label="Close">×</button>
      <div class="onboard-icon" aria-hidden="true">
        <svg viewBox="0 0 80 80" width="64" height="64">
          <circle cx="40" cy="40" r="34" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.55"/>
          <circle cx="40" cy="40" r="22" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>
          <g transform="translate(40 40)">
            <circle r="6" fill="currentColor"/>
            <g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none">
              <line x1="0" y1="-6" x2="0" y2="-14"/>
              <line x1="0" y1="6" x2="0" y2="14"/>
              <line x1="-6" y1="0" x2="-14" y2="0"/>
              <line x1="6" y1="0" x2="14" y2="0"/>
              <line x1="-4.2" y1="-4.2" x2="-10" y2="-10"/>
              <line x1="4.2" y1="4.2" x2="10" y2="10"/>
              <line x1="-4.2" y1="4.2" x2="-10" y2="10"/>
              <line x1="4.2" y1="-4.2" x2="10" y2="-10"/>
            </g>
          </g>
        </svg>
      </div>
      <h2 id="onboard-title">Welcome to MemeLab — CDA v3</h2>
      <p class="onboard-tag">Simulate outbreaks. Evolve strains. Master defenses.</p>
      <ol class="onboard-steps">
        <li><strong>Pick a disease</strong> — top-right panel. Click the disease name to browse presets.</li>
        <li><strong>Tune defenses</strong> — left panel. Adjust mask + vaccine uptake and effectiveness.</li>
        <li><strong>Press <kbd>Space</kbd></strong> to play, <kbd>→</kbd> to step a day, <kbd>R</kbd> to reset.</li>
        <li><strong>Share</strong> — the Share button copies a deterministic URL (and a QR code) anyone can replay.</li>
      </ol>
      <div class="onboard-actions">
        <button class="btn btn-primary" data-cta="hanta">Run a Bundibugyo Ebola outbreak →</button>
        <button class="btn" data-cta="dismiss">Explore on my own</button>
      </div>
      <p class="onboard-foot">Institute of Armchair Epidemiology · clean-room V3 rebuild</p>
    `;
    this.el = card;

    const closeBtn = card.querySelector('.onboard-close') as HTMLButtonElement;
    closeBtn.addEventListener('click', () => this.dismiss());
    card.querySelector('[data-cta="hanta"]')?.addEventListener('click', () => {
      this.onAccept();
      this.dismiss();
    });
    card.querySelector('[data-cta="dismiss"]')?.addEventListener('click', () => this.dismiss());

    host.appendChild(card);
  }

  dismiss(): void {
    this.el.classList.add('onboard-out');
    setTimeout(() => this.el.remove(), 240);
  }
}
