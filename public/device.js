let database;

function openDatabase() {
  if (database) return database;
  const pending = new Promise((resolve, reject) => {
    const open = indexedDB.open('our-days', 2);
    let blocked = false;
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains('meta')) open.result.createObjectStore('meta');
      if (!open.result.objectStoreNames.contains('outbox')) open.result.createObjectStore('outbox', { keyPath: 'id' });
      if (!open.result.objectStoreNames.contains('deletions')) open.result.createObjectStore('deletions', { keyPath: 'id' });
    };
    open.onblocked = () => {
      blocked = true;
      reject(new Error('다른 일상 기록 탭을 닫고 다시 시도해 주세요.'));
    };
    open.onsuccess = () => {
      if (blocked) { open.result.close(); return; }
      open.result.onversionchange = () => {
        open.result.close();
        if (database === pending) database = undefined;
      };
      resolve(open.result);
    };
    open.onerror = () => reject(open.error);
  });
  database = pending;
  pending.catch(() => { if (database === pending) database = undefined; });
  return pending;
}

async function transaction(names, mode, run) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(names, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('기기 저장소 작업이 취소됐어요.'));
    tx.onerror = () => reject(tx.error);
    try {
      run(tx, value => { result = value; });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}

function operate(name, mode, run) {
  return transaction([name], mode, (tx, done) => {
    const request = run(tx.objectStore(name));
    request.onsuccess = () => done(request.result);
  });
}

export const readDevice = key => operate('meta', 'readonly', store => store.get(key));
export const writeDevice = (key, value) => operate('meta', 'readwrite', store => store.put(value, key));
export const readOutbox = () => operate('outbox', 'readonly', store => store.getAll());
export const removePending = id => operate('outbox', 'readwrite', store => store.delete(id));
export const readDeletions = () => operate('deletions', 'readonly', store => store.getAll());

export function savePending(record) {
  return transaction(['outbox', 'deletions'], 'readwrite', (tx, done) => {
    const deleted = tx.objectStore('deletions').get(record.id);
    deleted.onsuccess = () => {
      if (deleted.result) { done(false); return; }
      tx.objectStore('outbox').put({ ...record, approved: record.approved === true });
      done(true);
    };
  });
}

export function approvePending(id, partition) {
  return transaction(['outbox', 'deletions'], 'readwrite', (tx, done) => {
    const deleted = tx.objectStore('deletions').get(id);
    deleted.onsuccess = () => {
      if (deleted.result) { done(false); return; }
      const outbox = tx.objectStore('outbox');
      const request = outbox.get(id);
      request.onsuccess = () => {
        const record = request.result;
        if (!record || record.partition !== partition) { done(false); return; }
        outbox.put({ ...record, approved: true });
        done(true);
      };
    };
  });
}

export function queueDeletion(record) {
  const familyId = record.familyId || record.partition?.split('/')[1];
  const authorId = record.authorId;
  const partition = record.partition || authorId + '/' + familyId;
  if (!record.id || !familyId || !authorId) return Promise.reject(new Error('기록의 소유자를 확인할 수 없어요.'));
  return transaction(['deletions', 'outbox', 'meta'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('deletions');
    const request = store.get(record.id);
    request.onsuccess = () => {
      const deletion = request.result || { id: record.id, partition, authorId, familyId, synced: false };
      store.put(deletion);
      tx.objectStore('outbox').delete(record.id);
      // Every cached account in this family must forget the deleted record.
      const cursor = tx.objectStore('meta').openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        if (typeof entry.key === 'string' && entry.key.startsWith('records:') &&
            entry.key.endsWith('/' + familyId) && Array.isArray(entry.value)) {
          entry.update(entry.value.filter(item => item.id !== record.id));
        }
        entry.continue();
      };
      done(deletion);
    };
  });
}

export function markDeletionSynced(id) {
  return transaction(['deletions'], 'readwrite', (tx, done) => {
    const store = tx.objectStore('deletions');
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) { done(false); return; }
      store.put({ ...request.result, synced: true });
      done(true);
    };
  });
}
