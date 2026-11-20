import {readdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const files=readdirSync('test').filter(name=>/^(cloud-|panel-cloud|pwa).*\.test\.mjs$/.test(name)).map(name=>'test/'+name);
for(const name of ['context.test.mjs'])if(readdirSync('test').includes(name))files.push('test/'+name);
if(!files.some(f=>f.includes('cloud-')))throw Error('CLOUD_TESTS_REQUIRED');
const result=spawnSync(process.execPath,['--test','--test-concurrency=2',...files],{stdio:'inherit'});process.exitCode=result.status??1;
