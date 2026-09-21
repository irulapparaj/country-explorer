import { createEl } from '../../lib/domUtils.js';

/**
 * Mounts a floating "About" button on the map view and a <dialog> modal.
 * @param {HTMLElement} mapView  The #view-map section element.
 */
export function createAboutModal(mapView) {
  // ---- Dialog -------------------------------------------------------------------

  const dialog = createEl('dialog', { className: 'about-dialog', attrs: { 'aria-label': 'About Country Explorer' } });

  const header = createEl('div', { className: 'about-dialog-header' });
  const title = createEl('h2', { className: 'about-dialog-title', text: 'Country Explorer' });
  const closeBtn = createEl('button', {
    className: 'about-close-btn',
    attrs: { type: 'button', 'aria-label': 'Close about dialog' },
    text: '✕',
  });
  header.append(title, closeBtn);

  const profile = createEl('div', { className: 'about-profile' });
  const avatar = createEl('div', { className: 'about-avatar', text: 'KI', attrs: { 'aria-hidden': 'true' } });
  const profileInfo = createEl('div', { className: 'about-profile-info' });
  profileInfo.append(
    createEl('div', { className: 'about-name', text: 'Kaviyuvan Irullappan' }),
    createEl('div', { className: 'about-role', text: 'Junior Student Developer' }),
  );
  profile.append(avatar, profileInfo);

  const body = createEl('div', { className: 'about-body' });

  /** @param {string} label @param {string} text */
  const textSection = (label, text) => {
    const section = createEl('div');
    section.append(
      createEl('div', { className: 'about-section-label', text: label }),
      createEl('p', { className: 'about-text', text }),
    );
    return section;
  };

  // About me section
  const meSection = textSection(
    'About me',
    'I am an 8th-grade student exploring the massive potential of artificial intelligence. Instead of just writing lines of code by hand, I wanted to see how modern creators use AI tools and "vibe coding" to turn ideas into reality instantly. As part of this journey, I developed this website by directing AI models to help me architect, debug, and build the layout. This project is a living experiment in human-AI collaboration and a glimpse into how software will be built in the future.',
  );

  const interestsSection = textSection(
    'Interests',
    'I love playing chess and table tennis, and spending time with my family.',
  );

  const thanksSection = textSection(
    'Acknowledgments',
    'A special thank you: a huge thank you to my father for teaching me how to leverage AI to build websites, and to Claude for assisting with the heavy lifting of the coding. This project wouldn\'t have been possible without your guidance and teamwork!',
  );

  // About the project
  const projectSection = createEl('div');
  projectSection.append(
    createEl('div', { className: 'about-section-label', text: 'About this project' }),
    createEl('p', {
      className: 'about-text',
      text: 'Country Explorer is an interactive atlas built entirely on live public APIs — no backend, no API keys, no build step. Click any country to explore its facts, demographics, and culture, all sourced from open data in real time.',
    }),
  );

  // Data sources
  const sourcesSection = createEl('div');
  sourcesSection.append(createEl('div', { className: 'about-section-label', text: 'Data sources' }));
  const chips = createEl('div', { className: 'about-sources' });
  for (const source of ['Wikidata', 'World Bank', 'Wikipedia', 'OpenStreetMap', 'Wikimedia Commons']) {
    chips.appendChild(createEl('span', { className: 'about-source-chip', text: source }));
  }
  sourcesSection.appendChild(chips);

  body.append(meSection, interestsSection, thanksSection, projectSection, sourcesSection);

  const footer = createEl('div', { className: 'about-footer', text: 'Open data, open knowledge.' });

  dialog.append(header, profile, body, footer);
  document.body.appendChild(dialog);

  // ---- Button on the map --------------------------------------------------------

  const btn = createEl('button', {
    className: 'about-btn',
    attrs: { type: 'button', 'aria-haspopup': 'dialog' },
    children: [
      createEl('span', { attrs: { 'aria-hidden': 'true' }, text: 'ⓘ' }),
      createEl('span', { text: 'About' }),
    ],
  });
  mapView.appendChild(btn);

  // ---- Interaction --------------------------------------------------------------

  function open() {
    dialog.showModal();
    closeBtn.focus();
  }

  function close() {
    dialog.close();
    btn.focus();
  }

  btn.addEventListener('click', open);
  closeBtn.addEventListener('click', close);

  // Close on backdrop click
  dialog.addEventListener('click', (e) => {
    const rect = dialog.getBoundingClientRect();
    const outside =
      e.clientX < rect.left || e.clientX > rect.right ||
      e.clientY < rect.top  || e.clientY > rect.bottom;
    if (outside) close();
  });

  // Escape is handled natively by <dialog>, but we need to return focus to the button
  dialog.addEventListener('close', () => btn.focus());
}
