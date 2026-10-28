import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {sha256} from '../src/rag/receipts.mjs';
import {stage6PrivateRoot} from '../src/evaluation/stage6-corpus.mjs';

const root=process.cwd(),privateRoot=stage6PrivateRoot(root),directory=path.join(privateRoot,'sources');
await mkdir(directory,{recursive:true});
const config=JSON.parse(await readFile('config/stage6.json','utf8')),manifest=[];
try{
  for(const source of config.sources){
    const prefix=`https://huggingface.co/datasets/${source.repository}/resolve/${source.revision}/`,file=path.join(directory,source.id+path.extname(source.file)),licenceFile=path.join(directory,source.id+'-licence.txt');
    for(const [url,destination]of [[prefix+source.file,file],[prefix+source.licenceFile,licenceFile]]){
      const response=await fetch(url);if(!response.ok)throw Error('Public source download failed');await writeFile(destination,Buffer.from(await response.arrayBuffer()),{mode:0o600});
    }
    let parsedFile=file;
    if(path.extname(file)==='.parquet'){
      parsedFile=path.join(directory,source.id+'.json');
      execFileSync(process.env.HANDOFF_PYTHON||'python',['scripts/stage6-read-parquet.py',file,parsedFile],{env:{...process.env,PYTHONPATH:path.join(root,'.cache/stage6-python')},stdio:'ignore',windowsHide:true});
    }
    manifest.push({...source,url:prefix+source.file,rawFile:path.relative(privateRoot,file),parsedFile:path.relative(privateRoot,parsedFile),sha256:sha256(await readFile(file)),parsedSha256:sha256(await readFile(parsedFile)),licenceSha256:sha256(await readFile(licenceFile))});
  }
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({version:1,downloadedAt:new Date().toISOString(),sources:manifest},null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({downloaded:manifest.map(({id,revision,licence,sha256})=>({id,revision,licence,sha256})),promptTextPrinted:false}));
}catch{console.error('Stage 6 dataset preparation failed; no source text printed. Check local prerequisites and source availability.');process.exitCode=1;}
