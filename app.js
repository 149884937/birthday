(() => {
  'use strict';
  const defaults = { version: 1, settings: { recipient: '亲爱的你', birthday: '', subtitle: '愿你被爱包围，也永远自由自在。\n新的一岁，我还想陪你看好多好多次日落。', letter: '遇见你以后，平凡的日子也有了值得期待的理由。\n\n喜欢和你一起散步，喜欢听你讲今天发生的小事，也喜欢什么都不做，只是安安静静地待在你身边。\n\n新的一岁，希望你做喜欢的事，见想见的人，慢慢来，也没关系。你不用成为别人期待的样子，你已经是我眼里很珍贵的你。\n\n生日快乐。以后的每一个今天，都想陪你一起过。', sender: '最喜欢你的人' }, memories: [] };
  const M = window.GiftModel;
  const $ = selector => document.querySelector(selector);
  const uid = () => crypto.randomUUID();
  const embedded = $('#gift-data');
  const published = embedded ? JSON.parse(embedded.textContent) : window.PUBLISHED_GIFT;
  const shared = !!published;
  let state = M.migrate(defaults, uid()), db, ready = false, toastTimer;
  let activePlace = 'xian', selectedId, editingId, pendingPhotos = [], coverId, imageBusy = false, savingStory = false, uploadToken = 0;
  let queue = Promise.resolve(), journeyBusy = false, dragActive = false, placeEditingId = null;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const placeById = id => state.places.find(p => p.id === id);
  const accessible = place => place.mode === 'heart' || state.unlocked.includes(place.id);
  const dateText = date => date ? date.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1 年 $2 月 $3 日') : '';
  document.body.classList.toggle('shared', shared);
  function toast(message) { $('#toast').textContent = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').textContent = '', 6500); }
  function guard(fn) { return async event => { try { await fn(event); } catch (error) { toast(error.message || '操作失败，请重试。'); } }; }
  function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
  function button(text, action, className = 'quiet') { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', guard(action)); return node; }
  function photoImage(photo, title) { const img = el('img'); img.src = photo.src; img.alt = photo.caption || title; img.loading = 'lazy'; return img; }
  function showDialog(id) { if (!$(id).open) $(id).showModal(); }
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));
  function openDatabase() {
    return new Promise((resolve, reject) => { const req = indexedDB.open('birthday-keepsake', 1); req.onupgradeneeded = () => req.result.createObjectStore('gift'); req.onerror = () => reject(req.error); req.onblocked = () => reject(new Error('请关闭其他生日页面后再试。')); req.onsuccess = () => resolve(req.result); });
  }
  const read = key => new Promise((resolve, reject) => { const req = db.transaction('gift').objectStore('gift').get(key); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
  const write = entries => new Promise((resolve, reject) => {
    const tx = db.transaction('gift', 'readwrite'); entries.forEach(([key, value]) => tx.objectStore('gift').put(value, key));
    tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(new Error('保存失败，请检查浏览器空间或先导出备份。'));
  });
  function commit(change) {
    const task = queue.then(async () => {
      if (!ready || !db) throw new Error('存储尚未就绪，请稍后再试。');
      const next = change(M.copy(state)); M.validate(next);
      if (shared) await write([['journey:' + state.giftId, next.unlocked]]);
      else await write([['current', next]]);
      state = next; render();
    });
    queue = task.catch(() => {}); return task;
  }
  function coverOf(story) { return state.photos.find(p => p.id === story.coverId); }
  function storyCard(story) {
    const card = button('', () => viewMemory(story.id), 'memory-card'); card.dataset.storyId = story.id;
    const photos = M.photosOf(state, story.id), media = el('div', 'memory-card-media');
    media.append(photoImage(coverOf(story), story.title), el('span', 'memory-card-count', photos.length + ' 张照片'));
    card.append(media, el('h3', '', story.title), el('p', '', story.story || '点击照片，重温这一刻。'), el('time', '', dateText(story.date)));
    return card;
  }
  function render() {
    const s = state.settings;
    $('#recipient').textContent = s.recipient; $('#subtitle').textContent = s.subtitle; $('#birthday-date').textContent = dateText(s.birthday) || '为你，认真准备的一点小浪漫';
    $('#letter-greeting').textContent = s.recipient + '：'; $('#letter-body').textContent = s.letter; $('#sender').textContent = s.sender; document.title = s.recipient + '，生日快乐';
    const selected = $('#memory-place').value;
    $('#memory-place').replaceChildren(...state.places.map(p => { const option = el('option', '', p.name); option.value = p.id; return option; }));
    $('#memory-place').value = selected || activePlace;
    // The first level is always places. Never mix stories from different places.
    $('#gallery').replaceChildren(); $('#empty').hidden = true;
    state.places.forEach(place => {
      const count = M.storiesAt(state, place.id).length, locked = !accessible(place);
      const card = button('', () => openPlaceMemories(place.id, !shared), 'place-card');
      card.dataset.placeId = place.id;
      card.append(el('span', 'place-card-symbol', place.mode === 'heart' ? '♡' : locked ? '🔒' : '🐸'), el('h3', '', place.name), el('p', '', count + ' 段故事'), el('small', '', locked ? (shared ? '完成这条旅程，打开回忆' : '待旅程解锁 · 可整理故事') : '打开这座城的回忆'));
      if (shared && locked) card.disabled = true;
      $('#gallery').append(card);
    });
    renderMap(); if ($('#frog-dialog').open) renderPlaceStories();
    if ($('#places-dialog').open) renderPlaceManager();
  }
  function openPlaceMemories(id, editor = false) {
    const place = placeById(id); if (!place || (!accessible(place) && (!editor || shared))) return;
    activePlace = id; renderPlaceStories(); showDialog('#frog-dialog');
  }
  function renderPlaceStories() {
    const place = placeById(activePlace); if (!place) return;
    $('#frog-title').textContent = place.name + ' · 回忆故事';
    const list = $('#frog-memories'), stories = M.storiesAt(state, activePlace); list.replaceChildren();
    if (!stories.length) list.append(el('p', 'muted', shared ? '这座城的故事，等待下一次一起写下。' : '这里还没有故事。添加照片和文字，留住这座城的小事。'));
    stories.forEach((story, index) => {
      const wrap = el('article', 'story-entry'); wrap.append(storyCard(story));
      if (!shared) {
        const controls = el('div', 'button-row');
        const move = direction => commit(data => { const sorted = M.storiesAt(data, activePlace), target = index + direction; if (target < 0 || target >= sorted.length) return data; [sorted[index], sorted[target]] = [sorted[target], sorted[index]]; sorted.forEach((s, i) => s.order = i); return data; });
        const up = button('上移', () => move(-1)); up.disabled = index === 0;
        const down = button('下移', () => move(1)); down.disabled = index === stories.length - 1;
        controls.append(button('编辑', () => { $('#frog-dialog').close(); editMemory(story.id); }), up, down); wrap.append(controls);
      }
      list.append(wrap);
    });
  }
  $('#city-add-story').addEventListener('click', () => { $('#frog-dialog').close(); editMemory(null, activePlace); });
  function viewMemory(id) {
    const story = state.stories.find(s => s.id === id); if (!story) return;
    if (shared && !accessible(placeById(story.placeId))) return;
    activePlace = story.placeId; selectedId = id; $('#frog-dialog').close();
    $('#view-title').textContent = story.title; $('#view-date').textContent = placeById(story.placeId).name + (story.date ? ' · ' + dateText(story.date) : ''); $('#view-story').textContent = story.story;
    $('#view-photos').replaceChildren(...M.photosOf(state, id).map((photo, i) => { const figure = el('figure'); figure.append(photoImage(photo, story.title + ' · 第 ' + (i + 1) + ' 张')); if (photo.caption) figure.append(el('figcaption', '', photo.caption)); return figure; }));
    showDialog('#view-dialog');
  }
  $('#back-to-stories').addEventListener('click', () => { $('#view-dialog').close(); openPlaceMemories(activePlace, true); });
  $('#edit-memory').addEventListener('click', () => { $('#view-dialog').close(); editMemory(selectedId); });
  $('#delete-memory').addEventListener('click', guard(async () => {
    if (!confirm('确定删除这段故事和其中的照片吗？删除后无法撤销。')) return;
    const id = selectedId;
    await commit(data => { data.stories = data.stories.filter(s => s.id !== id); data.photos = data.photos.filter(p => p.storyId !== id); return data; });
    $('#view-dialog').close(); openPlaceMemories(activePlace, true); toast('故事已删除。');
  }));
  function editMemory(id = null, placeId = activePlace) {
    if (!ready || shared) return;
    const story = state.stories.find(s => s.id === id); editingId = id; uploadToken++; setImageBusy(false);
    pendingPhotos = story ? M.copy(M.photosOf(state, id)) : []; coverId = story?.coverId || '';
    $('#memory-form').reset(); $('#memory-place').value = story?.placeId || placeId;
    for (const field of ['title', 'date', 'story']) $('#memory-form').elements[field].value = story?.[field] || '';
    $('#memory-title').textContent = story ? '编辑这段故事' : '收藏一段回忆'; renderPhotoPreview(); showDialog('#memory-dialog');
  }
  $('#add-memory').addEventListener('click', () => editMemory(null, activePlace)); $('#first-memory').addEventListener('click', () => editMemory(null, activePlace));
  function setImageBusy(value) { imageBusy = value; $('#photo').disabled = value; $('#save-memory').disabled = value || savingStory; if (value) { $('#photo-status').textContent = '正在整理照片，请稍候…'; $('#photo-preview').querySelectorAll('button,input,textarea').forEach(n => n.disabled = true); } else renderPhotoPreview(); }
  function renderPhotoPreview() {
    const preview = $('#photo-preview'); preview.replaceChildren();
    pendingPhotos.forEach((photo, index) => {
      const item = el('div', 'photo-edit'); item.dataset.photoId = photo.id;
      item.append(photoImage(photo, '第 ' + (index + 1) + ' 张'));
      const caption = el('textarea'); caption.maxLength = 300; caption.rows = 2; caption.placeholder = '这张照片的小注释'; caption.value = photo.caption; caption.setAttribute('aria-label', '第 ' + (index + 1) + ' 张照片描述'); caption.addEventListener('input', () => photo.caption = caption.value); item.append(caption);
      const controls = el('div', 'photo-actions');
      const move = direction => { const target = index + direction; if (target < 0 || target >= pendingPhotos.length) return; [pendingPhotos[index], pendingPhotos[target]] = [pendingPhotos[target], pendingPhotos[index]]; renderPhotoPreview(); };
      const up = button('前移', () => move(-1)); up.disabled = index === 0; const down = button('后移', () => move(1)); down.disabled = index === pendingPhotos.length - 1;
      const cover = button(coverId === photo.id ? '✓ 封面' : '设为封面', () => { coverId = photo.id; renderPhotoPreview(); }); cover.setAttribute('aria-pressed', String(coverId === photo.id));
      const replace = el('input'); replace.type = 'file'; replace.accept = 'image/jpeg,image/png,image/webp'; replace.hidden = true;
      replace.addEventListener('change', guard(async () => { const file = replace.files[0]; if (!file) return; const token = ++uploadToken; setImageBusy(true); try { const src = await compressPhoto(file); if (token !== uploadToken) return; photo.src = src; renderPhotoPreview(); } finally { if (token === uploadToken) setImageBusy(false); } }));
      controls.append(cover, up, down, button('替换', () => replace.click()), button('删除', () => { pendingPhotos.splice(index, 1); if (coverId === photo.id) coverId = pendingPhotos[0]?.id || ''; renderPhotoPreview(); }), replace);
      item.append(controls); preview.append(item);
    });
    $('#photo-status').textContent = '已选 ' + pendingPhotos.length + ' / 30 张';
  }
  async function compressPhoto(file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
    if (file.size > 15 * 1024 * 1024) throw new Error(file.name + ' 超过 15 MB，请先缩小。');
    const url = URL.createObjectURL(file);
    try {
      const img = new Image(); img.src = url; try { await img.decode(); } catch { throw new Error(file.name + ' 无法读取，请选择完整的照片。'); }
      if (img.naturalWidth * img.naturalHeight > 60000000) throw new Error('图片分辨率过高，请先缩小。');
      const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight)), canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(img.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fffaf7'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(img, 0, 0, canvas.width, canvas.height); return canvas.toDataURL('image/jpeg', .84);
    } finally { URL.revokeObjectURL(url); }
  }
  $('#photo').addEventListener('change', guard(async event => {
    const files = [...event.target.files]; event.target.value = ''; if (!files.length) return;
    if (pendingPhotos.length + files.length > 30) throw new Error('每个故事最多 30 张照片，请减少选择或删除部分照片。');
    const token = ++uploadToken; setImageBusy(true); const added = [];
    try { for (const file of files) { const src = await compressPhoto(file); if (token !== uploadToken) return; added.push({ id: uid(), src, caption: '', order: 0 }); } pendingPhotos.push(...added); coverId ||= pendingPhotos[0].id; renderPhotoPreview(); }
    finally { if (token === uploadToken) setImageBusy(false); }
  }));
  $('#memory-dialog').addEventListener('close', () => { uploadToken++; setImageBusy(false); });
  $('#memory-form').addEventListener('submit', guard(async event => {
    event.preventDefault(); if (imageBusy || savingStory) return; if (!pendingPhotos.length) throw new Error('先添加至少一张照片。');
    const fields = Object.fromEntries(new FormData(event.target)), id = editingId || uid();
    const photos = pendingPhotos.map((p, i) => ({ ...p, storyId: id, order: i })), chosenCover = coverId;
    savingStory = true; $('#save-memory').disabled = true;
    try { await commit(data => {
      const old = data.stories.find(s => s.id === id);
      const story = { id, placeId: fields.placeId, title: fields.title.trim(), date: fields.date, story: fields.story.trim(), coverId: chosenCover, order: old?.placeId === fields.placeId ? old.order : Math.max(-1, ...data.stories.filter(s => s.placeId === fields.placeId).map(s => s.order)) + 1 };
      data.stories = [...data.stories.filter(s => s.id !== id), story]; data.photos = [...data.photos.filter(p => p.storyId !== id), ...photos]; return data;
    });
    activePlace = fields.placeId; $('#memory-dialog').close(); openPlaceMemories(activePlace, true); toast('故事与照片已保存。');
    } finally { savingStory = false; $('#save-memory').disabled = imageBusy; }
  }));
  $('#manage').addEventListener('click', () => { for (const key of Object.keys(defaults.settings)) $('#settings-form').elements[key].value = state.settings[key]; showDialog('#settings-dialog'); });
  $('#settings-form').addEventListener('submit', guard(async event => { event.preventDefault(); const settings = Object.fromEntries(new FormData(event.target)); for (const key of Object.keys(settings)) settings[key] = settings[key].trim(); await commit(data => ({ ...data, settings })); $('#settings-dialog').close(); toast('心意已保存。'); }));
  $('#manage-places').addEventListener('click', () => { renderPlaceManager(); showDialog('#places-dialog'); });
  function renderPlaceManager() {
    const list = $('#place-list'); list.replaceChildren();
    state.places.forEach(p => { const row = el('div', 'place-manager-row'); row.append(el('span', '', p.name + ' · ' + ({ heart: '爱心入口', train: '火车', plane: '飞机' }[p.mode])), button('编辑地点', () => fillPlaceForm(p.id))); list.append(row); });
  }
  function fillPlaceForm(id = null) {
    placeEditingId = id; const p = placeById(id); $('#place-form').reset();
    $('#place-form').elements.name.value = p?.name || ''; $('#place-form').elements.mode.value = p?.mode || 'train'; $('#place-form').elements.x.value = p?.x ?? 500; $('#place-form').elements.y.value = p?.y ?? 300;
    $('#place-form').elements.mode.disabled = id === 'xian'; $('#place-form-title').textContent = p ? '编辑 ' + p.name : '新增地点';
  }
  $('#new-place').addEventListener('click', () => fillPlaceForm());
  $('#place-form').addEventListener('submit', guard(async event => {
    event.preventDefault(); const form = event.target, id = placeEditingId || uid();
    const place = { id, name: form.elements.name.value.trim(), mode: id === 'xian' ? 'heart' : form.elements.mode.value, x: Number(form.elements.x.value), y: Number(form.elements.y.value) };
    await commit(data => { const old = data.places.find(p => p.id === id); if (old && old.mode !== place.mode) data.unlocked = data.unlocked.filter(key => key !== id); data.places = old ? data.places.map(p => p.id === id ? place : p) : [...data.places, place]; return data; });
    fillPlaceForm(id); toast('地点已保存，地图与故事选择已更新。');
  }));
  const svgNS = 'http://www.w3.org/2000/svg';
  function svgEl(tag, attrs = {}) { const node = document.createElementNS(svgNS, tag); Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v)); return node; }
  function svgButton(x, y, label, action, className) {
    const node = svgEl('g', { transform: `translate(${x} ${y})`, class: className, role: 'button', tabindex: '0', 'aria-label': label }); node.append(svgEl('title')); node.firstChild.textContent = label;
    node.addEventListener('click', guard(action)); node.addEventListener('keydown', guard(async event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); await action(); } })); return node;
  }
  function pathFor(place) { const start = placeById('xian'); return `M ${start.x} ${start.y} Q ${(start.x + place.x) / 2} ${Math.min(start.y, place.y) - (place.mode === 'plane' ? 95 : 42)} ${place.x} ${place.y}`; }
  function renderMap() {
    const nodes = $('#city-layer'), frogs = $('#frog-layer'), routes = $('#route-layer'); nodes.replaceChildren(); frogs.replaceChildren(); routes.replaceChildren();
    if (matchMedia('(max-width:700px)').matches) {
      const minX = Math.max(0, Math.min(...state.places.map(p => p.x)) - 85), maxX = Math.min(900, Math.max(...state.places.map(p => p.x)) + 100);
      const minY = Math.max(0, Math.min(...state.places.map(p => p.y)) - 60), maxY = Math.min(540, Math.max(...state.places.map(p => p.y)) + 80);
      $('#china-map').setAttribute('viewBox', `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
    } else $('#china-map').setAttribute('viewBox', '0 0 900 540');
    const markerPositions = [];
    const start = placeById('xian'); $('#traveller-token').setAttribute('transform', `translate(${start.x} ${start.y})`);
    state.places.forEach(place => {
      const node = svgButton(place.x, place.y, place.name + (place.mode === 'heart' ? '回忆' : '旅程'), () => place.mode === 'heart' ? openPlaceMemories(place.id) : completeJourney(place.id), 'city-node' + (place.id !== 'xian' ? ' destination' : ''));
      node.dataset.city = place.id; node.dataset.mode = place.id === 'xian' ? 'start' : place.mode; node.append(svgEl('circle', { r: place.id === 'xian' ? 17 : 14 })); const text = svgEl('text', { y: -27, 'text-anchor': 'middle', class: 'city-label' }); text.textContent = place.name + (place.id === 'xian' ? ' · 出发' : ''); node.append(text); nodes.append(node);
      if (state.unlocked.includes(place.id) && place.mode !== 'heart') routes.append(svgEl('path', { d: pathFor(place), class: 'route-line ' + place.mode }));
      if (place.mode !== 'heart' && (place.mode !== 'train' || !state.unlocked.includes(place.id))) return;
      const heart = place.mode === 'heart';
      const candidates = [[55, 8], [-55, 8], [65, -20], [-65, -20], [0, 65]].map(([dx, dy]) => ({ x: Math.max(30, Math.min(870, place.x + dx)), y: Math.max(30, Math.min(475, place.y + dy)) }));
      const score = point => Math.min(...state.places.flatMap(p => [Math.hypot(p.x - point.x, p.y - point.y), Math.hypot(p.x - point.x, p.y - (point.y + 36)), Math.hypot(p.x - point.x, p.y - 27 - point.y)]), ...markerPositions.map(p => Math.hypot(p.x - point.x, p.y - point.y)));
      const position = candidates.find(p => score(p) > 40) || candidates.sort((a, b) => score(b) - score(a))[0]; markerPositions.push(position);
      const marker = svgButton(position.x, position.y, '打开' + place.name + '回忆', () => openPlaceMemories(place.id), heart ? 'city-heart' : 'city-frog'); marker.dataset.placeId = place.id;
      const icon = svgEl('g', { class: 'frog-bob' }); icon.append(svgEl('circle', { r: 23, fill: heart ? '#fff1f3' : '#f4e9cb', stroke: '#caa978', 'stroke-width': 2 }));
      const symbol = svgEl('text', { 'text-anchor': 'middle', y: 10, 'font-size': heart ? 31 : 29 }); symbol.textContent = heart ? '♥' : '🐸'; icon.append(symbol); marker.append(icon);
      const hint = svgEl('text', { y: 39, 'text-anchor': 'middle', class: 'frog-label' }); hint.textContent = '看回忆'; marker.append(hint); frogs.append(marker);
    });
    const destinations = state.places.filter(p => p.mode !== 'heart'), count = destinations.filter(p => state.unlocked.includes(p.id)).length;
    $('#journey-progress-count').textContent = `${count} / ${destinations.length}`; $('#journey-progress-bar').style.width = (destinations.length ? count / destinations.length * 100 : 0) + '%';
    $('#cake-station').hidden = !state.places.some(p => p.mode === 'plane' && state.unlocked.includes(p.id));
  }
  matchMedia('(max-width:700px)').addEventListener('change', () => { if (ready && !journeyBusy) renderMap(); });
  async function completeJourney(id) {
    const place = placeById(id); if (!ready || journeyBusy || !place || place.mode === 'heart') return;
    if (state.unlocked.includes(id)) { if (place.mode === 'train') openPlaceMemories(id); else $('#cake-station').scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth' }); return; }
    journeyBusy = true; $('#china-map').setAttribute('aria-busy', 'true');
    const path = svgEl('path', { d: pathFor(place), class: 'route-line ' + place.mode }); $('#route-layer').append(path);
    const vehicle = svgEl('text', { 'font-size': 30, 'text-anchor': 'middle', 'aria-hidden': 'true' }); vehicle.textContent = place.mode === 'plane' ? '✈' : '🚂'; $('#route-layer').append(vehicle);
    $('#travel-result').textContent = '从西安出发，正在前往' + place.name + '…';
    const duration = reduced() ? 150 : place.mode === 'plane' ? 2800 : 2500, length = path.getTotalLength();
    try {
      await new Promise(resolve => { const start = performance.now(); function frame(now) { const t = Math.min(1, (now - start) / duration), point = path.getPointAtLength(length * (t * t * (3 - 2 * t))); vehicle.setAttribute('transform', `translate(${point.x} ${point.y})`); if (t < 1) requestAnimationFrame(frame); else resolve(); } requestAnimationFrame(frame); });
      // Commit only after arrival. Failed storage must not leave a false unlocked marker.
      await commit(data => { if (!data.unlocked.includes(id)) data.unlocked.push(id); return data; });
      $('#travel-result').textContent = '已抵达' + place.name + (place.mode === 'train' ? '，旅行青蛙带来了这里的故事。' : '，蛋糕台已经为你准备好。');
      $('#map-instruction').textContent = '点击城市旁的青蛙看回忆，也可以继续出发。';
    } finally { journeyBusy = false; $('#china-map').setAttribute('aria-busy', 'false'); renderMap(); }
  }
  const token = $('#traveller-token');
  function mapPoint(event) { const point = new DOMPoint(event.clientX, event.clientY); return point.matrixTransform($('#china-map').getScreenCTM().inverse()); }
  function resetDrag() { dragActive = false; token.classList.remove('dragging'); const start = placeById('xian'); token.setAttribute('transform', `translate(${start.x} ${start.y})`); document.querySelectorAll('.drag-over').forEach(n => n.classList.remove('drag-over')); }
  token.addEventListener('pointerdown', event => { if (!ready || journeyBusy) return; event.preventDefault(); dragActive = true; token.classList.add('dragging'); token.setPointerCapture(event.pointerId); });
  token.addEventListener('pointermove', event => { if (!dragActive) return; const point = mapPoint(event); token.setAttribute('transform', `translate(${point.x} ${point.y})`); document.querySelectorAll('.destination').forEach(node => { const place = placeById(node.dataset.city); node.classList.toggle('drag-over', Math.hypot(point.x - place.x, point.y - place.y) < 30); }); });
  token.addEventListener('pointerup', guard(async event => { if (!dragActive) return; const point = mapPoint(event); const hit = state.places.filter(p => p.mode !== 'heart').sort((a, b) => Math.hypot(point.x - a.x, point.y - a.y) - Math.hypot(point.x - b.x, point.y - b.y)).find(p => Math.hypot(point.x - p.x, point.y - p.y) < 32); resetDrag(); if (hit) await completeJourney(hit.id); else $('#map-instruction').textContent = '将雪花拖到城市圆点上，再松开。'; }));
  token.addEventListener('pointercancel', resetDrag); token.addEventListener('lostpointercapture', () => { if (dragActive) resetDrag(); });
  function download(content, type, name) { const url = URL.createObjectURL(new Blob([content], { type })); const a = el('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
  $('#export-backup').addEventListener('click', () => download(JSON.stringify(state, null, 2), 'application/json', '生日礼物备份.json'));
  $('#import-backup').addEventListener('click', () => $('#backup-file').click());
  $('#backup-file').addEventListener('change', guard(async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    if (file.size > 100 * 1024 * 1024) throw new Error('备份不能超过 100 MB。');
    let raw; try { raw = JSON.parse(await file.text()); } catch { throw new Error('请选择有效的 JSON 备份。'); }
    const data = M.migrate(raw, uid());
    for (const photo of data.photos) { const img = new Image(); img.src = photo.src; try { await img.decode(); } catch { throw new Error('备份中有损坏的照片，原有内容未改变。'); } }
    if (!confirm('恢复将替换当前礼物内容和路线进度，确定继续吗？')) return;
    await commit(() => data); activePlace = 'xian'; $('#settings-dialog').close(); toast('备份已恢复。');
  }));
  $('#export-page').addEventListener('click', guard(async () => {
    if (!window.GIFT_SOURCES) await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'gift-sources.js';
      script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('分享资源加载失败，请重试。')); }; document.head.append(script);
    });
    const sources = window.GIFT_SOURCES; if (!sources?.model) throw new Error('分享资源未更新，请运行 build.ps1。');
    const doc = new DOMParser().parseFromString(sources.html, 'text/html'); doc.querySelector('link[rel="stylesheet"]').remove(); doc.querySelectorAll('script').forEach(n => n.remove());
    const style = doc.createElement('style'); style.textContent = sources.css; doc.head.append(style);
    if (sources.music) doc.querySelector('#birthday-music').src = sources.music;
    const data = doc.createElement('script'); data.id = 'gift-data'; data.type = 'application/json'; data.textContent = JSON.stringify(state).replace(/</g, '\\u003c'); doc.body.append(data);
    for (const code of [sources.model, sources.js]) { const script = doc.createElement('script'); script.textContent = code.replace(/<\/script/gi, '<\\/script'); doc.body.append(script); }
    download('<!doctype html>\n' + doc.documentElement.outerHTML, 'text/html;charset=utf-8', '给你的生日礼物.html'); toast('分享页面已导出，照片与地点都在文件里。');
  }));
  const birthdayMusic = $('#birthday-music'), musicToggle = $('#music-toggle');
  musicToggle.hidden = false;
  birthdayMusic.volume = 0.35;
  function updateMusicButton() {
    musicToggle.textContent = birthdayMusic.paused ? '♫ 播放音乐' : '♫ 暂停音乐';
    musicToggle.setAttribute('aria-label', birthdayMusic.paused ? '播放背景音乐' : '暂停背景音乐');
    musicToggle.setAttribute('aria-pressed', String(!birthdayMusic.paused));
  }
  function playBirthdayMusic() {
    musicToggle.hidden = false;
    birthdayMusic.play().catch(error => {
      updateMusicButton();
      toast(error.name === 'NotAllowedError' ? '请点击右侧播放音乐；微信内无法播放时，请用 Safari 或 Chrome 打开。' : '歌曲加载失败，请检查网络后点击播放音乐重试。');
    });
  }
  birthdayMusic.addEventListener('waiting', () => { musicToggle.textContent = '♫ 音乐加载中…'; });
  birthdayMusic.addEventListener('playing', updateMusicButton);
  birthdayMusic.addEventListener('error', () => { updateMusicButton(); toast('歌曲加载失败，请检查网络后重试。'); });
  birthdayMusic.addEventListener('play', updateMusicButton);
  birthdayMusic.addEventListener('pause', updateMusicButton);
  musicToggle.addEventListener('click', () => {
    if (birthdayMusic.paused) playBirthdayMusic(); else birthdayMusic.pause();
  });
  $('#wish').addEventListener('click', () => {
    playBirthdayMusic();
    toast('愿你的愿望，都在新的一岁慢慢实现 ♡'); if (reduced()) return;
    $('#confetti').replaceChildren();
    for (let i = 0; i < 45; i++) { const piece = el('i', 'confetti-piece'); piece.style.left = Math.random() * 100 + '%'; piece.style.background = ['#c88a9e', '#e7bd79', '#a5b897'][i % 3]; piece.style.animationDelay = Math.random() * .5 + 's'; $('#confetti').append(piece); }
    setTimeout(() => $('#confetti').replaceChildren(), 3300);
  });
    const cakeSteps = new Set(), cakeDecor = { cream: 0, flower: 0, candle: 0 }; let cakeTool = 'cream', cakeDrawing = false, lastCream = 0;
  const cake = $('#cake-preview');
  function updateCakeProgress() { $('#cake-progress').textContent = cakeSteps.size + ' / 4 完成'; $('#cake-hint').textContent = cakeSteps.size === 4 ? '蛋糕完成啦！烟花正在为你亮起。' : '当前工具：' + ({cream:'抹奶油',flower:'裱花',write:'许愿',candle:'插蜡烛'}[cakeTool]) + '。' + (cakeTool === 'cream' ? '在蛋糕表面拖动。' : '在蛋糕上点击操作。'); }
  function activateCakeTool(action) { cakeTool = action; document.querySelectorAll('[data-cake-action]').forEach(b => { b.classList.toggle('active', b.dataset.cakeAction === action); }); cake.className = 'cake-preview tool-' + action + (cakeSteps.has('cream') ? ' has-cream' : ''); $('#cake-write-tools').hidden = action !== 'write'; updateCakeProgress(); }
  function finishCakeStep(action) { if (cakeSteps.has(action)) return; cakeSteps.add(action); document.querySelector('[data-cake-action="' + action + '"]').classList.add('done'); updateCakeProgress(); if (cakeSteps.size === 4) completeCake(); }
  function completeCake() { $('#wish-panel').hidden = false; $('#wish-panel').scrollIntoView({ behavior: reduced() ? 'instant' : 'smooth', block: 'center' }); if (reduced()) return; $('#confetti').replaceChildren(); for (let i = 0; i < 42; i++) { const p = el('i', 'confetti-piece'); p.style.left = Math.random() * 100 + '%'; p.style.background = ['#f3cb9a','#e98f9d','#b7d4c2'][i % 3]; p.style.animationDelay = Math.random() * .4 + 's'; $('#confetti').append(p); } setTimeout(() => $('#confetti').replaceChildren(), 3500); }
  document.querySelectorAll('[data-cake-action]').forEach(button => button.addEventListener('click', () => activateCakeTool(button.dataset.cakeAction)));
  function cakePoint(event) { const rect = cake.getBoundingClientRect(); return { x: Math.max(5, Math.min(95, (event.clientX - rect.left) / rect.width * 100)), y: Math.max(20, Math.min(82, (event.clientY - rect.top) / rect.height * 100)) }; }
  function addCream(point) { const dot = el('i', 'cake-cream-dot'); dot.style.left = point.x + '%'; dot.style.top = point.y + '%'; $('.cake-cream-piping').append(dot); cakeDecor.cream++; if (cakeDecor.cream >= 6) finishCakeStep('cream'); }
  cake.addEventListener('pointerdown', event => { if (cakeTool !== 'cream') return; event.preventDefault(); cakeDrawing = true; cake.setPointerCapture(event.pointerId); addCream(cakePoint(event)); });
  cake.addEventListener('pointermove', event => { if (!cakeDrawing || cakeTool !== 'cream') return; const now = performance.now(); if (now - lastCream < 90) return; lastCream = now; addCream(cakePoint(event)); });
  cake.addEventListener('pointerup', () => { cakeDrawing = false; }); cake.addEventListener('pointercancel', () => { cakeDrawing = false; });
  cake.addEventListener('click', event => { if (cakeTool === 'flower') { const point = cakePoint(event), flower = el('i', 'cake-flower', ['✿','✾','❀'][cakeDecor.flower % 3]); flower.style.left = point.x + '%'; flower.style.top = point.y + '%'; $('.cake-decorations').append(flower); cakeDecor.flower++; if (cakeDecor.flower >= 3) finishCakeStep('flower'); } else if (cakeTool === 'candle') { const point = cakePoint(event), candle = el('i', 'cake-candle inserted'); const candleY = Math.min(38, Math.max(20, point.y)); candle.style.left = point.x + '%'; candle.style.top = (candleY - 8) + '%'; $('.cake-candle-row').append(candle); cakeDecor.candle++; if (cakeDecor.candle >= 3) finishCakeStep('candle'); } });
  $('#cake-message-apply').addEventListener('click', () => { const message = $('#cake-message-input').value.trim(); if (!message) return toast('先写下一个想实现的愿望吧。'); const layer = $('#wish-float-layer'); layer.replaceChildren(); const wish = el('span', 'wish-float', '♡ ' + message); layer.append(wish); finishCakeStep('write'); toast('愿望已经落在蛋糕后的星光里。'); });
  activateCakeTool('cream');
  $('#make-wish').addEventListener('click', () => { $('#wish-message').textContent='愿你想去的地方，我们都能一起抵达。'; toast('愿望已被冬夜的星星听见 ♡'); });

  async function init() {
    try {
      db = await openDatabase();
      if (shared) {
        state = M.migrate(published, 'shared-legacy');
        const unlocked = await read('journey:' + state.giftId);
        if (Array.isArray(unlocked)) state.unlocked = [...new Set([...state.unlocked, ...unlocked.filter(id => placeById(id))])];
      } else {
        const raw = await read('current');
        if (raw) { const migrated = M.migrate(raw, uid()); if (raw.version !== 3) await write([['before-v3-migration', raw], ['current', migrated]]); state = migrated; }
        else await write([['current', state]]);
      }
      ready = true;
    } catch (error) {
      // Never overwrite unreadable stored data with defaults.
      if (shared) { try { state = M.migrate(published, 'shared-legacy'); } catch {} }
      toast('内容未能加载或保存：' + error.message);
    }
    render(); document.body.dataset.appReady = String(ready);
  }
  init();
})();
