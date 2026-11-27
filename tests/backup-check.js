(async () => {
  const pause = () => new Promise(resolve => setTimeout(resolve, 250));
  const check = (value, label) => { if (!value) throw new Error(label); return 'PASS ' + label; };
  let backup;
  const originalURL = URL.createObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = blob => { backup = blob; return 'blob:test'; };
  HTMLAnchorElement.prototype.click = function () {};
  document.querySelector('#export-backup').click();
  URL.createObjectURL = originalURL;
  HTMLAnchorElement.prototype.click = originalClick;
  const data = JSON.parse(await backup.text());
  const results = [check(data.settings.recipient === '测试小桃', 'backup contains saved settings')];
  const restore = async content => {
    const dt = new DataTransfer(); dt.items.add(new File([content], 'backup.json', { type: 'application/json' }));
    const input = document.querySelector('#backup-file'); input.files = dt.files; input.dispatchEvent(new Event('change')); await pause();
  };
  await restore('{invalid');
  results.push(check(document.querySelector('#recipient').textContent === '测试小桃', 'invalid backup preserves content'));
  data.settings.recipient = '亲爱的你'; window.confirm = () => true;
  await restore(JSON.stringify(data));
  results.push(check(document.querySelector('#recipient').textContent === '亲爱的你', 'valid backup restored'));
  results.push(check(document.documentElement.scrollWidth <= innerWidth, 'no horizontal overflow'));
  return results;
})()
