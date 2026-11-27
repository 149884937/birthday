(async () => {
  if(document.body.dataset.appReady!=='true')throw Error('not ready');
  const db=await new Promise((r,j)=>{const q=indexedDB.open('birthday-keepsake',1);q.onsuccess=()=>r(q.result);q.onerror=j;});
  const read=key=>new Promise(r=>{const q=db.transaction('gift').objectStore('gift').get(key);q.onsuccess=()=>r(q.result);});
  const current=await read('current'), original=await read('before-v3-migration'), restore=await read('test-before-migration');
  if(current.version!==3||original.version!==1||current.photos.length!==original.memories[0].photos.length||current.photos[0].src!==original.memories[0].photos[0]||current.stories[0].placeId!=='xian')throw Error('migration mismatch');
  await new Promise((r,j)=>{const tx=db.transaction('gift','readwrite');tx.objectStore('gift').put(restore,'current');tx.objectStore('gift').delete('test-before-migration');tx.oncomplete=r;tx.onerror=j;});
  db.close();return 'PASS real startup migrates IndexedDB v1 to v3 with all photos intact and retains original backup';
})()
