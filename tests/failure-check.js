(async () => {
  const $ = s => document.querySelector(s), wait = ms => new Promise(r => setTimeout(r, ms));
  let results = [];
  const assert = (v, label) => { if (!v) throw Error(label); results.push('PASS ' + label); };
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function () { throw new DOMException('Test storage full', 'QuotaExceededError'); };
  try {
    $('.destination[data-city="jinan"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await wait(3100);
    assert(!$('.city-frog[data-place-id="jinan"]'), 'failed persistence does not leave false unlocked frog');
    assert($('#china-map').getAttribute('aria-busy') === 'false', 'failed save releases journey lock');
  } finally { IDBObjectStore.prototype.put = original; }
  $('#add-memory').click(); $('#memory-form').elements.title.value = '拒绝损坏图片';
  const dt = new DataTransfer(); dt.items.add(new File(['not image'], 'broken.png', { type: 'image/png' })); $('#photo').files = dt.files; $('#photo').dispatchEvent(new Event('change'));
  await wait(250);
  assert($('#photo-preview').children.length === 0 && !$('#save-memory').disabled, 'invalid upload preserves editor and releases busy state');
  $('#memory-dialog').close(); return results;
})()
