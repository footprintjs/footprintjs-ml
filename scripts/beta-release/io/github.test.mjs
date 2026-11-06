import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getJson} from './github.mjs';
for(const [name,response,ok] of [
 ['JSON200',()=>new Response('{"safe":true}'),true],
 ['real404',()=>new Response('',{status:404}),true],
 ['server500',()=>new Response('{}',{status:500}),false],
 ['malformedJSON',()=>new Response('{'),false],
 ['capacity',()=>new Response('x'.repeat(2097153)),false]])test('fixed GET '+name,async()=>{
 const call=()=>getJson('/git/ref/heads/main',{token:'fixture-not-a-credential',fetcher:async(url,options)=>{
  assert.equal(url,'https://api.github.com/repos/footprintjs/footprintjs-ml/git/ref/heads/main');
  assert.equal(options.method,undefined);assert.equal(options.redirect,'error');
  return response();
 }});
 if(ok)await call();else await assert.rejects(call);
});
test('arbitrary route refused before fetch',async()=>{
 let calls=0;await assert.rejects(()=>getJson('https://other.invalid',{fetcher:()=>calls++}));
 assert.equal(calls,0);
});
