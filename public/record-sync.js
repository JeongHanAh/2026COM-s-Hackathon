export async function syncRecords({
  partition, authorId, familyId, store, api, onUploaded = () => {},
  isCurrent = () => true, skipIds = new Set(), onRejected = () => {}
}) {
  const result = { uploaded: 0, deleted: 0 };
  if (!partition || !authorId || !familyId || !isCurrent()) return result;
  const session = await api('/api/session');
  if (!isCurrent() || session?.user?.id !== authorId || session?.family?.id !== familyId) return result;

  const own = item => item.partition === partition && item.authorId === authorId &&
    (item.familyId || item.partition?.split('/')[1]) === familyId;
  const isDeleted = async id => (await store.readDeletions()).some(item => item.id === id);

  async function flushDeletions() {
    for (const deletion of await store.readDeletions()) {
      if (!isCurrent()) return;
      if (!own(deletion) || deletion.synced) continue;
      await api('/api/records/' + encodeURIComponent(deletion.id), {
        method: 'DELETE', headers: { 'X-Record-Owner': authorId }
      });
      await store.markDeletionSynced(deletion.id);
      result.deleted++;
    }
  }

  await flushDeletions();
  for (const queued of await store.readOutbox()) {
    if (!isCurrent()) return result;
    if (!own(queued) || queued.approved !== true || skipIds.has(queued.id)) continue;
    // Another tab may approve or delete an item while a preceding upload runs.
    const record = (await store.readOutbox()).find(item => item.id === queued.id);
    if (!record || !own(record) || record.approved !== true || await isDeleted(record.id)) continue;
    if (!isCurrent()) return result;
    let uploaded;
    try {
      ({ record: uploaded } = await api('/api/records', {
        method: 'POST',
        body: record.blob,
        headers: {
          'Content-Type': record.blob.type || (record.kind === 'video' ? 'video/webm' : 'audio/webm'),
          'X-Record-Id': record.id,
          'X-Captured-At': record.capturedAt,
          'X-Record-Kind': record.kind,
          'X-Duration-Ms': String(record.durationMs),
          'X-Record-Owner': authorId
        }
      }));
    } catch (error) {
      if (error.status === 410) {
        await store.queueDeletion({ ...record, familyId });
        await store.markDeletionSynced(record.id);
        continue;
      }
      if (![413, 415, 422].includes(error.status)) throw error;
      skipIds.add(record.id);
      await onRejected(record, error);
      continue;
    }
    await store.removePending(record.id);
    const deleted = await isDeleted(record.id);
    if (!isCurrent()) return result;
    if (deleted) {
      await flushDeletions();
      continue;
    }
    await onUploaded(uploaded);
    result.uploaded++;
  }
  if (isCurrent()) await flushDeletions();
  return result;
}
