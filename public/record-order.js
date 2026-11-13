const timestamp = record => {
  for (const value of [record.updatedAt, record.uploadedAt, record.capturedAt]) {
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return 0;
};

export function timelineGroups(records, { order = 'recent', date = '', filter = 'all' }, dateKey) {
  const entries = records
    .map(record => ({ record, date: dateKey(record.capturedAt) }))
    .filter(item => (!date || item.date === date) && (filter === 'all' || item.record.kind === filter))
    .sort((a, b) => {
      const dayOrder = order === 'date' ? b.date.localeCompare(a.date) : 0;
      return dayOrder || timestamp(b.record) - timestamp(a.record)
        || Date.parse(b.record.capturedAt) - Date.parse(a.record.capturedAt)
        || b.record.id.localeCompare(a.record.id);
    });
  const groups = [];
  for (const { record, date: day } of entries) {
    // Only join adjacent dates: grouping every matching date would undo recent order.
    if (groups.at(-1)?.date !== day) groups.push({ date: day, records: [] });
    groups.at(-1).records.push(record);
  }
  return groups;
}
