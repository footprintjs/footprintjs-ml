import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
const path=new URL('../../.github/workflows/publish.yml',import.meta.url);
test('ML beta distribution has a checked-in native release workflow',()=>{
 assert.equal(existsSync(path),true,'ML beta release workflow is missing');
});
test('closed release job permissions and immutable actions',()=>{
 const source=readFileSync(path,'utf8'),publisher=source.split('  publish:\n')[1].split('  verify:\n')[0];
 assert.doesNotMatch(source,/^\s+(?:- )?run: (?![|>])/m);
 assert.match(source,/dry_run:[\s\S]*?default: true/);
 assert.match(source,/on:\n  workflow_dispatch:/);
 assert.doesNotMatch(source,/pull_request_target:|schedule:|repository_dispatch:/);
 assert.match(publisher,/permissions:\n      contents: write\n      actions: read/);
 assert.doesNotMatch(publisher,/uses:|npm ci|npm install|checkout@/);
 assert.match(publisher,/!inputs\.dry_run/);
 assert.match(publisher,/--fail-with-body --retry 0/);
 assert.doesNotMatch(publisher,/--clobber|--admin|--force|request DELETE/);
 for(const match of source.matchAll(/uses: (\S+)/g))assert.match(match[1],/^actions\/[\w-]+@[a-f0-9]{40}$/);
 for(const match of source.matchAll(/runs-on: (\S+)/g))assert.equal(match[1],'ubuntu-24.04');
});
