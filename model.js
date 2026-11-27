/* Versioned, independent place / story / photo records. No browser dependencies. */
(function (root) {
  'use strict';
  const initialPlaces = [
    { id: 'xian', name: '西安', mode: 'heart', x: 386, y: 280 },
    { id: 'shenyang', name: '沈阳', mode: 'plane', x: 621, y: 112 },
    { id: 'guangyuan', name: '广元', mode: 'train', x: 353, y: 337 },
    { id: 'chongqing', name: '重庆', mode: 'train', x: 410, y: 388 },
    { id: 'jinan', name: '济南', mode: 'train', x: 562, y: 220 }
  ];
  const copy = value => JSON.parse(JSON.stringify(value));
  const validDate = value => value === '' || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  function validate(data) {
    function require(ok, message) { if (!ok) throw new Error(message); }
    const text = (s, max, needed = false) => typeof s === 'string' && s.length <= max && (!needed || s.trim().length > 0);
    require(data?.version === 3 && text(data.giftId, 150, true), '不支持的备份版本。');
    const s = data.settings;
    require(s && text(s.recipient, 30, true) && validDate(s.birthday) && text(s.subtitle, 200, true) && text(s.letter, 5000, true) && text(s.sender, 30, true), '请检查昵称、日期和生日信的格式。');
    require(Array.isArray(data.places) && data.places.length > 0 && data.places.length <= 100 && Array.isArray(data.stories) && data.stories.length <= 1000 && Array.isArray(data.photos) && data.photos.length <= 3000, '地点、故事或照片数量超出限制。');
    const places = new Set(), stories = new Map(), photos = new Map();
    for (const p of data.places) {
      require(p && text(p.id, 150, true) && !places.has(p.id) && text(p.name, 30, true) && ['heart', 'train', 'plane'].includes(p.mode) && Number.isFinite(p.x) && p.x >= 25 && p.x <= 875 && Number.isFinite(p.y) && p.y >= 25 && p.y <= 515, '地点配置无效或编号重复。');
      places.add(p.id);
    }
    require(places.has('xian') && data.places.find(p => p.id === 'xian').mode === 'heart', '必须保留西安爱心起点。');
    for (const s of data.stories) {
      require(s && text(s.id, 150, true) && !stories.has(s.id) && places.has(s.placeId) && text(s.title, 50, true) && text(s.story, 1000) && validDate(s.date) && Number.isFinite(s.order) && s.order >= 0 && text(s.coverId, 150, true), '故事格式无效，或所属地点不存在。');
      stories.set(s.id, s);
    }
    for (const p of data.photos) {
      require(p && text(p.id, 150, true) && !photos.has(p.id) && stories.has(p.storyId) && text(p.caption, 300) && Number.isFinite(p.order) && p.order >= 0 && text(p.src, 12000000, true) && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.src), '照片格式无效，或所属故事不存在。');
      photos.set(p.id, p);
    }
    for (const s of data.stories) {
      const count = data.photos.filter(p => p.storyId === s.id).length;
      require(count >= 1 && count <= 30 && photos.get(s.coverId)?.storyId === s.id, '每个故事需要 1–30 张照片，封面必须来自该故事。');
    }
    require(Array.isArray(data.unlocked) && new Set(data.unlocked).size === data.unlocked.length && data.unlocked.every(id => places.has(id)), '解锁记录无效。');
    return data;
  }
  function migrate(input, giftId) {
    if (input?.version === 3) return validate(copy(input));
    if (![1, 2].includes(input?.version)) throw new Error('不支持的备份版本。');
    const out = { version: 3, giftId, settings: copy(input.settings), places: copy(initialPlaces), stories: [], photos: [], unlocked: [] };
    let groups;
    if (input.version === 1) {
      if (!Array.isArray(input.memories)) throw new Error('旧备份缺少故事列表。');
      groups = [{ id: 'xian', stories: input.memories }];
    } else {
      if (!Array.isArray(input.places)) throw new Error('旧备份缺少地点列表。');
      groups = input.places;
      const seen = new Set();
      for (const place of groups) {
        if (seen.has(place.id)) throw new Error('旧备份地点编号重复。');
        seen.add(place.id);
        if (!out.places.some(p => p.id === place.id)) out.places.push({ id: place.id, name: place.name, mode: place.route || 'train', x: place.x ?? 450, y: place.y ?? 270 });
        if (place.unlocked && place.id !== 'xian') out.unlocked.push(place.id);
      }
    }
    for (const group of groups) {
      if (!Array.isArray(group.stories)) throw new Error('旧备份故事列表损坏。');
      group.stories.forEach((story, index) => {
        const sources = story.photos ?? (story.photo ? [story.photo] : []);
        if (!Array.isArray(sources)) throw new Error('旧备份照片列表损坏。');
        const photos = sources.map((src, i) => ({ id: story.id + '-photo-' + i, storyId: story.id, src, caption: '', order: i }));
        out.stories.push({ id: story.id, placeId: group.id, title: story.title, story: story.story, date: story.date, order: story.order ?? index, coverId: photos[0]?.id });
        out.photos.push(...photos);
      });
    }
    return validate(out);
  }
  const ordered = list => [...list].sort((a, b) => a.order - b.order);
  const api = { initialPlaces, validate, migrate, copy, storiesAt: (data, id) => ordered(data.stories.filter(s => s.placeId === id)), photosOf: (data, id) => ordered(data.photos.filter(p => p.storyId === id)) };
  if (typeof module !== 'undefined') module.exports = api;
  else root.GiftModel = api;
})(globalThis);
