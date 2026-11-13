export const isNetworkFailure = error => error?.network === true;

export function anonymousSession(session) {
  return {
    user: null, family: null, demo: session?.demo === true,
    ...(session?.backend ? { backend: session.backend } : {}),
    ...(session?.auth ? { auth: { signup: session.auth.signup === true, recovery: session.auth.recovery === true } } : {})
  };
}

// Cache display data only. Never persist access/refresh tokens or invitation codes.
export function offlineSession(session) {
  if (!session?.user?.id || !session?.family?.id || session.recovery || session.user.member !== true
    || !session.family.members?.some(member => member.id === session.user.id)) return null;
  const member = ({ id, name, role }) => ({ id, name, role });
  return {
    ...anonymousSession(session),
    user: { ...member(session.user), member: true },
    family: { id: session.family.id, name: session.family.name, members: session.family.members.map(member) }
  };
}

export function validateAuthFields(action, fields) {
  if (action === 'signup' && (!fields.name?.trim() || fields.name.trim().length > 48)) return '이름은 1~48자로 입력해 주세요.';
  if (action === 'signup' || action === 'password-update') {
    if (!fields.password || fields.password.length < 10 || fields.password.length > 128) return '비밀번호는 10~128자로 입력해 주세요.';
    if (fields.password !== fields.passwordConfirm) return '비밀번호가 서로 다릅니다.';
  }
  return '';
}
