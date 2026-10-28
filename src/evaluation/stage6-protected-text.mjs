import {readFile} from 'node:fs/promises';
import path from 'node:path';

/** Read only the external private corpus. Callers report counts, never values. */
export async function stage6ProtectedText(root=process.cwd()){
  const directory=path.resolve(process.env.STAGE6_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6'));
  let body;try{body=await readFile(path.join(directory,'corpus.jsonl'),'utf8');}catch(error){if(error.code==='ENOENT')return[];throw error;}
  const values=new Set();
  const add=value=>{if(typeof value==='string'&&value.length>=12){values.add(value);values.add(JSON.stringify(value).slice(1,-1));}};
  for(const line of body.split(/\r?\n/).filter(Boolean)){
    const item=JSON.parse(line);
    if(['attacks','evasion'].includes(item.area))add(item.content);
    if(item.area==='inbound'&&['strongreject','local-red-team'].includes(item.sourceSuite))add(item.answer);
    for(const seed of item.piiSeeds??[])add(seed.value);
  }
  return[...values];
}
