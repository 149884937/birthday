(async () => {
  const db = await new Promise((r,j) => { const q=indexedDB.open('birthday-keepsake',1);q.onsuccess=()=>r(q.result);q.onerror=j; });
  const current = await new Promise(r=>{ const q=db.transaction('gift').objectStore('gift').get('current');q.onsuccess=()=>r(q.result); });
  const story=current.stories[0], legacy={version:1,settings:current.settings,memories:[{id:story.id,title:story.title,date:story.date,story:story.story,photos:current.photos.filter(p=>p.storyId===story.id).map(p=>p.src)}]};
  await new Promise((r,j)=>{const tx=db.transaction('gift','readwrite');tx.objectStore('gift').put(current,'test-before-migration');tx.objectStore('gift').put(legacy,'current');tx.oncomplete=r;tx.onerror=j;});
  db.close();location.reload();return 'Legacy v1 seeded in isolated test profile';
})()
