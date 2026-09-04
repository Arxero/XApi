chrome.devtools.panels.create(
  'XApi',
  '', // Icon path
  'panel.html',
  (panel: chrome.devtools.panels.ExtensionPanel) => {
    console.log('Panel created', panel);
  },
);
