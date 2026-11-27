(() => {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  document.querySelector('#journey').scrollIntoView({ block: 'start', behavior: 'instant' });
  return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth };
})()
