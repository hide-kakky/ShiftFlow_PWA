import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { Miniflare } from 'miniflare';

const source = await readFile(new URL('../functions/utils/webPush.js', import.meta.url), 'utf8');

test('本番と同じworkerdで暗号化とRequest構築が通り、307を送信結果として返す', async (t) => {
  const runtime = new Miniflare({
    compatibilityDate: '2025-11-02',
    modules: true,
    script: source + '\n' + `
        export default { async fetch(request) {
          const server = await crypto.subtle.generateKey({name:'ECDSA', namedCurve:'P-256'}, true, ['sign','verify']);
          const privateKey = await crypto.subtle.exportKey('jwk', server.privateKey);
          const env = {VAPID_PUBLIC_KEY:encode64(await crypto.subtle.exportKey('raw',server.publicKey)), VAPID_PRIVATE_KEY:privateKey.d, VAPID_SUBJECT:'https://example.invalid'};
          const client = await crypto.subtle.generateKey({name:'ECDH', namedCurve:'P-256'}, true, ['deriveBits']);
          const subscription = {endpoint:'https://web.push.apple.com/fixture', p256dh:encode64(await crypto.subtle.exportKey('raw',client.publicKey)), auth:encode64(crypto.getRandomValues(new Uint8Array(16)))};
          let calls=0, mode='', encrypted=false, signed=false;
          try {
            const status = await sendWebPush(subscription, {title:'合成データ'}, env, {fetchImpl:async(url,init)=>{
              // native Requestの構築も通し、Nodeのfetch stubだけでは拾えない差を検証する。
              const outbound = new Request(url,init);
              calls++; mode=outbound.redirect; encrypted=outbound.headers.get('Content-Encoding')==='aes128gcm'; signed=!!outbound.headers.get('Authorization');
              return new Response(null,{status:Number(new URL(request.url).searchParams.get('status'))||201,headers:{Location:'https://example.invalid/must-not-follow'}});
            }});
            return Response.json({status,calls,mode,encrypted,signed});
          } catch(error) { return Response.json({error:error.name}, {status:500}); }
        }};`,
  });
  t.after(() => runtime.dispose());
  for (const status of [201, 307]) {
    const result = await runtime.dispatchFetch('https://fixture.invalid/?status=' + status);
    const payload = await result.json();
    assert.equal(result.status, 200, JSON.stringify(payload));
    assert.deepEqual(payload, {status,calls:1,mode:'manual',encrypted:true,signed:true});
  }
});
