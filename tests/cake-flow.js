(async () => {
  const $ = s => document.querySelector(s);
  const wait = async (fn, label) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > 7000) throw Error(label); await new Promise(r => setTimeout(r, 40)); } };
  const check = (v, label) => { if (!v) throw Error(label); return 'PASS ' + label; };
  const results = [];
  await new Promise((resolve, reject) => { const q = indexedDB.deleteDatabase('birthday-keepsake'); q.onsuccess = q.onerror = q.onblocked = resolve; });
  location.reload(); await wait(() => document.body.dataset.appReady === 'true', 'app ready');
  $('.destination[data-city="shenyang"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await wait(() => !$('#cake-station').hidden, 'cake station unlocked'); results.push('PASS plane route opens cake station');
  const cake = $('#cake-preview'); const rect = cake.getBoundingClientRect();
  $('#cake-station').scrollIntoView({ behavior: 'instant', block: 'center' });
  const tool = action => { $('[data-cake-action="' + action + '"]').click(); };
  const drag = async (x1, y1, x2, y2) => { cake.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left+x1, clientY: rect.top+y1, pointerId: 1 })); for (let i=1;i<=8;i++) cake.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left+x1+(x2-x1)*i/8, clientY: rect.top+y1+(y2-y1)*i/8, pointerId: 1 })); cake.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: rect.left+x2, clientY: rect.top+y2, pointerId: 1 })); };
  tool('cream'); await drag(100, 140, 230, 150); await drag(120, 165, 245, 170); check($('#cake-preview .cake-cream-dot').length >= 6, 'cream drag creates visible frosting'); results.push('PASS cream drag');
  tool('flower'); for (const p of [[150,130],[200,140],[250,135]]) cake.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left+p[0], clientY: rect.top+p[1] })); check($('#cake-preview .cake-flower').length === 3, 'flower clicks create decorations'); results.push('PASS flower placement');
  tool('write'); $('#cake-message-input').value = '愿你天天开心'; $('#cake-message-apply').click(); check($('.cake-writing').textContent === '愿你天天开心', 'typed message appears on cake'); results.push('PASS written greeting');
  tool('candle'); for (const p of [[150,100],[200,90],[250,100]]) cake.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left+p[0], clientY: rect.top+p[1] })); check($('#cake-preview .cake-candle').length === 3, 'candle clicks create candles'); results.push('PASS candle placement');
  await wait(() => !$('#wish-panel').hidden, 'wish panel'); results.push('PASS completed cake reveals wish panel'); return results;
})()
