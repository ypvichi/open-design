// Quick SSO login diagnostic — prints the exact response from CAS
import { rawRequest } from './http.ts';
import * as crypto from 'crypto';

const CAS_RSA_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCqc90wxTr7Biug8nciEMrSygRg
Yvo31+shw+gxp0LqVbVCeGklV/Mwx7HXeGbbK9HHHAORE6lDgIb7tgCPZHygA2v
JtBhlhIy2IgHDpsp8Hv0UjwCML8/6KvChE3YChPffs6UUUgwJOQiDWOe/i2dCT4
J2p/AR1kFcd2UFEGaW1QIDAQAB
-----END PUBLIC KEY-----`;

const username = process.env.OA_USERNAME || 'yebo';
const password = process.env.OA_PASSWORD || 'F117Ak47_820723';

if (!password) {
  console.error('Missing OA_PASSWORD in environment.');
  process.exit(1);
}

console.log(`Testing SSO login for user: ${username}`);
console.log(`HTTPS_PROXY: ${process.env.HTTPS_PROXY || '(none)'}`);

// 强制用 HTTP domino 入口（默认值，绕过 .env 中 https://sso.hikvision.com 配置）
const cfg = { ssoEntryUrl: 'http://sso.hikvision.com.cn/domino/login', baseUrl: 'http://hicoo.hikvision.com.cn' };
const ssoEntryUrl = `${cfg.ssoEntryUrl}?RedirectTo=${Buffer.from(cfg.baseUrl + '/algomarket/algorithmRetrieval').toString('base64')}`;

try {
  // Step 1: GET SSO page
  console.log('\n[Step 1] GET SSO login page...');
  const step1 = await rawRequest('GET', ssoEntryUrl, []);
  console.log('  finalUrl:', step1.finalUrl);
  console.log('  status:', step1.status);

  const ltMatch = step1.body.match(/name="lt"\s+value="([^"]+)"/);
  const executionMatch = step1.body.match(/name="execution"\s+value="([^"]+)"/);
  const saltMatch = step1.body.match(/id="salt"\s+value="([^"]+)"/);

  console.log('  lt found:', !!ltMatch);
  console.log('  execution found:', !!executionMatch);
  console.log('  salt found:', !!saltMatch, saltMatch?.[1]?.substring(0, 8) + '...');

  if (!ltMatch || !executionMatch) {
    console.log('  [WARN] CAS form fields not found. Body excerpt:');
    console.log('  ', step1.body.substring(0, 500));
    process.exit(1);
  }

  const salt = saltMatch?.[1] ?? '';
  const encPwd = salt
    ? crypto.publicEncrypt(
        { key: CAS_RSA_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
        Buffer.from(salt + password),
      ).toString('base64')
    : password;

  // Step 2: POST credentials
  console.log('\n[Step 2] POST credentials...');
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const formBody = new URLSearchParams({
    username, password: encPwd, lt: ltMatch[1],
    execution: executionMatch[1], _eventId: 'submit',
    ver: '2.0', loginForm: 'qrLoginForm',
    localDate: `${today.getFullYear()}-${mm}-${dd}`, fingerprint: '',
  }).toString();

  const step2 = await rawRequest('POST', step1.finalUrl, step1.cookies, {
    body: formBody,
    extraHeaders: { Referer: step1.finalUrl, Origin: new URL(step1.finalUrl).origin },
  });

  console.log('  status:', step2.status);
  console.log('  finalUrl:', step2.finalUrl);
  const hasJwt = step2.cookies.some(c => c.name === 'JwtToken');
  const hasLtpa = step2.cookies.some(c => c.name === 'LtpaToken');
  console.log('  JwtToken:', hasJwt);
  console.log('  LtpaToken:', hasLtpa);

  if (!hasJwt || !hasLtpa) {
    const msgMatch = step2.body.match(/<div id="msg">([^<]+)<\/div>/);
    const bodyExcerpt = step2.body.substring(0, 800);
    console.log('  Login FAILED');
    console.log('  msg div:', msgMatch?.[1] || '(not found)');
    console.log('  Body excerpt:', bodyExcerpt);
  } else {
    console.log('\n✅ SSO Login SUCCESS!');
  }
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
