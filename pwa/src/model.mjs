export function safeExternalUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export function parseRoute(value) {
  const url = new URL(value, 'https://lingo.invalid');
  const valid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null;
  const tab = url.searchParams.get('tab');
  return { tab: tab === 'history' || tab === 'settings' ? tab : 'today', recordId: valid(url.searchParams.get('record')), batchId: valid(url.searchParams.get('batch')) };
}
export function readSetupLink(value) {
  const url = new URL(value, 'https://lingo.invalid');
  const params = new URLSearchParams(url.hash.slice(1));
  const present = params.has('token_hash') || params.has('token_type');
  const token = params.get('token_hash');
  const valid = present && params.get('token_type') === 'recovery' && typeof token === 'string' && /^[A-Za-z0-9_-]{20,512}$/.test(token);
  return { present, token: valid ? token : null };
}
export function reviewCards(batch) { return Array.isArray(batch?.cards) ? batch.cards.slice(0, 5) : []; }
export function languageLabel(language) { return language === 'ja' ? '日语' : language === 'en' ? '英语' : '英日语'; }
export function speechContent(text, reading, language) {
  const japanese = language === 'ja' || (language === 'mixed' && /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text));
  return { lang: japanese ? 'ja-JP' : 'en-US', text: japanese && reading?.trim() ? reading.trim() : text.trim() };
}
export function userError(error) {
  const code = error?.code || error?.message;
  const messages = {
    AUTH_REQUIRED: '登录已过期，请重新登录。', UNAUTHORIZED: '登录已过期，请重新登录。',
    LOGIN_REQUIRED: '请先登录，再查看你的学习内容。', AUTH_EXPIRED: '登录已过期，请重新登录。',
    AUTH_FAILED: '邮箱或密码不正确，或账号尚未开通。',
    AUTH_UNAVAILABLE: '登录服务暂时不可用，请稍后重试。',
    SETUP_LINK_INVALID: '密码设置链接已失效，请联系管理员获取新的链接。',
    PASSWORD_TOO_SHORT: '密码至少需要 10 个字符。', PASSWORD_REJECTED: '密码未通过安全检查，请换一个更长且未使用过的密码。',
    PASSWORD_SETUP_REQUIRED: '请先设置自己的登录密码。',
    INVALID_EMAIL: '请填写有效的邮箱地址。', INVITE_REQUIRED: '这个邮箱尚未受邀，请联系邀请人。',
    NOT_FOUND: '这条内容已不存在，可能已在其他设备删除。', RECORD_NOT_FOUND: '这条记录已删除。',
    REVISION_CONFLICT: '记录刚刚发生变化，请刷新后再试。', CONFLICT: '记录刚刚发生变化，请刷新后再试。',
    RATE_LIMITED: '操作有些频繁，请稍后再试。', NETWORK_ERROR: '暂时无法连接，请检查网络后重试。',
    FETCH_FAILED: '暂时无法连接，请检查网络后重试。', KEY_INVALID: 'Key 未通过验证，请检查后重新填写。',
    PUSH_NOT_CONFIGURED: '通知服务尚未就绪，请稍后再试。',
    TIMEOUT: '连接超时，请稍后重试。',
  };
  return messages[code] || '操作没有完成，请稍后重试。';
}
export function vapidBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded);
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}
export function pushSubscriptionError(error) {
  const messages = {
    AbortError: '浏览器暂时未能完成通知订阅。请检查网络，关闭后从主屏幕重新打开 Lingo Notes，再试一次。',
    NotAllowedError: '通知权限未获允许。请在设备的通知设置中允许 Lingo Notes，并从主屏幕打开后重试。',
    NotSupportedError: '当前浏览器不支持此通知方式。iPhone 请使用 iOS 16.4 或更新版本，将页面添加到主屏幕后再开启通知。',
    InvalidStateError: '浏览器的通知状态尚未就绪。请刷新页面，或关闭后从主屏幕重新打开，再试一次。',
  };
  return messages[error?.name] || null;
}
