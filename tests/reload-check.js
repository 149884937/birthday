(() => {
  if (document.body.dataset.appReady !== 'true') throw Error('app not ready');
  if (!document.querySelector('.city-frog[data-place-id="guangyuan"]')) throw Error('unlock not restored');
  if (document.querySelectorAll('.city-frog').length !== 1) throw Error('duplicate or unintended unlock');
  if (document.querySelectorAll('.city-heart').length !== 1) throw Error('Xian heart missing');
  if (![...document.querySelectorAll('.city-label')].some(n => n.textContent === '成都')) throw Error('new place lost');
  return 'PASS full page reload preserves exactly one Guangyuan frog, Xian heart, and new place';
})()
