export const demoHome = Object.freeze({
  id: 'residence-1',
  ownerId: 'family-a',
  neighborhood: '가자시 알샤티',
  address: '시연용 거주지 01',
});

export function viewHome(home, userId) {
  const canEdit = home.ownerId === userId;
  const hasAddress = Boolean(home.address);
  const match = home.buildingMatch;
  const buildingObservation = hasAddress && match?.verifiedAddress === home.address && match?.result
    ? {
        result: match.result,
        date: match.date,
        source: match.source,
      }
    : null;

  return {
    neighborhood: home.location?.region || '',
    location: home.location || null,
    canEdit,
    hasAddress,
    ...(canEdit ? { address: home.address } : {}),
    status: buildingObservation
      ? `건물 피해 관측 · ${buildingObservation.result}`
      : hasAddress || home.location ? '우리 집 상태 미확인' : '거주지 등록 대기',
    buildingObservation,
  };
}
